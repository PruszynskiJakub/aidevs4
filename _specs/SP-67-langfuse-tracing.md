# SP-67 Langfuse Tracing

## Main objective

Add Langfuse observability to the agent system via a new event bus subscriber,
providing nested traces for agent runs, LLM generations, and tool executions —
without changing existing logging behavior. Along the way, consolidate
LLM-related events into generic `generation.started`/`generation.completed`
(replacing `plan.produced` and `turn.acted`) and split `memory.compressed`
into `memory.observation`/`memory.reflection` per the project's
"dedicated events over boolean flags" convention.

## Context

The agent system has a typed event bus (SP-53) with two subscribers: a rendering
bridge (console + markdown) and a JSONL persistence writer. The bus emits domain
events for session lifecycle, turns, planning, tool dispatch, memory, and
moderation. This architecture was designed for exactly this kind of extension —
a new subscriber that translates domain events into external traces.

**What's missing today:**

1. **No unified LLM generation event.** `plan.produced` and `turn.acted` carry
   token counts and durations but not the actual messages sent to/from the LLM.
   Langfuse generations need full input/output for display and evaluation.
   These two events also overlap conceptually — both represent an LLM call
   completion but use different shapes and names.

2. **`memory.compressed` violates the "dedicated events" convention.**
   It uses `phase: "observation" | "reflection"` as a boolean discriminator,
   forcing subscribers to branch. The bridge already calls different log
   methods per phase. Should be two events: `memory.observation` and
   `memory.reflection`.

3. **No agent identity on events.** The `BusEvent` envelope carries only
   `sessionId`. There is no `agentId`, `parentAgentId`, `traceId`, or `depth`.
   The delegate tool creates a separate session with no parent link — child
   agent events are completely disconnected.

4. **`session.closed` never emitted on error.** If `runAgent` throws, the
   `finally` block does cleanup but no error event fires. The `reason: "error"`
   case in the type definition is dead code.

5. **Tool events lack timing and input context.** `tool.dispatched` has no
   `startTime`. `tool.succeeded`/`tool.failed` have no `args` (only the name
   and result/error).

**Dependencies already installed:** `@langfuse/tracing@^5`, `@langfuse/otel@^5`,
`@opentelemetry/sdk-node@^0.214`.

**Langfuse v5 API** (verified via docs):
```typescript
import { startObservation, propagateAttributes } from "@langfuse/tracing";
import { LangfuseSpanProcessor } from "@langfuse/otel";

// Wrap root observation with trace-level attributes
propagateAttributes({ sessionId, traceName }, () => {
  const agent = startObservation("name", { input }, { asType: "agent" });
  const gen = agent.startObservation("llm", { model, input }, { asType: "generation" });
  gen.update({ output, usageDetails: { input: N, output: N } }).end();
  const tool = agent.startObservation("name", { input }, { asType: "tool" });
  tool.update({ output }).end();
  agent.update({ output }).end();
  agent.setTraceIO({ input, output }); // trace-level I/O
});

// OTel init — LangfuseSpanProcessor auto-reads env vars
new NodeSDK({ spanProcessors: [new LangfuseSpanProcessor()] }).start();
```

## Out of scope

- Structured logging (pino) — keep existing console + markdown
- Tracing memory compression LLM calls (observer/reflector)
- Cost tracking or token budget features
- Langfuse prompt management integration
- Dashboard setup or alert configuration

## Constraints

- Tracing is **fully optional** — graceful no-op when `LANGFUSE_PUBLIC_KEY` /
  `LANGFUSE_SECRET_KEY` are absent. No startup errors, no performance impact.
- **Logging output unchanged** — console, markdown, and JSONL produce the same
  output. Existing subscribers (bridge, JSONL) are updated to listen to the
  renamed events, but their visible behavior is identical.
- New event fields are **additive** (optional) — existing subscribers ignore them.
- Bun runtime — use `NodeSDK` from `@opentelemetry/sdk-node`. If Bun's
  `async_hooks` support causes issues, fall back to manual `TracerProvider`
  from `@opentelemetry/sdk-trace-base`.
- Langfuse subscriber is a **global singleton** (not per-session) — attached
  once at process startup, routes by `agentId` from event envelope.
- Delegated child agents keep **separate sessions** — linked to parent via
  shared `traceId` and `parentAgentId` in event envelope.

## Acceptance criteria

