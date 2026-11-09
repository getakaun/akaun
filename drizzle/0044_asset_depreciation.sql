CREATE TABLE `depreciation_postings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`asset_id` integer NOT NULL,
	`month` text NOT NULL,
	`profile_id` integer NOT NULL,
	`run_id` integer NOT NULL,
	`amount_minor` integer NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `fixed_assets`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`profile_id`) REFERENCES `depreciation_profiles`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`run_id`) REFERENCES `depreciation_runs`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "depreciation_posting_amount" CHECK(typeof("amount_minor") = 'integer' AND "amount_minor" BETWEEN 1 AND 9007199254740991)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `depreciation_asset_month` ON `depreciation_postings` (`asset_id`,`month`);--> statement-breakpoint
CREATE TABLE `depreciation_profiles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`asset_id` integer NOT NULL,
	`start_month` text NOT NULL,
	`months` integer NOT NULL,
	`base_nbv_minor` integer NOT NULL,
	`residual_minor` integer NOT NULL,
	`expense_account_id` integer NOT NULL,
	`accumulated_account_id` integer NOT NULL,
	`mode` text NOT NULL,
	`basis` text NOT NULL,
	`stopped_from` text,
	`approved_by` integer NOT NULL,
	`reason` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `fixed_assets`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`expense_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`accumulated_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`approved_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "depreciation_profile_amounts" CHECK(typeof("base_nbv_minor") = 'integer' AND "base_nbv_minor" BETWEEN 0 AND 9007199254740991 AND typeof("residual_minor") = 'integer' AND "residual_minor" BETWEEN 0 AND "base_nbv_minor" AND typeof("months") = 'integer' AND "months" BETWEEN 1 AND 1200),
	CONSTRAINT "depreciation_profile_mode" CHECK("mode" IN ('review', 'auto'))
);
--> statement-breakpoint
CREATE INDEX `depreciation_profile_version` ON `depreciation_profiles` (`asset_id`,`start_month`);--> statement-breakpoint
CREATE TABLE `depreciation_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`month` text NOT NULL,
	`record_id` integer NOT NULL,
	`reversal_record_id` integer,
	`reversed_on` text,
	`created_by` integer NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`record_id`) REFERENCES `ledger_records`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`reversal_record_id`) REFERENCES `ledger_records`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `depreciation_runs_record_id_unique` ON `depreciation_runs` (`record_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `depreciation_runs_reversal_record_id_unique` ON `depreciation_runs` (`reversal_record_id`);