# SP-89 AgentEvent discriminated union

## Main objective

Replace the `EventMap` interface + detached `BusEvent<T>` envelope in
`src/types/events.ts` with a single flat discriminated union `AgentEvent`.
Each variant owns its `type` literal *and* its envelope/payload fields in
one shape, so `switch (e.type)` narrows everything at once and per-variant
invariants (`runId` is required on `tool.called`, optional on
`input.flagged`, etc.) become compile-time facts.

## Context

`src/types/events.ts` currently models events as a *type-indexed payload
registry*:

```ts
export interface EventMap { "run.started": {...}; ... }
export interface BusEvent<T = unknown> { type: string; data: T; runId?: string; ... }
export type Listener<K extends EventType> = (e: BusEvent<EventMap[K]>) => void;
```

Three problems:

1. **Envelope is detached from the registry.** `BusEvent.type` is `string`,
   not `keyof EventMap`. There is no value you can `switch (e.type)` on and
   have TS narrow the `data` field. The wildcard listener
   (`WildcardListener`) receives `BusEvent<unknown>` and any cross-type
   subscriber has to cast.
2. **Envelope optionality lies.** `runId?`, `parentRunId?`, `rootRunId?`,
   `traceId?`, `depth?` are all optional on `BusEvent`, yet semantically
   `tool.called` *must* carry `runId` while `input.flagged` need not.
   Today these invariants live in producer code, not the type.
3. **Open bags inside payloads.** `run.waiting.waitingOn`,
   `run.resumed.resolution`: `{ kind: string; [k: string]: unknown }`
   defeats the registry. Wait kinds are a closed set
   (`hitl_confirmation`, `child_run`, `tool_result`, …) and each has a
   distinct shape that should be a discriminated union of its own.

This spec adopts the user's proposed shape:

```ts
export type AgentEvent =
  | { type: "agent.started"; ts: number; runId: RunId; agentName: string; ... }
  | { type: "agent.completed"; ts: number; runId: RunId; tokens: TokenPair; ... }
  | ...;
```

`EventType` and the per-type narrowing helper are derived from the union
rather than the other way round.

### What exists today

| Piece | File | Status |
|-------|------|--------|
| `EventMap` registry (32 event types) | `src/types/events.ts:23-169` | In use |
| `BusEvent<T>` envelope | `src/types/events.ts:173-185` | `type: string` not narrowed; tracing fields all optional |
| `EventType = keyof EventMap` | `src/types/events.ts:189` | Will become `AgentEvent["type"]` |
| `Listener<K>` / `WildcardListener` | `src/types/events.ts:190-191` | Reshape to `Extract<AgentEvent, {type: K}>` |
| `EventBus` interface | `src/types/events.ts:193-200` | API stays; signatures rewire to `AgentEvent` |
| Bus impl, injects envelope from `AsyncLocalStorage` | `src/infra/events.ts:18-50` | Will keep injecting — see Constraints |
| Call sites: `bus.emit`, `bus.on`, `onAny` | ~141 sites across `src/` | Mechanical migration |
| Subscribers: Langfuse, JSONL log, markdown log, condense, slack, evals harness, run-continuation | `src/infra/**`, `src/agent/run-continuation.ts`, `src/slack.ts`, `src/evals/harness.ts` | Currently cast `BusEvent<unknown>` → typed; refactor removes the cast |

### What this spec adds

1. `AgentEvent` flat discriminated union — single source of truth.
2. Derived helpers: `EventType = AgentEvent["type"]`,
   `EventOf<T extends EventType> = Extract<AgentEvent, { type: T }>`.
3. Reshaped `EventBus` API: `on<T>(t, l: (e: EventOf<T>) => void)`,
   `onAny(l: (e: AgentEvent) => void)`, `emit` keeps the
   `(type, data)` ergonomics by accepting `EventOf<T>` minus the
   bus-injected envelope fields.
4. Replace the open `waitingOn` / `resolution` bags on `run.waiting` /
   `run.resumed` with a `Wait` / `WaitResolution` discriminated union
   imported from `src/agent/wait-descriptor.ts` (already exists).
5. Per-variant required envelope fields: `runId: RunId` mandatory on every
   `run.*`, `tool.*`, `cycle.*`, `generation.*`, `memory.*`, `agent.*`;
   optional only on `input.flagged` / `input.clean` (which fire before a
   run exists).
6. `assertNever` exhaustiveness check exported alongside `AgentEvent` so
   subscribers that switch get a compile error when a new variant lands.

## Out of scope

