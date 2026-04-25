# SP-88 Async delegation with run continuation

## Main objective

Make delegation non-blocking: the parent run parks with `status='waiting'`
while the child runs independently, and a single global event subscriber
bridges child terminal exits to parent resumption. This is the payoff that
SP-87's Run primitive was built for.

## Context

SP-87 delivered the Run concept — `runs` table, `RunExit` union,
`WaitDescriptor`, `WaitRequested`, `resumeRun()`, per-run message isolation,
and HITL confirmation rewired onto it. Everything works.

But delegation (`src/tools/delegate.ts`) is still **synchronous**: it calls
`executeRun()`, blocks the parent's tool dispatch, and waits for the child
to return. If the child hits HITL or exceeds time limits, the parent is
stuck in a blocked `dispatch()` call, not in a durable `waiting` state.
The parent can't be resumed across process restarts, can't be cancelled
independently, and can't be traced separately.

The `child_run` variant already exists in `WaitDescriptor` (line 17 of
`wait-descriptor.ts`) and `WaitResolution` (line 34), and `resume-run.ts`
has a reserved code path for it (line 87-95). It's all stubbed. This spec
wires it up.

### What exists today

| Piece | File | Status |
|-------|------|--------|
| `runs` table with `parentId`, `sourceCallId`, `status`, `waitingOn` | `infra/db/schema.ts:19-49` | Done (SP-87) |
| `RunExit` with 5 exit kinds including `waiting` | `agent/run-exit.ts` | Done |
| `WaitDescriptor.child_run` variant | `agent/wait-descriptor.ts:16-18` | Stubbed, never thrown |
| `WaitResolution.child_run` variant | `agent/wait-descriptor.ts:33-36` | Stubbed |
| `resumeRun()` with `child_run` code path | `agent/resume-run.ts:87-95` | Stubbed: injects `resolution.result` as tool-result messages |
| `delegate.ts` tool | `tools/delegate.ts` | Synchronous: `await executeRun()` then return result |
| `executeRun()` creates child run row with `parentId` + `sourceCallId` | `agent/orchestrator.ts:87-94` | Done |
| `bus.emit('run.waiting', ...)` on waiting exit | `agent/orchestrator.ts:180` | Done |
| Event bus with `run.completed`, `run.failed` events | `types/events.ts:26-35` | Done, but no subscriber bridges child→parent |
| Bootstrap wiring | `infra/bootstrap.ts` | No continuation subscriber registered |
| `rootRunId` in `RunState` context | `types/run-state.ts:13` | In-memory only; not persisted in `runs` table |

### What this spec adds

1. **`rootRunId` column** on the `runs` table — persists the tree root.
2. **`findRunWaitingOnChild(childRunId)` DB query** — the lookup the subscriber needs.
3. **`delegate.ts` throws `WaitRequested`** instead of blocking on `executeRun()`.
4. **Global continuation subscriber** — one handler, registered at bootstrap,
   listening to terminal `run.*` events, calling `resumeRun()` on the parent.
5. **Startup reconciliation sweep** — on boot, find orphaned parents whose
   children are already terminal but the parent was never woken.
6. **New events** for delegation lifecycle: `run.delegated`, `run.child_terminal`.

## Out of scope

- Additional wait kinds (sandbox writeback, file upload, external API).
- Memory scopes keyed to `rootRunId`.
- Cancellation propagation (cancel parent → cancel children). Will need its
  own spec — the DB pointers are already there to traverse the tree.
- Event outbox with durable delivery. The in-process bus is sufficient for
  single-process deployment. The reconciliation sweep handles crash gaps.
- Parallel child runs (fan-out). One child per delegation call.
- MCP code mode or tool profile indirection.

## Constraints

- **Single migration.** One SQL file adding `root_run_id` column and index.
- **delegate.ts stays a normal tool.** It returns a `ToolResult` to the loop
  (indicating delegation was initiated), then the loop sees `WaitRequested`
  thrown by the confirmation-like signal. Actually: the cleanest approach is
  that `delegate.ts` handler itself throws `WaitRequested` after creating
  the child run. The loop catches it the same way it catches HITL waits.
- **`resumeRun()` is the single resume entry point.** No special path for
  child-run completion — it flows through the same `resumeRun()` that HITL
  uses, just with `kind: 'child_run'`.
- **Idempotent resume.** If `resumeRun()` is called twice for the same run
  (e.g., subscriber fires twice, startup sweep replays), the second call is
  a no-op. The existing `status !== 'waiting'` guard in `resume-run.ts:33`
  handles this — but we tighten it to return gracefully rather than throw.
