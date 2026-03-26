# SP-53 Event Bus

## Main objective

Introduce a typed, synchronous, in-process event bus that decouples event
producers (agent loop, tool dispatch, memory) from consumers (loggers, JSONL
persistence, future streaming/agent-communication layers).

## Context

The current architecture has no event abstraction. State changes during agent
execution (turn started, tool called, memory observed, etc.) are communicated
exclusively through direct `Logger` method calls. This creates several
problems:

**Tight coupling.** The agent loop calls `log.toolCall()` directly. Adding a
new consumer (JSONL writer, WebSocket streamer, metrics collector) means
touching `CompositeLogger` or adding yet another forwarding layer.

**No machine-readable audit trail.** The markdown log is human-readable but
not programmatically queryable. There is no structured event stream for replay,
cost accounting, or automated analysis.

**No foundation for multi-agent coordination.** Agent-to-agent communication,
heartbeat orchestration, and human-in-the-loop patterns all need a pub/sub
mechanism. Without it, every future feature must invent its own ad-hoc
signaling.

**Logger conflation.** The `Logger` interface mixes two concerns: domain events
("a tool was invoked") and presentation ("render this to the console"). The bus
separates these — domain events are emitted, consumers decide how to render.

### Design review (3 iterations)

The initial design proposed sync emit with async-queued side-effects, 1:1
mapping from logger methods to events, session-scoped JSONL files, stringly-
typed `emit<T>(type: string, data: T)`, and a `once()` returning a bare
Promise. All were rejected after review:

1. **Sync dispatch, period.** The bus calls listeners synchronously in
   registration order. Listeners that need async I/O (JSONL, WebSocket) manage
   their own internal buffer/queue. The bus never awaits, never queues.
2. **Domain events, not renamed logger methods.** Events represent state
   transitions (tool invoked, turn ended), not rendering instructions. The
   logger subscribes to events and renders — it is a consumer, not a peer.
3. **Global bus, events carry sessionId.** The bus is a process-wide singleton.
   Persistence listeners decide how to split files. This supports cross-session
   coordination by design.
4. **Typed event map.** Compile-time safety on emit and subscribe via
   `keyof EventMap` generics. No stringly-typed dispatch.
5. **No `once()`.** Build with `on()` + manual unsubscribe when needed. Avoids
   leaked promises.
6. **No buffered JSONL.** Current throughput is low. Append-per-event is fine.
   Buffering can be added inside the listener later without changing the bus.

## Out of scope

- Task DAG, dependency resolution, heartbeat coordinator (future spec)
- WebSocket/SSE streaming transport (future spec — bus design supports it)
- Agent-to-agent messaging protocol (future spec — bus is the transport)
- Log rotation, cleanup, or compression
- Changes to existing `Logger` interface or `CompositeLogger` (kept as-is)

## Constraints

- No new runtime dependencies
- Must not alter data flowing through the agent loop
- Must not break existing logger tests or behavior
- Bus must be usable without JSONL persistence (listeners are optional)
- Event emission must have negligible overhead (~microseconds, no I/O in
  the hot path)

## Architecture

### Data flow

```
loop.ts / orchestrator.ts / processor.ts
           │
           │  bus.emit("turn.began", {...})
           ▼
     ┌─ EventBus (singleton) ─────────────────────┐
     │  synchronous dispatch to all listeners      │
     └─────┬──────────────────────┬────────────────┘
           │                      │
     exact listeners         onAny listeners
           │                      │
  ┌────────▼────────┐    ┌───────▼────────┐
  │ Rendering        │    │ JSONL Writer    │
  │ Listener         │    │ (appends to     │
  │ (Bus→Logger)     │    │  events.jsonl)  │
  └────────┬─────────┘    └────────────────┘
           │
    CompositeLogger
     ┌─────┴─────┐
  Console    Markdown
  Logger     Logger
```

The agent loop and memory processor emit domain events directly on the bus.
Two subscribers consume them:

1. **Rendering listener** (`bridge.ts`) — subscribes to specific event types
   via `bus.on()`, translates each into `Logger` method calls
   (e.g., `turn.began` → `log.step()`). The `Logger` is a `CompositeLogger`
   wrapping `ConsoleLogger` + `MarkdownLogger`.

2. **JSONL writer** (`jsonl.ts`) — subscribes via `bus.onAny()`, serialises
   each event as a single JSON line, appends to `events.jsonl`. Strips large
   rendering-only fields (`fullText`, `result`) to keep JSONL compact.

### Event envelope

