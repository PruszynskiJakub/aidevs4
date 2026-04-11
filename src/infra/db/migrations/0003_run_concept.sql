-- SP-87 Run concept and waiting state
-- Rename agents→runs, turnCount→cycleCount, sessions.rootAgentId→rootRunId,
-- items.agentId→runId; add waitingOn + exitKind columns; extend status enum.

-- Drop old indexes that reference the table to be renamed
DROP INDEX IF EXISTS `idx_agents_session`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_agents_parent`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_items_agent_seq`;--> statement-breakpoint

-- Rename tables and columns
ALTER TABLE `agents` RENAME TO `runs`;--> statement-breakpoint
ALTER TABLE `runs` RENAME COLUMN `turn_count` TO `cycle_count`;--> statement-breakpoint
ALTER TABLE `sessions` RENAME COLUMN `root_agent_id` TO `root_run_id`;--> statement-breakpoint
ALTER TABLE `items` RENAME COLUMN `agent_id` TO `run_id`;--> statement-breakpoint

-- Add new columns on runs
ALTER TABLE `runs` ADD COLUMN `waiting_on` text;--> statement-breakpoint
ALTER TABLE `runs` ADD COLUMN `exit_kind` text;--> statement-breakpoint

-- Recreate indexes with new names
CREATE INDEX `idx_runs_session` ON `runs` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_runs_parent` ON `runs` (`parent_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_items_run_seq` ON `items` (`run_id`,`sequence`);