- **`bun test` passes at merge.**

## Design

### 1. Migration: add `root_run_id`

```sql
ALTER TABLE `runs` ADD COLUMN `root_run_id` text
  REFERENCES `runs`(`id`);
CREATE INDEX `idx_runs_root` ON `runs` (`root_run_id`);

-- Backfill: runs with no parent are their own root
UPDATE `runs` SET `root_run_id` = `id` WHERE `parent_id` IS NULL;
```

After migration, `rootRunId` is always set for new runs. Existing parent
runs from before this migration get `root_run_id = id` via backfill.

### 2. Schema + DB ops changes

**`schema.ts`**: add `rootRunId` column to `runs` table, add index.

**`types/db.ts`**: add `rootRunId: string | null` to `DbRun`, add
`rootRunId?: string` to `CreateRunOpts`.

**`infra/db/index.ts`**: 
- `createRun()` accepts and persists `rootRunId`.
- New query: `findRunWaitingOnChild(childRunId: string): DbRun | null`
  ```ts
  SELECT * FROM runs
  WHERE status = 'waiting'
    AND json_extract(waiting_on, '$.kind') = 'child_run'
    AND json_extract(waiting_on, '$.childRunId') = ?
  LIMIT 1
  ```
- New query: `findOrphanedWaitingRuns(): DbRun[]` — runs with
  `status='waiting'` + `waitingOn.kind='child_run'` where the child run
  is in a terminal status. Used by reconciliation sweep.

### 3. Orchestrator changes

**`executeRun()`** (`orchestrator.ts`):
- Accept `rootRunId` in `ExecuteRunOpts` (rename `parentRootRunId`).
- Persist it: `dbOps.createRun({ ..., rootRunId: opts.rootRunId ?? runId })`.
- Root runs get `rootRunId = id`. Child runs inherit parent's `rootRunId`.

### 4. Delegate tool: throw instead of block

**`tools/delegate.ts`** — rewrite the handler:

```ts
async function delegate(args, ctx): Promise<ToolResult> {
  const { agent, prompt } = args;
  assertMaxLength(prompt, "prompt", MAX_PROMPT_LENGTH);

  // 1. Create the child run (returns immediately with runId)
  const child = await executeRun({
    prompt,
    assistant: agent,
    parentRunId: getRunId(),
    rootRunId: getRootRunId(),
    parentTraceId: getTraceId(),
    parentDepth: getDepth(),
    sourceCallId: ctx?.toolCallId,
  });

  // ... wait, this is the problem. executeRun() runs the full loop.
  // We need it to *create* the child and *start* it, but the parent
  // should not await the child's loop.
}
```

**The challenge:** `executeRun()` both creates the run AND enters the loop.
We need to split it. Two options:

**Option A: Split `executeRun` into `createRun` + `startRun`.**
- `createRun(opts)` → creates DB row, session, appends user message, returns
  `{ runId, sessionId }`.
- `startRun(runId)` → loads state from DB, enters `runAndPersist()`, returns
  `ExecuteRunResult`. This is what CLI/Slack/HTTP call after `createRun`.
- `delegate.ts` calls `createRun()` to get the child's `runId`, throws
  `WaitRequested({ kind: 'child_run', childRunId })`, and then the
  continuation subscriber calls `startRun(childRunId)` when it's ready to
  schedule the child.

**Problem with Option A:** adds complexity for sequencing — who starts the
child? The continuation subscriber would need to both start children and
resume parents, conflating two responsibilities.

**Option B (chosen): delegate starts the child on a detached async path.**
- `delegate.ts` calls `executeRun()` but does NOT await it. Instead:
  1. Create child run row with `status='pending'`.
  2. Schedule child execution via `setImmediate` / `queueMicrotask` so it
     runs outside the parent's tool dispatch.
  3. Throw `WaitRequested({ kind: 'child_run', childRunId })`.
  4. Parent parks. Child runs on its own async path. When child reaches a
     terminal state, the continuation subscriber resumes the parent.

Actually, the simplest correct approach:

**Option C (chosen): delegate creates and starts the child, then throws.**
- `delegate.ts`:
  1. Creates child run via a new `createChildRun(opts)` that only does the
     DB insert + user message append (no loop entry). Returns `childRunId`.
  2. Throws `WaitRequested({ kind: 'child_run', childRunId })`.
- The loop catches `WaitRequested`, parent goes `waiting`.
- A **post-wait hook** in the orchestrator (after persisting `waiting` status)
  checks: if `waitingOn.kind === 'child_run'`, start the child's loop
  asynchronously via `startChildRun(childRunId)` (fire-and-forget promise).
