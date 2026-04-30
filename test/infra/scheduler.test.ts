import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { scheduler, parseDelay, delayToRunAt } from "../../apps/server/src/infra/scheduler.ts";
import * as dbOps from "../../apps/server/src/infra/db/index.ts";
import type { DbJob } from "../../apps/server/src/types/db.ts";

// ── Helpers ────────────────────────────────────────────────

function makeJob(overrides: Partial<DbJob> = {}): DbJob {
  return {
    id: "test-job-1",
    name: "Test Job",
    message: "do something",
    agent: null,
    schedule: "* * * * *",
    runAt: null,
    status: "active",
    runCount: 0,
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── Delay parsing ──────────────────────────────────────────

describe("parseDelay", () => {
  test("parses minutes", () => {
    expect(parseDelay("30m")).toBe(30 * 60_000);
  });

  test("parses hours", () => {
    expect(parseDelay("2h")).toBe(2 * 3_600_000);
  });

  test("parses days", () => {
    expect(parseDelay("1d")).toBe(86_400_000);
  });

  test("accepts 30d (max)", () => {
    expect(parseDelay("30d")).toBe(30 * 86_400_000);
  });

  test("rejects 31d (over max)", () => {
    expect(() => parseDelay("31d")).toThrow("maximum of 30 days");
  });

  test("rejects invalid format", () => {
    expect(() => parseDelay("abc")).toThrow("Invalid delay format");
  });

  test("rejects empty string", () => {
    expect(() => parseDelay("")).toThrow("Invalid delay format");
  });

  test("rejects negative", () => {
    expect(() => parseDelay("-5m")).toThrow("Invalid delay format");
  });

  test("rejects zero", () => {
    expect(() => parseDelay("0m")).toThrow("positive integer");
  });

  test("trims whitespace", () => {
    expect(parseDelay(" 5m ")).toBe(5 * 60_000);
  });
});

describe("delayToRunAt", () => {
  test("returns ISO string in the future", () => {
    const before = Date.now();
    const runAt = delayToRunAt("30m");
    const after = Date.now();
    const parsed = new Date(runAt).getTime();
    expect(parsed).toBeGreaterThanOrEqual(before + 30 * 60_000);
    expect(parsed).toBeLessThanOrEqual(after + 30 * 60_000);
  });
});

// ── DB query functions ─────────────────────────────────────

describe("scheduled jobs DB operations", () => {
  beforeEach(() => {
    // Clean up scheduled jobs
    for (const job of dbOps.listJobs()) {
      dbOps.deleteJob(job.id);
    }
  });

  test("createJob + getJob round-trips", () => {
    dbOps.createJob({
      id: "j1",
      name: "Test",
      message: "hello",
      schedule: "* * * * *",
    });
    const job = dbOps.getJob("j1");
    expect(job).not.toBeNull();
    expect(job!.name).toBe("Test");
    expect(job!.message).toBe("hello");
    expect(job!.schedule).toBe("* * * * *");
    expect(job!.status).toBe("active");
    expect(job!.runCount).toBe(0);
  });

  test("createJob with one-shot runAt", () => {
    const runAt = new Date(Date.now() + 60_000).toISOString();
    dbOps.createJob({
      id: "j2",
      name: "OneShot",
      message: "fire once",
      runAt,
    });
    const job = dbOps.getJob("j2");
    expect(job!.runAt).toBe(runAt);
    expect(job!.schedule).toBeNull();
  });

  test("listJobs returns all jobs", () => {
    dbOps.createJob({ id: "j1", name: "A", message: "a" });
    dbOps.createJob({ id: "j2", name: "B", message: "b" });
    expect(dbOps.listJobs()).toHaveLength(2);
  });

  test("listActiveJobs filters by status", () => {
    dbOps.createJob({ id: "j1", name: "A", message: "a" });
    dbOps.createJob({ id: "j2", name: "B", message: "b" });
    dbOps.updateJobStatus("j2", "paused");
    expect(dbOps.listActiveJobs()).toHaveLength(1);
  });

  test("listDueOneShots finds due jobs", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 3_600_000).toISOString();
    dbOps.createJob({ id: "j1", name: "Past", message: "a", runAt: past });
    dbOps.createJob({ id: "j2", name: "Future", message: "b", runAt: future });
    dbOps.createJob({ id: "j3", name: "Cron", message: "c", schedule: "* * * * *" });

    const due = dbOps.listDueOneShots(new Date().toISOString());
    expect(due).toHaveLength(1);
    expect(due[0].id).toBe("j1");
  });

  test("updateJobStatus changes status", () => {
    dbOps.createJob({ id: "j1", name: "A", message: "a" });
    dbOps.updateJobStatus("j1", "paused");
    expect(dbOps.getJob("j1")!.status).toBe("paused");
  });

  test("updateJobExecution updates metadata", () => {
    dbOps.createJob({ id: "j1", name: "A", message: "a" });
    const now = new Date().toISOString();
    dbOps.updateJobExecution("j1", 1, now, "success");
    const job = dbOps.getJob("j1")!;
    expect(job.runCount).toBe(1);
    expect(job.lastRunAt).toBe(now);
    expect(job.lastStatus).toBe("success");
    expect(job.lastError).toBeNull();
  });

  test("updateJobExecution stores error", () => {
    dbOps.createJob({ id: "j1", name: "A", message: "a" });
    const now = new Date().toISOString();
    dbOps.updateJobExecution("j1", 1, now, "error", "boom");
    const job = dbOps.getJob("j1")!;
    expect(job.lastStatus).toBe("error");
    expect(job.lastError).toBe("boom");
  });

  test("deleteJob removes the row", () => {
    dbOps.createJob({ id: "j1", name: "A", message: "a" });
    dbOps.deleteJob("j1");
    expect(dbOps.getJob("j1")).toBeNull();
  });

  test("getJob returns null for missing id", () => {
    expect(dbOps.getJob("nonexistent")).toBeNull();
  });
});

