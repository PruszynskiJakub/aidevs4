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

// ── Sessions ────────────────────────────────────────────────

export function createSession(id: string): void {
  db.insert(sessions).values({ id }).run();
}

export function getSession(id: string): DbSession | null {
  return db.select().from(sessions).where(eq(sessions.id, id)).get() as DbSession | undefined ?? null;
}

export function touchSession(id: string): void {
  db.update(sessions)
    .set({ updatedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))` })
    .where(eq(sessions.id, id))
    .run();
}

export function setRootRun(sessionId: string, runId: string): void {
  db.update(sessions)
    .set({ rootRunId: runId })
    .where(eq(sessions.id, sessionId))
    .run();
}

export function setAssistant(sessionId: string, assistant: string): void {
  db.update(sessions)
    .set({ assistant })
    .where(eq(sessions.id, sessionId))
    .run();
}

// ── Runs ────────────────────────────────────────────────────

export function createRun(opts: CreateRunOpts): void {
  db.insert(runs)
    .values({
      id: opts.id,
      sessionId: opts.sessionId,
      parentId: opts.parentId ?? null,
      sourceCallId: opts.sourceCallId ?? null,
      template: opts.template,
      task: opts.task,
    })
    .run();
}

export function getRun(id: string): DbRun | null {
  return db.select().from(runs).where(eq(runs.id, id)).get() as DbRun | undefined ?? null;
}

export interface UpdateRunStatusOpts {
  status: RunStatus;
  result?: string;
  error?: string;
  exitKind?: string | null;
  waitingOn?: string | null;
}

export function updateRunStatus(id: string, opts: UpdateRunStatusOpts): void {
  const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;
  const updates: Record<string, unknown> = { status: opts.status };

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

  db.update(runs).set(updates).where(eq(runs.id, id)).run();
}

export function incrementCycleCount(id: string): void {
  db.update(runs)
    .set({ cycleCount: sql`${runs.cycleCount} + 1` })
    .where(eq(runs.id, id))
    .run();
}

export function listRunsBySession(sessionId: string): DbRun[] {
  return db.select().from(runs).where(eq(runs.sessionId, sessionId)).all() as DbRun[];
}

// ── Items ───────────────────────────────────────────────────

export function nextSequence(runId: string): number {
  const row = db
    .select({ maxSeq: sql<number>`coalesce(max(${items.sequence}), -1)` })
    .from(items)
    .where(eq(items.runId, runId))
    .get();
  return (row?.maxSeq ?? -1) + 1;
}

export function appendItem(item: NewItem): void {
  db.insert(items).values(item).run();
}

export function appendItems(batch: NewItem[]): void {
  if (batch.length === 0) return;
  db.transaction((tx) => {
    for (const item of batch) {
      tx.insert(items).values(item).run();
    }
  });
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

export function getItemByCallId(callId: string): DbItem | null {
  return db
    .select()
    .from(items)
    .where(eq(items.callId, callId))
    .get() as DbItem | undefined ?? null;
}

// ── Scheduled Jobs ─────────────────────────────────────────

export function createJob(opts: CreateJobOpts): void {
  db.insert(scheduledJobs)
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

export function getJob(id: string): DbJob | null {
  return db.select().from(scheduledJobs).where(eq(scheduledJobs.id, id)).get() as DbJob | undefined ?? null;
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

export function updateJobStatus(id: string, status: JobStatus): void {
  const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;
  db.update(scheduledJobs)
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
): void {
  const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;
  db.update(scheduledJobs)
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

export function deleteJob(id: string): void {
  db.delete(scheduledJobs).where(eq(scheduledJobs.id, id)).run();
}

/** Visible for testing — deletes all data from all tables */
export function _clearAll(): void {
  db.delete(items).run();
  db.delete(runs).run();
  db.delete(sessions).run();
  db.delete(scheduledJobs).run();
}
