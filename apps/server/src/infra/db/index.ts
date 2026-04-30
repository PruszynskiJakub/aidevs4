import { eq, sql, and, lte } from "drizzle-orm";
import { db } from "./connection.ts";
import { sessions, runs, items, scheduledJobs } from "./schema.ts";
import type { JobStatus, JobRunStatus } from "./schema.ts";
import type {
  DbSession,
  DbRun,
  DbItem,
  DbJob,
  CreateRunOpts,
  CreateJobOpts,
  NewItem,
  RunStatus,
} from "../../types/db.ts";

export { db, sqlite } from "./connection.ts";

// ── Transaction wrapper ─────────────────────────────────────

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type DbOrTx = typeof db | Tx;

/**
 * Run `fn` inside a SQLite transaction. Either every write inside lands or
 * none do. The body MUST be synchronous-style — `bun:sqlite` transactions
 * cannot await non-DB work, and even DB-only `await` widens the lock window
 * unnecessarily. Compose all I/O outside, then call this with the persistence.
 */
export function withTransaction<T>(fn: (tx: Tx) => T): T {
  return db.transaction(fn);
}

// ── Sessions ────────────────────────────────────────────────

export function createSession(id: string, dbOrTx: DbOrTx = db): void {
  dbOrTx.insert(sessions).values({ id }).run();
}

export function getSession(id: string, dbOrTx: DbOrTx = db): DbSession | null {
  return dbOrTx.select().from(sessions).where(eq(sessions.id, id)).get() as DbSession | undefined ?? null;
}