- [ ] `LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY` absent → no errors, no tracing, no overhead
- [ ] `LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY` present → traces appear in Langfuse dashboard
- [ ] Each agent run produces one Langfuse trace with the agent name, sessionId, and input/output
- [ ] Plan and act LLM calls appear as `generation` observations with model, full messages, output, and token usage
- [ ] Tool calls appear as `tool` observations with input args, output/error, and duration
- [ ] Delegated child agents appear as nested agent observations within the parent's trace (single `traceId`)
- [ ] Error cases produce traces with `ERROR` level and status message
- [ ] `session.closed` with `reason: "error"` is emitted when `runAgent` throws
- [ ] Existing logging output (console, markdown, JSONL) is unchanged — all existing tests pass (bridge/JSONL updated to new event names)
- [ ] `generation.started` + `generation.completed` events replace `plan.produced` and `turn.acted` for every LLM call
- [ ] `memory.compressed` replaced by `memory.observation` and `memory.reflection` (dedicated events, no phase discriminator)
- [ ] `BusEvent` envelope carries `agentId`, `parentAgentId`, `traceId`, `depth` (auto-populated from context)
- [ ] `shutdownTracing()` flushes pending spans before process exit
- [ ] HTTP server exposes `X-Session-Id` in response headers

## Implementation plan

### Phase 1 — Foundation types (no behavioral changes)

1. **Extend `BusEvent` envelope** (`src/types/events.ts`).
   Add optional fields: `agentId?: string`, `parentAgentId?: string`,
   `traceId?: string`, `depth?: number`. Existing subscribers ignore them.

2. **Replace `plan.produced` and `turn.acted` with generic generation events**
   (`src/types/events.ts`). Remove `plan.produced` and `turn.acted` from
   `EventMap`. Add:
   ```
   "generation.started": {
     name: string             // "plan", "act" (future: "observation", "reflection")
     model: string
     startTime: number        // epoch ms
   }

   "generation.completed": {
     name: string
     model: string
     input: unknown[]         // messages sent to LLM
     output: {
       content: string | null
       toolCalls?: { id: string; name: string; arguments: string }[]
     }
     usage: { input: number; output: number; total: number }
     durationMs: number
     startTime: number
   }
   ```

3. **Split `memory.compressed` into dedicated events** (`src/types/events.ts`).
   Remove `memory.compressed`. Add:
   ```
   "memory.observation": {
     tokensBefore: number
     tokensAfter: number
   }

   "memory.reflection": {
     level: number            // no longer optional — reflection always has a level
     tokensBefore: number
     tokensAfter: number
   }
   ```

4. **Enrich existing event payloads** (`src/types/events.ts`):
   - `session.opened` — add `userInput?: string`
   - `session.closed` — add `error?: string`

5. **Add tracing identity to `AgentState`** (`src/types/agent-state.ts`):
   `agentId?: string`, `parentAgentId?: string`, `traceId?: string`,
   `depth?: number`.

### Phase 2 — Context plumbing

6. **Add context accessors** (`src/agent/context.ts`).
   New functions: `getAgentId()`, `getParentAgentId()`, `getTraceId()`,
   `getDepth()` — same pattern as existing `getSessionId()`.

7. **Auto-populate envelope** (`src/infra/events.ts`).
   Import new accessors. In `emit()`, add `agentId`, `parentAgentId`,
   `traceId`, `depth` to the `BusEvent` construction alongside `sessionId`.

8. **Generate agent identity** (`src/agent/orchestrator.ts`).
   Extend `ExecuteTurnOpts` with optional `parentAgentId`, `parentTraceId`,
   `parentDepth`. When building `AgentState`:
   - `agentId = randomUUID()` (always fresh)
   - `traceId = opts.parentTraceId ?? randomUUID()` (inherit or create)
   - `depth = opts.parentAgentId ? (opts.parentDepth ?? 0) + 1 : 0`
   - `agentName = assistantName` (fix: populate the currently-unused field)

9. **Thread context through delegate** (`src/tools/delegate.ts`).
   Import `getAgentId`, `getTraceId`, `getDepth` from context. Pass
   `parentAgentId`, `parentTraceId`, `parentDepth` into `executeTurn()`.

### Phase 3 — Emit new/enriched events

10. **Replace `plan.produced`/`turn.acted` emissions with generation events**
    (`src/agent/loop.ts`).
    In `executePlanPhase`: capture `startEpoch = Date.now()` before the LLM
    call. Emit `generation.started` with `name: "plan"`. Replace the existing
    `bus.emit("plan.produced", ...)` with `bus.emit("generation.completed", ...)`
    carrying `name: "plan"`, full `planMessages` as input, `{ content: planText }`
    as output, and usage/duration.
    In `executeActPhase`: same pattern with `name: "act"`. Replace
    `bus.emit("turn.acted", ...)` with `generation.started` + `generation.completed`.

