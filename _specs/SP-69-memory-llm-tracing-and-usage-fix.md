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

### Problem 2 — `usageDetails` field names are wrong

The Langfuse subscriber (`langfuse-subscriber.ts:179-182`) passes:

```typescript
usageDetails: {
  input: e.data.usage.input,
  output: e.data.usage.output,
}
```

Langfuse expects `input`, `output`, and `total` as `usageDetails` keys.
The original code was missing the `total` field — without it, Langfuse
cannot compute aggregate token counts properly. The keys `input`/`output`
are correct (Langfuse maps OpenAI's `prompt_tokens`→`input`,
`completion_tokens`→`output` internally).

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

**`memory.observation.completed`** — nest single generation, close span:
```typescript
const span = memoryMap.get(`${agentId}:observation`);
const gen = e.data.generation;
const genObs = span.startObservation(gen.name, {
  model: gen.model,
  input: gen.input,
  startTime: toDate(gen.startTime),
}, { asType: "generation" });
genObs.update({
  output: gen.output,
  usageDetails: {
    input: gen.usage.input,
    output: gen.usage.output,
    total: gen.usage.total,
  },
  endTime: toDate(gen.startTime + gen.durationMs),
});
genObs.end();
span.update({
  output: { tokensAfter: e.data.tokensAfter,
            compression: `${e.data.tokensBefore} → ${e.data.tokensAfter}` },
  endTime: toDate(Date.now()),
});
span.end();
memoryMap.delete(`${agentId}:observation`);
```

**`memory.reflection.started`** — create span:
```typescript
const span = parent.startObservation(`memory-reflection-L${e.data.level}`, {
  input: { level: e.data.level, tokensBefore: e.data.tokensBefore },
  startTime: toDate(Date.now()),
});
memoryMap.set(`${agentId}:reflection`, span);
```

**`memory.reflection.completed`** — nest N generations (one per level), close:
```typescript
const span = memoryMap.get(`${agentId}:reflection`);
for (const gen of e.data.generations) {
  const genObs = span.startObservation(gen.name, {
    model: gen.model,
    input: gen.input,
    startTime: toDate(gen.startTime),
  }, { asType: "generation" });
  genObs.update({
    output: gen.output,
    usageDetails: {
      promptTokens: gen.usage.input,
      completionTokens: gen.usage.output,
      totalTokens: gen.usage.total,
    },
    endTime: toDate(gen.startTime + gen.durationMs),
  });
  genObs.end();
}
span.update({
  output: { tokensAfter: e.data.tokensAfter,
            compression: `${e.data.tokensBefore} → ${e.data.tokensAfter}` },
  endTime: toDate(Date.now()),
});
span.end();
memoryMap.delete(`${agentId}:reflection`);
```

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

**Trace structure:** Moderation is a trace-level concern — it runs before
the agent starts and gates whether the agent runs at all. In Langfuse, the
guardrail observation is a sibling of the agent span, not nested inside it:

```
Trace (created in orchestrator, before moderation)
  ├── Guardrail: input-moderation    ← runs first
  └── Agent (session.opened)         ← only if moderation passes
      ├── Turn 1 ...
      └── Turn 2 ...
```

**Implementation in `orchestrator.ts`:**

The orchestrator already builds `traceId` and calls `propagateAttributes`.
The new flow creates the trace context first, then emits moderation events
within that context (so they carry `traceId`), then proceeds to `runAgent`:

```typescript
// orchestrator.ts
const traceId = opts.parentTraceId ?? randomUUID();

// Create trace context early — moderation and agent share it
propagateAttributes({ sessionId, traceName: assistantName }, () => {
  // Moderation runs inside trace context
  const moderationStart = Date.now();
  const moderation = await moderateInput(opts.prompt);
  const durationMs = Date.now() - moderationStart;

  if (moderation.flagged) {
    const flaggedCategories = Object.entries(moderation.categories)
      .filter(([, v]) => v)
      .map(([k]) => k);
    bus.emit("input.flagged", {
      categories: flaggedCategories,
      categoryScores: moderation.categoryScores,
    });
    assertNotFlagged(moderation);  // throws — agent never starts
  } else {
    bus.emit("input.clean", { durationMs });
  }

  // Agent starts only after moderation passes
  const result = await runAgent(state);
});
```

