# SP-92 Replace WaitRequested error with return-value signaling

## Main objective

Eliminate exception-based flow control for run pausing by replacing the
`WaitRequested` error class with return values at every layer (confirmation
gate, tool dispatch, registry, loop), making the wait signal explicit and
impossible to accidentally swallow.

## Context

The agent loop can pause ("park") a run for two reasons today:

1. **User approval** — `confirmBatch()` detects tool calls needing operator
   confirmation and throws `WaitRequested` with `kind: "user_approval"`.
2. **Child delegation** — the `delegate` tool handler throws `WaitRequested`
   with `kind: "child_run"` after creating a child run.

The throw propagates through 3–4 stack frames:
- `confirmation.ts:101` or `delegate.ts:49` → throw
- `registry.ts:153` → re-throw (special-case `instanceof` check)
- `loop.ts:207` → re-throw from `Promise.allSettled` rejected outcome
- `loop.ts:298` → catch & convert to `CycleOutcome.waiting`
- `loop.ts:434` → outer defensive catch (safety net)

**Problems:**
- Any intermediate `catch` that omits `instanceof WaitRequested` silently
  swallows the pause signal — a latent bug waiting to happen.
- When `confirmBatch` throws, auto-approved calls in the same batch are
  discarded. They must be re-dispatched after resume.
- The registry must special-case `WaitRequested` in its generic error handler.
- Three `instanceof` catch sites form a fragile chain.

The Wonderlands reference server uses pure return-value flow control: tools
return `ToolOutcome = { kind: 'immediate' } | { kind: 'waiting' }`, the loop
inspects return values and returns `WaitingRunExecutionOutput`. No exceptions
for control flow.

## Out of scope

- Adding new wait kinds (upload, timeout, external) — future specs.
- Changing `WaitDescriptor` / `WaitResolution` types — they stay as-is.
- Changing DB schema or persistence logic.
- Changing event types or the event bus.

## Constraints

- Zero new dependencies.
- `WaitDescriptor` and `WaitResolution` types are unchanged — only the
  signaling mechanism changes.
- `RunExit`, `CycleOutcome`, and `LoopResult` shapes stay the same — callers
  of `runAgent()` see no difference.
- The `delegate` tool must remain a normal `ToolDefinition` handler — no
  special interface beyond the new return type.
- At most one `WaitDescriptor` per batch. If multiple tools in a batch return
  wait descriptors, take the first one found. (In practice only one delegate
  call per batch is expected; this constraint codifies that assumption.)

## Acceptance criteria

- [ ] `WaitRequested` error class is deleted; no `instanceof WaitRequested`
      anywhere in the codebase.
- [ ] `confirmBatch()` returns instead of throwing. When gated calls exist,
      `GateResult.waitingOn` is set alongside the `approved` list.
- [ ] Auto-approved tool calls execute immediately even when gated calls exist
      in the same batch. Their tool-result messages are recorded in
      `state.messages` before the run parks — so `findPendingToolCalls()`
      on resume naturally skips them.
- [ ] `delegate` tool returns a `ToolResult` with a `wait` field instead of
      throwing. The dispatch layer reads this field.
- [ ] `registry.ts tryDispatch()` has no special-case for wait errors — the
      generic error handler is clean.
- [ ] `dispatchTools()` collects wait descriptors from tool outcomes via return
      values, not by scanning `Promise.allSettled` rejections.
- [ ] `runCycle()` has no try/catch for wait signaling — it reads the return
      value from `dispatchTools()`.
- [ ] `runAgent()` outer catch has no `instanceof WaitRequested` branch.
- [ ] Resume path (`resume-run.ts`, `run-continuation.ts`) works unchanged.
      On resume after partial execution, `findPendingToolCalls()` sees only
      the unanswered gated calls because auto-approved results are already
      in the message history.
- [ ] All existing tests pass.

## Implementation plan

### Phase 1 — Type extensions

1. In `src/types/tool-result.ts`, add optional `wait?: WaitDescriptor` to
   `ToolResult`. When present, the dispatch layer treats it as a park signal.

2. In `src/types/tool.ts`, add optional `wait?: WaitDescriptor` to
   `DispatchResult`. Registry propagates `ToolResult.wait` here.

3. In `src/types/confirmation.ts`, add optional `waitingOn?: WaitDescriptor`
   to `GateResult`. No new type — just extend the existing interface.