export function touchSession(id: string, dbOrTx: DbOrTx = db): void {
  dbOrTx.update(sessions)
    .set({ updatedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))` })
    .where(eq(sessions.id, id))
    .run();
}

export function setRootRun(sessionId: string, runId: string, dbOrTx: DbOrTx = db): void {
  dbOrTx.update(sessions)
    .set({ rootRunId: runId })
    .where(eq(sessions.id, sessionId))
    .run();
}

export function setAssistant(sessionId: string, assistant: string, dbOrTx: DbOrTx = db): void {
  dbOrTx.update(sessions)
    .set({ assistant })
    .where(eq(sessions.id, sessionId))
    .run();
}

// ── Runs ────────────────────────────────────────────────────

export function createRun(opts: CreateRunOpts, dbOrTx: DbOrTx = db): void {
  dbOrTx.insert(runs)
    .values({
      id: opts.id,
      sessionId: opts.sessionId,
      parentId: opts.parentId ?? null,
      rootRunId: opts.rootRunId ?? null,
      sourceCallId: opts.sourceCallId ?? null,
      template: opts.template,
      task: opts.task,
    })
    .run();
}

export function getRun(id: string, dbOrTx: DbOrTx = db): DbRun | null {
  return dbOrTx.select().from(runs).where(eq(runs.id, id)).get() as DbRun | undefined ?? null;
}

export interface UpdateRunStatusOpts {
  status: RunStatus;
  expectedVersion?: number;
  result?: string;
  error?: string;
  exitKind?: string | null;
  waitingOn?: string | null;
}

/**
 * Update run status with optional optimistic locking.
 * When `expectedVersion` is provided, the update only succeeds if the
 * current version matches — prevents concurrent mutations.
 * Returns true if the update was applied, false on version conflict.
 */
export function updateRunStatus(id: string, opts: UpdateRunStatusOpts, dbOrTx: DbOrTx = db): boolean {
  const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;
  const updates: Record<string, unknown> = {
    status: opts.status,
    version: sql`${runs.version} + 1`,
  };

  if (opts.status === "running") {
    updates.startedAt = now;
  }
  if (
    opts.status === "completed" ||
    opts.status === "failed" ||
    opts.status === "cancelled" ||
    opts.status === "exhausted"
  ) {
    updates.completedAt = now;
  }
  if (opts.result !== undefined) updates.result = opts.result;
  if (opts.error !== undefined) updates.error = opts.error;
  if (opts.exitKind !== undefined) updates.exitKind = opts.exitKind;
  if (opts.waitingOn !== undefined) updates.waitingOn = opts.waitingOn;

  const where = opts.expectedVersion !== undefined
    ? and(eq(runs.id, id), eq(runs.version, opts.expectedVersion))
    : eq(runs.id, id);

  const result = dbOrTx.update(runs).set(updates).where(where!).run();
  return result.changes > 0;
}

export function incrementCycleCount(id: string, dbOrTx: DbOrTx = db): void {
  dbOrTx.update(runs)
    .set({ cycleCount: sql`${runs.cycleCount} + 1` })
    .where(eq(runs.id, id))
    .run();
}

export function listRunsBySession(sessionId: string): DbRun[] {
  return db.select().from(runs).where(eq(runs.sessionId, sessionId)).all() as DbRun[];
}

/**
 * Find the parent run that is waiting on a specific child run.
 * Returns null if no parent is waiting (e.g. root run or already resumed).
 */
export function findRunWaitingOnChild(childRunId: string): DbRun | null {
  return db
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.status, "waiting"),
        sql`json_extract(${runs.waitingOn}, '$.kind') = 'child_run'`,
        sql`json_extract(${runs.waitingOn}, '$.childRunId') = ${childRunId}`,
      ),
    )
    .limit(1)
    .get() as DbRun | undefined ?? null;
}

/**
 * Find parent runs in `waiting` status whose child run is already terminal.
 * Used by the startup reconciliation sweep to handle crash-gap scenarios.
 */
export function findOrphanedWaitingRuns(): DbRun[] {
  return db
    .select({ parent: runs })
    .from(runs)
    .where(
      and(
        eq(runs.status, "waiting"),
        sql`json_extract(${runs.waitingOn}, '$.kind') = 'child_run'`,
      ),
    )
    .all()
    .filter((row) => {
      const waitingOn = JSON.parse(row.parent.waitingOn!);
      const child = getRun(waitingOn.childRunId);
      if (!child) return true; // child missing — treat as orphaned
      return (
        child.status === "completed" ||
        child.status === "failed" ||
        child.status === "cancelled" ||
        child.status === "exhausted"
      );
    })
    .map((row) => row.parent) as DbRun[];
}

// ── Items ───────────────────────────────────────────────────

export function nextSequence(runId: string, dbOrTx: DbOrTx = db): number {
  const row = dbOrTx
    .select({ maxSeq: sql<number>`coalesce(max(${items.sequence}), -1)` })
    .from(items)
    .where(eq(items.runId, runId))
    .get();
  return (row?.maxSeq ?? -1) + 1;
}

export function appendItem(item: NewItem, dbOrTx: DbOrTx = db): void {
  dbOrTx.insert(items).values(item).run();
}

/**
 * Insert a batch of items atomically. When called outside a transaction this
 * opens one of its own; when called inside one (`dbOrTx` is a tx), it reuses
 * the caller's transaction so the batch composes with the surrounding writes.
 */
export function appendItems(batch: NewItem[], dbOrTx: DbOrTx = db): void {
  if (batch.length === 0) return;
  if (dbOrTx === db) {
    db.transaction((tx) => {
      for (const item of batch) {
        tx.insert(items).values(item).run();
      }
    });
  } else {
    for (const item of batch) {
      dbOrTx.insert(items).values(item).run();
    }
  }
}

export function listItemsByRun(runId: string): DbItem[] {
  return db
    .select()
    .from(items)
    .where(eq(items.runId, runId))
    .orderBy(items.sequence)
    .all() as DbItem[];
}

export function listItemsBySession(sessionId: string): DbItem[] {
  return db
    .select({ item: items })
    .from(items)
    .innerJoin(runs, eq(items.runId, runs.id))
    .where(eq(runs.sessionId, sessionId))
    .orderBy(sql`${items}.rowid`)
    .all()
    .map((r) => r.item) as DbItem[];
}

export function getItemByCallId(callId: string, dbOrTx: DbOrTx = db): DbItem | null {
  return dbOrTx
    .select()
    .from(items)
    .where(eq(items.callId, callId))
    .get() as DbItem | undefined ?? null;
}

// ── Scheduled Jobs ─────────────────────────────────────────

export function createJob(opts: CreateJobOpts, dbOrTx: DbOrTx = db): void {
  dbOrTx.insert(scheduledJobs)
    .values({
      id: opts.id,
      name: opts.name,
      message: opts.message,
      agent: opts.agent ?? null,
      schedule: opts.schedule ?? null,
      runAt: opts.runAt ?? null,
    })
    .run();
}

export function getJob(id: string, dbOrTx: DbOrTx = db): DbJob | null {
  return dbOrTx.select().from(scheduledJobs).where(eq(scheduledJobs.id, id)).get() as DbJob | undefined ?? null;
}

export function listJobs(): DbJob[] {
  return db.select().from(scheduledJobs).all() as DbJob[];
}

export function listActiveJobs(): DbJob[] {
  return db.select().from(scheduledJobs).where(eq(scheduledJobs.status, "active")).all() as DbJob[];
}

export function listDueOneShots(now: string): DbJob[] {
  return db.select().from(scheduledJobs)
    .where(and(
      eq(scheduledJobs.status, "active"),
      lte(scheduledJobs.runAt, now),
    ))
    .all()
    .filter((j) => j.schedule === null) as DbJob[];
}

export function updateJobStatus(id: string, status: JobStatus, dbOrTx: DbOrTx = db): void {
  const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;
  dbOrTx.update(scheduledJobs)
    .set({ status, updatedAt: now })
    .where(eq(scheduledJobs.id, id))
    .run();
}

export function updateJobExecution(
  id: string,
  runCount: number,
  lastRunAt: string,
  lastStatus: JobRunStatus,
  lastError?: string,
  dbOrTx: DbOrTx = db,
): void {
  const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;
  dbOrTx.update(scheduledJobs)
    .set({
      runCount,
      lastRunAt,
      lastStatus,
      lastError: lastError ?? null,
      updatedAt: now,
    })
    .where(eq(scheduledJobs.id, id))
    .run();
}

export function deleteJob(id: string, dbOrTx: DbOrTx = db): void {
  dbOrTx.delete(scheduledJobs).where(eq(scheduledJobs.id, id)).run();
}

/** Visible for testing — deletes all data from all tables */
export function _clearAll(): void {
  db.delete(items).run();
  db.delete(runs).run();
  db.delete(sessions).run();
  db.delete(scheduledJobs).run();
}
