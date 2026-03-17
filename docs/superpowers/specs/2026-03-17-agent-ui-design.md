# Agent UI with Semantic Streaming Events

## Objective

Build a web UI for the agent system that combines a chat interface with full developer-level visibility into agent execution — streaming plan steps, tool calls with arguments/results, token usage, approval gates, and log file browsing. All driven by semantic events over SSE.

## Context

The agent runs a PLAN+ACT loop (`src/agent.ts`) with parallel tool execution, detailed markdown logging, session management, and per-request assistant selection. Currently the only interfaces are a CLI entry point and a synchronous `POST /chat` HTTP endpoint that returns `{ msg: string }` after the full run completes — no real-time visibility for the client.

A working prototype exists in `playground/semantic_events/` demonstrating the full architecture: typed event system, buffered event emitter with approval gating, Hono SSE endpoint, and an inline HTML UI with plan sidebar, color-coded event cards, and interactive approval buttons.

### Dependencies

- **SP-33 (Logger Redesign)** must be implemented first. It introduces a `Logger` interface, `ConsoleLogger`, refactored `MarkdownLogger`, and `CompositeLogger`. The event system layers on top of SP-33 by adding an `EventEmittingLogger` as a composite target.

### Course alignment

The AI Devs 4 course (S01E01, S01E02) explicitly advocates for semantic event-based architecture over naive text streaming. Key principles incorporated:
- Events carry type, ID, and metadata — enabling grouping, rich rendering, and extensibility
- Destructive actions require UI-level confirmation (buttons, not chat messages)
- Agent Harness includes an observation layer — this UI serves that role

## Architecture

### Event flow

```
agent.ts calls Logger methods (SP-33 interface)
    |
CompositeLogger (SP-33)
    +-- ConsoleLogger      -> terminal output (CLI)
    +-- MarkdownLogger     -> log files (logs/{date}/{session}/)
    +-- EventEmittingLogger -> AgentEventEmitter (NEW)
                                  |
                           AgentEventEmitter (buffered, approval-gating)
                                  |
                            SSE stream -> SvelteKit UI
```

The agent always emits events through the Logger interface. Three renderers consume them:
- **ConsoleLogger** — ANSI-colored terminal output (existing, from SP-33)
- **MarkdownLogger** — persistent log files (existing, from SP-33)
- **EventEmittingLogger** — translates Logger calls into typed `AgentEvent` emissions (new)

The `AgentEventEmitter` buffers all events per session. SSE clients that connect late get the full replay. Future consumers (webhooks, test harnesses, Langfuse) subscribe the same way.

### Agent integration

`runAgent()` receives the `AgentEventEmitter` instance as a new parameter:

```ts
export async function runAgent(
  messages: LLMMessage[],
  options: {
    tools: Tool[];
    model: string;
    emitter: AgentEventEmitter;
    logger: Logger; // CompositeLogger with EventEmittingLogger inside
  }
): Promise<string | null>
```

