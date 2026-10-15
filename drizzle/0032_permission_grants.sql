CREATE TABLE `group_delegations` (
	`group_id` integer NOT NULL,
	`permission` text NOT NULL,
	PRIMARY KEY(`group_id`, `permission`),
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `group_grants` (
	`group_id` integer NOT NULL,
	`permission` text NOT NULL,
	PRIMARY KEY(`group_id`, `permission`),
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `personal_access_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`last_four` text NOT NULL,
	`permissions` text NOT NULL,
	`expires_at` integer,
	`last_used_at` integer,
	`created_at` integer NOT NULL,
	`created_by` integer,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `personal_access_tokens_token_hash_unique` ON `personal_access_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `personal_access_tokens_user_idx` ON `personal_access_tokens` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `personal_access_tokens_live_name_idx` ON `personal_access_tokens` (`user_id`,`name`) WHERE "personal_access_tokens"."revoked_at" IS NULL;--> statement-breakpoint
CREATE TABLE `user_grants` (
	`user_id` integer NOT NULL,
	`permission` text NOT NULL,
	PRIMARY KEY(`user_id`, `permission`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