- `startChildRun()` loads the child's state from DB and calls
  `runAndPersist()`. When it completes, the normal terminal event fires,
  and the continuation subscriber resumes the parent.

This keeps `executeRun()` unchanged for root runs (CLI, Slack, HTTP all
still call it the same way). Only delegation uses the split path.

### 5. New functions

**`src/agent/orchestrator.ts`**:

```ts
/**
 * Create a child run row and append the user message, but do NOT enter
 * the loop. Returns the child runId. The caller is responsible for
 * starting execution (typically via startChildRun after the parent parks).
 */
export async function createChildRun(opts: ExecuteRunOpts): Promise<{
  runId: string;
  sessionId: string;
}> {
  // Same setup as executeRun lines 52-104 (session, moderation, DB insert,
  // user message append), but stops before building RunState and calling
  // runAndPersist.
}

/**
 * Load a pending/running run from DB and enter the loop. Used to start
 * child runs after the parent has parked, and by the reconciliation sweep.
 */
export async function startChildRun(runId: string): Promise<ExecuteRunResult> {
  const run = dbOps.getRun(runId);
  // Build RunState from DB row
  // Call runAndPersist(state)
}
```

### 6. Post-wait child dispatch

In `runAndPersist()` (`orchestrator.ts`), after persisting the `waiting`
status, check if the wait is a `child_run` and schedule its execution:

```ts
case "waiting":
  dbOps.updateRunStatus(runId, {
    status: "waiting",
    waitingOn: JSON.stringify(exit.waitingOn),
  });
  bus.emit("run.waiting", { waitingOn: exit.waitingOn });

  // If waiting on a child run, start the child asynchronously
  if (exit.waitingOn.kind === "child_run") {
    startChildRun(exit.waitingOn.childRunId).catch((err) => {
      // Child failed to start — resume parent with error
      resumeRun(state.runId!, {
        kind: "child_run",
        childRunId: exit.waitingOn.childRunId,
        result: `Child run failed to start: ${err.message}`,
      }).catch(console.error);
    });
  }
  break;
```

### 7. Global continuation subscriber

**`src/agent/run-continuation.ts`** (new file):

```ts
import { bus } from "../infra/events.ts";
import { resumeRun } from "./resume-run.ts";
import * as dbOps from "../infra/db/index.ts";

/**
 * Register the global continuation subscriber. Called once at process
 * startup from bootstrap.ts. Listens for terminal run events and
 * resumes any parent that was waiting on the completed child.
 */
export function registerContinuationSubscriber(): void {
  bus.on("run.completed", handleChildTerminal);
  bus.on("run.failed",    handleChildTerminal);
  // run.cancelled and run.exhausted are also terminal
  // but currently only emitted as exit kinds, not separate events.
  // When they get their own events, add them here.
}

async function handleChildTerminal(
  event: BusEvent<{ [k: string]: unknown }>
): Promise<void> {
  const childRunId = event.runId;
  if (!childRunId) return;

  const parent = dbOps.findRunWaitingOnChild(childRunId);
  if (!parent) return; // root run or parent not waiting

  const childRun = dbOps.getRun(childRunId);
  if (!childRun) return;

  const result = childExitToResult(childRun);

  bus.emit("run.child_terminal", {
    parentRunId: parent.id,
    childRunId,
    childStatus: childRun.status,
  });

  try {
    await resumeRun(parent.id, {
      kind: "child_run",
      childRunId,
      result,
    });
  } catch (err) {
    console.error(
      `[continuation] Failed to resume parent ${parent.id} after child ${childRunId}:`,
      err,
    );
  }
}

function childExitToResult(child: DbRun): string {
  switch (child.status) {
    case "completed":
      return child.result ?? "(no result)";
    case "failed":
      return `Delegated run failed: ${child.error ?? "unknown error"}`;
    case "cancelled":
      return `Delegated run was cancelled: ${child.error ?? "no reason"}`;
    case "exhausted":
      return `Delegated run hit cycle limit (${child.cycleCount} cycles)`;
    default:
      return `Delegated run ended with unexpected status: ${child.status}`;
  }
}

/**
 * Startup reconciliation: find parents waiting on children that are
 * already terminal, and resume them. Handles crash-gap scenarios where
 * the child completed but the subscriber didn't fire (or fired but
 * the resume failed).
 */
export async function reconcileOrphanedWaits(): Promise<void> {
  const orphaned = dbOps.findOrphanedWaitingRuns();
  for (const parent of orphaned) {
    const waitingOn = JSON.parse(parent.waitingOn!) as WaitDescriptor;
    if (waitingOn.kind !== "child_run") continue;

    const child = dbOps.getRun(waitingOn.childRunId);
    if (!child) continue;

    console.log(
      `[reconcile] Resuming orphaned parent ${parent.id} (child ${child.id} is ${child.status})`,
    );

    try {
      await resumeRun(parent.id, {
        kind: "child_run",
        childRunId: child.id,
        result: childExitToResult(child),
      });
    } catch (err) {
      console.error(`[reconcile] Failed to resume ${parent.id}:`, err);
    }
  }
}
```