The agent interacts with the emitter directly in exactly two places:
1. **Session lifecycle** — `agent.ts` emits `session_start` and `session_end` events directly on the emitter (these bookend the entire run and don't map to Logger methods)
2. **Approval gating** — before executing tool calls, agent emits `approval_request` and calls `emitter.waitForApproval(requestId)`, which blocks until the user responds or timeout expires

All other events flow through the Logger interface via `EventEmittingLogger`.

### Approval flow

Sequence:
1. Agent determines tool calls from LLM response
2. Agent emits `ApprovalRequestEvent` directly on emitter (with `requestId`, tool call details)
3. Agent calls `await emitter.waitForApproval(requestId)` — blocks here
4. UI shows Approve/Reject buttons in the event stream
5. User clicks → UI sends `POST /approve/:sessionId { requestId, approved }`
6. Server handler calls `emitter.resolveApproval(requestId, approved)`
7. Emitter emits `ApprovalResponseEvent` and resolves the Promise
8. Agent proceeds based on result:
   - **Approved** — executes tool calls normally
   - **Rejected** — synthesizes error tool results (`"User rejected this tool call."`) for each tool call, continues loop so the LLM can re-plan
   - **Timeout** (default 1 hour) — same as rejection, with reason `"timeout"`

The emitter itself emits the `ApprovalResponseEvent` when `resolveApproval()` is called or on timeout, ensuring the SSE stream always reflects the outcome.

## Event types

Promoted from `playground/semantic_events/types.ts`. Changes from prototype noted inline:

```typescript
interface BaseEvent {
  id: string;        // "evt_{timestamp}_{counter}"
  timestamp: number; // Date.now()
}

SessionStartEvent   { type: "session_start", sessionId, prompt, assistant?: string }
                    // assistant is optional — CLI runs may not specify one
PlanStartEvent      { type: "plan_start", iteration, model }
PlanUpdateEvent     { type: "plan_update", iteration, steps: PlanStep[], durationMs }
ToolCallEvent       { type: "tool_call", iteration, toolName, arguments: string, batchIndex, batchSize }
                    // arguments is JSON-stringified (matches OpenAI tc.function.arguments)
ToolResultEvent     { type: "tool_result", iteration, toolName, status, data: string, hints?, durationMs }
                    // data is JSON-stringified, durationMs is raw milliseconds (number)
ThinkingEvent       { type: "thinking", iteration, content }
MessageEvent        { type: "message", content }
ErrorEvent          { type: "error", message }
TokenUsageEvent     { type: "token_usage", iteration, phase, model, tokens, cumulative }
SessionEndEvent     { type: "session_end", sessionId, totalDurationMs, totalTokens }
ApprovalRequestEvent  { type: "approval_request", iteration, requestId, toolCalls[] }
ApprovalResponseEvent { type: "approval_response", requestId, approved, reason?: "user" | "timeout" }
```

Also promoted from playground: `parsePlanSteps(planText: string): PlanStep[]` helper (parses numbered steps with `[x]/[>]/[ ]` markers). Used by `EventEmittingLogger` to convert raw plan text into structured step arrays.

### Events emitted directly by agent (not through Logger)

These lifecycle and flow-control events don't map to Logger methods — `agent.ts` emits them directly on the `AgentEventEmitter`:

| Event | When |
|-------|------|
| `session_start` | At the beginning of `runAgent()`, before the loop |
| `session_end` | After the loop completes (or on error), with totals |
| `thinking` | When LLM returns text alongside tool calls (assistant reasoning) |
| `approval_request` | Before tool execution, when approval gating is enabled |
| `approval_response` | Emitted by the emitter itself when approval is resolved/timed out |

### Events emitted through Logger → EventEmittingLogger

The `EventEmittingLogger` maps SP-33 Logger method calls to `AgentEvent` emissions. Because the current Logger method signatures don't carry all fields needed by events (e.g., `iteration`, `model`, `phase`), the `EventEmittingLogger` maintains internal mutable state:

- `currentIteration: number` — set when `step()` is called
- `currentModel: string` — set when `step()` is called (from its `model` parameter)
- `batchSize: number` — set when `toolHeader()` is called
- `batchIndex: number` — incremented on each `toolCall()`, reset on `toolHeader()`
- `cumulativeTokens: { prompt, completion }` — accumulated across iterations

**SP-33 Logger interface implications:** This spec assumes SP-33's final Logger signatures will carry raw numeric durations (milliseconds), not pre-formatted strings. If SP-33 delivers formatted strings (e.g., `"1.23s"`), the `EventEmittingLogger` will need to parse them back — preferably SP-33 should pass raw `number` values and let each Logger implementation format as needed.

| SP-33 Logger method | AgentEvent type | State used |
|---|---|---|
| `step(iter, max, model, msgCount)` | `plan_start` | sets `currentIteration`, `currentModel` |
| `plan(planText, model, elapsed, tokensIn?, tokensOut?)` | `plan_update` + `token_usage` (phase: "plan") | uses `currentIteration`; calls `parsePlanSteps()` |
| `toolHeader(count)` | _(no event)_ | sets `batchSize`, resets `batchIndex` |
| `toolCall(name, rawArgs)` | `tool_call` | increments `batchIndex`; uses `currentIteration`, `batchSize` |
| `toolOk(name, elapsed, rawResult, hints?)` | `tool_result` (status: ok) | uses `currentIteration` |
| `toolErr(name, errorMsg)` | `tool_result` (status: error, durationMs: 0) | uses `currentIteration`; no elapsed available for errors currently |
| `batchDone(elapsed)` | _(no event — derivable from tool_results)_ | — |
| `answer(text)` | `message` | — |
| `llm(elapsed, tokensIn?, tokensOut?)` | `token_usage` (phase: "act") | uses `currentIteration`, `currentModel`; updates `cumulativeTokens` |
| `maxIter()` | `error` (message: "max iterations reached") | — |
| `info/success/error/debug` | _(no-op)_ | — |

## Server changes

### Stream flag

Both entry points support a `stream` toggle:

**CLI:**
```bash
bun run agent "prompt"            # sync — prints final answer
bun run agent "prompt" --stream   # streams events to terminal
```

**HTTP:**
```
POST /chat { msg, sessionId?, assistant?, stream?: boolean }
              // note: prototype used "prompt" — we use "msg" for backward compat

sessionId: optional — if omitted, server generates a UUID v4 (matching SP-30)
           if provided, resumes an existing session
stream: false (default) -> waits for session_end, returns { msg: string, sessionId: string }
stream: true            -> returns SSE event stream (sessionId in first event)
```

The `msg` field name is kept for backward compatibility with the current server. The prototype used `prompt` but we follow existing convention.

The agent always emits events internally. The difference is how the entry point consumes them:
- **Sync mode** — handler subscribes, waits for `session_end`, extracts `message` event content, returns `{ msg, sessionId }`
- **Stream mode** — handler pipes every event as SSE frames immediately. The `session_start` event contains the `sessionId`. Uses `streamSSE` from `hono/streaming`.

When `stream: true`, the session queue (`sessionService.enqueue`) still serializes requests per session, but the response is written as an SSE stream rather than awaited and returned as JSON.

### New routes

All routes are at root level (no `/api` prefix). The SvelteKit frontend proxies all non-asset requests to the Hono backend in development.

| Route                        | Method | Purpose                                       |
|------------------------------|--------|-----------------------------------------------|
| `GET /events/:sessionId`     | GET    | SSE stream with buffer replay + 5s heartbeat  |
| `GET /sessions`              | GET    | List active/completed sessions with status     |
| `POST /approve/:sessionId`   | POST   | Resolve pending approval (requestId, approved) |
| `GET /logs`                  | GET    | Tree of log files grouped by date/session      |
| `GET /logs/:date/:sid/:file` | GET    | Raw markdown content of a log file             |

**`GET /sessions` response shape** (matching prototype):
```json
{
  "sessions": [
    { "id": "string", "ended": false, "hasPendingApproval": true, "eventCount": 42 }
  ]
}
```

### Session unification

The current `sessionService` stores messages. The emitter stores events. These merge: one session object holds both the LLM message history and the `AgentEventEmitter`.

## Frontend

### Stack

SvelteKit app in `ui/` at project root. Vite dev server proxies all non-asset requests to Hono backend on port 3000 (from config `server.port`).

### Structure

```
ui/
  src/
    lib/
      stores/
        session.ts          # current session state, event buffer
        sessions.ts         # session list from GET /sessions
      components/
        ChatInput.svelte
        EventStream.svelte
        PlanSidebar.svelte
        EventCard.svelte
        ToolCallCard.svelte
        ApprovalCard.svelte
        TokenCounter.svelte
        SessionList.svelte
        LogViewer.svelte
      sse.ts                # EventSource wrapper, reconnection
      types.ts              # re-exports from shared event types
    routes/
      +page.svelte          # single-page app
    app.html
  svelte.config.js
  vite.config.ts
  package.json
```

### Layout

Three-panel layout:

```
+----------------------------------------------------------+
|  Header: token counter | elapsed timer | assistant name  |
+--------+--------------------------------+----------------+
|        |                                |                |
|Sessions|       Event Stream             |    Plan        |
| / Logs |                                |   Sidebar      |
|        |  > Session Start               |                |
| * s1   |  Planning (iter 1)             |  done  Step 1  |
| * s2   |  Plan Updated                  |  curr  Step 2  |
|        |  Approve Tool Calls?           |  pend  Step 3  |
|  Logs  |    [Approve] [Reject]          |                |
|  03-17 |  tool_call: agents_hub         |                |
|   ses1 |    > Arguments                 |                |
|   ses2 |  tool_result: ok (1.2s)        |                |
|        |    > Result                    |                |
|        |  Answer: The answer is...      |                |
|        |                                |                |
+--------+--------------------------------+----------------+
|  [Enter a prompt...]          [assistant v]    [Run >]   |
+----------------------------------------------------------+
```

**Panels:**
- **Sessions/Logs sidebar** (left, collapsible) — two tabs. Sessions tab lists active/completed sessions with pending-approval indicator. Logs tab shows a file tree of markdown logs grouped by date and session. Click a log to view rendered markdown in center panel.
- **Event stream** (center) — color-coded event cards. Tool args/results collapsed by default, expandable. Auto-scrolls unless user scrolls up.
- **Plan sidebar** (right, collapsible) — latest plan checklist, updates live. Sticky — always shows current plan regardless of event stream scroll position.
- **Input bar** (bottom) — prompt input, assistant dropdown, run button. Disabled while session is running.

**Responsive:** sidebars collapse to icons on narrow screens. Plan sidebar can overlay as slide-out.

### Key behaviors

- **SSE connection** — on session start, connects to `GET /events/:sessionId`. Buffer replay ensures late connections see full history.
- **Approval interaction** — approval cards show Approve/Reject buttons. Click sends `POST /approve/:sessionId`. Buttons disable after click. Already-resolved approvals render as resolved on replay.
- **Session reconnection** — current session ID stored in localStorage. On page reload, reconnects if session is still active.
- **Markdown rendering** — agent `message` events rendered through a markdown library, not plain `pre-wrap`.
- **Log viewer** — clicking a log file in the sidebar switches center panel from live event stream to rendered markdown view. "Back to live" button returns to event stream.

## File changes

### New files

| File | Description |
|------|-------------|
| `src/types/events.ts` | AgentEvent union type, BaseEvent, PlanStep, helpers |
| `src/services/event-emitter.ts` | Buffered AgentEventEmitter with approval gating |
| `src/services/event-emitting-logger.ts` | `implements Logger`, maps Logger calls to AgentEvents |
| `ui/` | Entire SvelteKit frontend |

### Modified files

| File | Change |
|------|--------|
| `src/agent.ts` | Add EventEmittingLogger to CompositeLogger targets, add approval gating call |
| `src/server.ts` | Add SSE, sessions, approve, logs routes; add stream flag to /chat |
| `src/services/session.ts` | Extend session to hold AgentEventEmitter alongside messages |

### Unchanged

- All tools, schemas, prompts, config, dispatcher — untouched
- `playground/semantic_events/` — stays as reference
- SP-33 logger classes — used as-is, not modified

### Note on SP-33 interface design

This spec has implications for SP-33's `Logger` interface design. For `EventEmittingLogger` to work cleanly:
- Duration/elapsed parameters should be raw `number` (milliseconds), not pre-formatted strings
- `step()` should include `model` and `iteration` parameters
- `plan()` should include token usage so `EventEmittingLogger` can emit a `token_usage` event alongside `plan_update`
- `toolCall()` does not need `batchIndex`/`batchSize` — `EventEmittingLogger` derives these from `toolHeader(count)` + internal counter

Note: the current `duration()` helper returns a formatted string (e.g., `"1.23s"`), not a raw number. SP-33 renames it to `elapsed()` but does not explicitly commit to changing the return type. If SP-33 keeps string returns, `EventEmittingLogger` must parse them back to milliseconds.

If SP-33 is implemented before this spec, these needs should be communicated. If SP-33's final signatures differ, `EventEmittingLogger` adapts — the event types remain stable.

## Out of scope

- File/content previews (deferred)
- Session persistence across server restarts (in-memory is fine)
- WebSocket support (SSE is sufficient)
- Authentication/authorization
- Mobile-optimized layout
- Multi-user support
