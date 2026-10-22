PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_settlements` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`payment_movement_id` integer NOT NULL,
	`owed_movement_id` integer NOT NULL,
	`amount_minor` integer NOT NULL,
	`reversed_at` text,
	`reversed_by` integer,
	`reversal_reason` text,
	`created_by` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`payment_movement_id`) REFERENCES `ledger_movements`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`owed_movement_id`) REFERENCES `ledger_movements`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`reversed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_settlements`("id", "payment_movement_id", "owed_movement_id", "amount_minor", "reversed_at", "reversed_by", "reversal_reason", "created_by", "created_at") SELECT "id", "payment_movement_id", "owed_movement_id", "amount_minor", NULL, NULL, NULL, "created_by", "created_at" FROM `settlements`;--> statement-breakpoint
-- Preserve IDs used by old audit-only reversals, even when their rows were deleted.
INSERT INTO sqlite_sequence(name, seq)
SELECT '__new_settlements', seq FROM sqlite_sequence
WHERE name = 'settlements' AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = '__new_settlements');--> statement-breakpoint
UPDATE sqlite_sequence SET seq = max(seq, coalesce((SELECT seq FROM sqlite_sequence WHERE name = 'settlements'), 0))
WHERE name = '__new_settlements';--> statement-breakpoint
DROP TABLE `settlements`;--> statement-breakpoint
ALTER TABLE `__new_settlements` RENAME TO `settlements`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `settlements_pair_idx` ON `settlements` (`payment_movement_id`,`owed_movement_id`) WHERE "settlements"."reversed_at" IS NULL;--> statement-breakpoint
CREATE INDEX `settlements_owed_idx` ON `settlements` (`owed_movement_id`);
