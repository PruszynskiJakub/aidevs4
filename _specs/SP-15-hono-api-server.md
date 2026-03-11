# SP-15 Hono API Server with Session Management

## Main objective

Expose the agent over HTTP via a Hono server with `/chat` and `/health` endpoints, backed by an in-memory session service that persists conversation history across requests within the same session.

## Context

Today the agent is CLI-only (`bun run agent "prompt"`). `runAgent()` in `src/agent.ts` accepts a prompt string, runs the tool-calling loop, logs everything, and returns `void` — it has no way to return the final answer programmatically, nor does it accept prior conversation history.

There is no web framework in the dependency tree and no session/conversation management. Each agent invocation is fully isolated.

This change is needed to allow external systems (frontends, other agents, task runners) to interact with the agent over HTTP while maintaining multi-turn conversation context.

## Out of scope

- Authentication / authorization on the HTTP endpoints
- Persistent (disk/DB) session storage — sessions live in memory only and are lost on restart
- Streaming responses (SSE / WebSocket) — the endpoint returns the full answer when ready
- Rate limiting or request size limits
- Deploying or containerizing the server

## Constraints

- Runtime: Bun (not Node.js) — Hono must be compatible with Bun
- Must not break the existing CLI entry point (`bun run agent "prompt"`)
- Logging must integrate with the existing `createLogger` + `MarkdownLogger` system — every HTTP-initiated agent run produces a markdown log just like CLI runs
- Concurrent requests to the **same** sessionId must be serialized (queued); different sessions may run in parallel
- All new code follows existing project conventions (services pattern, types in `src/types/`, strict TS)

## Acceptance criteria

- [ ] `bun run server` starts a Hono HTTP server on a configurable port (env `PORT`, default 3000)
- [ ] `POST /chat` accepts `{ sessionId: string, msg: string }`, returns `{ msg: string }` with the agent's final answer
- [ ] Conversation history is maintained per sessionId — subsequent requests in the same session include prior messages
- [ ] `GET /health` returns `200 { status: "ok" }`
- [ ] Requests to the same sessionId are queued (serialized); requests to different sessions execute concurrently
- [ ] Each agent invocation (via HTTP) produces a markdown log in `logs/` identical in format to CLI runs
- [ ] Console logger output appears in the server's stdout
- [ ] Existing CLI entry point (`bun run agent "prompt"`) continues to work unchanged
- [ ] `runAgent` is refactored to accept a messages array and return the final answer string (both CLI and server use this)
- [ ] A dedicated session service manages in-memory session state (create, get, append messages)

## Implementation plan

1. **Refactor `runAgent` signature** — change from `runAgent(userPrompt: string, provider?)` to `runAgent(messages: LLMMessage[], provider?): Promise<string>`. The function returns the assistant's final text answer. Move the CLI arg-parsing / "if main" block to use the new signature (build the initial `[system, user]` messages itself). This keeps CLI working.

2. **Create session types** (`src/types/session.ts`) — define `Session { id: string, messages: LLMMessage[], createdAt: Date, updatedAt: Date }`.

3. **Create session service** (`src/services/session.ts`) — in-memory `Map<string, Session>`. Methods: `getOrCreate(id): Session`, `appendMessage(id, message): void`, `getMessages(id): LLMMessage[]`. Exported as singleton.

4. **Create per-session queue** — either within the session service or as a small utility. Each session gets a promise-chain (similar pattern to `MarkdownLogger`'s `this.chain`). `enqueue(sessionId, fn)` ensures serial execution per session.

5. **Add Hono dependency** — `bun add hono`.

6. **Create server entry point** (`src/server.ts`):
   - Import Hono, session service, `runAgent`, logger, prompt service.
   - `GET /health` → `{ status: "ok" }`.
   - `POST /chat` → validate body (`sessionId`, `msg`), load system prompt, get/create session, append user message, enqueue agent run, append assistant answer, return `{ msg: answer }`.
   - Error handling middleware: catch errors, return `500 { error: message }`.
   - Read `PORT` from `process.env` or default 3000.
   - Log server start.

7. **Add `server` script to package.json** — `"server": "bun run src/server.ts"`.

8. **Logging integration** — inside the `/chat` handler, create a fresh `MarkdownLogger` for each agent run (same as CLI does now) and pass it through to `createLogger`. The console logger already writes to stdout, which is where server logs go.

## Testing scenarios

- **Unit: session service** — create session, append messages, verify retrieval; verify getOrCreate returns existing session on second call.
- **Unit: queue** — enqueue two tasks for same sessionId, verify they run sequentially; enqueue tasks for different sessionIds, verify they run concurrently.
- **Integration: /health** — `GET /health` returns `200 { status: "ok" }`.
- **Integration: /chat** — `POST /chat { sessionId: "s1", msg: "hello" }` returns `200 { msg: "..." }` with a non-empty response.
- **Integration: session continuity** — send two messages with the same sessionId, verify the agent receives conversation history (second response is contextually aware).
- **Integration: missing fields** — `POST /chat {}` returns `400` with error.
- **Manual: CLI unchanged** — run `bun run agent "hello"` and verify it still works end-to-end.
- **Manual: logging** — after an HTTP request, verify a new `logs/log_*.md` file was created with expected structure.
