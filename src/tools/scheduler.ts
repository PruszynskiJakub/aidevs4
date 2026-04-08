import { z } from "zod";
import { randomUUID } from "node:crypto";
import { Cron } from "croner";
import type { ToolDefinition } from "../types/tool.ts";
import type { ToolResult } from "../types/tool-result.ts";
import { text } from "../types/tool-result.ts";
import { scheduler, parseDelay, delayToRunAt } from "../infra/scheduler.ts";
import * as dbOps from "../infra/db/index.ts";
import { assertMaxLength } from "../utils/parse.ts";

const ID_RE = /^[a-zA-Z0-9_.\-]+$/;
const MAX_NAME_LEN = 100;
const MAX_MESSAGE_LEN = 10_000;
const MAX_CRON_LEN = 100;
const MAX_DELAY_LEN = 20;
const MAX_AGENT_LEN = 100;

function validateId(id: string): void {
  assertMaxLength(id, "id", 100);
  if (!ID_RE.test(id)) throw new Error(`Invalid id: must match ${ID_RE}`);
}

function validateCron(cron: string): void {
  assertMaxLength(cron, "cron", MAX_CRON_LEN);
  try {
    // Validate by creating a stopped instance
    const c = new Cron(cron);
    c.stop();
  } catch {
    throw new Error(`Invalid cron expression: "${cron}"`);
  }
}

// ── Actions ────────────────────────────────────────────────

async function scheduleAction(payload: {
  name: string;
  message: string;
  cron: string;
  agent: string;
}): Promise<ToolResult> {
  assertMaxLength(payload.name, "name", MAX_NAME_LEN);
  assertMaxLength(payload.message, "message", MAX_MESSAGE_LEN);
  validateCron(payload.cron);
  const agent = payload.agent || undefined;
  if (agent) assertMaxLength(agent, "agent", MAX_AGENT_LEN);

  const id = randomUUID();
  dbOps.createJob({
    id,
    name: payload.name,
    message: payload.message,
    agent,
    schedule: payload.cron,
  });

  const job = dbOps.getJob(id)!;
  scheduler.scheduleCron(job);

  return text(`Scheduled recurring job "${payload.name}" (id: ${id}) with cron: ${payload.cron}\nNote: Use the job id to pause, resume, or delete this job.`);
}

async function delayAction(payload: {
  name: string;
  message: string;
  delay: string;
  agent: string;
}): Promise<ToolResult> {
  assertMaxLength(payload.name, "name", MAX_NAME_LEN);
  assertMaxLength(payload.message, "message", MAX_MESSAGE_LEN);
  assertMaxLength(payload.delay, "delay", MAX_DELAY_LEN);
  const agent = payload.agent || undefined;
  if (agent) assertMaxLength(agent, "agent", MAX_AGENT_LEN);

  // Validate and compute runAt
  const runAt = delayToRunAt(payload.delay);
  const id = randomUUID();

  dbOps.createJob({
    id,
    name: payload.name,
    message: payload.message,
    agent,
    runAt,
  });

  return text(`Created one-shot job "${payload.name}" (id: ${id}) scheduled for ${runAt}\nNote: The job will fire within 60 seconds of the scheduled time.`);
}

async function listAction(): Promise<ToolResult> {
  const jobs = dbOps.listJobs();
  if (jobs.length === 0) return text("No scheduled jobs.");

  const lines = jobs.map((j) => {
    const type = j.schedule ? `cron: ${j.schedule}` : `one-shot: ${j.runAt}`;
    return `- ${j.name} (${j.id}) [${j.status}] ${type} — runs: ${j.runCount}`;
  });

  return text(lines.join("\n"));
}

async function getAction(payload: { id: string }): Promise<ToolResult> {
  validateId(payload.id);
  const job = dbOps.getJob(payload.id);
  if (!job) throw new Error(`Job not found: ${payload.id}`);

  const info = [
    `Name: ${job.name}`,
    `ID: ${job.id}`,
    `Status: ${job.status}`,
    `Message: ${job.message}`,
    job.agent ? `Agent: ${job.agent}` : null,
    job.schedule ? `Schedule: ${job.schedule}` : null,
    job.runAt ? `Run at: ${job.runAt}` : null,
    `Run count: ${job.runCount}`,
    job.lastRunAt ? `Last run: ${job.lastRunAt}` : null,
    job.lastStatus ? `Last status: ${job.lastStatus}` : null,
    job.lastError ? `Last error: ${job.lastError}` : null,
    `Created: ${job.createdAt}`,
  ].filter(Boolean);

  return text(info.join("\n"));
}