### Phase 2 — Signal sources + consumers (do together to avoid broken state)

4. **confirmation.ts**: Replace the `throw new WaitRequested(...)` with
   `return { approved: autoApproved, denied: [], waitingOn: { ... } }`.
   The `approved` list now contains only auto-approved calls; gated calls
   are not in either list (they remain pending in `pendingConfirmations`).

5. **delegate.ts**: Return `ToolResult` with `wait` set instead of throwing:
   ```typescript
   return {
     content: [{ type: "text", text: `Delegated to ${agent} (run ${child.runId})` }],
     wait: { kind: "child_run", childRunId: child.runId },
   };
   ```

6. **registry.ts**: Remove the `instanceof WaitRequested` re-throw from
   `tryDispatch()`. After successful dispatch, if `ToolResult.wait` is set,
   propagate it to `DispatchResult.wait`.

7. **loop.ts `dispatchTools()`**: Change return type from `void` to
   `WaitDescriptor | undefined`. New flow:
   a. Call `confirmBatch()` — check `result.waitingOn`, not catch.
   b. Execute `result.approved` calls (works for both gated and non-gated
      batches — when gated, `approved` has only auto-approved calls).
   c. Record all tool outcomes via `recordToolOutcome()` — this persists
      tool-result messages in `state.messages`.
   d. If `result.waitingOn` is set, return it.
   e. Scan settled results for any `DispatchResult.wait`. If found, return
      the first one.
   f. Otherwise return `undefined`.

8. **loop.ts `runCycle()`**: Replace try/catch with:
   ```typescript
   const waitingOn = await dispatchTools(functionCalls);
   if (waitingOn) return { kind: "waiting", waitingOn };
   return { kind: "continue" };
   ```

9. **loop.ts `runAgent()`**: Remove `instanceof WaitRequested` from outer
   catch.

### Phase 3 — Cleanup & tests

10. Delete `WaitRequested` class from `wait-descriptor.ts`.
11. Remove all `WaitRequested` imports.
12. Update tests to assert on return values instead of thrown errors.
13. Add test: mixed batch (1 gated + 1 safe) — verify safe call executes
    and its result message is recorded before the run parks.
14. Add test: resume after partial execution — verify only gated calls
    are re-dispatched.
15. Run full test suite.

## Design notes

**Partial execution and resume correctness**: When a batch has both
auto-approved and gated calls, the auto-approved calls execute and their
tool-result messages are appended to `state.messages` via `recordToolOutcome()`
before the run parks. On resume, `findPendingToolCalls()` in `resume-run.ts`
walks backward through messages to find unanswered tool calls — it naturally
skips calls that already have result messages. No changes to the resume path
are needed; the existing logic handles this correctly.

**Batch events**: When a batch is partially executed (auto-approved only),
`emitBatchStarted` and `emitBatchCompleted` cover only the auto-approved
subset. Gated calls emit no batch events until they execute on resume.

**Single wait per batch**: At most one `WaitDescriptor` is returned per
`dispatchTools()` call. If `confirmBatch` returns `waitingOn`, that takes
precedence. If tool execution produces a `wait` (e.g. delegate), the first
one found wins. Multiple waits in a single batch are not expected in practice
(the LLM would need to call delegate twice in one response).

## Testing scenarios

| Criterion | Scenario | Verification |
|-----------|----------|--------------|
| confirmBatch returns waitingOn | Batch with 1 gated + 1 safe call | Assert `waitingOn` set, `approved` has safe call only |
| Auto-approved execute before park | Same batch | Assert safe call dispatched, result message in `state.messages` |
| Delegate returns wait | Call delegate tool | Assert `ToolResult.wait` set, no exception thrown |
| Registry clean dispatch | Tool returns wait-bearing result | Assert `DispatchResult.wait` set, no re-throw |
| Loop reads return value | dispatchTools returns WaitDescriptor | Assert `CycleOutcome.kind === "waiting"` |
| No WaitRequested anywhere | Codebase grep | Zero matches |
| Resume after partial exec | Park with 1 executed + 1 gated, then resume | Only gated call dispatched on resume |
| Resume after delegation | Park via delegate → child completes → resume | Parent run reaches `completed` |
| Multiple tools, one waits | Batch: [normal_tool, delegate] | normal_tool executes, delegate's wait returned |