The `input.flagged`/`input.clean` events carry `traceId` from the
propagated context but no `agentId` (the agent hasn't started yet).
The Langfuse subscriber attaches the guardrail to the trace root, not
to an agent span.

**Flagged input:** When input is flagged, `assertNotFlagged()` throws
after the event is emitted. The trace in Langfuse shows just the
guardrail observation (fail) with no agent span — exactly the right
picture: moderation blocked this request.

**Langfuse mapping:** Both events fire inside the `propagateAttributes`
callback, so `otelContext.active()` already carries the trace context.
The guardrail attaches to the trace root via `startObservation` (top-level,
not nested under an agent):

```typescript
// input.clean → guardrail observation (pass)
bus.on("input.clean", (e) => {
  // No agentId yet — use trace-level context directly
  const guard = startObservation("input-moderation", {
    input: { check: "openai-moderation" },
  }, { asType: "guardrail" });
  guard.update({
    output: { passed: true },
    metadata: { durationMs: e.data.durationMs },
  });
  guard.end();
});

// input.flagged → guardrail observation (fail)
bus.on("input.flagged", (e) => {
  const guard = startObservation("input-moderation", {
    input: { check: "openai-moderation" },
  }, { asType: "guardrail" });
  guard.update({
    output: { passed: false, categories: e.data.categories },
    level: "WARNING",
    statusMessage: `Flagged: ${e.data.categories.join(", ")}`,
    metadata: { categoryScores: e.data.categoryScores },
  });
  guard.end();
});
```

This produces a `guardrail` observation at the trace root — sibling of
the agent span, not nested inside it. For flagged input the trace shows
only the failed guardrail (agent never started).

### 6. Fix `usageDetails` field names on all generation spans

In `langfuse-subscriber.ts`, the `generation.completed` handler (line ~179):

**Before:**
```typescript
usageDetails: {
  input: e.data.usage.input,
  output: e.data.usage.output,
},
```

**After:**
```typescript
usageDetails: {
  input: e.data.usage.input,
  output: e.data.usage.output,
  total: e.data.usage.total,
},
```

Langfuse expects `input`/`output`/`total` as usage keys (not
`promptTokens`/`completionTokens`). The fix adds the missing `total` field.
This applies to both existing plan/act generation spans AND the new memory
generation spans (which use the same field names via `MemoryGeneration`).

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
  ├── Guardrail: input-moderation                 ← NEW (pass/fail, categories)
  └── Agent (session.opened → session.completed)
      ├── Turn 1 (turn.started → turn.completed)
      │   ├── Generation: plan-llm
      │   ├── Generation: act-llm
      │   ├── Tool: web_search
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

Flagged input trace (agent never starts):
```
Trace (assistantName, sessionId)
  └── Guardrail: input-moderation [WARNING]
        output: { passed: false, categories: ["violence"] }
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

### Phase 1 — Fix usageDetails (standalone, immediate value)

1. **Fix `usageDetails` field names** (`src/infra/langfuse-subscriber.ts`).
   Change `input`/`output` keys to `promptTokens`/`completionTokens`/`totalTokens`
   in the `generation.completed` handler.

2. **Fix `setTraceIO` truncation** (`src/infra/langfuse-subscriber.ts`).
   Use `answerText` (already truncated) instead of raw `e.data.text`.

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
    - Replace `memory.observation`/`memory.reflection` listeners with the six
      lifecycle event listeners. Add `memoryMap`.
    - Add `input.flagged`/`input.clean` listeners — create `guardrail`
      observation type on the agent span.

11. **Update bridge subscriber** (`src/infra/log/bridge.ts`).
    Replace `memory.observation`/`memory.reflection` listeners with
    `memory.observation.completed`/`memory.reflection.completed`. Log output
    unchanged — extract `tokensBefore`/`tokensAfter` from new payload shape.

12. **Update JSONL subscriber** (if it references memory events by name).

### Phase 5 — Verification

13. **Update tests** for new event shapes and subscriber behavior.

14. **Manual verification** — run agent with Langfuse enabled, confirm:
    - Memory spans appear nested under turns with generation children
    - Moderation guardrail appears at top of agent trace
    - Token counts appear in Langfuse usage dashboard (promptTokens/completionTokens)
    - Reflector multi-level loops produce multiple generation children
    - Flagged input produces WARNING-level guardrail with categories

## Files touched

| File | Action |
|------|--------|
| `src/infra/langfuse-subscriber.ts` | Modify — fix usageDetails keys, fix setTraceIO, replace memory listeners, add memoryMap, add moderation guardrail listeners |
| `src/types/events.ts`              | Modify — replace memory.observation/memory.reflection with 6 lifecycle events, enrich moderation payloads, add MemoryGeneration type |
| `src/agent/memory/observer.ts`     | Modify — return ObserveResult with generation metadata |
| `src/agent/memory/reflector.ts`    | Modify — return ReflectResult with generations array |
| `src/agent/memory/processor.ts`    | Modify — emit memory lifecycle events, consume new return types |
| `src/agent/orchestrator.ts`        | Modify — create trace context early, emit moderation events inside it before runAgent |
| `src/infra/log/bridge.ts`          | Modify — update memory event listeners |
| `src/infra/log/jsonl.ts`           | Modify — update if memory events referenced by name |

## Acceptance criteria

- [ ] `usageDetails` uses `promptTokens`/`completionTokens`/`totalTokens` — verified in Langfuse dashboard that token counts and costs appear
- [ ] `setTraceIO` output uses truncated text (consistent with agent observation)
- [ ] Memory observer LLM call appears as a `generation` observation in Langfuse with model, input (system prompt + messages), output, and token usage
- [ ] Memory reflector LLM calls appear as `generation` observations — one per compression level attempted
- [ ] Observer generation is nested inside a `memory-observation` span
- [ ] Reflector generations are nested inside a `memory-reflection-L{N}` span
- [ ] `memory.observation.failed` / `memory.reflection.failed` produce ERROR-level spans in Langfuse
- [ ] Observer/reflector errors don't crash the agent (graceful degradation)
- [ ] `input.clean` produces a `guardrail` observation (pass) at the trace root, sibling of the agent span
- [ ] `input.flagged` produces a `guardrail` observation (fail) with WARNING level, flagged categories, and category scores
- [ ] Flagged input trace shows only the failed guardrail (no agent span)
- [ ] Moderation events fire inside the trace context (carry `traceId`, no `agentId` needed)
- [ ] Console and markdown log output unchanged (bridge still logs token compression)
- [ ] All existing tests pass
- [ ] No new runtime dependencies