- Adding new event types (no `run.cancelling`, no `tool.waiting`, no
  `turn.*` rename). Pure refactor of the type story; the *set* of events
  stays identical. Lifecycle gaps go in a follow-up spec.
- Splitting telemetry from domain events (no `category` field). Wonderlands
  parity work goes in a follow-up.
- Persisting events / outbox / causationId. The bus stays in-memory.
- Renaming `cycle.*` → `turn.*` or collapsing `cycle.completed.outcome`
  into dedicated variants. Naming cleanup is a separate spec.
- Plugin extensibility via declaration merging. The flat union is
  intentionally closed; if third-party events become a real requirement,
  re-add a `type AgentEvent = CoreEvent | PluginEvent` seam later.

## Constraints

- **Zero behavioural change.** Every event currently emitted must still
  emit, with the same payload fields, same timing, same envelope contents.
  This is a pure type-system refactor.
- **Bus keeps injecting envelope fields from `AsyncLocalStorage`.**
  `src/infra/events.ts` continues to read `getRunId()`, `getSessionId()`,
  etc., from context. Producers do not start passing tracing fields
  manually — that would be an unrelated, much larger churn. The variant
  type just *requires* those fields to be present on the envelope, and
  the bus is the single point that satisfies the requirement.
- **`bun test` passes at merge.** Existing tests
  (`src/infra/log/jsonl.test.ts`, anything that constructs `BusEvent`
  literals in tests) get mechanically updated.
- **No runtime cost.** No tagged-class wrappers, no per-event factories.
  Plain object literals built in `bus.emit`.
- **Single PR.** ~141 call sites is mechanical; splitting it across PRs
  creates a long-lived broken intermediate state.

## Design

### 1. New `src/types/events.ts` shape

