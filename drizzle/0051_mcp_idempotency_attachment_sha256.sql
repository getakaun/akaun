CREATE TABLE `mcp_idempotency` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`binding` text NOT NULL,
	`key` text NOT NULL,
	`tool` text NOT NULL,
	`input_hash` text NOT NULL,
	`result` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_idempotency_key_idx` ON `mcp_idempotency` (`user_id`,`binding`,`key`);--> statement-breakpoint
CREATE INDEX `mcp_idempotency_created_at_idx` ON `mcp_idempotency` (`created_at`);--> statement-breakpoint
ALTER TABLE `record_attachments` ADD `sha256` text;