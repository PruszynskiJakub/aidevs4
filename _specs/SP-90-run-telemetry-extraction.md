# SP-90 Run telemetry extraction

## Main objective

Extract every `bus.emit(...)` call out of `src/agent/loop.ts` into a new
module `src/agent/run-telemetry.ts`. After the change, `loop.ts` contains
zero direct references to the event bus, and `runAgent` reads as a clean
state machine instead of an event firehose. No behavior changes — same
events, same payloads, same order.

## Context

`src/agent/loop.ts` is 471 LOC. The `runAgent` function alone is ~180 LOC
and is interleaved with **22 inline `bus.emit` calls** spanning six event
domains:

| Line | Event |
|---|---|
| 68 | `generation.started` |
| 83 | `generation.completed` |
| 135 | `batch.started` |
| 144 | `tool.called` |
| 182 | `tool.failed` (executor failure path) |
| 192 | `tool.succeeded` |
| 209 | `tool.failed` (rejected promise path) |
| 226 | `batch.completed` |
| 316 | `run.started` |
| 322 | `agent.started` |
| 340 | `turn.started` |
| 361 | `turn.completed` (answer) |
| 367 | `agent.answered` |
| 368 | `agent.completed` (answer) |
| 375 | `run.completed` (answer) |
| 395 | `turn.completed` (waiting) |
| 409 | `turn.completed` (after dispatch) |
| 422 | `turn.completed` (max iterations) |
| 428 | `agent.completed` (max iterations) |
| 435 | `run.completed` (max iterations) |
| 454 | `agent.failed` |
| 460 | `run.failed` |

Three concrete problems with the current shape:

1. **The state machine is invisible.** `runAgent` mixes (a) the act/dispatch
   loop, (b) terminal-state classification (answer / waiting / max-iter /
   fail), and (c) emissions that *describe* those transitions. Reading the
   loop body, you cannot see the state machine without filtering out the
   emissions.
2. **Triple-emit on terminal transitions.** Each terminal state fans out
   into three events with overlapping payload (e.g. answer emits
   `turn.completed` + `agent.completed` + `run.completed`, all three
   sharing `tokens` and a duration / iteration count). The construction of
   these payloads is duplicated three times in the function.
3. **Payload construction is co-located with control flow.** Building
   `{ assistant, model, userInput }` for `run.started` lives next to the
   `agentsService.resolve(...)` call. This is the exact concern Wonderlands
   isolates in `application/runtime/run-telemetry.ts` (13 KB, ~360 LOC,
   reference: `Wonderlands/apps/server/src/application/runtime/run-telemetry.ts`).

This spec addresses (1) and (2) by extraction; (3) follows naturally
because each named function in the new module owns one event family.

## Non-goals

- **No event renames, no payload changes, no order changes.** The
  `AgentEvent` discriminated union from SP-89 is untouched. Subscribers
  (markdown logger, JSONL writer, langfuse) must observe identical streams
  before and after this spec.
- **No `bus.emit` extraction outside `loop.ts`.** `orchestrator.ts`,
  `resume-run.ts`, `confirmation.ts`, and `session.ts` keep their own
  `bus.emit` calls. Hoisting those is out of scope (the loop is the
  highest-density emitter; the others are 1–3 calls each).
- **No new event types.** Even though `tool.failed` is emitted from two
  different code paths, both paths keep emitting the same event with the
  same payload. Splitting it into a third type is a separate concern.
- **No telemetry policy changes.** Sampling, filtering, conditional
  emission — none introduced. Every event still fires unconditionally
  exactly as today.
- **No structural refactor of `runAgent` beyond the extraction.** Memory
  pipeline (`buildCycleContext`, `createMemorySaver`, `flushMemory`),
  confirmation gate, and `WaitRequested` propagation stay where they are.

## Proposed module shape

`src/agent/run-telemetry.ts` exports a flat set of named functions, one
per logical transition. No class, no factory — just functions that take
the minimum data they need and call `bus.emit` internally. Importing
`bus` is confined to this file.