```ts
import type { Wait, WaitResolution } from "../agent/wait-descriptor.ts";

export type RunId = string;
export type SessionId = string;

export type TokenPair = { promptTokens: number; completionTokens: number };

export type MemoryGeneration = {
  name: string;
  model: string;
  input: unknown[];
  output: { content: string | null };
  usage: { input: number; output: number; total: number };
  durationMs: number;
  startTime: number;
};

/** Envelope fields injected by the bus from AsyncLocalStorage. */
type RunScoped = {
  id: string;
  ts: number;
  sessionId?: SessionId;
  correlationId?: string;
  runId: RunId;
  rootRunId?: RunId;
  parentRunId?: RunId;
  traceId?: string;
  depth?: number;
};

/** Subset for events fired before a run exists. */
type Unscoped = Omit<RunScoped, "runId"> & { runId?: RunId };

export type AgentEvent =
  // ── Run lifecycle ─────────────────────────────────────────
  | (RunScoped & { type: "run.started"; assistant: string; model: string; userInput?: string })
  | (RunScoped & { type: "run.completed"; reason: "answer" | "max_iterations"; iterations: number; tokens: TokenPair })
  | (RunScoped & { type: "run.failed"; iterations: number; tokens: TokenPair; error: string })
  | (RunScoped & { type: "run.waiting"; waitingOn: Wait })
  | (RunScoped & { type: "run.resumed"; resolution: WaitResolution })
  | (RunScoped & { type: "run.delegated"; childRunId: RunId; childAgent: string; task: string })
  | (RunScoped & { type: "run.child_terminal"; childRunId: RunId; childStatus: string })

  // ── Cycle ─────────────────────────────────────────────────
  | (RunScoped & { type: "cycle.started"; cycleIndex: number; iteration: number; maxIterations: number; model: string; messageCount: number })
  | (RunScoped & { type: "cycle.completed"; cycleIndex: number; iteration: number; outcome: "continue" | "answer" | "max_iterations"; durationMs: number; tokens: TokenPair })

  // ── Generation ────────────────────────────────────────────
  | (RunScoped & { type: "generation.started"; name: string; model: string; startTime: number })
  | (RunScoped & {
      type: "generation.completed";
      name: string; model: string;
      input: unknown[];
      output: { content: string | null; toolCalls?: { id: string; name: string; arguments: string }[] };
      usage: { input: number; output: number; total: number };
      durationMs: number; startTime: number;
    })
  | (Unscoped & { type: "llm.call.failed"; model: string; error: string; fatal: boolean; code?: string })

  // ── Tool execution ────────────────────────────────────────
  | (RunScoped & { type: "tool.called"; toolCallId: string; name: string; args: string; batchIndex: number; batchSize: number; startTime: number })
  | (RunScoped & { type: "tool.succeeded"; toolCallId: string; name: string; durationMs: number; result: string; args?: string; startTime?: number })
  | (RunScoped & { type: "tool.failed"; toolCallId: string; name: string; durationMs: number; error: string; args?: string; startTime?: number })
  | (RunScoped & { type: "batch.started"; batchId: string; toolCallIds: string[]; count: number })
  | (RunScoped & { type: "batch.completed"; batchId: string; count: number; durationMs: number; succeeded: number; failed: number })

  // ── Confirmation ──────────────────────────────────────────
  | (RunScoped & { type: "confirmation.requested"; calls: Array<{ toolCallId: string; toolName: string }> })
  | (RunScoped & { type: "confirmation.resolved"; approved: string[]; denied: string[] })

  // ── Memory ────────────────────────────────────────────────
  | (RunScoped & { type: "memory.observation.started"; tokensBefore: number })
  | (RunScoped & { type: "memory.observation.completed"; tokensBefore: number; tokensAfter: number; generation: MemoryGeneration })
  | (RunScoped & { type: "memory.observation.failed"; error: string })
  | (RunScoped & { type: "memory.reflection.started"; level: number; tokensBefore: number })
  | (RunScoped & { type: "memory.reflection.completed"; level: number; tokensBefore: number; tokensAfter: number; generations: MemoryGeneration[] })
  | (RunScoped & { type: "memory.reflection.failed"; level: number; error: string })

  // ── Agent ─────────────────────────────────────────────────
  | (RunScoped & { type: "agent.started"; agentName: string; model: string; task: string; parentRunId?: RunId; depth: number })
  | (RunScoped & { type: "agent.completed"; agentName: string; durationMs: number; iterations: number; tokens: TokenPair; result: string | null })
  | (RunScoped & { type: "agent.failed"; agentName: string; durationMs: number; iterations: number; error: string })
  | (RunScoped & { type: "agent.answered"; text: string | null })

  // ── Moderation ────────────────────────────────────────────
  | (Unscoped & { type: "input.flagged"; categories: string[]; categoryScores: Record<string, number> })
  | (Unscoped & { type: "input.clean"; durationMs: number });

export type EventType = AgentEvent["type"];
export type EventOf<T extends EventType> = Extract<AgentEvent, { type: T }>;

/** Payload portion an emitter supplies — bus injects everything in RunScoped/Unscoped. */
export type EventInput<T extends EventType> = Omit<EventOf<T>, keyof RunScoped | "type">;

export type Listener<T extends EventType> = (event: EventOf<T>) => void;
export type WildcardListener = (event: AgentEvent) => void;

export interface EventBus {
  emit<T extends EventType>(type: T, data: EventInput<T>): void;
  on<T extends EventType>(type: T, listener: Listener<T>): () => void;
  onAny(listener: WildcardListener): () => void;
  off<T extends EventType>(type: T, listener: Listener<T>): void;
  offAny(listener: WildcardListener): void;
  clear(): void;
}

export const assertNever = (x: never): never => {
  throw new Error(`Unhandled event variant: ${JSON.stringify(x)}`);
};
```

Notes on the shape:

- `RunScoped` *requires* `runId`. Variants that fire before a run exists
  (`input.*`, `llm.call.failed`) use `Unscoped`. This is the central
  invariant fix.
- `id` and `ts` are mandatory on every variant (always injected by the
  bus). No more optional `id?`.
- `waitingOn` and `resolution` import the existing `Wait` /
  `WaitResolution` unions from `src/agent/wait-descriptor.ts`. The open
  `[k: string]: unknown` bag is gone.
- `EventInput<T>` is what call sites pass to `bus.emit(type, data)` — same
  ergonomics as today, but typed against the variant rather than
  `EventMap[T]`.
- `BusEvent<T>` is **deleted**. There's no separate envelope type; an
  event *is* an `AgentEvent`. Any external consumer that referenced
  `BusEvent` migrates to `AgentEvent` or `EventOf<T>`.

### 2. Bus impl (`src/infra/events.ts`)

The implementation barely changes — just the construction of the event
object inside `emit`:

```ts
function emit<T extends EventType>(type: T, data: EventInput<T>): void {
  const event = {
    id: randomUUID(),
    type,
    ts: Date.now(),
    sessionId: getSessionId(),
    runId: getRunId(),
    rootRunId: getRootRunId(),
    parentRunId: getParentRunId(),
    traceId: getTraceId(),
    depth: getDepth(),
    ...data,
  } as AgentEvent;
  // dispatch to listeners (unchanged)
}
```

