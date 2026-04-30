import { Cron } from "croner";
import { randomUUID } from "node:crypto";
import { randomSessionId } from "../utils/id.ts";
import { DomainError } from "../types/errors.ts";
import { sessionService } from "../agent/session.ts";
import { executeRun } from "../agent/orchestrator.ts";
import * as dbOps from "./db/index.ts";
import type { DbJob } from "../types/db.ts";

const cronJobs = new Map<string, Cron>();
let pollTimer: ReturnType<typeof setInterval> | null = null;

const POLL_INTERVAL_MS = 60_000;
const MAX_DELAY_DAYS = 30;
const DELAY_RE = /^(\d+)([mhd])$/;

// ── Delay parsing ──────────────────────────────────────────

export function parseDelay(delay: string): number {
  const match = delay.trim().match(DELAY_RE);
  if (!match) throw new DomainError({
    type: "validation",
    message: `Invalid delay format: "${delay}". Use Nm, Nh, or Nd (e.g. "30m", "2h", "1d")`,
  });

  const n = parseInt(match[1], 10);
  if (n <= 0) throw new DomainError({ type: "validation", message: "Delay must be a positive integer" });

  const unit = match[2];
  let ms: number;
  switch (unit) {
    case "m": ms = n * 60_000; break;
    case "h": ms = n * 3_600_000; break;
    case "d": ms = n * 86_400_000; break;
    default: throw new DomainError({ type: "validation", message: `Unknown delay unit: ${unit}` });
  }

  if (n > MAX_DELAY_DAYS && unit === "d") {
    throw new DomainError({ type: "capacity", message: `Delay exceeds maximum of ${MAX_DELAY_DAYS} days` });
  }
  if (ms > MAX_DELAY_DAYS * 86_400_000) {
    throw new DomainError({ type: "capacity", message: `Delay exceeds maximum of ${MAX_DELAY_DAYS} days` });
  }

  return ms;
}

export function delayToRunAt(delay: string): string {
  const ms = parseDelay(delay);
  return new Date(Date.now() + ms).toISOString();
}

// ── Job execution ──────────────────────────────────────────

async function executeJob(job: DbJob): Promise<void> {
  const sessionId = randomSessionId();
  const now = new Date().toISOString();
  try {
    await sessionService.enqueue(sessionId, () =>
      executeRun({ sessionId, prompt: job.message, assistant: job.agent ?? undefined }),
    );
    dbOps.updateJobExecution(job.id, job.runCount + 1, now, "success");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const sanitized = msg.slice(0, 500);
    dbOps.updateJobExecution(job.id, job.runCount + 1, now, "error", sanitized);
  }

  // Mark one-shot jobs as completed after execution
  if (!job.schedule) {
    dbOps.updateJobStatus(job.id, "completed");
  }
}

// ── Cron scheduling ────────────────────────────────────────

function scheduleCron(job: DbJob): void {
  if (!job.schedule) return;
  cancelJob(job.id);

  const cron = new Cron(job.schedule, async () => {
    const fresh = dbOps.getJob(job.id);
    if (!fresh || fresh.status !== "active") return;
    await executeJob(fresh);
  });

  cronJobs.set(job.id, cron);
}

function cancelJob(id: string): void {
  const cron = cronJobs.get(id);
  if (cron) {
    cron.stop();
    cronJobs.delete(id);
  }
}

// ── One-shot polling ───────────────────────────────────────

async function pollOneShots(): Promise<void> {
  const now = new Date().toISOString();
  const dueJobs = dbOps.listDueOneShots(now);
  for (const job of dueJobs) {
    await executeJob(job);
  }
}

// ── Lifecycle ──────────────────────────────────────────────

function loadAll(): void {
  const activeJobs = dbOps.listActiveJobs();
  for (const job of activeJobs) {
    if (job.schedule) {
      scheduleCron(job);
    }
  }
  // Start the one-shot poll timer
  if (!pollTimer) {
    pollTimer = setInterval(() => { pollOneShots().catch(() => {}); }, POLL_INTERVAL_MS);
  }
}

function shutdown(): void {
  for (const [id, cron] of cronJobs) {
    cron.stop();
  }
  cronJobs.clear();

  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// ── Public API ─────────────────────────────────────────────

export const scheduler = {
  loadAll,
  shutdown,
  scheduleCron,
  cancelJob,
  executeJob,
  pollOneShots,
  parseDelay,
  delayToRunAt,

  /** Visible for testing */
  _activeCronCount(): number { return cronJobs.size; },
  _hasPollTimer(): boolean { return pollTimer !== null; },
};
