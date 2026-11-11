DROP TRIGGER IF EXISTS tax_capital_final_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS tax_capital_final_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS tax_capital_retain;
--> statement-breakpoint
DROP TRIGGER IF EXISTS tax_capital_manual_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS tax_capital_overlap_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS tax_capital_overlap_update;
--> statement-breakpoint
CREATE TABLE `asset_tax_schemes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`family_key` text NOT NULL,
	`version` integer NOT NULL,
	`definition` text NOT NULL,
	`request_key` text NOT NULL,
	`payload_hash` text NOT NULL,
	`actor_name` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "asset_tax_scheme_version_check" CHECK(typeof("version") = 'integer' AND "version" > 0),
	CONSTRAINT "asset_tax_scheme_definition" CHECK(json_valid("definition"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `asset_tax_schemes_request_key_unique` ON `asset_tax_schemes` (`request_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `asset_tax_scheme_version` ON `asset_tax_schemes` (`family_key`,`version`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_tax_capital_schedules` (
	`revision_id` integer PRIMARY KEY NOT NULL,
	`active` integer NOT NULL,
	`evidence` text NOT NULL,
	FOREIGN KEY (`revision_id`) REFERENCES `tax_worksheet_revisions`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "tax_capital_active" CHECK("active" IN (0, 1)),
	CONSTRAINT "tax_capital_json" CHECK(CASE WHEN json_valid("evidence") THEN coalesce((json_extract("evidence", '$.calculationVersion') = 1 AND json_extract("evidence", '$.currency') = 'MYR' OR json_extract("evidence", '$.calculationVersion') = 2 AND json_type("evidence", '$.currency') = 'text' AND length(json_extract("evidence", '$.currency')) = 3) AND json_type("evidence", '$.rows') = 'array' AND json_type("evidence", '$.assets') = 'array' AND json_type("evidence", '$.utilisation') = 'array', 0) ELSE 0 END)
);
--> statement-breakpoint
INSERT INTO `__new_tax_capital_schedules`("revision_id", "active", "evidence") SELECT "revision_id", "active", "evidence" FROM `tax_capital_schedules`;--> statement-breakpoint
DROP TABLE `tax_capital_schedules`;--> statement-breakpoint
ALTER TABLE `__new_tax_capital_schedules` RENAME TO `tax_capital_schedules`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
--> statement-breakpoint
CREATE TRIGGER tax_capital_final_insert BEFORE INSERT ON tax_capital_schedules
WHEN (SELECT status FROM tax_worksheet_revisions WHERE id=NEW.revision_id)='finalised'
BEGIN SELECT RAISE(ABORT, 'Finalised capital allowance evidence is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER tax_capital_final_update BEFORE UPDATE ON tax_capital_schedules
WHEN NEW.revision_id<>OLD.revision_id OR (SELECT status FROM tax_worksheet_revisions WHERE id=OLD.revision_id)='finalised'
BEGIN SELECT RAISE(ABORT, 'Finalised capital allowance evidence is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER tax_capital_retain BEFORE DELETE ON tax_capital_schedules
BEGIN SELECT RAISE(ABORT, 'Capital allowance evidence must be retained'); END;
--> statement-breakpoint
CREATE TRIGGER tax_capital_manual_insert BEFORE INSERT ON tax_worksheet_adjustments
WHEN NEW.withdrawn_at IS NULL AND NEW.kind IN ('capital_allowance','allowance_brought_forward') AND EXISTS(SELECT 1 FROM tax_capital_schedules WHERE revision_id=NEW.revision_id AND active=1)
BEGIN SELECT RAISE(ABORT, 'Asset schedule already supplies allowance claims'); END;
--> statement-breakpoint
CREATE TRIGGER tax_capital_overlap_insert BEFORE INSERT ON tax_capital_schedules
WHEN NEW.active=1 AND EXISTS(SELECT 1 FROM tax_worksheet_adjustments WHERE revision_id=NEW.revision_id AND withdrawn_at IS NULL AND kind IN ('capital_allowance','allowance_brought_forward'))
BEGIN SELECT RAISE(ABORT, 'Withdraw overlapping manual allowance entries'); END;
--> statement-breakpoint
CREATE TRIGGER tax_capital_overlap_update BEFORE UPDATE ON tax_capital_schedules
WHEN NEW.active=1 AND EXISTS(SELECT 1 FROM tax_worksheet_adjustments WHERE revision_id=NEW.revision_id AND withdrawn_at IS NULL AND kind IN ('capital_allowance','allowance_brought_forward'))
BEGIN SELECT RAISE(ABORT, 'Withdraw overlapping manual allowance entries'); END;
--> statement-breakpoint
CREATE TRIGGER asset_tax_scheme_update BEFORE UPDATE ON asset_tax_schemes
BEGIN SELECT RAISE(ABORT, 'Create a new scheme version instead of editing history'); END;
--> statement-breakpoint
CREATE TRIGGER asset_tax_scheme_delete BEFORE DELETE ON asset_tax_schemes
BEGIN SELECT RAISE(ABORT, 'Tax scheme versions must be retained'); END;
