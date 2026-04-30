CREATE TABLE `scheduled_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`message` text NOT NULL,
	`agent` text,
	`schedule` text,
	`run_at` text,
	`status` text DEFAULT 'active' NOT NULL,
	`run_count` integer DEFAULT 0 NOT NULL,
	`last_run_at` text,
	`last_status` text,
	`last_error` text,
	`createdAt` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updatedAt` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_jobs_status` ON `scheduled_jobs` (`status`);