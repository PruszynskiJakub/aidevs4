# SP-80 Scheduled Jobs (Cron & One-Shot)

## Main objective

Add a scheduler service that triggers agent runs via `executeTurn`, with
both recurring cron schedules and one-shot delayed executions, persisted in
SQLite and manageable by the agent via a `scheduler` tool.

## Context

### What exists today

The agent system has no way to schedule future work. Every agent run is
triggered synchronously — by a user via CLI, HTTP POST to `/chat`, or a Slack
message. There is no background scheduler.

Common use cases that require scheduling:
- "Check my inbox in 30 minutes"
- "Poll this endpoint every hour"
- "Remind me about X tomorrow at 9am"

The server (`src/server.ts`) already exposes `POST /chat` which accepts a
message and runs the agent. The SQLite persistence layer (SP-78) provides
durable storage via Drizzle ORM. The bootstrap service (`src/infra/bootstrap.ts`)
handles service initialization and graceful shutdown.

### Why now

The agent needs autonomy over time — not just reacting to prompts, but
initiating work on a schedule. This is essential for monitoring, polling, and
deferred task patterns that recur across AI Devs tasks.

## Out of scope

- **Distributed scheduling** — single-process only, no multi-node coordination
- **Job queues / retries** — if a scheduled run fails, it's logged but not
  automatically retried
- **Session continuity** — each triggered run creates a fresh session
- **Authentication per job** — jobs run with the server's own credentials
- **Complex dependencies** — no job chaining or DAG-based workflows

## Constraints

- **SQLite via Drizzle** — job definitions stored in the existing database,
  following SP-78 patterns (schema in `src/infra/db/schema.ts`, migrations via
  `drizzle-kit`)
- **Direct `executeTurn` call** — scheduled jobs call `executeTurn` directly
  via `sessionService.enqueue()`, avoiding HTTP overhead and self-POST
  fragility. This reuses all existing agent infrastructure (session creation,
  logging, tools) without coupling to the HTTP layer
- **Dependencies**: `croner` (lightweight cron parser, no transitive deps).
  No heavy job framework
- **Polling for one-shots** — instead of per-job `setTimeout` (which overflows
  for delays >24.8 days), use a single 60-second interval that polls the DB
  for due one-shot jobs (`runAt <= now`). Cron jobs use `croner` directly
- **Graceful shutdown** — all timers cleared on `SIGTERM`/`SIGINT` via the
  existing bootstrap shutdown hook
- **Agent name per job** — each job specifies which agent template to use
  (defaults to the configured assistant)

## Acceptance criteria

- [ ] Cron jobs persist in SQLite and survive process restarts
- [ ] Recurring jobs fire on schedule using standard cron expressions
  (e.g., `*/5 * * * *`)
- [ ] One-shot jobs fire once at a specified time, then mark as `completed`
  (remain in DB for audit, no active timer)
- [ ] Each job trigger calls `executeTurn` directly via `sessionService.enqueue`,
  creating a fresh session
- [ ] The `scheduler` tool exposes actions: `schedule`, `delay`, `list`, `get`,
  `pause`, `resume`, `delete`
- [ ] `delay` action creates one-shot jobs from duration strings
  (e.g., `"30m"`, `"2h"`)
- [ ] Paused jobs remain in the database but do not fire
- [ ] Last execution metadata is tracked per job (last run time, last status,
  run count) — not a full history log
- [ ] All active timers are cleared on graceful shutdown
- [ ] On startup, all active jobs are loaded from the database and their timers
  are (re)scheduled

## Implementation plan

### 1. Database schema

Add a `scheduled_jobs` table to `src/infra/db/schema.ts`:

```typescript
export const scheduledJobs = sqliteTable("scheduled_jobs", {
  id:          text("id").primaryKey(),
  name:        text("name").notNull(),
  message:     text("message").notNull(),
  agent:       text("agent"),               // agent template name, null = default
  schedule:    text("schedule"),             // cron expression, null for one-shot
  runAt:       text("run_at"),              // ISO timestamp for one-shot jobs
  status:      text("status", { enum: ["active", "paused", "completed"] })
                 .notNull().default("active"),
  runCount:    integer("run_count").notNull().default(0),
  lastRunAt:   text("last_run_at"),
  lastStatus:  text("last_status"),          // "success" | "error"
  lastError:   text("last_error"),
  createdAt:   timestamp(),
  updatedAt:   timestamp(),
}, (table) => [
  index("idx_jobs_status").on(table.status),
]);
```

Run `bun run db:generate` to produce the migration.