// ── Scheduler service ──────────────────────────────────────

describe("scheduler service", () => {
  afterEach(() => {
    scheduler.shutdown();
    for (const job of dbOps.listJobs()) {
      dbOps.deleteJob(job.id);
    }
  });

  test("scheduleCron creates a cron timer", () => {
    const job = makeJob({ id: "cron-1", schedule: "* * * * *" });
    scheduler.scheduleCron(job);
    expect(scheduler._activeCronCount()).toBe(1);
  });

  test("cancelJob removes the cron timer", () => {
    const job = makeJob({ id: "cron-2", schedule: "* * * * *" });
    scheduler.scheduleCron(job);
    scheduler.cancelJob("cron-2");
    expect(scheduler._activeCronCount()).toBe(0);
  });

  test("cancelJob is safe for non-existent id", () => {
    expect(() => scheduler.cancelJob("nope")).not.toThrow();
  });

  test("loadAll schedules active cron jobs from DB", () => {
    dbOps.createJob({ id: "lj1", name: "Cron", message: "x", schedule: "* * * * *" });
    dbOps.createJob({ id: "lj2", name: "Paused", message: "y", schedule: "*/5 * * * *" });
    dbOps.updateJobStatus("lj2", "paused");

    scheduler.loadAll();
    // Only the active cron job should be scheduled
    expect(scheduler._activeCronCount()).toBe(1);
    expect(scheduler._hasPollTimer()).toBe(true);
  });

  test("shutdown clears all timers", () => {
    const job = makeJob({ id: "sd-1", schedule: "* * * * *" });
    scheduler.scheduleCron(job);
    scheduler.loadAll();

    scheduler.shutdown();
    expect(scheduler._activeCronCount()).toBe(0);
    expect(scheduler._hasPollTimer()).toBe(false);
  });
});
