import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import schedulerTool from "../../apps/server/src/tools/scheduler.ts";
import { scheduler } from "../../apps/server/src/infra/scheduler.ts";
import * as dbOps from "../../apps/server/src/infra/db/index.ts";

const handle = schedulerTool.handler;

beforeEach(() => {
  for (const job of dbOps.listJobs()) {
    scheduler.cancelJob(job.id);
    dbOps.deleteJob(job.id);
  }
});

afterEach(() => {
  scheduler.shutdown();
});

describe("scheduler tool", () => {
  test("schedule action creates a cron job", async () => {
    const result = await handle({
      action: "schedule",
      payload: { name: "Poll", message: "check inbox", cron: "*/5 * * * *" },
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Scheduled recurring job");
    expect(result.content[0].text).toContain("Poll");

    const jobs = dbOps.listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].schedule).toBe("*/5 * * * *");
    expect(jobs[0].status).toBe("active");
    expect(scheduler._activeCronCount()).toBe(1);
  });

  test("schedule action rejects invalid cron", async () => {
    await expect(
      handle({ action: "schedule", payload: { name: "Bad", message: "x", cron: "not-a-cron" } }),
    ).rejects.toThrow("Invalid cron expression");
  });

  test("delay action creates a one-shot job", async () => {
    const before = Date.now();
    const result = await handle({
      action: "delay",
      payload: { name: "Reminder", message: "check later", delay: "30m" },
    });
    expect(result.content[0].text).toContain("one-shot job");

    const jobs = dbOps.listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].schedule).toBeNull();
    const runAtMs = new Date(jobs[0].runAt!).getTime();
    expect(runAtMs).toBeGreaterThanOrEqual(before + 30 * 60_000 - 1000);
  });

  test("delay action rejects invalid delay", async () => {
    await expect(
      handle({ action: "delay", payload: { name: "Bad", message: "x", delay: "abc" } }),
    ).rejects.toThrow("Invalid delay format");
  });

  test("delay action rejects over 30 days", async () => {
    await expect(
      handle({ action: "delay", payload: { name: "Bad", message: "x", delay: "31d" } }),
    ).rejects.toThrow("maximum of 30 days");
  });

  test("list action returns all jobs", async () => {
    await handle({ action: "schedule", payload: { name: "A", message: "a", cron: "* * * * *" } });
    await handle({ action: "delay", payload: { name: "B", message: "b", delay: "1h" } });

    const result = await handle({ action: "list", payload: {} });
    expect(result.content[0].text).toContain("A");
    expect(result.content[0].text).toContain("B");
  });

  test("list action returns message when empty", async () => {
    const result = await handle({ action: "list", payload: {} });
    expect(result.content[0].text).toBe("No scheduled jobs.");
  });

  test("get action returns job details", async () => {
    await handle({ action: "schedule", payload: { name: "Info", message: "test", cron: "* * * * *" } });
    const jobs = dbOps.listJobs();
    const result = await handle({ action: "get", payload: { id: jobs[0].id } });
    expect(result.content[0].text).toContain("Name: Info");
    expect(result.content[0].text).toContain("Schedule: * * * * *");
  });

  test("get action throws for missing job", async () => {
    await expect(
      handle({ action: "get", payload: { id: "nonexistent" } }),
    ).rejects.toThrow("Job not found");
  });

  test("pause action pauses a job", async () => {
    await handle({ action: "schedule", payload: { name: "P", message: "x", cron: "* * * * *" } });
    const jobs = dbOps.listJobs();
    expect(scheduler._activeCronCount()).toBe(1);

    await handle({ action: "pause", payload: { id: jobs[0].id } });
    expect(dbOps.getJob(jobs[0].id)!.status).toBe("paused");
    expect(scheduler._activeCronCount()).toBe(0);
  });

  test("pause rejects non-active job", async () => {
    await handle({ action: "schedule", payload: { name: "P", message: "x", cron: "* * * * *" } });
    const jobs = dbOps.listJobs();
    await handle({ action: "pause", payload: { id: jobs[0].id } });

    await expect(
      handle({ action: "pause", payload: { id: jobs[0].id } }),
    ).rejects.toThrow("not active");
  });

  test("resume action resumes a paused job", async () => {
    await handle({ action: "schedule", payload: { name: "R", message: "x", cron: "* * * * *" } });
    const jobs = dbOps.listJobs();
    await handle({ action: "pause", payload: { id: jobs[0].id } });

    await handle({ action: "resume", payload: { id: jobs[0].id } });
    expect(dbOps.getJob(jobs[0].id)!.status).toBe("active");
    expect(scheduler._activeCronCount()).toBe(1);
  });

  test("resume rejects non-paused job", async () => {
    await handle({ action: "schedule", payload: { name: "R", message: "x", cron: "* * * * *" } });
    const jobs = dbOps.listJobs();

    await expect(
      handle({ action: "resume", payload: { id: jobs[0].id } }),
    ).rejects.toThrow("not paused");
  });

  test("delete action removes job and cancels timer", async () => {
    await handle({ action: "schedule", payload: { name: "D", message: "x", cron: "* * * * *" } });
    const jobs = dbOps.listJobs();
    expect(scheduler._activeCronCount()).toBe(1);

    await handle({ action: "delete", payload: { id: jobs[0].id } });
    expect(dbOps.getJob(jobs[0].id)).toBeNull();
    expect(scheduler._activeCronCount()).toBe(0);
  });

  test("delete rejects missing job", async () => {
    await expect(
      handle({ action: "delete", payload: { id: "nope" } }),
    ).rejects.toThrow("Job not found");
  });

  test("unknown action throws", async () => {
    await expect(
      handle({ action: "unknown", payload: {} }),
    ).rejects.toThrow("Unknown scheduler action");
  });

  test("schedule with agent parameter", async () => {
    await handle({
      action: "schedule",
      payload: { name: "WithAgent", message: "go", cron: "0 * * * *", agent: "researcher" },
    });
    const jobs = dbOps.listJobs();
    expect(jobs[0].agent).toBe("researcher");
  });
});
