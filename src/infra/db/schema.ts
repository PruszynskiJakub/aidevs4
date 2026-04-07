import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

const timestamp = () =>
  text().notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`);

export const sessions = sqliteTable("sessions", {
  id:          text("id").primaryKey(),
  rootAgentId: text("root_agent_id"),
  assistant:   text("assistant"),
  title:       text("title"),
  createdAt:   timestamp(),
  updatedAt:   timestamp(),
});

export const agents = sqliteTable("agents", {
  id:            text("id").primaryKey(),
  sessionId:     text("session_id").notNull().references(() => sessions.id),
  parentId:      text("parent_id").references(() => agents.id),
  sourceCallId:  text("source_call_id"),
  template:      text("template").notNull(),
  task:          text("task").notNull(),
  status:        text("status", { enum: ["pending", "running", "completed", "failed"] })
                   .notNull().default("pending"),
  result:        text("result"),
  error:         text("error"),
  turnCount:     integer("turn_count").notNull().default(0),
  createdAt:     timestamp(),
  startedAt:     text("started_at"),
  completedAt:   text("completed_at"),
}, (table) => [
  index("idx_agents_session").on(table.sessionId),
  index("idx_agents_parent").on(table.parentId),
]);

export const items = sqliteTable("items", {
  id:        text("id").primaryKey(),
  agentId:   text("agent_id").notNull().references(() => agents.id),
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
  uniqueIndex("idx_items_agent_seq").on(table.agentId, table.sequence),
  index("idx_items_call_id").on(table.callId),
]);
