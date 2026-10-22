CREATE TABLE `reimbursement_entries` (
	`record_id` integer PRIMARY KEY NOT NULL,
	`group_id` integer NOT NULL,
	`role` text NOT NULL,
	FOREIGN KEY (`record_id`) REFERENCES `ledger_records`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`group_id`) REFERENCES `reimbursements`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `reimbursement_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`group_id` integer NOT NULL,
	`source_movement_id` integer NOT NULL,
	`amount_minor` integer NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `reimbursements`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`source_movement_id`) REFERENCES `ledger_movements`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `reimbursements` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`payable_record_id` integer NOT NULL,
	`payment_record_id` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`payable_record_id`) REFERENCES `ledger_records`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`payment_record_id`) REFERENCES `ledger_records`(`id`) ON UPDATE no action ON DELETE restrict
);
