-- The audit log is recreated empty rather than copied: entries written before
-- this migration carry no channel (session / token / app), and the maintainer
-- chose to discard them over keeping rows that cannot say how they arrived.
DROP TABLE `audit_log`;--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`record_type` text NOT NULL,
	`record_id` text NOT NULL,
	`record_label` text,
	`user_id` integer,
	`actor_name` text,
	`via` text NOT NULL,
	`credential_id` text,
	`client_id` text,
	`credential_label` text,
	`request_id` text,
	`operation` text,
	`action` text NOT NULL,
	`changes` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `audit_log_record_idx` ON `audit_log` (`record_type`,`record_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_log_user_idx` ON `audit_log` (`user_id`,`id`);--> statement-breakpoint
CREATE INDEX `audit_log_via_idx` ON `audit_log` (`via`,`id`);--> statement-breakpoint
CREATE INDEX `audit_log_client_idx` ON `audit_log` (`client_id`,`id`);--> statement-breakpoint
CREATE INDEX `audit_log_request_idx` ON `audit_log` (`request_id`);
