# SP-94 DB transactions, pragmas, and tx threading

## Main objective

Make multi-step DB writes atomic by wrapping them in transactions, set the
missing SQLite pragmas (`synchronous = NORMAL`, `busy_timeout = 5000`), and
thread an optional `tx` parameter through every `dbOps` helper so future call
sites can compose transactions freely.

## Context

Today, multi-step writes against the runs/sessions/items tables are sequences
of independent statements with no atomicity guarantee. A crash, OOM, or PM2
restart between any two writes leaves the DB half-applied. Concrete windows:

- `src/agent/orchestrator.ts:198–203` (executeRun setup): 5 separate writes
  across `runs`, `sessions`, and `items`. A crash mid-block leaves a `pending`
  run row that the `reconcileOrphanedWaits` sweep does not catch.
- `src/agent/orchestrator.ts:225–226` (runAndPersist tail): items batch-INSERT
  followed by run status UPDATE. Crash between them leaves a run that looks
  `running` while it has actually finished — silent freeze on next request.
- `src/agent/resume-run.ts:154–169`: synthetic tool-result items appended,
  then status transitioned. Crash mid-block leaves the same kind of zombie.

Concurrency: `bun:sqlite`'s default behavior in WAL mode is to throw
`SQLITE_BUSY` immediately when a write lock is held by another transaction.
Without `busy_timeout`, two parallel writers (e.g. `/chat` HTTP handler +
`run-continuation` subscriber on the same session) collide and surface a 500
to the user instead of waiting briefly.

Durability: `synchronous` is unset; the bun:sqlite default fsyncs more
aggressively than necessary in WAL mode. Wonderlands explicitly sets
`synchronous = NORMAL`, which is the recommended pairing for WAL on a VPS SSD.

The codebase already has one correct transaction usage — `appendItems` in
`src/infra/db/index.ts:189–196` — but it's the only one, and the pattern is
not exposed as a reusable wrapper. Repository helpers all import the global
`db` directly, so they cannot participate in a caller's transaction without a
parameter change.

Reference implementation: `Wonderlands/apps/server/src/db/transaction.ts`
(`withTransaction` wrapper) and `Wonderlands/apps/server/src/db/client.ts:21–28`
(pragma block).

## Out of scope

- Pending/running run reconciliation sweep (finding 10.1) — separate spec,
  covered by the Topic 6 graceful-shutdown work.
- Conversion of `dbOps` from module-level functions to factory/repository
  classes — keep the function-style API; only the call signatures change.
- Optimistic-locking discipline beyond what already exists (`expectedVersion`
  in `updateRunStatus`) — finding 1.4 is its own spec (Topic 4).
- Cross-process concurrency (PM2 cluster mode, multiple Bun instances on the
  same SQLite file). Single-process is the deployment model.
- WAL checkpointing on shutdown (finding 10.3) — separate spec.
- Switching to a server-mode database — explicit non-goal.

## Constraints

- Must not change the public API surface of `dbOps` exports; existing call
  sites that pass no `tx` must continue to work unchanged.
- Transaction bodies must contain no `await` of non-DB work (no LLM calls,
  no `fetch`, no `files.write`). The lock window must stay short.
- `bun:sqlite` transactions are synchronous-style — async work cannot be
  performed inside `db.transaction(...)`. The wrapper signature must reflect
  this (`fn` returns `T`, not `Promise<T>`).
- No new dependencies. Use Drizzle's existing `db.transaction` API.
- All existing tests must continue to pass with no behavioural drift.
- The pragma block must run exactly once at module load, before any
  `db.insert`/`db.update`/`db.transaction` call.

## Acceptance criteria

- [ ] `src/infra/db/connection.ts` sets `synchronous = NORMAL` and
      `busy_timeout = 5000` immediately after opening the database, in addition
      to the existing `journal_mode = WAL` and `foreign_keys = ON`.
- [ ] `src/infra/db/index.ts` exports `withTransaction<T>(fn: (tx) => T): T`
      and a `DbOrTx` type alias derived from Drizzle's transaction parameter
      type.
- [ ] Every multi-statement-using `dbOps` helper accepts an optional second
      parameter `dbOrTx: DbOrTx = db` and uses it in place of the global `db`.
      Specifically: `createSession`, `touchSession`, `setRootRun`,
      `setAssistant`, `createRun`, `getRun`, `updateRunStatus`,
      `incrementCycleCount`, `nextSequence`, `appendItem`, `appendItems`,
      `getItemByCallId`, `createJob`, `getJob`, `updateJobStatus`,
      `updateJobExecution`, `deleteJob`.