```typescript
interface BusEvent<T = unknown> {
  id: string;                // UUID v4
  type: string;              // dot-namespaced key from EventMap
  ts: number;                // epoch ms (Date.now())
  sessionId?: string;        // from AsyncLocalStorage context, if available
  correlationId?: string;    // links related events across turns/agents
  data: T;
}
```

- `id` uses `crypto.randomUUID()`.
- `ts` is epoch ms — fast to produce, sortable, convertible to ISO on read.
- `correlationId` is optional. Set by the heartbeat coordinator or agent
  communication layer when those exist. Ignored until then.
- `sessionId` is auto-populated from `AsyncLocalStorage` context on emit.

### EventMap — typed event registry

Events represent **domain state transitions**, not logging calls. The key
question for each event is: "what just changed in the system's state?" — not
"what should the console print?".

Design principles:
- **One event per state transition.** A turn entering its planning phase is a
  transition. The LLM returning tokens is an observation *about* that phase,
  carried as data on the phase event — not a separate event.
- **Events are facts, not instructions.** `session.opened` says a session now
  exists. It doesn't say "render a header." Consumers decide what to do.
- **Carry enough context to be self-contained.** A consumer reading the JSONL
  should reconstruct what happened without cross-referencing other data.
- **Only events the system actually produces today.** No speculative events
  for features that don't exist yet. Extend the map when the feature lands.
- **Events carry rendering data for consumers.** Some events include fields
  like `fullText` and `result` that are needed by the rendering listener but
  stripped from JSONL persistence.

```typescript
interface EventMap {
  // ── Session ──────────────────────────────────────────────
  "session.opened":    { assistant: string; model: string };
  "session.closed":    { reason: "answer" | "max_iterations" | "error";
                         iterations: number;
                         tokens: { plan: TokenPair; act: TokenPair } };

  // ── Turn ─────────────────────────────────────────────────
  "turn.began":        { iteration: number; maxIterations: number;
                         model: string; messageCount: number };
  "turn.acted":        { toolCount: number; durationMs: number;
                         tokensIn: number; tokensOut: number };
  "turn.ended":        { iteration: number;
                         outcome: "continue" | "answer" | "max_iterations" };

  // ── Planning ─────────────────────────────────────────────
  "plan.produced":     { model: string; durationMs: number;
                         tokensIn: number; tokensOut: number;
                         summary: string;      // first ~200 chars (persisted)
                         fullText: string };    // full plan (rendering only, stripped from JSONL)

  // ── Tool execution ───────────────────────────────────────
  "tool.dispatched":   { callId: string; name: string; args: string;
                         batchIndex: number; batchSize: number };
  "tool.completed":    { callId: string; name: string;
                         ok: boolean; durationMs: number;
                         result?: string;      // XML result (rendering only, stripped from JSONL)
                         error?: string };
  "batch.completed":   { count: number; durationMs: number;
                         succeeded: number; failed: number };

  // ── Agent answer ─────────────────────────────────────────
  "agent.answer":      { text: string | null };

  // ── Memory ───────────────────────────────────────────────
  "memory.compressed": { phase: "observation" | "reflection";
                         level?: number;
                         tokensBefore: number; tokensAfter: number };

  // ── Moderation ───────────────────────────────────────────
  "input.moderated":   { flagged: boolean; categories?: string[] };
}

type TokenPair = { promptTokens: number; completionTokens: number };
```

**Why this shape, not the logger shape:**

| Logger call | Why it's NOT a separate event |
|---|---|
| `log.step()` | → `turn.began` — same transition, semantic name |
| `log.llm()` | → data on `turn.acted` — the LLM responding is not a transition, it's how the act phase completed |
| `log.plan()` | → `plan.produced` — the plan existing is a fact, not "log this plan text" |
| `log.toolHeader()` | → derived from `tool.dispatched` batchIndex/batchSize — the rendering listener calls `log.toolHeader()` when batchIndex === 0 |
| `log.toolCall()` | → `tool.dispatched` — the agent decided to use a capability |
| `log.toolOk/Err()` | → `tool.completed` with `ok` flag — one event, one transition |
| `log.batchDone()` | → `batch.completed` with success/fail counts — richer than just count+elapsed |
| `log.answer()` | → `agent.answer` — the agent produced a final answer |
| `log.maxIter()` | → `session.closed` with reason "max_iterations" |
| `log.memoryObserve/Reflect()` | → `memory.compressed` with phase discriminator — one concept, one event |

**Extending the map:** New event types are added by extending this interface
when the feature that produces them is implemented. Consumers that don't
recognize an event type simply ignore it.

### Bus interface

