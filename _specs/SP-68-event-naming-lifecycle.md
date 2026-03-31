# SP-68 Event Naming & Lifecycle Alignment

## Main objective

Align the event system with `category.past_tense` naming conventions and
complete lifecycle triplets (`started`/`completed`/`failed`) across all event
domains. This spec addresses audit findings NOT covered by SP-67 (Langfuse
tracing).

## Context

An audit of `src/types/events.ts` against event system best practices revealed
several naming inconsistencies and missing lifecycle events. SP-67 already
handles:

- Replacing `plan.produced`/`turn.acted` with `generation.started`/`generation.completed`
- Splitting `memory.compressed` into `memory.observation`/`memory.reflection`
- Adding `agentId`, `parentAgentId`, `traceId`, `depth` to `BusEvent`
- Emitting `session.closed` on error

This spec covers the **remaining gaps**: naming fixes, missing lifecycle pairs,
session event split, and the `rootAgentId` field.

### What's wrong today

1. **Inconsistent naming.** `turn.began` and `turn.ended` don't follow the
   `started`/`completed` triplet pattern used everywhere else. `tool.dispatched`
   uses an implementation-detail verb instead of the domain action (`called`).
   `agent.answer` is not past tense.

2. **No agent lifecycle events.** Session events track the session container,
   but there's no event for "an agent instance started executing" or "an agent
   instance finished." This matters for nested agents (via delegate) where
   multiple agents share a session, and for Langfuse where each agent maps to
   a span.

