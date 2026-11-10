CREATE TABLE `tax_worksheet_adjustments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`revision_id` integer NOT NULL,
	`kind` text NOT NULL,
	`source_movement_id` integer,
	`percentage_bps` integer,
	`treatment` text,
	`amount_minor` integer DEFAULT 0 NOT NULL,
	`direction` text DEFAULT 'decrease' NOT NULL,
	`balance_minor` integer DEFAULT 0 NOT NULL,
	`origin_ya` integer,
	`reason` text NOT NULL,
	`evidence` text NOT NULL,
	`request_key` text NOT NULL,
	`created_by` integer,
	`actor_name` text NOT NULL,
	`created_at` text NOT NULL,
	`withdrawn_at` text,
	`withdrawal_reason` text,
	FOREIGN KEY (`revision_id`) REFERENCES `tax_worksheet_revisions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "tax_adjustment_kind" CHECK("kind" IN ('source', 'other', 'capital_allowance', 'allowance_brought_forward', 'loss_brought_forward')),
	CONSTRAINT "tax_adjustment_direction" CHECK("direction" IN ('increase', 'decrease')),
	CONSTRAINT "tax_adjustment_amount" CHECK(typeof("amount_minor") = 'integer' AND "amount_minor" BETWEEN 0 AND 9007199254740991 AND typeof("balance_minor") = 'integer' AND "balance_minor" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "tax_manual_claim" CHECK(coalesce("kind" = 'source' OR ("kind" = 'other' AND "amount_minor" > 0 AND "balance_minor" = 0 AND "origin_ya" IS NULL) OR ("kind" = 'capital_allowance' AND "direction" = 'decrease' AND "amount_minor" > 0 AND "balance_minor" = 0 AND "origin_ya" IS NULL) OR ("kind" IN ('allowance_brought_forward', 'loss_brought_forward') AND "direction" = 'decrease' AND typeof("origin_ya") = 'integer' AND "origin_ya" BETWEEN 2000 AND 9999 AND "amount_minor" <= "balance_minor"), 0)),
	CONSTRAINT "tax_adjustment_source" CHECK(coalesce(("kind" = 'source' AND typeof("source_movement_id") = 'integer' AND "source_movement_id" > 0 AND typeof("percentage_bps") = 'integer' AND "balance_minor" = 0 AND "origin_ya" IS NULL AND (("treatment" = 'ordinary_deductible' AND "percentage_bps" = 10000) OR ("treatment" = 'partial' AND "percentage_bps" BETWEEN 1 AND 9999) OR ("treatment" IN ('non_deductible', 'capital_expenditure') AND "percentage_bps" = 0))) OR ("kind" <> 'source' AND "source_movement_id" IS NULL AND "percentage_bps" IS NULL AND "treatment" IS NULL), 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tax_adjustment_request` ON `tax_worksheet_adjustments` (`revision_id`,`request_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `tax_active_source_correction` ON `tax_worksheet_adjustments` (`revision_id`,`source_movement_id`) WHERE "withdrawn_at" IS NULL AND "kind" = 'source';--> statement-breakpoint
CREATE UNIQUE INDEX `tax_current_allowance_claim` ON `tax_worksheet_adjustments` (`revision_id`) WHERE "withdrawn_at" IS NULL AND "kind" = 'capital_allowance';--> statement-breakpoint
CREATE UNIQUE INDEX `tax_carry_origin` ON `tax_worksheet_adjustments` (`revision_id`,`kind`,`origin_ya`) WHERE "withdrawn_at" IS NULL AND "kind" IN ('allowance_brought_forward', 'loss_brought_forward');--> statement-breakpoint
CREATE INDEX `tax_adjustment_revision` ON `tax_worksheet_adjustments` (`revision_id`);--> statement-breakpoint
CREATE TABLE `tax_worksheet_revisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`worksheet_id` integer NOT NULL,
	`revision` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`snapshot` text NOT NULL,
	`source_hash` text NOT NULL,
	`captured_at` text NOT NULL,
	`amendment_reason` text,
	`request_key` text NOT NULL,
	`reviewed_by` integer,
	`reviewed_at` text,
	`finalised_by` integer,
	`finalised_at` text,
	FOREIGN KEY (`worksheet_id`) REFERENCES `tax_worksheets`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`reviewed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`finalised_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "tax_revision_status" CHECK("status" IN ('draft', 'reviewed', 'finalised')),
	CONSTRAINT "tax_revision_numbers" CHECK(typeof("revision") = 'integer' AND "revision" > 0 AND typeof("version") = 'integer' AND "version" > 0),
	CONSTRAINT "tax_revision_json" CHECK(json_valid("snapshot")),
	CONSTRAINT "tax_revision_lock" CHECK(("status" = 'draft' AND "reviewed_at" IS NULL AND "finalised_at" IS NULL) OR ("status" = 'reviewed' AND "reviewed_at" IS NOT NULL AND "finalised_at" IS NULL) OR ("status" = 'finalised' AND "reviewed_at" IS NOT NULL AND "finalised_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tax_worksheet_revisions_request_key_unique` ON `tax_worksheet_revisions` (`request_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `tax_revision_number` ON `tax_worksheet_revisions` (`worksheet_id`,`revision`);--> statement-breakpoint
CREATE TABLE `tax_worksheets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ya` integer NOT NULL,
	`date_from` text NOT NULL,
	`date_to` text NOT NULL,
	`request_key` text NOT NULL,
	`created_by` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "tax_period_order" CHECK("date_from" <= "date_to")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tax_worksheets_ya_unique` ON `tax_worksheets` (`ya`);--> statement-breakpoint
CREATE UNIQUE INDEX `tax_worksheets_request_key_unique` ON `tax_worksheets` (`request_key`);--> statement-breakpoint
CREATE TRIGGER tax_finalised_revision_update BEFORE UPDATE OF worksheet_id, revision, version, status, snapshot, source_hash, captured_at, amendment_reason, request_key, reviewed_at, finalised_at ON tax_worksheet_revisions
WHEN OLD.status = 'finalised'
BEGIN SELECT RAISE(ABORT, 'Finalised tax evidence is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER tax_revision_delete BEFORE DELETE ON tax_worksheet_revisions
BEGIN SELECT RAISE(ABORT, 'Tax revisions must be retained'); END;
--> statement-breakpoint
CREATE TRIGGER tax_adjustment_insert BEFORE INSERT ON tax_worksheet_adjustments
WHEN (SELECT status FROM tax_worksheet_revisions WHERE id = NEW.revision_id) = 'finalised'
BEGIN SELECT RAISE(ABORT, 'Finalised tax adjustments are locked'); END;
--> statement-breakpoint
CREATE TRIGGER tax_adjustment_withdraw BEFORE UPDATE OF withdrawn_at, withdrawal_reason ON tax_worksheet_adjustments
WHEN OLD.withdrawn_at IS NOT NULL OR (SELECT status FROM tax_worksheet_revisions WHERE id = OLD.revision_id) = 'finalised'
BEGIN SELECT RAISE(ABORT, 'Tax adjustment history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER tax_adjustment_edit BEFORE UPDATE OF revision_id, kind, source_movement_id, percentage_bps, treatment, amount_minor, direction, balance_minor, origin_ya, reason, evidence, request_key, actor_name, created_at ON tax_worksheet_adjustments
BEGIN SELECT RAISE(ABORT, 'Replace or withdraw tax adjustments instead of editing history'); END;
--> statement-breakpoint
CREATE TRIGGER tax_adjustment_delete BEFORE DELETE ON tax_worksheet_adjustments
BEGIN SELECT RAISE(ABORT, 'Tax adjustment history must be retained'); END;
--> statement-breakpoint
CREATE TRIGGER tax_period_edit BEFORE UPDATE OF ya, date_from, date_to, request_key, created_at ON tax_worksheets
BEGIN SELECT RAISE(ABORT, 'Annual tax periods are immutable'); END;
