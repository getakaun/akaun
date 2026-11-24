CREATE TABLE `authentication_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`revision` text NOT NULL,
	`configuration` text NOT NULL,
	`encrypted_secret` text
);
--> statement-breakpoint
CREATE TABLE `oidc_attempts` (
	`state` text PRIMARY KEY NOT NULL,
	`browser_hash` text NOT NULL,
	`verifier` text NOT NULL,
	`nonce` text NOT NULL,
	`revision` text NOT NULL,
	`started_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`return_to` text NOT NULL,
	`link_session_id` text,
	FOREIGN KEY (`link_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `oidc_attempt_expiry` ON `oidc_attempts` (`expires_at`);--> statement-breakpoint
CREATE INDEX `oidc_attempt_link` ON `oidc_attempts` (`link_session_id`);--> statement-breakpoint
CREATE TABLE `oidc_group_memberships` (
	`user_id` integer NOT NULL,
	`group_id` integer NOT NULL,
	PRIMARY KEY(`user_id`, `group_id`),
	FOREIGN KEY (`user_id`,`group_id`) REFERENCES `user_groups`(`user_id`,`group_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `oidc_identities` (
	`issuer` text NOT NULL,
	`subject` text NOT NULL,
	`user_id` integer NOT NULL,
	PRIMARY KEY(`issuer`, `subject`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oidc_identity_user_issuer` ON `oidc_identities` (`user_id`,`issuer`);--> statement-breakpoint
CREATE TABLE `oidc_logout_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`configuration` text NOT NULL,
	`subject` text,
	`sid` text,
	`received_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `oidc_logout_configuration` ON `oidc_logout_receipts` (`configuration`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `oidc_configuration` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `oidc_subject` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `oidc_sid` text;--> statement-breakpoint
ALTER TABLE `users` ADD `oidc_managed_by` text;--> statement-breakpoint
ALTER TABLE `users` ADD `disabled` integer DEFAULT false NOT NULL;