- [ ] `sessionService.appendMessage` and `sessionService.appendRun` accept an
      optional `tx` and thread it down to `persistMessages` →
      `dbOps.nextSequence` / `appendItem` / `appendItems` / `touchSession`.
- [ ] `executeRun` (orchestrator.ts:198–203) wraps the run-row creation,
      session updates, status transition, and initial user-message append in a
      single `withTransaction` call.
- [ ] `runAndPersist` (orchestrator.ts:225–226) wraps the `appendRun` and
      `persistRunExit` calls in a single `withTransaction`.
- [ ] `resumeRun` (resume-run.ts:154–169) wraps the synthetic-message append
      and the status transition in a single `withTransaction`.
- [ ] No transaction body contains `await` of non-DB work (verified by
      manual inspection — bash, fetch, LLM calls remain outside).
- [ ] `bun test` passes with no regressions.

## Implementation plan

1. **Pragmas.** Add the two missing PRAGMAs in `src/infra/db/connection.ts`,
   immediately after `foreign_keys`:
   ```ts
   sqlite.run("PRAGMA synchronous = NORMAL");
   sqlite.run("PRAGMA busy_timeout = 5000");
   ```
   Verify: open the DB in a test and read back `PRAGMA synchronous` (should
   return `1`) and `PRAGMA busy_timeout` (should return `5000`).

2. **`withTransaction` + `DbOrTx` type.** In `src/infra/db/index.ts`:
   ```ts
   type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
   export type DbOrTx = typeof db | Tx;
   export function withTransaction<T>(fn: (tx: Tx) => T): T {
     return db.transaction(fn);
   }
   ```
   Export both `withTransaction` and `DbOrTx`.

3. **Thread `tx` through `dbOps` helpers.** For every helper listed in the
   acceptance criteria, change the signature from
   `function foo(...): X` to `function foo(..., dbOrTx: DbOrTx = db): X`,
   and replace the body's `db.xxx` usage with `dbOrTx.xxx`. Mechanical edit;
   no behavioural change for existing callers.

4. **Thread `tx` through `sessionService`.** In `src/agent/session.ts`:
   - `persistMessages(runId, msgs, tx?)` accepts optional `tx` and passes to
     `nextSequence`, `appendItem`, `appendItems`.
   - `appendMessage(id, runId, msg, tx?)` and `appendRun(id, runId, msgs, tx?)`
     accept optional `tx` and forward.

5. **Wrap the three multi-step windows.**
   - `src/agent/orchestrator.ts` `executeRun`: wrap lines 198–203 in
     `withTransaction((tx) => { ... })`. Pass `tx` to `insertRunRow`,
     `setRootRun`, `updateRunStatus`, `appendMessage`.
   - `src/agent/orchestrator.ts` `runAndPersist`: wrap the `appendRun` +
     `persistRunExit` block in `withTransaction((tx) => { ... })`. Pass
     `tx` through.
   - `src/agent/resume-run.ts`: wrap lines 154–169 in `withTransaction` and
     pass `tx` to `appendRun` and `updateRunStatus`.

6. **Audit transaction bodies for stray `await`s.** Read each new
   `withTransaction` block carefully. The bodies must call only synchronous
   `dbOps`/`sessionService` helpers. Any LLM call, file write, or fetch must
   happen before or after, never inside.

7. **Tests.** Run `bun test`. Add one focused integration test that:
   - Opens a fresh test DB.
   - Calls `executeRun` with a deliberately-throwing mock partway through the
     setup transaction.
   - Asserts the `runs` table is empty (rollback worked) and the `sessions`
     table reflects the pre-transaction state.

## Testing scenarios

- **Pragmas active**: open the DB, run `PRAGMA synchronous` and `PRAGMA
  busy_timeout` directly, confirm `1` and `5000`.
- **Atomicity on rollback**: inside a `withTransaction` body, throw after one
  insert. Assert the inserted row is not visible after the throw (verifies
  rollback).
- **Backwards compat**: every existing test that touches `dbOps` or
  `sessionService` runs unchanged (no callers updated to pass `tx`).
- **Crash simulation for executeRun setup**: stub `updateRunStatus` to throw
  on first call, run `executeRun`, assert no orphaned `pending` row remains.
- **Crash simulation for runAndPersist tail**: stub `persistRunExit` to throw,
  assert items batch is also rolled back (no half-persisted run).
- **Concurrent writers**: spawn two parallel `withTransaction` calls writing
  to the same session row. Without `busy_timeout`, the second would
  immediately fail; with `busy_timeout=5000`, both succeed in sequence.
  Verify the second one waits and completes.
- **Lock window discipline**: grep the new `withTransaction` blocks for
  `await ` and `fetch(`; should match nothing inside the bodies (only outside).
