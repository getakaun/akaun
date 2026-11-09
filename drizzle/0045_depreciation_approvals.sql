CREATE TABLE `depreciation_allocations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`asset_id` integer NOT NULL,
	`record_id` integer NOT NULL,
	`expense_account_id` integer NOT NULL,
	`accumulated_account_id` integer NOT NULL,
	`amount_minor` integer NOT NULL,
	`from_month` text NOT NULL,
	`through_month` text NOT NULL,
	`record_date` text NOT NULL,
	`approved_by` integer NOT NULL,
	`reason` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `fixed_assets`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`record_id`) REFERENCES `ledger_records`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`expense_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`accumulated_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`approved_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "depreciation_allocation_amount" CHECK(typeof("amount_minor") = 'integer' AND "amount_minor" BETWEEN 1 AND 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE `depreciation_approvals` (
	`profile_id` integer PRIMARY KEY NOT NULL,
	`future_from_month` text NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `depreciation_profiles`(`id`) ON UPDATE no action ON DELETE restrict
);

--> statement-breakpoint
INSERT INTO depreciation_approvals (profile_id, future_from_month) SELECT id, strftime('%Y-%m', 'now', 'localtime') FROM depreciation_profiles;
