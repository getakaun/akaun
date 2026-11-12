-- Remove the unreleased manual asset-allowance storage and paths. Financial rows and audit history are untouched.
DROP TRIGGER IF EXISTS tax_capital_manual_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS tax_capital_overlap_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS tax_capital_overlap_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS tax_capital_final_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS tax_capital_final_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS tax_capital_retain;
--> statement-breakpoint
DROP TRIGGER IF EXISTS tax_capital_command_delete;
--> statement-breakpoint
CREATE TEMP TABLE scheme_only_affected_revisions AS
SELECT revision_id FROM tax_capital_schedules
UNION SELECT revision_id FROM tax_worksheet_adjustments WHERE kind IN ('capital_allowance','allowance_brought_forward');
--> statement-breakpoint
DELETE FROM tax_capital_commands WHERE revision_id IN (SELECT revision_id FROM scheme_only_affected_revisions);
--> statement-breakpoint
DROP TRIGGER IF EXISTS tax_finalised_revision_update;
--> statement-breakpoint
INSERT INTO audit_log(record_type,record_id,action,via,actor_name,operation,changes)
SELECT 'tax_worksheet', CAST(r.worksheet_id AS text), 'update', 'system', 'Migration 0049', 'migration:scheme-only-tax',
  json_array(json_object('field','assetTaxWorkings','before','Unreleased saved asset deductions','after','Cleared for scheme-only calculations; select asset schemes again'))
FROM tax_worksheet_revisions r
WHERE r.id IN (SELECT revision_id FROM scheme_only_affected_revisions)
AND r.revision=(SELECT MAX(latest.revision) FROM tax_worksheet_revisions latest WHERE latest.worksheet_id=r.worksheet_id);
--> statement-breakpoint
UPDATE tax_worksheet_revisions SET status='draft', version=version+1, reviewed_by=NULL, reviewed_at=NULL, finalised_by=NULL, finalised_at=NULL
WHERE id IN (SELECT revision_id FROM scheme_only_affected_revisions)
AND revision=(SELECT MAX(latest.revision) FROM tax_worksheet_revisions latest WHERE latest.worksheet_id=tax_worksheet_revisions.worksheet_id);
--> statement-breakpoint
CREATE TRIGGER tax_finalised_revision_update BEFORE UPDATE OF worksheet_id, revision, version, status, snapshot, source_hash, captured_at, amendment_reason, request_key, reviewed_at, finalised_at ON tax_worksheet_revisions
WHEN OLD.status='finalised'
BEGIN SELECT RAISE(ABORT, 'Finalised tax evidence is immutable'); END;
--> statement-breakpoint
DROP TABLE scheme_only_affected_revisions;
--> statement-breakpoint