11. **Replace `memory.compressed` emissions** (`src/agent/memory/processor.ts`).
    Replace `bus.emit("memory.compressed", { phase: "observation", ... })` with
    `bus.emit("memory.observation", { tokensBefore, tokensAfter })`.
    Replace `bus.emit("memory.compressed", { phase: "reflection", ... })` with
    `bus.emit("memory.reflection", { level, tokensBefore, tokensAfter })`.

12. **Enrich `session.opened`** (`src/agent/loop.ts`).
    Add `userInput` (available as `userPrompt`).

13. **Emit `session.closed` on error** (`src/agent/loop.ts`).
    Wrap main try block with catch that emits `session.closed` with
    `reason: "error"` and `error: message`, then re-throws.

14. **Update existing subscribers** (`src/infra/log/bridge.ts`, `src/infra/log/jsonl.ts`).
    - Bridge: replace `bus.on("plan.produced", ...)` with
      `bus.on("generation.completed", ...)` filtered by `name === "plan"`.
      Replace `bus.on("turn.acted", ...)` with filter by `name === "act"`.
      Replace `bus.on("memory.compressed", ...)` with separate listeners for
      `memory.observation` and `memory.reflection`.
    - JSONL: same event name updates — the writer logs all events so just the
      type names change.

### Phase 4 — Config

15. **Add Langfuse env vars** (`src/config/env.ts`).
    Optional: `langfusePublicKey`, `langfuseSecretKey`, `langfuseBaseUrl`.

16. **Add config section** (`src/config/index.ts`).
    ```
    langfuse: {
      publicKey: env.langfusePublicKey,
      secretKey: env.langfuseSecretKey,
      baseUrl: env.langfuseBaseUrl ?? "https://cloud.langfuse.com",
    }
    ```

### Phase 5 — Tracing infrastructure (new files)

17. **Create `src/infra/tracing.ts`** — OTel/Langfuse init and shutdown.
    Exports: `isTracingEnabled()`, `initTracing()`, `shutdownTracing()`.
    Uses `LangfuseSpanProcessor` + `NodeSDK`. No-op when keys absent.

18. **Create `src/infra/langfuse-subscriber.ts`** — event-to-Langfuse mapping.
    Global subscriber attached once at startup. Three internal maps:
    - `agentMap: Map<agentId, { obs, ctx }>` — observation + saved OTel context
    - `turnMap: Map<agentId, observation>` — current turn span per agent
    - `toolMap: Map<callId, observation>` — open tool spans

    **Critical**: `propagateAttributes` stores sessionId/traceName in OTel
    context. Child observations created *outside* that callback scope lose
    those attributes because `context.active()` returns a bare context.
    Fix: capture `otelContext.active()` inside `propagateAttributes` and
    wrap all child observation creation with `otelContext.with(savedCtx, fn)`.

    Nesting structure:
    ```
    Agent (session.opened → session.closed)
      ├── Turn 1 (turn.began → turn.ended)
      │   ├── Generation: plan-llm
      │   ├── Generation: act-llm
      │   └── Tool: read_file
      ├── Turn 2
      │   ├── Generation: plan-llm
      │   └── Generation: act-llm
      └── ...
    ```

    Event mapping:

    | Bus Event | Langfuse Action |
    |-----------|-----------------|
    | `session.opened` | Root (depth=0): `propagateAttributes(...)` → `startObservation(asType:"agent")` + capture `otelContext.active()`. Child: `otelContext.with(parentCtx, () => parentObs.startObservation(...))`. Store `{ obs, ctx }` in `agentMap`. |
    | `turn.began` | `otelContext.with(ctx, () => agentObs.startObservation("turn-N"))`. Store in `turnMap`. |
    | `turn.ended` | `turnObs.update({ output: outcome })` → `.end()`. Delete from `turnMap`. |
    | `generation.completed` | `otelContext.with(ctx, () => turnObs.startObservation(name+"-llm", asType:"generation"))` → `.update({ output, usageDetails })` → `.end()` |
    | `tool.dispatched` | `otelContext.with(ctx, () => turnObs.startObservation(name, asType:"tool"))`. Store in `toolMap`. |
    | `tool.succeeded` | `toolObs.update({ output })` → `.end()`. Delete from `toolMap`. |
    | `tool.failed` | `toolObs.update({ output, level:"ERROR" })` → `.end()`. Delete from `toolMap`. |
    | `agent.answer` | `otelContext.with(ctx, () => agentObs.setTraceIO({ output }))` |
    | `session.closed` | End dangling turn if any. `otelContext.with(ctx, () => agentObs.end())`. Delete from maps. |

    Returns cleanup function (detach listeners, clear maps).
    Guard: if `!isTracingEnabled()`, return no-op `() => {}`.

### Phase 6 — Wiring

