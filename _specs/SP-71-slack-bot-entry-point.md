# SP-71 Slack Bot Entry Point with Streaming

## Main objective

Add a Slack bot entry point (`src/slack.ts`) that bridges Slack messages to the
existing agent orchestrator, streaming progress as thread replies via the event
bus.

## Context

The agent system has three interfaces today: CLI (`src/cli.ts`), HTTP server
(`src/server.ts`), and programmatic (`executeTurn()`). The HTTP server already
demonstrates the streaming pattern — subscribe to `bus.onAny()`, filter by
`sessionId`, and forward events. `@slack/bolt` is already installed but unused.

The Slack bot reuses this exact pattern (see SP-62 SSE implementation as
reference): receive a Slack message, call `executeTurn()`, subscribe to the
event bus, and post progress updates to a Slack thread. No changes to the agent
core, tools, or event system are needed.

Note: `slack.ts` must replicate the same startup sequence as `server.ts` —
`initTracing()`, `attachLangfuseSubscriber()`, `initMcpTools()` — since it runs
as a separate process.

## Out of scope

- Slack slash commands or interactive components (buttons, modals)
- Multi-workspace / Slack Connect support
- Agent selection from Slack (uses default assistant; configurable later)
- Rate limiting or per-user quotas
- File/image uploads from Slack to the agent (future enhancement)
- Changes to the agent loop, tools, or event bus

## Constraints

- Must not modify existing entry points (`cli.ts`, `server.ts`) or core agent code
- Must use `@slack/bolt` (already in dependencies)
- Must use `executeTurn()` as the only interface to the agent
- Must use the event bus for streaming — no polling or custom hooks
- Slack API rate limits: Tier 3 (~50 req/min for `chat.postMessage`), Tier 4 for `chat.update`; throttle accordingly
- Slack message text limit: 4000 characters; responses exceeding this must be split or truncated
- Socket Mode preferred (no public URL required for development)

## Acceptance criteria

- [ ] `src/slack.ts` starts a Bolt app in Socket Mode
- [ ] Bot responds to DMs and @mentions in channels
- [ ] Each Slack thread maps to one agent session (thread_ts = session key)
- [ ] Agent progress shown via a single editable "status" message in thread (`chat.update`), collapsing tool calls and intermediate results
- [ ] Status message throttled (max 1 `chat.update`/second) to respect Slack rate limits
- [ ] Typing indicator (`:thinking_face:` reaction) shown while agent is working; removed on both success and error
- [ ] Final answer posted as a distinct new thread reply (not an edit of the status message)
- [ ] Final answers exceeding 4000 chars are split into multiple thread replies
- [ ] Errors surface as thread replies with clear message
- [ ] Events from session A never appear in session B's thread (concurrent isolation)
- [ ] `bun run slack` starts the bot (package.json script)
- [ ] Env vars: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` (Socket Mode) — optional, bot only starts if present
- [ ] Graceful shutdown on SIGINT/SIGTERM

## Implementation plan

1. **Create `src/slack.ts`** — new entry point:
   - Initialize Bolt app with Socket Mode
   - Register `message` and `app_mention` event handlers
   - Start the app, log ready status

2. **Session mapping** — derive agent `sessionId` from Slack thread:
   - Key: `slack-{teamId}-{channelId}-{thread_ts}` (or message `ts` if no thread)
   - If user replies in thread, reuse the session; new top-level message = new session

3. **Message handler flow**:
   - Call `await ack()` immediately (Bolt retries if not acked within 3s)
   - Guard: ignore messages with empty/undefined text (file-only messages, etc.)
   - Deduplicate: track in-flight `thread_ts` keys; ignore duplicate deliveries
   - Add `thinking_face` reaction to the triggering message
   - Subscribe to `bus.onAny()` filtered by `sessionId` **before** calling `executeTurn` (same ordering as `server.ts` — avoids missing early events)
   - Call `executeTurn({ sessionId, prompt: message.text })`
   - On completion: remove reaction, post final answer as thread reply
   - On error: remove reaction, post error as thread reply

4. **Event-to-thread streaming** (edit-in-place pattern):
   - Post one "status" message in thread on first relevant event
   - Update it via `chat.update` as new events arrive:
     - `tool.called` → append "Using {toolName}..."
     - `tool.succeeded` / `tool.failed` → append brief result/error
   - Throttle updates: buffer events, call `chat.update` at most once per second (collapse buffered events into single update)
   - Skip noisy events (generation.started/completed, batch.*, memory.*)
   - `agent.answered` → post final answer as a **new** thread reply (not an update to the status message)
   - If final answer > 4000 chars, split into multiple sequential replies

5. **Concurrency & error handling**:
   - `executeTurn` already handles session queuing — no extra locking needed
   - Wrap handler in try/catch with `finally` block for cleanup (unsubscribe from bus, remove reaction)
   - Handle Slack API 429 responses: respect `retry_after` header on `chat.update`/`postMessage`

6. **Package.json script**:
   - Add `"slack": "bun run src/slack.ts"` to scripts

7. **Markdown formatting**:
   - Convert agent markdown to Slack mrkdwn (basic: bold, code blocks, links)
   - Keep it simple — a small `toSlackMarkdown()` helper, not a full converter

## Testing scenarios

- **Unit**: session ID derivation from Slack event payloads (thread_ts handling)
- **Unit**: event-to-Slack-message formatting (tool.called, agent.answered, errors)
- **Unit**: throttle logic (events within 1s window batched into single message)
- **Unit**: markdown conversion (code blocks, bold, links)
- **Unit**: answer splitting at 4000-char boundary (preserves code blocks, doesn't split mid-word)
- **Integration**: manual test — send DM to bot, verify status updates + final answer in thread, verify session continuity
- **Edge case**: two users message simultaneously — events from session A never leak to session B's thread
- **Edge case**: bot @mentioned in a thread — uses existing thread session
- **Edge case**: missing SLACK_BOT_TOKEN — bot does not start, no crash
- **Edge case**: empty/file-only Slack message — ignored gracefully
- **Edge case**: duplicate Slack event delivery — second delivery is no-op
- **Edge case**: final answer > 4000 chars — split into multiple replies
