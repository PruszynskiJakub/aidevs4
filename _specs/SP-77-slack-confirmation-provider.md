# SP-77 Slack Confirmation Provider

## Main objective

Add a `ConfirmationProvider` for the Slack entry point so that tool calls flagged with `confirmIf` present interactive BlockKit buttons in the Slack thread, allowing users to approve or deny actions directly from Slack.

## Context

The confirmation gate (SP-76) is fully implemented. `confirmBatch()` in `src/agent/confirmation.ts` intercepts tool calls, emits `confirmation.requested`/`confirmation.resolved` events, and delegates to a pluggable `ConfirmationProvider`. Two providers exist today:

- **CLI** (`src/cli.ts`): readline prompt — works for terminal sessions.
- **HTTP** (`src/server.ts`): stores a pending promise keyed by sessionId; resolved via `POST /chat/:sessionId/confirm` — works for the web/API client.

The Slack bot (`src/slack.ts`) currently has **no confirmation provider**. Any tool with `confirmIf` will either use a fallback (if one is registered globally) or fail. The Slack bot needs its own provider that leverages Slack's native interactive components (BlockKit buttons) so operators can approve or deny destructive tool calls without leaving Slack.

### Current Slack bot characteristics

- Message-only — no interactive components, no `app.action()` handlers.
- Session IDs derived from thread context (`slack-{teamId}-{channelId}-{threadTs}`).
- Status updates posted via throttled message updater during agent execution.
- Event bus subscriber already captures tool lifecycle events per session.

## Out of scope

- Changing the core `confirmBatch()` logic or `ConfirmationProvider` interface.
- Adding new tools or new `confirmIf` predicates — existing tool annotations are unchanged.
- Slack modal dialogs or Slack shortcuts — buttons in the thread are sufficient.
- Multi-user approval (e.g., require 2 approvals) — single user approval only.
- Confirmation UI for the web/API client (already handled by HTTP provider).

## Constraints

- Must implement the existing `ConfirmationProvider` interface — no changes to the core confirmation module.
- Slack API rate limits: avoid posting more than 1 message per second. Batch multiple pending calls into a single BlockKit message where possible.
- Slack interactive payloads require a registered Request URL or Socket Mode — the current bot uses Socket Mode (`@slack/bolt`), so `app.action()` handlers are available without additional infrastructure.
- Timeout behaviour: auto-deny after a configurable period (default 120s), matching the HTTP provider pattern.
- BlockKit button payloads are limited to 2000 characters — keep `action_id` and `value` fields compact.

## Acceptance criteria

- [ ] A `SlackConfirmationProvider` class implements `ConfirmationProvider` from `src/agent/confirmation.ts`.
- [ ] When `confirm()` is called during a Slack session, the provider posts a BlockKit message in the active thread with tool call details and Approve / Deny buttons for each flagged call.
- [ ] Clicking Approve resolves that call's decision as `"approve"`; clicking Deny resolves as `"deny"`.
- [ ] If multiple tool calls need confirmation in a single batch, they appear in one message with per-call button pairs.
- [ ] After all decisions in a batch are collected, the confirmation message is updated to reflect the outcome (e.g., strikethrough or status emoji) and buttons are removed.
- [ ] Auto-deny triggers after 120s (configurable) if the user doesn't respond. The message is updated to indicate timeout.
- [ ] The provider is registered in `src/slack.ts` at bot startup, scoped to the Slack entry point (does not affect CLI or HTTP providers).
- [ ] Existing tool execution flow is unchanged — only the provider injection point in `src/slack.ts` is new code outside the provider itself.

## Implementation plan

1. **Create `src/slack-confirmation.ts`** — new file containing `SlackConfirmationProvider`:
   - Constructor takes the Slack `App` instance and registers regex-based action handlers (see step 2).
   - Maintains two maps:
     - `threadContexts: Map<sessionId, { channel, threadTs }>` — populated per turn by `setThreadContext()`.
     - `pendingBatches: Map<sessionId, PendingConfirmation>` — holds the `resolve` function, timeout handle, per-call decisions, and Slack message reference (channel + ts) for later update.
   - `setThreadContext(sessionId, { channel, threadTs })` — called by `handleMessage` in `src/slack.ts` before each `executeTurn()`, so the provider knows which thread to post to. Cleaned up on session end.
   - `confirm(requests)` method:
     - Retrieves sessionId via `requireState()` from `src/agent/context.ts` (same pattern as the HTTP provider).
     - Looks up thread context from `threadContexts` map. If missing, auto-denies all calls and logs error.
     - Builds a BlockKit message with a section per tool call (tool name, truncated args) and two buttons (Approve / Deny) per call.
     - Posts the message to the thread.
     - Returns a promise that resolves when all calls in the batch have decisions or timeout fires.
   - Timeout handler: auto-denies all remaining undecided calls, updates the Slack message.

2. **Register regex-based `app.action()` handlers** in the constructor:
   - Two handlers registered once: `app.action(/^confirm_approve_/, ...)` and `app.action(/^confirm_deny_/, ...)`.
   - `action_id` format: `confirm_approve_{callId}` / `confirm_deny_{callId}`. CallIds are extracted from the action_id at runtime.
   - On click: acknowledge (`ack()`), look up the pending batch, record the decision. Ignore duplicate clicks (idempotent).
   - When all calls in the batch are decided, resolve the promise and update the message.

3. **Wire up in `src/slack.ts`**:
   - Import and instantiate `SlackConfirmationProvider` after creating the Slack `App`.
   - Call `setConfirmationProvider(provider)` once at startup.
   - In `handleMessage`, call `provider.setThreadContext(sessionId, { channel: channelId, threadTs: replyThread })` before `executeTurn()`. Clean up context after turn completes.

4. **Message update on resolution**:
   - Replace buttons with a summary line: "✓ Approved" or "✗ Denied" or "⏱ Timed out" per call.
   - Use `chat.update` to modify the original BlockKit message in-place.

5. **Edge cases**:
   - If the Slack message fails to post (e.g., channel archived), auto-deny all calls and log the error.
   - If the bot restarts mid-confirmation, pending promises are lost — auto-deny via timeout is the safety net.
   - Duplicate button clicks (Slack retries) — idempotent; ignore if decision already recorded.

## Testing scenarios

| Scenario | How to verify |
|---|---|
| Single tool call needing approval | Send a message that triggers `web__scrape`. Verify BlockKit message appears with Approve/Deny buttons. Click Approve → tool executes. |
| Single tool call denied | Same setup, click Deny → agent receives "Tool call denied by operator" error. |
| Batch of 2+ tool calls | Trigger multiple confirmable calls in one turn. Verify single message with button pairs per call. Approve one, deny another → correct routing. |
| Timeout auto-deny | Trigger confirmable call, wait 120s without clicking. Verify message updates to "Timed out" and agent receives denial. |
| Message update after decision | After clicking Approve/Deny, verify the BlockKit message is updated: buttons removed, status shown. |
| Duplicate click handling | Click Approve twice rapidly. Verify no error and decision is recorded only once. |
| Post failure fallback | Simulate message post failure (e.g., invalid channel). Verify auto-deny and error logged. |
| No confirmable calls | Normal tool execution without `confirmIf` tools. Verify no BlockKit messages posted — zero overhead. |