**Delay validation**: accepted formats are `Nm`, `Nh`, `Nd` where N is a
positive integer. Maximum delay: 30 days. Longer scheduling should use cron
or an absolute `runAt` timestamp.

### 2. Scheduler service (`src/infra/scheduler.ts`)

Core service responsible for timer management:

```
- loadAll(): read active jobs from DB, schedule cron jobs + start poll timer
- scheduleCron(job): create Cron instance, store in map
- cancelJob(id): stop Cron instance / remove from map
- executeJob(job): call executeTurn via sessionService.enqueue
- pollOneShots(): every 60s, query DB for active one-shots with runAt <= now
- shutdown(): stop all Cron instances + clear poll interval
```

**Cron jobs**: Use the `croner` package (lightweight, no deps, supports
standard 5-field cron + seconds). Each cron job gets a `Cron` instance that
calls `executeJob` on tick.

**One-shot jobs**: A single `setInterval(pollOneShots, 60_000)` polls the DB
for due one-shot jobs. This avoids `setTimeout` overflow for long delays and
simplifies timer management to one interval. After execution, set status to
`completed`.

**Execution**: `executeJob` calls the agent directly:
```typescript
const sessionId = generateId();
await sessionService.enqueue(sessionId, () =>
  executeTurn({ sessionId, prompt: job.message, agent: job.agent })
);
```

Update `runCount`, `lastRunAt`, `lastStatus` after each execution.

**Error handling**: If `executeTurn` throws, log the error, set
`lastStatus = "error"` and `lastError` with a sanitized message. The job
remains active (cron) or marks as completed (one-shot) regardless.

### 3. Scheduler tool (`src/tools/scheduler.ts`)

Multi-action tool with these actions:

| Action     | Parameters                          | Description                              |
|------------|-------------------------------------|------------------------------------------|
| `schedule` | `name`, `message`, `cron`, `agent?` | Create a recurring job on a cron schedule |
| `delay`    | `name`, `message`, `delay`, `agent?`| Create a one-shot job after a duration    |
| `list`     | (none)                              | List all jobs with status                 |
| `get`      | `id`                                | Get job details + last run info           |
| `pause`    | `id`                                | Pause a recurring job                     |
| `resume`   | `id`                                | Resume a paused job                       |
| `delete`   | `id`                                | Delete a job and cancel its timer         |

- `schedule` → `cron` is a standard cron expression (e.g., `"*/5 * * * *"`)
- `delay` → `delay` is a human-friendly duration string (e.g., `"30m"`, `"2h"`,
  `"1d"`)

Register in `src/tools/index.ts`.

### 4. Bootstrap integration

In `src/infra/bootstrap.ts`:
- `initServices()`: after DB init, import and call `scheduler.loadAll()` to
  restore active jobs from the database
- `shutdownServices()`: call `scheduler.shutdown()` to clear all timers

### 5. DB query functions

Add to `src/infra/db/index.ts`:
```
createJob(opts): Job
getJob(id): Job | null
listJobs(): Job[]
updateJobStatus(id, status): void
updateJobExecution(id, runCount, lastRunAt, lastStatus, lastError?): void
deleteJob(id): void
```

## Testing scenarios

| Criterion | Test |
|-----------|------|
| Jobs persist across restarts | Unit: create job, re-init scheduler from DB, assert job is loaded and scheduled |
| Cron fires on schedule | Unit: create job with `* * * * *`, mock fetch, advance timer, assert fetch called |
| One-shot fires and completes | Unit: create one-shot with `runAt` in the past, trigger `pollOneShots()`, assert fires once, status → completed |
| One-shot stays in DB | Unit: after one-shot fires, assert status is "completed", row still exists, no active timer |
| Direct executeTurn call | Integration: create job, trigger execution, assert new session created with correct prompt and agent |
| Pause/resume | Unit: pause job, advance past fire time, assert no execution; resume, assert fires |
| Delete cancels timer | Unit: create job, delete it, advance past fire time, assert no execution |
| Execution history updated | Unit: run job, assert `runCount++`, `lastRunAt` set, `lastStatus` correct |
| Graceful shutdown clears timers | Unit: create jobs, call `shutdown()`, assert all timers cleared |
| Tool CRUD works | Unit: test each scheduler tool action with valid and invalid inputs |
| Invalid cron expression rejected | Unit: create with bad cron string, assert validation error |
| Delay parsing | Unit: "30m" → 30 min from now, "2h" → 2 hours, "1d" → 24 hours |
| Delay max enforced | Unit: "31d" rejected, "30d" accepted |
| Execution error handling | Unit: mock executeTurn to throw, assert lastStatus="error", lastError set, job still active (cron) or completed (one-shot) |