3. **`session.closed` violates the "dedicated events" rule.** It uses
   `reason: "error"` with an optional `error` field — the same pattern the
   project explicitly rejects (see CLAUDE.md: "Prefer separate event types for
   distinct outcomes instead of a single event with a boolean discriminator").

4. **Missing `rootAgentId`.** The `BusEvent` envelope (after SP-67) carries
   `agentId` and `parentAgentId` but no `rootAgentId`. In deeply nested agent
   chains (A→B→C), consumers need the root to group all activity under one
   top-level trace without walking the parent chain.

5. **Missing `batch.started`.** `batch.completed` exists but has no opening
   counterpart. This prevents computing batch duration from event pairs and
   detecting hung batches.

6. **Metrics on wrong event.** `turn.acted` (soon `generation.completed` per
   SP-67) carries token counts and duration, but `turn.ended` — the actual
   completion event — carries no metrics. Best practice: completion events
   should carry the metrics.

## Dependency

- **SP-67 (Langfuse tracing)** must land first. This spec renames events that
  SP-67 introduces (`generation.started`/`generation.completed`) and modifies
  the envelope SP-67 extends. Applying these changes before SP-67 would create
  merge conflicts.

## Out of scope

- Streaming events (`stream.delta`/`stream.done`) — add when streaming is implemented
- `agent.cancelled`/`agent.waiting`/`agent.resumed` — add when cancellation/pause is implemented
- `batch.progress` — add when real-time batch progress tracking is needed
- Langfuse subscriber updates — SP-67 handles that integration

## Constraints

- All renames are **breaking** for subscribers — bridge, JSONL, and any
  SP-67 Langfuse subscriber must be updated atomically
- Existing logging output must remain identical after renames
- No new runtime dependencies
- All existing tests must pass (updated for new event names)

## Changes

### 1. Event renames

| Before | After | Rationale |
|--------|-------|-----------|
| `turn.began` | `turn.started` | Matches `started`/`completed`/`failed` triplet convention |
| `turn.ended` | `turn.completed` | Pairs with `turn.started` |
| `tool.dispatched` | `tool.called` | Domain action, not implementation detail |
| `agent.answer` | `agent.answered` | Past tense per naming convention |

Payloads are unchanged — only the key in `EventMap` changes.

### 2. Split `session.closed`

Remove `session.closed`. Add two dedicated events:

```typescript
"session.completed": {
  reason: "answer" | "max_iterations";
  iterations: number;
  tokens: { plan: TokenPair; act: TokenPair };
}

"session.failed": {
  iterations: number;
  tokens: { plan: TokenPair; act: TokenPair };
  error: string;   // always present, not optional
}
```

Benefits:
- Subscribers handle success and failure with separate listeners — no branching
- `error` is required on `session.failed` (not optional)
- `reason` on `session.completed` drops `"error"` — dead variant eliminated

### 3. Add agent lifecycle events

```typescript
"agent.started": {
  agentName: string;
  model: string;
  task: string;         // the user input / delegated prompt
  parentAgentId?: string;
  depth: number;
}

"agent.completed": {
  agentName: string;
  durationMs: number;
  iterations: number;
  tokens: { plan: TokenPair; act: TokenPair };
  result: string | null;
}

"agent.failed": {
  agentName: string;
  durationMs: number;
  iterations: number;
  error: string;
}
```

These are distinct from session events:
- **Session** = the container/conversation (may span multiple agent invocations)
- **Agent** = a specific execution instance within a session

For the current single-agent case, `agent.started`/`agent.completed` fire
alongside `session.opened`/`session.completed`. For delegated agents, child
agents emit their own lifecycle events within the parent's session.

### 4. Add `rootAgentId` to `BusEvent`

```typescript
interface BusEvent<T = unknown> {
  // ... existing fields ...
  rootAgentId?: string;   // top-level agent that started the chain
}
```

Population in `emit()`:
- Root agent (depth=0): `rootAgentId = agentId`
- Child agent: `rootAgentId` inherited from parent context

### 5. Add `batch.started`

```typescript
"batch.started": {
  batchId: string;       // UUID, shared with batch.completed
  callIds: string[];     // tool call IDs in this batch
  count: number;         // batch size
}
```

Update `batch.completed` to include `batchId`:

```typescript
"batch.completed": {
  batchId: string;       // matches batch.started
  count: number;
  durationMs: number;
  succeeded: number;
  failed: number;
}
```

### 6. Enrich `turn.completed` with metrics

```typescript
"turn.completed": {
  iteration: number;
  outcome: "continue" | "answer" | "max_iterations";
  durationMs: number;           // full turn duration (plan + act + tools)
  tokens: { plan: TokenPair; act: TokenPair };
}
```

This makes `turn.completed` the authoritative summary of a turn, carrying
both the outcome and the resource usage.

## Updated EventMap (final state after SP-67 + SP-68)

```typescript
interface EventMap {
  // ── Session ──────────────────────────────────────────────
  "session.opened":     { assistant: string; model: string; userInput?: string };
  "session.completed":  { reason: "answer" | "max_iterations";
                          iterations: number;
                          tokens: { plan: TokenPair; act: TokenPair } };
  "session.failed":     { iterations: number;
                          tokens: { plan: TokenPair; act: TokenPair };
                          error: string };

  // ── Agent lifecycle ────────────────────────────────────────
  "agent.started":      { agentName: string; model: string; task: string;
                          parentAgentId?: string; depth: number };
  "agent.completed":    { agentName: string; durationMs: number;
                          iterations: number;
                          tokens: { plan: TokenPair; act: TokenPair };
                          result: string | null };
  "agent.failed":       { agentName: string; durationMs: number;
                          iterations: number; error: string };
  "agent.answered":     { text: string | null };

  // ── Turn ─────────────────────────────────────────────────
  "turn.started":       { iteration: number; maxIterations: number;
                          model: string; messageCount: number };
  "turn.completed":     { iteration: number;
                          outcome: "continue" | "answer" | "max_iterations";
                          durationMs: number;
                          tokens: { plan: TokenPair; act: TokenPair } };

  // ── Generation (from SP-67) ────────────────────────────────
  "generation.started":   { name: string; model: string; startTime: number };
  "generation.completed": { name: string; model: string;
                            input: unknown[];
                            output: { content: string | null;
                                      toolCalls?: { id: string; name: string; arguments: string }[] };
                            usage: { input: number; output: number; total: number };
                            durationMs: number; startTime: number };

  // ── Tool execution ───────────────────────────────────────
  "tool.called":        { callId: string; name: string; args: string;
                          batchIndex: number; batchSize: number; startTime: number };
  "tool.succeeded":     { callId: string; name: string; durationMs: number;
                          result: string; args?: string; startTime?: number };
  "tool.failed":        { callId: string; name: string; durationMs: number;
                          error: string; args?: string; startTime?: number };
  "batch.started":      { batchId: string; callIds: string[]; count: number };
  "batch.completed":    { batchId: string; count: number; durationMs: number;
                          succeeded: number; failed: number };

  // ── Memory (from SP-67) ────────────────────────────────────
  "memory.observation": { tokensBefore: number; tokensAfter: number };
  "memory.reflection":  { level: number; tokensBefore: number;
                          tokensAfter: number };

  // ── Moderation ───────────────────────────────────────────
  "input.flagged":      { categories: string[] };
  "input.clean":        {};
}
```

## Implementation plan

### Phase 1 — Renames (mechanical, no behavioral changes)

1. **Rename events in `EventMap`** (`src/types/events.ts`).
   `turn.began` → `turn.started`, `turn.ended` → `turn.completed`,
   `tool.dispatched` → `tool.called`, `agent.answer` → `agent.answered`.

2. **Update all emit sites** (`src/agent/loop.ts`).
   Find-and-replace event type strings in `bus.emit()` calls.

3. **Update subscribers** (`src/infra/log/bridge.ts`, `src/infra/log/jsonl.ts`,
   `src/infra/langfuse-subscriber.ts`).
   Update `bus.on()` event type strings. Output behavior unchanged.

4. **Update tests** (`src/infra/events.test.ts`, `src/infra/log/bridge.test.ts`,
   `src/infra/log/jsonl.test.ts`).

### Phase 2 — Split session.closed

5. **Replace `session.closed` in `EventMap`** with `session.completed` and
   `session.failed`.

6. **Update emit sites** (`src/agent/loop.ts`).
   - Success path (`reason: "answer"` or `"max_iterations"`): emit `session.completed`
   - Error path: emit `session.failed` with required `error` field

7. **Update subscribers**.
   - Bridge: separate listeners for `session.completed` (→ `log.maxIter()` if
     reason is `max_iterations`) and `session.failed` (→ `log.error()`)
   - JSONL: event name change only
   - Langfuse: update mapping

8. **Update tests** for new event names and payloads.

### Phase 3 — Agent lifecycle events

9. **Add `agent.started`, `agent.completed`, `agent.failed` to `EventMap`**.

10. **Emit agent lifecycle events** (`src/agent/loop.ts`).
    - `agent.started`: emit at the top of `runAgent()`, after session setup,
      carrying agent name, model, user input, parent info, and depth.
    - `agent.completed`: emit in the success path before `session.completed`.
    - `agent.failed`: emit in the catch block before `session.failed`.

11. **Add bridge listeners** for agent lifecycle events.
    - `agent.started`: `log.info(...)` with agent name and model
    - `agent.completed`/`agent.failed`: no additional logging needed (session
      events already cover this for console/markdown output)

### Phase 4 — rootAgentId and batch.started

12. **Add `rootAgentId` to `BusEvent`** (`src/types/events.ts`).

13. **Add context accessor** (`src/agent/context.ts`).
    `getRootAgentId()` — same pattern as other accessors.

14. **Populate in emit** (`src/infra/events.ts`).
    Add `rootAgentId: getRootAgentId()` to envelope construction.

15. **Set rootAgentId in orchestrator** (`src/agent/orchestrator.ts`).
    - Root agent: `rootAgentId = agentId`
    - Child agent: `rootAgentId = parentRootAgentId` (passed from delegate)

16. **Add `batch.started` to `EventMap`**. Add `batchId` to `batch.completed`.

17. **Emit `batch.started`** (`src/agent/loop.ts`).
    Generate `batchId = randomUUID()` before tool dispatch. Emit with callIds
    array. Pass `batchId` through to `batch.completed`.

### Phase 5 — Enrich turn.completed

18. **Update `turn.completed` payload** in `EventMap`.
    Add `durationMs` and `tokens` fields.

19. **Capture turn timing and tokens** (`src/agent/loop.ts`).
    Record `turnStartTime` at `turn.started` emission. Accumulate plan/act
    token pairs. Pass both into `turn.completed`.

20. **Run full test suite**. Verify all tests pass, logging output unchanged.

## Files touched

| File | Action |
|------|--------|
| `src/types/events.ts` | Modify — renames, split session.closed, add agent lifecycle, add batch.started, enrich turn.completed, add rootAgentId |
| `src/agent/loop.ts` | Modify — update all emit calls, add agent lifecycle emissions, add batch.started, enrich turn.completed |
| `src/agent/context.ts` | Modify — add `getRootAgentId()` accessor |
| `src/agent/orchestrator.ts` | Modify — set `rootAgentId` on agent state |
| `src/infra/events.ts` | Modify — populate `rootAgentId` in envelope |
| `src/infra/log/bridge.ts` | Modify — update listener registrations for renamed events, split session listener |
| `src/infra/log/jsonl.ts` | Modify — update for renamed event types |
| `src/infra/langfuse-subscriber.ts` | Modify — update for renamed events (if SP-67 landed) |
| `src/tools/delegate.ts` | Modify — pass `rootAgentId` through to child |
| `src/infra/events.test.ts` | Modify — update event names in tests |
| `src/infra/log/bridge.test.ts` | Modify — update event names, add agent lifecycle tests |
| `src/infra/log/jsonl.test.ts` | Modify — update event names |

## Acceptance criteria

- [ ] `turn.began` → `turn.started`, `turn.ended` → `turn.completed` in EventMap and all emit/subscribe sites
- [ ] `tool.dispatched` → `tool.called` in EventMap and all emit/subscribe sites
- [ ] `agent.answer` → `agent.answered` in EventMap and all emit/subscribe sites
- [ ] `session.closed` replaced by `session.completed` and `session.failed` (no boolean discriminator)
- [ ] `session.failed` has required `error: string` field (not optional)
- [ ] `agent.started` emitted at agent execution start with name, model, task, depth
- [ ] `agent.completed` emitted on success with duration, iterations, tokens, result
- [ ] `agent.failed` emitted on error with duration, iterations, error
- [ ] `rootAgentId` field on `BusEvent`, auto-populated from context
- [ ] `batch.started` emitted before tool dispatch with batchId and callIds
- [ ] `batch.completed` includes matching `batchId`
- [ ] `turn.completed` carries `durationMs` and `tokens` metrics
- [ ] Console, markdown, and JSONL output unchanged (same visual output)
- [ ] All existing tests pass (updated for new event names)
- [ ] New tests for agent lifecycle events and batch.started