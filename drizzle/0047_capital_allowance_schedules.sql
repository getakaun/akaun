CREATE TABLE `tax_capital_commands` (
	`request_key` text PRIMARY KEY NOT NULL,
	`revision_id` integer NOT NULL,
	`payload_hash` text NOT NULL,
	FOREIGN KEY (`revision_id`) REFERENCES `tax_worksheet_revisions`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `tax_capital_schedules` (
	`revision_id` integer PRIMARY KEY NOT NULL,
	`active` integer NOT NULL,
	`evidence` text NOT NULL,
	FOREIGN KEY (`revision_id`) REFERENCES `tax_worksheet_revisions`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "tax_capital_active" CHECK("active" IN (0, 1)),
	CONSTRAINT "tax_capital_json" CHECK(CASE WHEN json_valid("evidence") THEN coalesce(json_extract("evidence", '$.calculationVersion') = 1 AND json_extract("evidence", '$.currency') = 'MYR' AND json_type("evidence", '$.rows') = 'array' AND json_type("evidence", '$.assets') = 'array' AND json_type("evidence", '$.utilisation') = 'array', 0) ELSE 0 END)
);
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
CREATE TRIGGER tax_capital_command_update BEFORE UPDATE ON tax_capital_commands
BEGIN SELECT RAISE(ABORT, 'Capital allowance command history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER tax_capital_command_delete BEFORE DELETE ON tax_capital_commands
BEGIN SELECT RAISE(ABORT, 'Capital allowance command history must be retained'); END;
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
