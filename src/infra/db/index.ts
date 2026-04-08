import { eq, sql, and, lte } from "drizzle-orm";
import { db } from "./connection.ts";
import { sessions, agents, items, scheduledJobs } from "./schema.ts";
import type { JobStatus, JobRunStatus } from "./schema.ts";
import type {
  DbSession,
  DbAgent,
  DbItem,
  DbJob,
  CreateAgentOpts,
  CreateJobOpts,
  NewItem,
  AgentStatus,
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

export function setRootAgent(sessionId: string, agentId: string): void {
  db.update(sessions)
    .set({ rootAgentId: agentId })
    .where(eq(sessions.id, sessionId))
    .run();
}

export function setAssistant(sessionId: string, assistant: string): void {
  db.update(sessions)
    .set({ assistant })
    .where(eq(sessions.id, sessionId))
    .run();
}

// ── Agents ──────────────────────────────────────────────────

export function createAgent(opts: CreateAgentOpts): void {
  db.insert(agents)
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

export function getAgent(id: string): DbAgent | null {
  return db.select().from(agents).where(eq(agents.id, id)).get() as DbAgent | undefined ?? null;
}

export function updateAgentStatus(
  id: string,
  status: AgentStatus,
  result?: string,
  error?: string,
): void {
  const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;
  const updates: Record<string, unknown> = { status };

  if (status === "running") {
    updates.startedAt = now;
  }
  if (status === "completed" || status === "failed") {
    updates.completedAt = now;
  }
  if (result !== undefined) updates.result = result;
  if (error !== undefined) updates.error = error;

  db.update(agents).set(updates).where(eq(agents.id, id)).run();
}

export function incrementTurnCount(id: string): void {
  db.update(agents)
    .set({ turnCount: sql`${agents.turnCount} + 1` })
    .where(eq(agents.id, id))
    .run();
}

export function listAgentsBySession(sessionId: string): DbAgent[] {
  return db.select().from(agents).where(eq(agents.sessionId, sessionId)).all() as DbAgent[];
}

// ── Items ───────────────────────────────────────────────────

export function nextSequence(agentId: string): number {
  const row = db
    .select({ maxSeq: sql<number>`coalesce(max(${items.sequence}), -1)` })
    .from(items)
    .where(eq(items.agentId, agentId))
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

export function listItemsByAgent(agentId: string): DbItem[] {
  return db
    .select()
    .from(items)
    .where(eq(items.agentId, agentId))
    .orderBy(items.sequence)
    .all() as DbItem[];
}

export function listItemsBySession(sessionId: string): DbItem[] {
  return db
    .select({ item: items })
    .from(items)
    .innerJoin(agents, eq(items.agentId, agents.id))
    .where(eq(agents.sessionId, sessionId))
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
  db.delete(agents).run();
  db.delete(sessions).run();
  db.delete(scheduledJobs).run();
}