### 8. Bootstrap wiring

**`infra/bootstrap.ts`**: add two lines to `initServices()`:

```ts
import { registerContinuationSubscriber, reconcileOrphanedWaits } from "../agent/run-continuation.ts";

export async function initServices(): Promise<void> {
  // ... existing lines ...
  registerContinuationSubscriber();
  await reconcileOrphanedWaits();
}
```

### 9. Resume-run hardening

**`resume-run.ts`** changes:

1. **Idempotent on non-waiting status.** Change lines 32-33 from throwing
   to returning a graceful no-op:
   ```ts
   if (run.status !== "waiting") {
     // Already resumed (idempotent) — return current state
     return {
       exit: dbRunToExit(run),
       sessionId: run.sessionId,
       runId,
     };
   }
   ```
   This makes the reconciliation sweep and double-fired events safe.

2. **`rootRunId` reconstruction.** Line 124 currently has
   `rootRunId: runId` as "best-effort." Fix it to read from the DB:
   ```ts
   rootRunId: run.rootRunId ?? runId,
   ```

### 10. Event additions

**`types/events.ts`**: add new events:

```ts
"run.delegated": {
  parentRunId: string;
  childRunId: string;
  childAgent: string;
  task: string;
};
"run.child_terminal": {
  parentRunId: string;
  childRunId: string;
  childStatus: RunStatus;
};
```

These are for observability only (Langfuse, logs). They don't drive logic.

### 11. Delegate tool rewrite

**`tools/delegate.ts`**:

```ts
async function delegate(args, ctx): Promise<ToolResult> {
  const { agent, prompt } = args;
  assertMaxLength(prompt, "prompt", MAX_PROMPT_LENGTH);
  if (!prompt.trim()) throw new Error("prompt must not be empty");

  const child = await createChildRun({
    prompt,
    assistant: agent,
    parentRunId: getRunId(),
    rootRunId: getRootRunId(),
    parentTraceId: getTraceId(),
    parentDepth: getDepth(),
    sourceCallId: ctx?.toolCallId,
  });

  bus.emit("run.delegated", {
    parentRunId: getRunId()!,
    childRunId: child.runId,
    childAgent: agent,
    task: prompt,
  });

  // Park the parent — the continuation subscriber will resume it
  // when the child reaches a terminal state.
  throw new WaitRequested({
    kind: "child_run",
    childRunId: child.runId,
  });
}
```

Note: the tool throws `WaitRequested`, which means the loop catches it,
the parent exits `waiting`, and `runAndPersist` persists the status and
starts the child asynchronously.

### 12. Nested delegation trace

With `rootRunId` persisted, the full tree is queryable:

```sql
-- All runs in a delegation tree
SELECT * FROM runs WHERE root_run_id = ? ORDER BY created_at;

-- Parent chain for a given run
WITH RECURSIVE chain AS (
  SELECT * FROM runs WHERE id = ?
  UNION ALL
  SELECT r.* FROM runs r JOIN chain c ON r.id = c.parent_id
)
SELECT * FROM chain;
```

## Acceptance criteria

### Schema

- [ ] Migration adds `root_run_id` column with FK, index, and backfill.
- [ ] `DbRun` type includes `rootRunId`.
- [ ] `CreateRunOpts` accepts `rootRunId`.
- [ ] `createRun()` persists `rootRunId`.

### Async delegation

- [ ] `delegate.ts` does not await the child's loop. It creates the child
      run, throws `WaitRequested`, and returns.
- [ ] Parent run transitions `running → waiting` with
      `waitingOn: { kind: 'child_run', childRunId }`.
- [ ] Child run executes asynchronously after parent parks.
- [ ] On child terminal exit, parent is resumed with the child's result
      injected as a synthetic tool-result message for the `delegate` call.
- [ ] Parent continues its loop from where it left off.

### Continuation subscriber