CREATE TABLE `__new_tax_worksheet_adjustments` (
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
	CONSTRAINT "tax_adjustment_kind" CHECK("kind" IN ('source', 'other', 'loss_brought_forward')),
	CONSTRAINT "tax_adjustment_direction" CHECK("direction" IN ('increase', 'decrease')),
	CONSTRAINT "tax_adjustment_amount" CHECK(typeof("amount_minor") = 'integer' AND "amount_minor" BETWEEN 0 AND 9007199254740991 AND typeof("balance_minor") = 'integer' AND "balance_minor" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "tax_adjustment_values" CHECK(coalesce("kind" = 'source' OR ("kind" = 'other' AND "amount_minor" > 0 AND "balance_minor" = 0 AND "origin_ya" IS NULL) OR ("kind" = 'loss_brought_forward' AND "direction" = 'decrease' AND typeof("origin_ya") = 'integer' AND "origin_ya" BETWEEN 2000 AND 9999 AND "amount_minor" <= "balance_minor"), 0)),
	CONSTRAINT "tax_adjustment_source" CHECK(coalesce(("kind" = 'source' AND typeof("source_movement_id") = 'integer' AND "source_movement_id" > 0 AND typeof("percentage_bps") = 'integer' AND "balance_minor" = 0 AND "origin_ya" IS NULL AND (("treatment" = 'ordinary_deductible' AND "percentage_bps" = 10000) OR ("treatment" = 'partial' AND "percentage_bps" BETWEEN 1 AND 9999) OR ("treatment" IN ('non_deductible', 'capital_expenditure') AND "percentage_bps" = 0))) OR ("kind" <> 'source' AND "source_movement_id" IS NULL AND "percentage_bps" IS NULL AND "treatment" IS NULL), 0))
);
--> statement-breakpoint
INSERT INTO __new_tax_worksheet_adjustments SELECT * FROM tax_worksheet_adjustments WHERE kind IN ('source','other','loss_brought_forward');
--> statement-breakpoint
DROP TABLE tax_worksheet_adjustments;
--> statement-breakpoint
ALTER TABLE __new_tax_worksheet_adjustments RENAME TO tax_worksheet_adjustments;
--> statement-breakpoint
CREATE UNIQUE INDEX tax_adjustment_request ON tax_worksheet_adjustments(revision_id,request_key);
--> statement-breakpoint
CREATE UNIQUE INDEX tax_active_source_correction ON tax_worksheet_adjustments(revision_id,source_movement_id) WHERE withdrawn_at IS NULL AND kind='source';
--> statement-breakpoint
CREATE UNIQUE INDEX tax_carry_origin ON tax_worksheet_adjustments(revision_id,kind,origin_ya) WHERE withdrawn_at IS NULL AND kind='loss_brought_forward';
--> statement-breakpoint
CREATE INDEX tax_adjustment_revision ON tax_worksheet_adjustments(revision_id);
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
CREATE TABLE __new_tax_capital_schedules (
  revision_id integer PRIMARY KEY NOT NULL REFERENCES tax_worksheet_revisions(id) ON DELETE restrict,
  evidence text NOT NULL,
  CONSTRAINT tax_capital_json CHECK(CASE WHEN json_valid(evidence) THEN coalesce(json_extract(evidence, '$.calculationVersion') = 2 AND json_type(evidence, '$.currency') = 'text' AND length(json_extract(evidence, '$.currency')) = 3 AND json_type(evidence, '$.rows') = 'array' AND json_type(evidence, '$.assets') = 'array' AND json_type(evidence, '$.utilisation') = 'array', 0) ELSE 0 END)
);
--> statement-breakpoint
-- All stored capital schedules used the unreleased manual-capable format and are intentionally cleared.

DROP TABLE tax_capital_schedules;
--> statement-breakpoint
ALTER TABLE __new_tax_capital_schedules RENAME TO tax_capital_schedules;
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
CREATE TRIGGER tax_capital_command_delete BEFORE DELETE ON tax_capital_commands
BEGIN SELECT RAISE(ABORT, 'Capital allowance command history must be retained'); END;
--> statement-breakpoint
CREATE TRIGGER tax_capital_scheme_insert BEFORE INSERT ON tax_capital_schedules
WHEN EXISTS (SELECT 1 FROM json_each(NEW.evidence, '$.rows') AS r WHERE
  json_extract(r.value, '$.treatment') = 'claim' AND (
    coalesce(json_type(r.value, '$.schemeId') <> 'integer', 1) OR
    coalesce(json_extract(r.value, '$.schemeId') <= 0, 1) OR
    coalesce(json_type(r.value, '$.appliedScheme') <> 'object', 1) OR
    coalesce(json_extract(r.value, '$.appliedScheme.id') <> json_extract(r.value, '$.schemeId'), 1) OR
    coalesce(json_extract(r.value, '$.schemeOverride') <> 0, 0) OR
    json_type(r.value, '$.disposal') NOT IN ('null') OR
    json_extract(r.value, '$.firstYearTreatment.version') = 1
  ))
BEGIN SELECT RAISE(ABORT, 'Asset claims require scheme calculations'); END;
--> statement-breakpoint
CREATE TRIGGER tax_capital_scheme_update BEFORE UPDATE ON tax_capital_schedules
WHEN EXISTS (SELECT 1 FROM json_each(NEW.evidence, '$.rows') AS r WHERE
  json_extract(r.value, '$.treatment') = 'claim' AND (
    coalesce(json_type(r.value, '$.schemeId') <> 'integer', 1) OR
    coalesce(json_extract(r.value, '$.schemeId') <= 0, 1) OR
    coalesce(json_type(r.value, '$.appliedScheme') <> 'object', 1) OR
    coalesce(json_extract(r.value, '$.appliedScheme.id') <> json_extract(r.value, '$.schemeId'), 1) OR
    coalesce(json_extract(r.value, '$.schemeOverride') <> 0, 0) OR
    json_type(r.value, '$.disposal') NOT IN ('null') OR
    json_extract(r.value, '$.firstYearTreatment.version') = 1
  ))
BEGIN SELECT RAISE(ABORT, 'Asset claims require scheme calculations'); END;