```ts
// src/agent/run-telemetry.ts
import { bus } from "../infra/events.ts";
import type { LLMMessage, LLMChatResponse } from "../types/llm.ts";
import type { TokenPair } from "../types/events.ts";

// ── Run lifecycle ───────────────────────────────────────────
export function emitRunStarted(args: {
  assistant: string;
  model: string;
  userInput?: string;
}): void;

export function emitRunCompleted(args: {
  reason: "answer" | "max_iterations";
  iterations: number;
  tokens: TokenPair;
}): void;

export function emitRunFailed(args: {
  iterations: number;
  tokens: TokenPair;
  error: string;
}): void;

// ── Agent lifecycle ─────────────────────────────────────────
export function emitAgentStarted(args: {
  agentName: string;
  model: string;
  task: string;
  depth: number;
}): void;

export function emitAgentAnswered(text: string | null): void;

export function emitAgentCompleted(args: {
  agentName: string;
  durationMs: number;
  iterations: number;
  tokens: TokenPair;
  result: string | null;
}): void;

export function emitAgentFailed(args: {
  agentName: string;
  durationMs: number;
  iterations: number;
  error: string;
}): void;

// ── Turn ────────────────────────────────────────────────────
export function emitTurnStarted(args: {
  index: number;
  maxTurns: number;
  model: string;
  messageCount: number;
}): void;

export function emitTurnCompleted(args: {
  index: number;
  outcome: "answer" | "continue" | "max_iterations";
  durationMs: number;
  tokens: TokenPair;
}): void;

// ── LLM generation ──────────────────────────────────────────
export function emitGenerationStarted(args: {
  name: string;
  model: string;
  startTime: number;
}): void;

export function emitGenerationCompleted(args: {
  name: string;
  model: string;
  input: LLMMessage[];
  response: LLMChatResponse;
  usage: { input: number; output: number; total: number };
  durationMs: number;
  startTime: number;
}): void;

// ── Tool dispatch ───────────────────────────────────────────
export function emitToolCalled(args: {
  toolCallId: string;
  name: string;
  args: string;
  batchIndex: number;
  batchSize: number;
  startTime: number;
}): void;

export function emitToolSucceeded(args: {
  toolCallId: string;
  name: string;
  durationMs: number;
  result: string;
  args: string;
  startTime: number;
}): void;

export function emitToolFailed(args: {
  toolCallId: string;
  name: string;
  durationMs: number;
  error: string;
  args: string;
  startTime: number;
}): void;

export function emitBatchStarted(args: {
  batchId: string;
  toolCallIds: string[];
  count: number;
}): void;

export function emitBatchCompleted(args: {
  batchId: string;
  count: number;
  durationMs: number;
  succeeded: number;
  failed: number;
}): void;

// ── Composite terminal transitions ──────────────────────────
// These wrap the triple-emit patterns in `runAgent` so the loop body
// expresses intent, not bookkeeping.
export function emitAnswerTerminal(args: {
  agentName: string;
  iterationIndex: number;
  iterationCount: number;
  turnDurationMs: number;
  runDurationMs: number;
  tokens: TokenPair;
  answerText: string | null;
}): void;

export function emitMaxIterationsTerminal(args: {
  agentName: string;
  maxIterations: number;
  turnDurationMs: number;
  runDurationMs: number;
  tokens: TokenPair;
}): void;

export function emitFailureTerminal(args: {
  agentName: string;
  iterations: number;
  runDurationMs: number;
  tokens: TokenPair;
  error: string;
}): void;
```

### Composite functions (the actual win)

The single-event helpers (`emitTurnStarted`, etc.) are mechanical. The
real readability win is the three composite emitters that collapse the
triple-emit patterns. Compare:

**Before** (current `loop.ts:361-379`):

```ts
if (response.finishReason === "stop" || !response.toolCalls.length) {
  if (memoryEnabled) { ... }
  bus.emit("turn.completed", {
    index: i,
    outcome: "answer",
    durationMs: performance.now() - turnStartTime,
    tokens: { ...state.tokens },
  });
  bus.emit("agent.answered", { text: response.content });
  bus.emit("agent.completed", {
    agentName: state.agentName ?? state.assistant,
    durationMs: performance.now() - runStartTime,
    iterations: i + 1,
    tokens: { ...state.tokens },
    result: response.content,
  });
  bus.emit("run.completed", {
    reason: "answer",
    iterations: i + 1,
    tokens: { ...state.tokens },
  });
  return { exit: { kind: "completed", result: response.content ?? "" }, ... };
}
```

**After**:

```ts
if (response.finishReason === "stop" || !response.toolCalls.length) {
  if (memoryEnabled) { ... }
  emitAnswerTerminal({
    agentName: state.agentName ?? state.assistant,
    iterationIndex: i,
    iterationCount: i + 1,
    turnDurationMs: performance.now() - turnStartTime,
    runDurationMs: performance.now() - runStartTime,
    tokens: state.tokens,
    answerText: response.content,
  });
  return { exit: { kind: "completed", result: response.content ?? "" }, ... };
}
```

The composite owns the snapshot of `state.tokens` (currently spread three
times inline) and owns the rule "answer terminal = turn.completed +
agent.answered + agent.completed + run.completed in this order."

## Implementation steps

1. **Create `src/agent/run-telemetry.ts`** with the function signatures
   above. Each function is a one-liner that calls `bus.emit` with the
   exact payload shape that exists today. Snapshots (`{ ...tokens }`) are
   taken inside the helper, not at the call site.
2. **Replace call sites in `loop.ts`** one event family at a time, in this
   order to keep diffs small and reviewable:
   1. `generation.*` (2 calls in `executeActPhase`)
   2. `tool.*` + `batch.*` (5 calls in `dispatchTools`)
   3. `turn.*` (5 calls in `runAgent`)
   4. `agent.*` + `run.*` via the three composite emitters (12 calls
      collapse to 3)
3. **Remove `import { bus } from "../infra/events.ts"`** from `loop.ts`
   once the last `bus.emit` is gone. This is the executable assertion that
   the extraction is complete.
4. **Verify event-stream parity** by running the existing test suite.
   `loop.test.ts` already asserts on the event sequence; if those tests
   pass unchanged, parity is proven.

Each step is its own commit so `bun test` stays green between steps and a
bisect on any future event regression points to the responsible substep.

## Testing

- **`loop.test.ts`** — must pass unchanged (no event renames, no payload
  changes, no order changes).
- **New `run-telemetry.test.ts`** — co-located, covers each emitter:
  - Each single-event helper emits exactly one event with the expected
    shape (use the in-process `bus.subscribe` to capture).
  - Each composite emitter emits its events in the documented order
    (`emitAnswerTerminal` → `[turn.completed, agent.answered,
    agent.completed, run.completed]`).
  - Token snapshots are taken at call time: mutating the input object
    after the call must not mutate the emitted payload.

## Acceptance criteria

- [ ] `grep -c 'bus\.emit' src/agent/loop.ts` returns `0`.
- [ ] `grep -c 'from "../infra/events' src/agent/loop.ts` returns `0`.
- [ ] `bun test src/agent/loop.test.ts` passes with no test changes.
- [ ] `bun test src/agent/run-telemetry.test.ts` passes (new file).
- [ ] Markdown session log produced by a real `bun run agent "..."` run is
      byte-identical (modulo timestamps, IDs, durations) to a log produced
      before this change for the same prompt.
- [ ] `runAgent` body is < 100 LOC after the extraction (currently ~180).

## Risks

- **Event order regressions.** The composite emitters must preserve the
  exact emit order. `loop.test.ts` covers the answer path; verify
  max-iterations and waiting paths are also covered before merging — if
  not, add coverage in step 4 of the plan, not as a follow-up.
- **Snapshot semantics.** `{ ...state.tokens }` is currently spread at the
  emission site. Moving the spread inside the helper preserves semantics
  *if and only if* the helper is called synchronously before any further
  mutation. All current call sites are synchronous; document this in the
  helper's signature comment.
- **Future emitters drift back into `loop.ts`.** Mitigation: the
  acceptance criterion `grep -c 'bus\.emit' src/agent/loop.ts == 0` can
  be enforced as a test (single-line assertion in `loop.test.ts` that
  reads the file and asserts the count). Cheap and prevents regression.

## Out of scope (future specs)

- Splitting `session.ts` into `session/{messages,service,paths}.ts` (next
  in the stabilization series).
- Splitting `orchestrator.ts` child-run plumbing into `child-run.ts`.
- Hoisting `bus.emit` from `orchestrator.ts`, `resume-run.ts`,
  `confirmation.ts`, `session.ts` into their own telemetry modules.
- Any change to the `AgentEvent` union from SP-89.
- Any of the §5 capability gaps from `wonderlands-reference-analysis.md`
  (waits, attachment refs, sandbox promotion, etc.).