19. **CLI** (`src/cli.ts`).
    Import and call `initTracing()` at top. Call `await shutdownTracing()`
    after `executeTurn` completes.

20. **Server** (`src/server.ts`).
    Import and call `initTracing()` at module level. Add `SIGTERM`/`SIGINT`
    handlers calling `await shutdownTracing()`. Add `X-Session-Id` and
    `Access-Control-Expose-Headers` headers on `/chat` responses.

21. **Attach subscriber** (`src/cli.ts` and `src/server.ts`).
    After `initTracing()`, call `attachLangfuseSubscriber(bus)`. This is a
    global singleton — attached once, not per session.

## Delegation trace flow

```
CLI: executeTurn({ prompt }) → agentId=A1, traceId=T1, depth=0
  session.opened       → Langfuse: root agent obs [A1] + capture OTel context
  turn.began(1)        → Langfuse: turn-1 span (child of A1)
  generation.completed → Langfuse: plan-llm generation (child of turn-1)
  generation.completed → Langfuse: act-llm generation (child of turn-1)
  tool.dispatched      → Langfuse: tool "delegate" (child of turn-1)
    └─ executeTurn({ parentAgentId=A1, parentTraceId=T1, parentDepth=0 })
         → agentId=A2, traceId=T1 (inherited), depth=1
         session.opened       → Langfuse: agent A2 (child of A1, shares parent OTel ctx)
         turn.began(1)        → Langfuse: turn-1 span (child of A2)
         generation.completed → Langfuse: plan-llm (child of A2/turn-1)
         tool.dispatched      → Langfuse: tool (child of A2/turn-1)
         tool.succeeded       → end tool obs
         turn.ended(1)        → end A2/turn-1
         session.closed       → end A2 obs
  tool.succeeded       → end "delegate" tool obs
  turn.ended(1)        → end A1/turn-1
  agent.answer         → setTraceIO({ output }) on A1
  session.closed       → end A1 obs
```

All observations share `traceId=T1` → single Langfuse trace with full nesting.

## Files touched

| File | Action |
|------|--------|
| `src/types/events.ts` | Modify — extend `BusEvent`, replace `plan.produced`/`turn.acted` with `generation.started`/`generation.completed`, split `memory.compressed` into `memory.observation`/`memory.reflection`, enrich payloads |
| `src/types/agent-state.ts` | Modify — add 4 optional tracing identity fields |
| `src/agent/context.ts` | Modify — add 4 accessor functions |
| `src/infra/events.ts` | Modify — auto-populate tracing fields in envelope |
| `src/agent/orchestrator.ts` | Modify — accept parent context, generate identity, populate `agentName` |
| `src/tools/delegate.ts` | Modify — pass parent context to `executeTurn` |
| `src/agent/loop.ts` | Modify — replace `plan.produced`/`turn.acted` with `generation.started`/`generation.completed`, enrich events, error handling |
| `src/agent/memory/processor.ts` | Modify — replace `memory.compressed` with `memory.observation`/`memory.reflection` |
| `src/infra/log/bridge.ts` | Modify — update listeners for renamed events (same output) |
| `src/infra/log/jsonl.ts` | Modify — update for renamed event types |
| `src/infra/log/bridge.test.ts` | Modify — update test event names |
| `src/config/env.ts` | Modify — add 3 optional Langfuse env vars |
| `src/config/index.ts` | Modify — add `langfuse` config section |
| `src/cli.ts` | Modify — init/shutdown tracing, attach subscriber |
| `src/server.ts` | Modify — init/shutdown tracing, attach subscriber, HTTP headers |
| `src/infra/tracing.ts` | **Create** — OTel/Langfuse init, shutdown, `isTracingEnabled()` |
| `src/infra/langfuse-subscriber.ts` | **Create** — event-to-Langfuse observation mapping |

## Testing scenarios

1. **No keys** — `bun run agent "hello"` with no Langfuse env vars → no errors,
   no warnings beyond info log, existing output unchanged
2. **With keys** — set env vars, run agent → Langfuse dashboard shows trace with
   agent name, sessionId, nested generations (plan + act) with full messages and
   tokens, nested tool spans with args and results
3. **Delegation** — trigger a prompt that uses `delegate` → single Langfuse trace
   with parent agent, nested child agent, each with their own generations and tools
4. **Error** — force an error (e.g., unknown agent name mid-run) → trace shows
   ERROR level with status message, observation is properly ended
5. **Shutdown flush** — run a quick agent task, verify trace appears in Langfuse
   (confirms `shutdownTracing` flushed the span processor)
6. **Existing tests** — `bun test` passes with no regressions
7. **HTTP headers** — `POST /chat` response includes `X-Session-Id` header
