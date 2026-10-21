ALTER TABLE `import_items` ADD `expense_payment_source` text;--> statement-breakpoint
ALTER TABLE `import_items` ADD `supplier_contact_id` integer REFERENCES contacts(id);--> statement-breakpoint
ALTER TABLE `import_items` ADD `paid_by_contact_id` integer REFERENCES contacts(id);--> statement-breakpoint
ALTER TABLE `import_queue` ADD `expense_payment_source` text;--> statement-breakpoint
ALTER TABLE `import_queue` ADD `supplier_contact_id` integer REFERENCES contacts(id);--> statement-breakpoint
ALTER TABLE `import_queue` ADD `paid_by_contact_id` integer REFERENCES contacts(id);--> statement-breakpoint
ALTER TABLE `ledger_records` ADD `expense_payment_source` text;--> statement-breakpoint
ALTER TABLE `ledger_records` ADD `supplier_contact_id` integer REFERENCES contacts(id);