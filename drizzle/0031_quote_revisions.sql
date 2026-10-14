ALTER TABLE `invoices` ADD `replaces_invoice_id` integer;--> statement-breakpoint
ALTER TABLE `quotations` ADD `revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `quotations` ADD `superseded_by_id` integer;