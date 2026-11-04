-- HAND-CORRECTED: drizzle-kit's ADD COLUMN drops the ON DELETE clause the
-- schema declares; SQLite accepts it on ADD COLUMN (the column defaults to
-- NULL), so it is written out to match meta/0040_snapshot.json.
ALTER TABLE `ledger_records` ADD `reverses_record_id` integer REFERENCES ledger_records(id) ON DELETE restrict;--> statement-breakpoint
CREATE UNIQUE INDEX `ledger_records_reverses_idx` ON `ledger_records` (`reverses_record_id`);
