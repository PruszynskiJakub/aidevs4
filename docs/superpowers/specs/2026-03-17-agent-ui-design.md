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

### Approval gating

Approval is the one operation that doesn't fit the Logger interface — it's flow control, not logging. The agent calls `emitter.waitForApproval(requestId)` directly, which returns a Promise that resolves when the user clicks Approve/Reject in the UI (or times out). This is the only place `agent.ts` touches the emitter directly.

## Event types

Promoted from `playground/semantic_events/types.ts` with one addition (`assistant` field on `SessionStartEvent`):

```typescript
interface BaseEvent {
  id: string;        // "evt_{timestamp}_{counter}"
  timestamp: number; // Date.now()
}

SessionStartEvent   { type: "session_start", sessionId, prompt, assistant }
PlanStartEvent      { type: "plan_start", iteration, model }
PlanUpdateEvent     { type: "plan_update", iteration, steps: PlanStep[], durationMs }
ToolCallEvent       { type: "tool_call", iteration, toolName, arguments, batchIndex, batchSize }
ToolResultEvent     { type: "tool_result", iteration, toolName, status, data, hints?, durationMs }
ThinkingEvent       { type: "thinking", iteration, content }
MessageEvent        { type: "message", content }
ErrorEvent          { type: "error", message }
TokenUsageEvent     { type: "token_usage", iteration, phase, model, tokens, cumulative }
SessionEndEvent     { type: "session_end", sessionId, totalDurationMs, totalTokens }
ApprovalRequestEvent  { type: "approval_request", iteration, requestId, toolCalls[] }
ApprovalResponseEvent { type: "approval_response", requestId, approved, reason? }
```

### Logger method to event mapping

| SP-33 Logger method          | AgentEvent type               |
|------------------------------|-------------------------------|
| `step(iteration)`            | `plan_start`                  |
| `plan(iteration, text)`      | `plan_update`                 |
| `toolHeader(count)`          | _(absorbed into tool_call batch fields)_ |
| `toolCall(name, args, i, n)` | `tool_call`                   |
| `toolOk(name, result, dur)`  | `tool_result` (status: ok)    |
| `toolErr(name, error, dur)`  | `tool_result` (status: error) |
| `batchDone(duration)`        | _(derivable from tool_results, no separate event)_ |
| `answer(text)`               | `message`                     |
| `llm(model, usage)`          | `token_usage`                 |
| `maxIter()`                  | `error` (max iterations)      |
| `info/success/error/debug`   | _(no-op in EventEmittingLogger — operational, not lifecycle)_ |

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
POST /chat { msg, sessionId, assistant?, stream?: boolean }

stream: false (default) -> waits for session_end, returns { msg: string }
stream: true            -> returns SSE event stream
```

The agent always emits events internally. The difference is how the entry point consumes them:
- **Sync mode** — handler subscribes, waits for `session_end`, extracts `message` event content, returns it
- **Stream mode** — handler pipes every event as SSE frames immediately

### New routes

| Route                        | Method | Purpose                                       |
|------------------------------|--------|-----------------------------------------------|
| `GET /events/:sessionId`     | GET    | SSE stream with buffer replay + 5s heartbeat  |
| `GET /sessions`              | GET    | List active/completed sessions with status     |
| `POST /approve/:sessionId`   | POST   | Resolve pending approval (requestId, approved) |
| `GET /logs`                  | GET    | Tree of log files grouped by date/session      |
| `GET /logs/:date/:sid/:file` | GET    | Raw markdown content of a log file             |

### Session unification

The current `sessionService` stores messages. The emitter stores events. These merge: one session object holds both the LLM message history and the `AgentEventEmitter`.

## Frontend

### Stack

SvelteKit app in `ui/` at project root. Vite dev server proxies `/api/*` to Hono backend on port 3000.

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

## Out of scope

- File/content previews (deferred)
- Session persistence across server restarts (in-memory is fine)
- WebSocket support (SSE is sufficient)
- Authentication/authorization
- Mobile-optimized layout
- Multi-user support
