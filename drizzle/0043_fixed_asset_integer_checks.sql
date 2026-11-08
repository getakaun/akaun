-- Keep CHECK columns unqualified so legacy SQLite table renames do not retain the temporary table name.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_fixed_assets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`asset_type` text NOT NULL,
	`serial_number` text DEFAULT '' NOT NULL,
	`acquisition_date` text NOT NULL,
	`in_service_date` text,
	`asset_account_id` integer NOT NULL,
	`cost_minor` integer NOT NULL,
	`source_movement_id` integer,
	`source_record_id` integer,
	`source_sort_order` integer,
	`source_snapshot` text,
	`opening_as_at` text,
	`brought_forward_dep_minor` integer DEFAULT 0 NOT NULL,
	`accumulated_depreciation_account_id` integer,
	`opening_record_id` integer,
	`business_use_bps` integer,
	`document_reference` text DEFAULT '' NOT NULL,
	`book_method` text,
	`useful_life_months` integer,
	`residual_minor` integer,
	`depreciation_expense_account_id` integer,
	`created_by` integer NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_by` integer NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`asset_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`source_record_id`) REFERENCES `ledger_records`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`accumulated_depreciation_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`opening_record_id`) REFERENCES `ledger_records`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`depreciation_expense_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "fixed_assets_cost_check" CHECK(typeof("cost_minor") = 'integer' AND "cost_minor" > 0 AND "cost_minor" <= 9007199254740991),
	CONSTRAINT "fixed_assets_dep_check" CHECK(typeof("brought_forward_dep_minor") = 'integer' AND "brought_forward_dep_minor" BETWEEN 0 AND "cost_minor"),
	CONSTRAINT "fixed_assets_business_check" CHECK("business_use_bps" IS NULL OR (typeof("business_use_bps") = 'integer' AND "business_use_bps" BETWEEN 0 AND 10000)),
	CONSTRAINT "fixed_assets_source_check" CHECK(("source_record_id" IS NOT NULL AND "source_movement_id" IS NOT NULL AND "source_sort_order" IS NOT NULL AND "source_snapshot" IS NOT NULL AND "opening_as_at" IS NULL AND "brought_forward_dep_minor" = 0 AND "opening_record_id" IS NULL) OR ("source_record_id" IS NULL AND "source_movement_id" IS NULL AND "source_sort_order" IS NULL AND "source_snapshot" IS NULL AND "opening_as_at" IS NOT NULL)),
	CONSTRAINT "fixed_assets_accounts_check" CHECK("accumulated_depreciation_account_id" IS NULL OR "accumulated_depreciation_account_id" <> "asset_account_id"),
	CONSTRAINT "fixed_assets_dep_mapping_check" CHECK("brought_forward_dep_minor" = 0 OR "accumulated_depreciation_account_id" IS NOT NULL),
	CONSTRAINT "fixed_assets_residual_check" CHECK("residual_minor" IS NULL OR (typeof("residual_minor") = 'integer' AND "residual_minor" BETWEEN 0 AND "cost_minor"))
);
--> statement-breakpoint
INSERT INTO `__new_fixed_assets`("id", "name", "description", "asset_type", "serial_number", "acquisition_date", "in_service_date", "asset_account_id", "cost_minor", "source_movement_id", "source_record_id", "source_sort_order", "source_snapshot", "opening_as_at", "brought_forward_dep_minor", "accumulated_depreciation_account_id", "opening_record_id", "business_use_bps", "document_reference", "book_method", "useful_life_months", "residual_minor", "depreciation_expense_account_id", "created_by", "created_at", "updated_by", "revision") SELECT "id", "name", "description", "asset_type", "serial_number", "acquisition_date", "in_service_date", "asset_account_id", "cost_minor", "source_movement_id", "source_record_id", "source_sort_order", "source_snapshot", "opening_as_at", "brought_forward_dep_minor", "accumulated_depreciation_account_id", "opening_record_id", "business_use_bps", "document_reference", "book_method", "useful_life_months", "residual_minor", "depreciation_expense_account_id", "created_by", "created_at", "updated_by", "revision" FROM `fixed_assets`;--> statement-breakpoint
DROP TABLE `fixed_assets`;--> statement-breakpoint
ALTER TABLE `__new_fixed_assets` RENAME TO `fixed_assets`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `fixed_assets_source_movement_unique` ON `fixed_assets` (`source_movement_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `fixed_assets_source_slot_unique` ON `fixed_assets` (`source_record_id`,`source_sort_order`);--> statement-breakpoint
CREATE INDEX `fixed_assets_account_idx` ON `fixed_assets` (`asset_account_id`);