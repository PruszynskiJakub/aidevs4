# SP-69 Memory LLM Tracing, Moderation Events & Langfuse Usage Fix

## Main objective

Make memory subsystem LLM calls (observer, reflector) visible in Langfuse as
generation spans nested inside memory lifecycle spans, wire up input
moderation events (`input.flagged`/`input.clean`) that are defined but never
emitted, and fix incorrect `usageDetails` field names that break Langfuse
cost/token dashboards.

## Context

SP-67 introduced Langfuse tracing via an event bus subscriber. Three problems
remain:

### Problem 1 — Memory LLM calls are invisible

`observer.ts` and `reflector.ts` call `provider.chatCompletion()` directly
without emitting any events. The `memory.observation` and `memory.reflection`
events only carry token counts of the compressed text — not the LLM
generation itself. This means:

- No generation spans in Langfuse for memory LLM calls
- No input/output capture (can't evaluate observer/reflector prompt quality)
- No model or token usage tracking (hidden cost, invisible in dashboards)
- Reflector can loop up to `maxReflectionLevels` times — multiple LLM calls,
  all invisible

Currently, `memory.observation` and `memory.reflection` are mapped to generic
spans in Langfuse. They should become proper lifecycle spans wrapping
generation child observations.

### Problem 2 — `usageDetails` missing `total` field

The Langfuse subscriber passes `input` and `output` in `usageDetails` but
omits `total`. Langfuse expects all three keys (`input`/`output`/`total`)
for proper token aggregation in dashboards.

### Problem 2b — Generation output not in OpenAI ChatML format

The `generation.completed` event passes output as
`{ content, toolCalls? }` — a custom shape. Langfuse expects the output
in **OpenAI ChatML format** for playground compatibility:
`{ role: "assistant", content, tool_calls: [{ id, type, function }] }`.
Without this, tool calls from function calling are not properly displayed
in Langfuse.

### Problem 2c — Tool observation durations show as zero

Tool `endTime` was computed as `toDate(startTime + durationMs)` where
`startTime` is `Date.now()` epoch and `durationMs` is a `performance.now()`
delta. The `Date` constructor truncates fractional milliseconds, so
sub-millisecond tools show 0 duration. Fix: use `Date.now()` at event
receipt time as `endTime`.

### Problem 3 — Moderation events defined but never emitted

`EventMap` defines `input.flagged` and `input.clean` but no code emits them.
The moderation check runs in `orchestrator.ts:55-56`:

```typescript
const moderation = await moderateInput(opts.prompt);
assertNotFlagged(moderation);
```

This calls the OpenAI Moderation API, logs the result via `log.error()`/
`log.debug()`, then throws if flagged. But no bus events fire — so:

- Langfuse has no visibility into moderation (pass or fail)
- No way to evaluate moderation false-positive rate or track flagged categories
- When moderation blocks input, the agent trace ends abruptly with an
  uncaught error — no structured moderation data in the trace

Langfuse has a dedicated `guardrail` observation type designed exactly for
this: input safety checks with pass/fail outcome, policies, and category
scores. Currently unused.

## Out of scope

- Batch-level spans (`batch.started`/`batch.completed` → Langfuse)
- Trace-level tags/metadata (session ID, task description, environment)
- `modelParameters` (temperature) on generation spans
- `completionStartTime` (time-to-first-token)

## Constraints

- Memory subsystem must remain decoupled — observer/reflector should not
  import the event bus directly. Events are emitted from `processor.ts`
  which already has the bus import.
- Existing `memory.observation` and `memory.reflection` events change shape
  (become lifecycle start/complete pairs). All subscribers must be updated.
- Langfuse subscriber remains a single global instance, no per-session state
  beyond the existing maps.
- Bun runtime — no Node-specific APIs.

## Changes

### 1. New event types — memory lifecycle with generation data

Upgrade the existing `memory.observation` and `memory.reflection` from
point-in-time events to lifecycle triplets, each carrying LLM generation
metadata. Six events total — consistent with the project's "dedicated events
over boolean flags" convention:

```typescript
// ── Memory — observation lifecycle ──────────────────────
"memory.observation.started": {
  tokensBefore: number;
}

"memory.observation.completed": {
  tokensBefore: number;
  tokensAfter: number;
  generation: MemoryGeneration;      // exactly 1 LLM call
}

"memory.observation.failed": {
  error: string;
}

// ── Memory — reflection lifecycle ───────────────────────
"memory.reflection.started": {
  level: number;                     // current generation count
  tokensBefore: number;
}

"memory.reflection.completed": {
  level: number;
  tokensBefore: number;
  tokensAfter: number;
  generations: MemoryGeneration[];   // 1 per compression level attempted
}

"memory.reflection.failed": {
  level: number;
  error: string;
}
```

Where `MemoryGeneration` is:

```typescript
type MemoryGeneration = {
  name: string;               // "memory-observer", "memory-reflector-L0", etc.
  model: string;
  input: unknown[];           // messages sent to LLM
  output: { content: string | null };
  usage: { input: number; output: number; total: number };
  durationMs: number;
  startTime: number;          // epoch ms
}
```

Each lifecycle triplet maps 1:1 to a Langfuse span with generation children.
No phase discriminator — the event type itself carries the semantics.

### 2. Observer/reflector return generation metadata

**`observer.ts`** — `observe()` returns generation metadata alongside the
observation text:

```typescript
interface ObserveResult {
  text: string;                    // the observation text (empty string if no new observations)
  generation: MemoryGeneration;    // LLM call metadata
}

export async function observe(
  messages: LLMMessage[],
  existingObservations: string,
  provider: LLMProvider,
): Promise<ObserveResult>
```

Implementation: capture `startTime = Date.now()` before `chatCompletion`,
compute `durationMs` after. Extract `usage` from `LLMChatResponse.usage`.
Build `MemoryGeneration` with `name: "memory-observer"`, the system message
as `input`, and response content as `output`.

**`reflector.ts`** — `reflect()` returns generation metadata for each
compression level:

```typescript
interface ReflectResult {
  text: string;                     // compressed observations
  generations: MemoryGeneration[];  // one per compression level attempted
}

export async function reflect(
  observations: string,
  targetTokens: number,
  provider: LLMProvider,
): Promise<ReflectResult>
```

Implementation: accumulate a `MemoryGeneration` entry for each loop iteration.
Name format: `"memory-reflector-L{level}"`.

### 3. Processor emits lifecycle events

**`processor.ts`** — `processMemory()` and `flushMemory()` updated to:

1. Emit `*.started` before calling `observe()` / `reflect()`
2. Emit `*.completed` after, carrying the generation metadata from the
   return value
3. Wrap in try/catch to emit `*.failed` on errors (currently errors
   propagate uncaught from memory — this adds resilience)

Example flow for a turn that triggers both observation and reflection:

```
bus.emit("memory.observation.started",   { tokensBefore: 8500 })
  → observe() call
bus.emit("memory.observation.completed", { tokensBefore: 8500,
                                           tokensAfter: 2100,
                                           generation: { ... } })
bus.emit("memory.reflection.started",    { level: 1, tokensBefore: 2100 })
  → reflect() call (may loop 2 levels internally)
bus.emit("memory.reflection.completed",  { level: 1, tokensBefore: 2100,
                                           tokensAfter: 900,
                                           generations: [{ L0 }, { L1 }] })
```

### 4. Langfuse subscriber — memory spans with nested generations

Replace the current `memory.observation` and `memory.reflection` listeners
with the six lifecycle events. Both observation and reflection follow the
same pattern — open a span on `*.started`, nest generation children and
close on `*.completed`, close with error on `*.failed`.

**`memory.observation.started`** — create span:
```typescript
const span = parent.startObservation("memory-observation", {
  input: { tokensBefore: e.data.tokensBefore },
  startTime: toDate(Date.now()),
});
memoryMap.set(`${agentId}:observation`, span);
```

**`memory.observation.completed`** — nest single generation via
`nestGeneration()`, close span with compression summary as output.

**`memory.reflection.started`** — create span:
```typescript
const span = parent.startObservation(`memory-reflection-L${e.data.level}`, {
  input: { level: e.data.level, tokensBefore: e.data.tokensBefore },
  startTime: toDate(Date.now()),
});
memoryMap.set(`${agentId}:reflection`, span);
```

**`memory.reflection.completed`** — nest N generations via `nestGeneration()`,
close span. The shared helper handles `usageDetails` and timing uniformly.

**`*.failed`** (both) — close span with error:
```typescript
const key = `${agentId}:observation`; // or :reflection
const span = memoryMap.get(key);
if (span) {
  span.update({ level: "ERROR", statusMessage: e.data.error });
  span.end();
  memoryMap.delete(key);
}
```

New internal map: `memoryMap: Map<string, Observation>` (key =
`${agentId}:observation` or `${agentId}:reflection`).

### 5. Emit moderation events and map to Langfuse guardrail

**Emit events from `orchestrator.ts`** — after `moderateInput()` returns,
emit the appropriate event before calling `assertNotFlagged()`:

```typescript
const moderation = await moderateInput(opts.prompt);

if (moderation.flagged) {
  const flaggedCategories = Object.entries(moderation.categories)
    .filter(([, v]) => v)
    .map(([k]) => k);
  bus.emit("input.flagged", { categories: flaggedCategories });
} else {
  bus.emit("input.clean", {});
}

assertNotFlagged(moderation);
```

**Enrich `input.flagged` payload** (`src/types/events.ts`) — add category
scores for evaluation:

```typescript
"input.flagged": {
  categories: string[];
  categoryScores: Record<string, number>;
}

"input.clean": {
  durationMs: number;
}
```

**Trace structure:** The guardrail observation is nested as the first
child of the agent span (not a sibling at the trace root):

```
Trace (assistantName, sessionId)
  └── Agent (session.opened → session.completed)
      ├── Guardrail: input-moderation    ← first child
      ├── Turn 1 ...
      └── Turn 2 ...
```

**Implementation — buffered guardrail pattern:**

Moderation events fire in `orchestrator.ts` BEFORE `runAgent()` and
BEFORE `session.opened` — so there is no agent context yet (no `agentId`,
no `sessionId` in AsyncLocalStorage, no entry in `agentMap`). The
Langfuse subscriber cannot create the guardrail observation immediately.

Solution: the subscriber **buffers** the moderation result when
`input.clean`/`input.flagged` fires, then **replays** it as a guardrail
observation when `session.opened` creates the root agent span:

```typescript
// Buffer on moderation event (no agent context yet)
bus.on("input.clean", (e) => {
  pendingModeration = { passed: true, durationMs: e.data.durationMs };
});

bus.on("input.flagged", (e) => {
  pendingModeration = {
    passed: false,
    categories: e.data.categories,
    categoryScores: e.data.categoryScores,
  };
});

// Replay when agent span is created
bus.on("session.opened", (e) => {
  // ... create agent observation ...
  flushModeration(obs); // creates guardrail child
});
```

`flushModeration()` creates a `guardrail` observation as the first child
of the agent span, then clears the buffer.

### 6. Fix `usageDetails` — add missing `total` field

All generation spans now pass `{ input, output, total }` in `usageDetails`
via the shared `nestGeneration()` helper. The `total` field was previously
missing.

### 6b. Format generation output as OpenAI ChatML

The `generation.completed` handler converts the output to OpenAI ChatML
format before passing to Langfuse:

```typescript
const chatMlOutput = {
  role: "assistant",
  content: output.content,
  ...(output.toolCalls?.length && {
    tool_calls: output.toolCalls.map((tc) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: tc.arguments },
    })),
  }),
};
```

This enables Langfuse playground compatibility and proper tool call display.

### 6c. Fix tool observation duration

Tool `endTime` changed from `toDate(startTime + durationMs)` to
`toDate(Date.now())`. This avoids `Date` constructor truncating fractional
milliseconds from the `performance.now()` delta, which caused sub-ms tools
to show 0 duration.

### 7. Fix inconsistent `setTraceIO` truncation

In the `agent.answered` handler (line ~261):

**Before:**
```typescript
entry.obs.setTraceIO({ output: e.data.text });
```

**After:**
```typescript
entry.obs.setTraceIO({ output: answerText }); // use already-truncated value
```

## Langfuse trace structure (after this spec)

```
Trace (assistantName, sessionId)
  └── Agent (session.opened → session.completed)
      ├── Guardrail: input-moderation             ← NEW (first child, pass/fail)
      ├── Turn 1 (turn.started → turn.completed)
      │   ├── Generation: plan-llm                   (output: ChatML format)
      │   ├── Generation: act-llm                    (output: ChatML with tool_calls)
      │   ├── Tool: web_search                       (endTime: Date.now())
      │   ├── Tool: read_file
      │   ├── Span: memory-observation            ← NEW
      │   │   └── Generation: memory-observer     ← NEW (model, input, output, tokens)
      │   └── Span: memory-reflection-L1          ← NEW (only when reflection triggers)
      │       ├── Generation: memory-reflector-L0 ← NEW
      │       └── Generation: memory-reflector-L1 ← NEW
      ├── Turn 2
      │   ├── Generation: plan-llm
      │   ├── Generation: act-llm
      │   └── Tool: agents_hub
      └── ...
```

## Updated EventMap (changed sections)

```typescript
// ── Memory generation metadata ────────────────────────────
type MemoryGeneration = {
  name: string;
  model: string;
  input: unknown[];
  output: { content: string | null };
  usage: { input: number; output: number; total: number };
  durationMs: number;
  startTime: number;
};

interface EventMap {
  // ... session, agent, turn, generation, tool events unchanged ...

  // ── Memory — observation (replaces memory.observation) ──
  "memory.observation.started":   { tokensBefore: number };
  "memory.observation.completed": { tokensBefore: number;
                                    tokensAfter: number;
                                    generation: MemoryGeneration };
  "memory.observation.failed":    { error: string };

  // ── Memory — reflection (replaces memory.reflection) ───
  "memory.reflection.started":    { level: number;
                                    tokensBefore: number };
  "memory.reflection.completed":  { level: number;
                                    tokensBefore: number;
                                    tokensAfter: number;
                                    generations: MemoryGeneration[] };
  "memory.reflection.failed":     { level: number;
                                    error: string };

  // ── Moderation (now emitted — previously dead types) ───
  "input.flagged": { categories: string[];
                     categoryScores: Record<string, number> };
  "input.clean":   { durationMs: number };
}
```

## Implementation plan

### Phase 1 — Fix usageDetails and output format (standalone, immediate value)

1. **Add missing `total` to `usageDetails`** (`src/infra/langfuse-subscriber.ts`).
   Extracted shared `nestGeneration()` helper with `{ input, output, total }`.

2. **Fix `setTraceIO` truncation** (`src/infra/langfuse-subscriber.ts`).
   Use `answerText` (already truncated) instead of raw `e.data.text`.

2b. **Format generation output as OpenAI ChatML** (`src/infra/langfuse-subscriber.ts`).
    Convert `{ content, toolCalls }` to `{ role, content, tool_calls }` for
    Langfuse playground compatibility.

2c. **Fix tool observation duration** (`src/infra/langfuse-subscriber.ts`).
    Use `Date.now()` for `endTime` instead of `startTime + durationMs`.

### Phase 2 — Observer/reflector return generation metadata

3. **Update `observe()` signature** (`src/agent/memory/observer.ts`).
   Return `ObserveResult` with `text` and `generation` fields. Capture
   `startTime`, `durationMs`, `usage` from `provider.chatCompletion()` response.

4. **Update `reflect()` signature** (`src/agent/memory/reflector.ts`).
   Return `ReflectResult` with `text` and `generations` array. Accumulate one
   `MemoryGeneration` per compression level.

### Phase 3 — Event type changes

5. **Replace memory events in `EventMap`** (`src/types/events.ts`).
   Remove `memory.observation` and `memory.reflection`. Add six lifecycle
   events: `memory.observation.started`/`.completed`/`.failed` and
   `memory.reflection.started`/`.completed`/`.failed`.
   Add `MemoryGeneration` type export.

6. **Update processor** (`src/agent/memory/processor.ts`).
   Emit `memory.observation.started` before `observe()`, emit
   `memory.observation.completed` after. Same pattern for reflection.
   Wrap in try/catch for `*.failed`.

7. **Enrich moderation event payloads** (`src/types/events.ts`).
   Add `categoryScores` to `input.flagged`. Add `durationMs` to `input.clean`.

8. **Emit moderation events from orchestrator** (`src/agent/orchestrator.ts`).
   Move `propagateAttributes` call to orchestrator (currently it lives in the
   Langfuse subscriber's `session.opened` handler). Create trace context
   before moderation, emit `input.flagged`/`input.clean` inside that context,
   then call `assertNotFlagged()`, then `runAgent()`. The guardrail attaches
   to the trace root — no `agentId` needed.

### Phase 4 — Subscriber updates

10. **Update Langfuse subscriber** (`src/infra/langfuse-subscriber.ts`).
    - Extract `nestGeneration()` helper for all generation spans.
    - Replace `memory.observation`/`memory.reflection` listeners with the six
      lifecycle event listeners. Add `memoryMap`.
    - Add `input.flagged`/`input.clean` listeners with buffered guardrail
      pattern — store moderation result, replay as guardrail child when
      `session.opened` creates the agent span.

11. **Update bridge subscriber** (`src/infra/log/bridge.ts`).
    Replace `memory.observation`/`memory.reflection` listeners with
    `memory.observation.completed`/`memory.reflection.completed`. Log output
    unchanged — extract `tokensBefore`/`tokensAfter` from new payload shape.

12. **Update JSONL subscriber** (if it references memory events by name).

### Phase 5 — Verification

13. **Update tests** for new event shapes and subscriber behavior.

14. **Manual verification** — run agent with Langfuse enabled, confirm:
    - Memory spans appear nested under turns with generation children
    - Moderation guardrail appears as first child of agent span
    - Token counts appear in Langfuse usage dashboard (input/output/total)
    - Generation output in OpenAI ChatML format with tool_calls
    - Tool observations show non-zero duration
    - Reflector multi-level loops produce multiple generation children
    - Flagged input produces WARNING-level guardrail with categories

## Files touched

| File | Action |
|------|--------|
| `src/infra/langfuse-subscriber.ts` | Modify — extract `nestGeneration()`, fix usageDetails (add `total`), ChatML output format, tool endTime, replace memory listeners with lifecycle events + `memoryMap`, buffered moderation guardrail |
| `src/types/events.ts`              | Modify — add `MemoryGeneration` type, replace memory.observation/memory.reflection with 6 lifecycle events, enrich moderation payloads |
| `src/agent/memory/observer.ts`     | Modify — return `ObserveResult` with generation metadata |
| `src/agent/memory/reflector.ts`    | Modify — return `ReflectResult` with generations array |
| `src/agent/memory/generation.ts`   | New — shared `buildMemoryGeneration()` helper |
| `src/agent/memory/processor.ts`    | Modify — emit memory lifecycle events, consume new return types, try/catch for graceful degradation |
| `src/agent/orchestrator.ts`        | Modify — emit `input.flagged`/`input.clean` moderation events |
| `src/infra/log/bridge.ts`          | Modify — update memory event listeners to `.completed` variants |
| `src/infra/log/jsonl.ts`           | No change — uses wildcard listener |

## Acceptance criteria

- [x] `usageDetails` uses `input`/`output`/`total` — verified in Langfuse dashboard that token counts and costs appear
- [x] `setTraceIO` output uses truncated text (consistent with agent observation)
- [x] Generation output in OpenAI ChatML format (`role`, `content`, `tool_calls` with `type`/`function`)
- [x] Tool observations show non-zero duration (endTime uses `Date.now()`)
- [x] Memory observer LLM call appears as a `generation` observation in Langfuse with model, input (system prompt + messages), output, and token usage
- [x] Memory reflector LLM calls appear as `generation` observations — one per compression level attempted
- [x] Observer generation is nested inside a `memory-observation` span
- [x] Reflector generations are nested inside a `memory-reflection-L{N}` span
- [x] `memory.observation.failed` / `memory.reflection.failed` produce ERROR-level spans in Langfuse
- [x] Observer/reflector errors don't crash the agent (graceful degradation)
- [x] `input.clean` produces a `guardrail` observation (pass) as first child of agent span (buffered pattern)
- [x] `input.flagged` produces a `guardrail` observation (fail) with WARNING level, flagged categories, and category scores
- [x] Moderation events buffered and replayed on `session.opened` (no agent context at emit time)
- [x] Console and markdown log output unchanged (bridge still logs token compression)
- [x] All existing tests pass
- [x] No new runtime dependencies