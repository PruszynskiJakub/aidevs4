import { sqliteTable, text, integer, index, uniqueIndex, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export type JobStatus = "active" | "paused" | "completed";
export type JobRunStatus = "success" | "error";

const timestamp = () =>
  text().notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`);

export const sessions = sqliteTable("sessions", {
  id:          text("id").primaryKey(),
  rootRunId:   text("root_run_id"),
  assistant:   text("assistant"),
  title:       text("title"),
  createdAt:   timestamp(),
  updatedAt:   timestamp(),
});

export const runs = sqliteTable("runs", {
  id:            text("id").primaryKey(),
  sessionId:     text("session_id").notNull().references(() => sessions.id),
  parentId:      text("parent_id").references((): any => runs.id),
  rootRunId:     text("root_run_id").references((): any => runs.id),
  sourceCallId:  text("source_call_id"),
  template:      text("template").notNull(),
  task:          text("task").notNull(),
  status:        text("status", {
                   enum: [
                     "pending",
                     "running",
                     "waiting",
                     "completed",
                     "failed",
                     "cancelled",
                     "exhausted",
                   ],
                 })
                   .notNull().default("pending"),
  result:        text("result"),
  error:         text("error"),
  waitingOn:     text("waiting_on"),
  exitKind:      text("exit_kind"),
  turnCount:     integer("turn_count").notNull().default(0),
  version:       integer("version").notNull().default(1),
  createdAt:     timestamp(),
  startedAt:     text("started_at"),
  completedAt:   text("completed_at"),
}, (table) => [
  index("idx_runs_session").on(table.sessionId),
  index("idx_runs_parent").on(table.parentId),
  index("idx_runs_root").on(table.rootRunId),
  check(
    "runs_root_run_rule",
    sql`(${table.parentId} is null and ${table.rootRunId} = ${table.id}) or (${table.parentId} is not null and ${table.rootRunId} is not null)`,
  ),
]);

export const items = sqliteTable("items", {
  id:        text("id").primaryKey(),
  runId:     text("run_id").notNull().references(() => runs.id),
  sequence:  integer("sequence").notNull(),
  type:      text("type", { enum: ["message", "function_call", "function_call_output"] })
               .notNull(),
  role:      text("role"),
  content:   text("content"),
  callId:    text("call_id"),
  name:      text("name"),
  arguments: text("arguments"),
  output:    text("output"),
  createdAt: timestamp(),
}, (table) => [
  uniqueIndex("idx_items_run_seq").on(table.runId, table.sequence),
  index("idx_items_call_id").on(table.callId),
]);

export const scheduledJobs = sqliteTable("scheduled_jobs", {
  id:          text("id").primaryKey(),
  name:        text("name").notNull(),
  message:     text("message").notNull(),
  agent:       text("agent"),
  schedule:    text("schedule"),
  runAt:       text("run_at"),
  status:      text("status", { enum: ["active", "paused", "completed"] })
                 .notNull().default("active"),
  runCount:    integer("run_count").notNull().default(0),
  lastRunAt:   text("last_run_at"),
  lastStatus:  text("last_status"),
  lastError:   text("last_error"),
  createdAt:   timestamp(),
  updatedAt:   timestamp(),
}, (table) => [
  index("idx_jobs_status").on(table.status),
]);