- [ ] Single global subscriber registered in `bootstrap.ts`.
- [ ] Listens to `run.completed` and `run.failed` (terminal events).
- [ ] Looks up parent via `findRunWaitingOnChild(childRunId)`.
- [ ] Calls `resumeRun(parentId, { kind: 'child_run', ... })`.
- [ ] No-op if no parent is waiting (root run).

### Crash safety

- [ ] `resumeRun()` is idempotent: second call for an already-resumed run
      returns gracefully instead of throwing.
- [ ] `reconcileOrphanedWaits()` runs on startup and resumes any parents
      whose children are already terminal.
- [ ] Process crash between child completion and parent resume is handled
      by the reconciliation sweep.

### Nested delegation

- [ ] A → B → C delegation works: C completes → B resumes → B completes
      → A resumes → A completes. Each step is one subscriber invocation.
- [ ] All three runs share the same `rootRunId`.
- [ ] A run waiting on a child that is itself waiting stays parked until
      the full chain unwinds.

### Events

- [ ] `run.delegated` emitted when delegation is initiated.
- [ ] `run.child_terminal` emitted when the subscriber bridges a child
      completion to a parent resume.

### Tests

- [ ] `bun test` passes.
- [ ] Test: simple delegation — parent delegates to child, child completes,
      parent resumes with child's result. DB rows show correct `parentId`,
      `rootRunId`, status transitions.
- [ ] Test: child failure — child fails, parent resumes with error message
      in tool result.
- [ ] Test: nested delegation — A → B → C, verify each level resumes
      correctly in sequence.
- [ ] Test: idempotent resume — calling `resumeRun` twice for the same
      parent after a child completes does not throw or double-inject messages.
- [ ] Test: `findRunWaitingOnChild` returns the correct parent, returns
      null for root runs.
- [ ] Test: `reconcileOrphanedWaits` resumes a parent whose child completed
      while the process was down.

## Implementation plan

1. **Migration.** Add `root_run_id` column, index, backfill.
2. **DB ops.** Add `rootRunId` to `createRun`, add `findRunWaitingOnChild`,
   add `findOrphanedWaitingRuns`.
3. **Orchestrator split.** Extract `createChildRun()` from `executeRun()`.
   Add `startChildRun()`. Add post-wait child dispatch in `runAndPersist()`.
4. **Delegate tool.** Rewrite to call `createChildRun()` + throw
   `WaitRequested`.
5. **Continuation subscriber.** New file `run-continuation.ts`. Register in
   `bootstrap.ts`. Add `reconcileOrphanedWaits`.
6. **Resume hardening.** Make `resumeRun` idempotent. Fix `rootRunId`
   reconstruction.
7. **Events.** Add `run.delegated` and `run.child_terminal` to `EventMap`.
   Wire into Langfuse subscriber and log bridge if desired.
8. **Tests.** Cover all acceptance criteria.

## Testing scenarios

1. **Simple delegation via CLI.** `bun run agent "delegate to researcher:
   find X"` — parent parks, child runs, parent resumes, final answer
   displayed. Check session log shows both runs.

2. **Child failure.** Child agent hits a tool error and exits `failed`.
   Parent resumes with an error tool-result, decides what to do next
   (retry, answer with partial info, etc.).

3. **Nested delegation.** Agent A delegates to B, B delegates to C. C
   completes → B resumes and completes → A resumes and completes. Three
   runs in the DB, all sharing `rootRunId`.

4. **Child HITL.** Child hits a confirmation gate, parks. Human approves
   (via CLI/Slack). Child resumes, completes. Parent resumes. Tests that
   the nested-wait case (parent waiting on child, child waiting on human)
   works correctly — parent stays parked until the full chain unwinds.

5. **Crash recovery.** Start a delegation, kill the process after the child
   completes but before the parent resumes. Restart. Reconciliation sweep
   detects the orphan and resumes the parent.

6. **No regression.** `bun run agent "simple prompt"` (no delegation)
   behaves identically to before this change.

## Risks

- **Single-process assumption.** The fire-and-forget child dispatch and
  in-process event bus assume one process. If we ever split to multiple
  workers, we need the event outbox pattern (SP-98). The reconciliation
  sweep is a safety net, not a substitute.

- **Session sharing.** Currently `delegate.ts` does not pass `sessionId`
  to `createChildRun`, so the child gets its own session. This is
  intentional for isolation, but means the child can't see the parent's
  message history. If we want shared-session delegation later, we add an
  option — but that's out of scope here.

- **Unbounded nesting.** No depth limit on delegation chains. The existing
  `depth` counter in `RunState` tracks it, and we could add a max-depth
  guard in `createChildRun`. Not adding it in this spec since agent
  definitions already control which agents can delegate to whom.