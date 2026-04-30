CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`parent_id` text,
	`source_call_id` text,
	`template` text NOT NULL,
	`task` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`result` text,
	`error` text,
	`turn_count` integer DEFAULT 0 NOT NULL,
	`createdAt` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`started_at` text,
	`completed_at` text,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_agents_session` ON `agents` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_agents_parent` ON `agents` (`parent_id`);--> statement-breakpoint
CREATE TABLE `items` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`type` text NOT NULL,
	`role` text,
	`content` text,
	`call_id` text,
	`name` text,
	`arguments` text,
	`output` text,
	`createdAt` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_items_agent_seq` ON `items` (`agent_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `idx_items_call_id` ON `items` (`call_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`root_agent_id` text,
	`title` text,
	`createdAt` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updatedAt` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
