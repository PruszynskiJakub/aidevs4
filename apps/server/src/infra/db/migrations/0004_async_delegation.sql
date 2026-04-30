-- SP-88 Async delegation with run continuation
-- Add root_run_id column, version column, and CHECK constraint.

ALTER TABLE `runs` ADD COLUMN `root_run_id` text REFERENCES `runs`(`id`);--> statement-breakpoint
ALTER TABLE `runs` ADD COLUMN `version` integer NOT NULL DEFAULT 1;--> statement-breakpoint
CREATE INDEX `idx_runs_root` ON `runs` (`root_run_id`);--> statement-breakpoint

-- Backfill: runs with no parent are their own root
UPDATE `runs` SET `root_run_id` = `id` WHERE `parent_id` IS NULL;