```typescript
type EventType = keyof EventMap;
type Listener<K extends EventType> = (event: BusEvent<EventMap[K]>) => void;
type WildcardListener = (event: BusEvent) => void;

interface EventBus {
  emit<K extends EventType>(type: K, data: EventMap[K]): void;
  on<K extends EventType>(type: K, listener: Listener<K>): () => void;
  onAny(listener: WildcardListener): () => void;
  off<K extends EventType>(type: K, listener: Listener<K>): void;
  offAny(listener: WildcardListener): void;
  clear(): void;   // remove all listeners (for tests)
}
```

- `emit()` builds the envelope (id, ts, sessionId from context), then calls
  exact-match listeners for `type`, then all wildcard listeners. Synchronous.
  Each listener call is wrapped in try-catch — a failing listener logs to
  stderr and does not block other listeners.
- `on()` returns an unsubscribe function for convenience.
- `onAny()` receives every event. Used by JSONL writer and future transports.
- `clear()` is for test teardown only.

### Subscription model

Two tiers only — **exact match** and **wildcard (`onAny`)**:

- Exact: `on('tool.dispatched', fn)` — called only for `tool.dispatched`.
- Wildcard: `onAny(fn)` — called for every event.

Prefix/glob matching (e.g., `on('tool.*')`) is intentionally omitted. It adds
complexity for no current use case. If needed later, it can be added as
`onPrefix(prefix: string, listener)` without breaking existing API.

### Rendering listener (Bus → Logger)

```typescript
function attachLoggerListener(bus: EventBus, log: Logger): () => void;
```

Subscribes to domain events on the bus and translates them into `Logger`
method calls. The `Logger` is typically a `CompositeLogger` wrapping console
and markdown targets.

| Event | Logger call(s) |
|---|---|
| `session.opened` | `log.info(...)` |
| `session.closed` (max_iterations) | `log.maxIter(iterations)` |
| `turn.began` | `log.step(iteration, max, model, msgCount)` |
| `turn.acted` | `log.llm(elapsed, tokensIn, tokensOut)` |
| `plan.produced` | `log.plan(fullText, model, elapsed, tokensIn, tokensOut)` |
| `tool.dispatched` (batchIndex=0) | `log.toolHeader(batchSize)` then `log.toolCall(name, args)` |
| `tool.dispatched` (batchIndex>0) | `log.toolCall(name, args)` |
| `tool.completed` (ok) | `log.toolOk(name, elapsed, result)` |
| `tool.completed` (!ok) | `log.toolErr(name, error)` |
| `batch.completed` | `log.batchDone(count, elapsed)` |
| `agent.answer` | `log.answer(text)` |
| `memory.compressed` (observation) | `log.memoryObserve(before, after)` |
| `memory.compressed` (reflection) | `log.memoryReflect(level, before, after)` |

Returns a detach function that unsubscribes all listeners (used in `finally`
blocks for cleanup).

### JSONL persistence listener

```typescript
function createJsonlWriter(pathFn?): JsonlWriter;
```

- Subscribes via `bus.onAny()`.
- `pathFn` maps event → file path. Default:
  `logs/{YYYY-MM-DD}/{sessionId}/events.jsonl`.
  Events without `sessionId` go to `logs/{YYYY-MM-DD}/_global/events.jsonl`.
- Strips large rendering-only fields before serialising: `fullText` from
  `plan.produced`, `result` from `tool.completed`. These are only needed by
  the rendering listener, not for structured audit.
- Writes are chained internally so ordering is preserved without blocking
  the bus.
- Exposes `flush(): Promise<void>` for graceful shutdown and `dispose()` to
  detach the `beforeExit` handler.

### JSONL line format

```jsonl
{"id":"...","type":"turn.began","ts":1711353600000,"sid":"abc123","data":{"iteration":1,"maxIterations":40,"model":"gpt-4.1","messageCount":3}}
{"id":"...","type":"plan.produced","ts":1711353600800,"sid":"abc123","data":{"model":"gpt-4.1","durationMs":780,"tokensIn":2100,"tokensOut":340,"summary":"1. Search for API docs..."}}
{"id":"...","type":"tool.dispatched","ts":1711353601000,"sid":"abc123","data":{"callId":"call_abc","name":"web_search","args":"{}","batchIndex":0,"batchSize":1}}
{"id":"...","type":"tool.completed","ts":1711353602200,"sid":"abc123","data":{"callId":"call_abc","name":"web_search","ok":true,"durationMs":1200}}
{"id":"...","type":"turn.ended","ts":1711353602300,"sid":"abc123","data":{"iteration":1,"outcome":"continue"}}
```