async function pauseAction(payload: { id: string }): Promise<ToolResult> {
  validateId(payload.id);
  const job = dbOps.getJob(payload.id);
  if (!job) throw new Error(`Job not found: ${payload.id}`);
  if (job.status !== "active") throw new Error(`Job is not active (status: ${job.status})`);

  dbOps.updateJobStatus(payload.id, "paused");
  scheduler.cancelJob(payload.id);

  return text(`Paused job "${job.name}" (${payload.id})\nNote: Resume the job to restart its schedule.`);
}

async function resumeAction(payload: { id: string }): Promise<ToolResult> {
  validateId(payload.id);
  const job = dbOps.getJob(payload.id);
  if (!job) throw new Error(`Job not found: ${payload.id}`);
  if (job.status !== "paused") throw new Error(`Job is not paused (status: ${job.status})`);

  dbOps.updateJobStatus(payload.id, "active");

  if (job.schedule) {
    const updated = dbOps.getJob(payload.id)!;
    scheduler.scheduleCron(updated);
  }

  return text(`Resumed job "${job.name}" (${payload.id})\nNote: The job is now active and will fire on its next scheduled time.`);
}

async function deleteAction(payload: { id: string }): Promise<ToolResult> {
  validateId(payload.id);
  const job = dbOps.getJob(payload.id);
  if (!job) throw new Error(`Job not found: ${payload.id}`);

  scheduler.cancelJob(payload.id);
  dbOps.deleteJob(payload.id);

  return text(`Deleted job "${job.name}" (${payload.id})`);
}

// ── Handler ────────────────────────────────────────────────

async function schedulerHandler(args: Record<string, unknown>): Promise<ToolResult> {
  const { action, payload } = args as { action: string; payload: Record<string, unknown> };
  switch (action) {
    case "schedule": return scheduleAction(payload as any);
    case "delay": return delayAction(payload as any);
    case "list": return listAction();
    case "get": return getAction(payload as any);
    case "pause": return pauseAction(payload as any);
    case "resume": return resumeAction(payload as any);
    case "delete": return deleteAction(payload as any);
    default: throw new Error(`Unknown scheduler action: ${action}`);
  }
}

export default {
  name: "scheduler",
  schema: {
    name: "scheduler",
    description: "Manage scheduled agent runs — create recurring cron jobs or one-shot delayed executions that trigger the agent automatically.",
    actions: {
      schedule: {
        description: "Create a recurring job on a cron schedule. The agent will be triggered with the given message on each cron tick.",
        schema: z.object({
          name: z.string().describe("Human-readable job name"),
          message: z.string().describe("The prompt to send to the agent on each trigger"),
          cron: z.string().describe('Standard cron expression (e.g. "*/5 * * * *" for every 5 minutes)'),
          agent: z.string().describe('Agent template name (empty string for default assistant)'),
        }),
      },
      delay: {
        description: "Create a one-shot job that fires once after a duration. Accepted formats: Nm (minutes), Nh (hours), Nd (days). Max 30 days.",
        schema: z.object({
          name: z.string().describe("Human-readable job name"),
          message: z.string().describe("The prompt to send to the agent when the timer fires"),
          delay: z.string().describe('Duration string (e.g. "30m", "2h", "1d")'),
          agent: z.string().describe('Agent template name (empty string for default assistant)'),
        }),
      },
      list: {
        description: "List all scheduled jobs with their status, schedule, and run count.",
        schema: z.object({}),
      },
      get: {
        description: "Get detailed information about a specific job including last execution metadata.",
        schema: z.object({
          id: z.string().describe("The job ID"),
        }),
      },
      pause: {
        description: "Pause an active job. It remains in the database but will not fire until resumed.",
        schema: z.object({
          id: z.string().describe("The job ID to pause"),
        }),
      },
      resume: {
        description: "Resume a paused job so it fires on its next scheduled time.",
        schema: z.object({
          id: z.string().describe("The job ID to resume"),
        }),
      },
      delete: {
        description: "Permanently delete a job and cancel its timer.",
        schema: z.object({
          id: z.string().describe("The job ID to delete"),
        }),
      },
    },
  },
  handler: schedulerHandler,
} satisfies ToolDefinition;