The cast `as AgentEvent` is the one unavoidable trust point — the bus
trusts that `getRunId()` returns a string when the variant requires it.
That contract is enforced at the *boundary* (anything that emits a
`run.*` or `tool.*` event must run inside a session context that supplies
`runId`), and a runtime guard inside `emit` can throw early if a
required field is missing for the requested variant. Cheap insurance.

### 3. Call-site migration

`bus.emit("foo", { ... })` keeps working unchanged at every call site —
`EventInput<T>` is shape-compatible with the old `EventMap[T]` for every
event whose payload didn't already mention envelope fields. Two
exceptions:

- `agent.started.parentRunId` already exists in the payload and now
  collides with the envelope's `parentRunId`. Resolution: drop it from
  the payload (envelope already carries it) — call sites stop passing
  `parentRunId` in the data object.
- `run.waiting.waitingOn` and `run.resumed.resolution` change from open
  bags to `Wait` / `WaitResolution`. Today's emitters (`orchestrator.ts`,
  `resume-run.ts`) already construct these as proper `Wait` /
  `WaitResolution` values then pass them through; the cast just becomes
  unnecessary.

Subscribers (`onAny` consumers in Langfuse, JSONL log, markdown log,
slack, condense, run-continuation) drop their `as BusEvent<EventMap[K]>`
casts and start using `switch (e.type)` for narrowing. JSONL writer in
particular wins: today it serializes `BusEvent<unknown>` and trusts the
producer; after the refactor the writer can statically map each variant
to a column set if desired.

### 4. Wait descriptor reuse

Confirm `src/agent/wait-descriptor.ts` exports `Wait` and `WaitResolution`
as discriminated unions (per SP-87). Import them into `events.ts`. Any
gap (e.g., `tool_result` resolution shape) gets fixed in
`wait-descriptor.ts`, not by re-bagging here.

## Migration plan

1. **Land the new `events.ts`** with `AgentEvent`, `EventOf`,
   `EventInput`, reshaped `EventBus`. Keep `BusEvent` exported as a
   `@deprecated` alias for `AgentEvent` for one commit only.
2. **Update `src/infra/events.ts`** to the new emit shape. Add the
   runtime invariant guard (throw if `runId` missing on a `RunScoped`
   variant).
3. **Strip envelope-field duplicates** from payloads
   (`agent.started.parentRunId`).
4. **Switch `run.waiting` / `run.resumed`** to `Wait` / `WaitResolution`.
5. **Migrate subscribers** off `BusEvent`, onto `AgentEvent` /
   `EventOf<T>` and exhaustive `switch` with `assertNever`.
6. **Delete `BusEvent`** alias and any `EventMap`-mode helpers.
7. **`bun test`** + `bun run agent "ping"` smoke run.

Each step keeps the build green; the whole sequence ships in one PR.

## Acceptance

- `BusEvent` and `EventMap` no longer exported from
  `src/types/events.ts`.
- `AgentEvent`, `EventType`, `EventOf<T>`, `EventInput<T>`, `Listener<T>`,
  `WildcardListener`, `EventBus`, `assertNever` are.
- `runId` is `string` (not `string | undefined`) on every `run.*`,
  `tool.*`, `cycle.*`, `generation.completed`, `memory.*`, `agent.*`,
  `confirmation.*`, `batch.*` variant when narrowed by `e.type`.
- `run.waiting.waitingOn` is `Wait`, not `{ kind: string; [k]: unknown }`.
- A new event variant added without a corresponding subscriber branch
  causes a compile error in any subscriber that uses `assertNever`.
- `bun test` passes. `bun run agent "what is 2+2"` produces a JSONL log
  byte-identical (modulo `id`/`ts`) to a run on the previous commit.
- No `as BusEvent` or `as any` casts remain in the events code path.

## Risk / rollback

- **Risk:** producer code that emits a `RunScoped` event outside a session
  context (no `runId` in `AsyncLocalStorage`) will now throw at the
  invariant guard. Mitigation: the guard logs the offending event type
  before throwing; a one-line patch downgrades to a warning if a real
  legitimate caller surfaces. Expected to be zero — every emitter
  already runs inside `withSessionContext`.
- **Risk:** declaration-merging consumers (none today, but possible) lose
  the ability to extend the registry. Mitigation: noted in Out of scope;
  re-add via union seam if it ever becomes real.
- **Rollback:** revert the PR. The `EventMap` shape is self-contained
  and the migration is mechanical, so revert is clean.