Fields: `id`, `type`, `ts`, `sid` (shortened sessionId key for compactness),
`cid` (correlationId, omitted when null), `data`. One JSON object per line,
no pretty-printing. Large fields (`fullText`, `result`) stripped.

### Event emission sites

Events are emitted directly by the code that performs the state transition:

| Emit site | Events emitted |
|---|---|
| `loop.ts` — `runAgent()` | `session.opened`, `session.closed`, `turn.began`, `turn.ended`, `agent.answer` |
| `loop.ts` — `executePlanPhase()` | `plan.produced` |
| `loop.ts` — `executeActPhase()` | `turn.acted` |
| `loop.ts` — `dispatchTools()` | `tool.dispatched`, `tool.completed`, `batch.completed` |
| `memory/processor.ts` | `memory.compressed` |

The memory processor no longer receives a `Logger` parameter — it imports the
bus singleton directly and emits events.

### File layout

```
src/infra/
  events.ts              # EventBus implementation + singleton + createEventBus()
  events.test.ts         # Bus unit tests
  log/
    jsonl.ts             # JSONL persistence listener (onAny subscriber)
    jsonl.test.ts
    bridge.ts            # Rendering listener (Bus → Logger)
    bridge.test.ts
    console.ts           # (existing, unchanged)
    markdown.ts          # (existing, unchanged)
    composite.ts         # (existing, unchanged)
src/types/
  events.ts              # EventMap, BusEvent, EventBus interfaces
  logger.ts              # (existing, unchanged)
```

### Wiring (in loop.ts setupSession)

```typescript
import { bus } from "../infra/events.ts";
import { createJsonlWriter } from "../infra/log/jsonl.ts";
import { attachLoggerListener } from "../infra/log/bridge.ts";

// Console + Markdown for human output
const log = createCompositeLogger([new ConsoleLogger(), md]);

// Rendering listener: bus events → log.step(), log.toolCall(), etc.
const detachLogger = attachLoggerListener(bus, log);

// JSONL persistence: bus events → events.jsonl
const jsonl = createJsonlWriter();
const detachJsonl = bus.onAny(jsonl.listener);

// In finally block:
detachLogger();
detachJsonl();
await Promise.all([md.flush(), jsonl.flush()]);
```

## Extensibility paths (not implemented in this spec)

These are the patterns the bus is designed to support in future specs:

**Streaming (SSE/WebSocket):** A transport listener subscribes via `onAny()`,
buffers events, and flushes over a connection. High-frequency events (e.g.,
token-by-token streaming) are handled by the listener's internal buffer — the
bus is unaffected.

**Agent-to-agent communication:** Agent A emits domain events. Agent B
subscribes to specific event types. The bus is the mediator. A future
`agent.message` event type with `targetAgentId` in data enables directed
messaging.

**Heartbeat coordinator:** Subscribes to `turn.ended` and `tool.completed`
to track progress. Emits `heartbeat.started` / `heartbeat.finished`. The bus
carries both inner (agent) and outer (coordinator) events.

**Metrics/cost tracking:** A listener subscribes to `turn.acted` and
`session.closed`, aggregates token counts and durations, exposes via an
endpoint or writes to a metrics file.

**Replay/debugging:** Read the JSONL file, filter by sessionId or
correlationId, replay events through any listener for post-hoc analysis.

## Acceptance criteria

- [x] `EventMap` interface in `src/types/events.ts` defines all event types
- [x] `BusEvent<T>` envelope includes `id`, `type`, `ts`, `sessionId?`, `correlationId?`, `data`
- [x] `EventBus` implementation in `src/infra/events.ts` supports `emit`, `on`, `onAny`, `off`, `offAny`, `clear`
- [x] `emit()` is synchronous — no awaits, no I/O in the dispatch path
- [x] Failing listeners do not block other listeners (try-catch per listener)
- [x] `emit()` populates `sessionId` from `AsyncLocalStorage` context automatically
- [x] Agent loop emits domain events directly on the bus (not through logger)
- [x] Memory processor emits `memory.compressed` directly on the bus
- [x] Rendering listener (`attachLoggerListener`) subscribes to bus events and translates to `Logger` method calls
- [x] JSONL listener appends one JSON line per event to `logs/{date}/{sessionId}/events.jsonl`
- [x] JSONL listener strips large rendering-only fields (`fullText`, `result`)
- [x] JSONL listener exposes `flush()` and `dispose()`
- [x] `bus.clear()` removes all listeners (for test isolation)
- [x] All new code has tests: bus core (12), JSONL listener (4), rendering listener (11)
- [x] `events.jsonl` lines are valid JSON, one per line, parseable with `JSON.parse()`
- [x] No existing tests broken (399 pass, 0 fail)
