import type { LeafPermission } from "$lib/permissions/catalog.js";

/**
 * Every leaf an old grid flag (`resource.action`) used to allow. Migration
 * 0033 (`drizzle/0033_permission_grants_data.sql`) writes exactly these for
 * each stored row; `migration-0033.spec.ts` checks the two agree. Nothing at
 * runtime reads this: it is the record of how the grid was converted.
 *
 * The pre-merge names (`expenses`, `income`, `journal`) appear here because
 * the migration has to read them from books that were never merged.
 */
export const LEGACY_MAP: Record<string, LeafPermission[]> = {
  "dashboard.view": ["dashboard.read"],
  "records.view": ["records.read"],
  "records.add": ["records.create"],
  "records.change": ["records.update"],
  "records.delete": ["records.delete"],
  "expenses.view": ["records.read"],
  "expenses.add": ["records.create"],
  "expenses.change": ["records.update"],
  "expenses.delete": ["records.delete"],
  "income.view": ["records.read"],
  "income.add": ["records.create"],
  "income.change": ["records.update"],
  "income.delete": ["records.delete"],
  "adjustments.add": ["records.adjust"],
  "adjustments.change": ["records.adjust"],
  "adjustments.delete": ["records.adjust"],
  "journal.add": ["records.adjust"],
  "journal.change": ["records.adjust"],
  "journal.delete": ["records.adjust"],
  "import.view": ["import.read"],
  "import.add": ["import.create"],
  "import.change": ["import.update", "import.confirm", "import.profiles"],
  "import.delete": ["import.delete"],
  "contacts.view": ["contacts.read"],
  "contacts.add": ["contacts.create"],
  "contacts.change": ["contacts.update"],
  "contacts.delete": ["contacts.delete", "contacts.merge"],
  "quotations.view": ["quotations.read"],
  "quotations.add": ["quotations.create"],
  "quotations.change": [
    "quotations.update",
    "quotations.revise",
    "quotations.convert",
  ],
  "quotations.delete": ["quotations.delete"],
  "invoices.view": ["invoices.read"],
  "invoices.add": ["invoices.create"],
  "invoices.change": ["invoices.update", "invoices.issue", "invoices.void"],
  "invoices.delete": ["invoices.delete"],
  "reconciliation.view": ["reconciliation.read"],
  "reconciliation.add": ["reconciliation.create"],
  "reconciliation.change": ["reconciliation.update", "reconciliation.match"],
  "reconciliation.delete": ["reconciliation.delete"],
  "accounts.view": ["accounts.read"],
  "accounts.add": ["accounts.create"],
  "accounts.change": ["accounts.update"],
  "accounts.delete": ["accounts.delete"],
  "reports.view": ["reports.read"],
};

/**
 * For specs written against the old grid: the (resource, action) pair a leaf
 * came from, so a fake that answers `allow(resource, action)` keeps its
 * meaning. Leaves with no grid ancestor answer as their own area and verb
 * (`settings`, `manage`).
 */
export function legacyPairOf(leaf: string): [string, string] {
  if (leaf === "records.adjust") return ["adjustments", "add"];
  for (const [key, leaves] of Object.entries(LEGACY_MAP)) {
    const [resource] = key.split(".");
    if (["expenses", "income", "journal", "adjustments"].includes(resource))
      continue;
    if ((leaves as string[]).includes(leaf))
      return key.split(".") as [string, string];
  }
  return leaf.split(".") as [string, string];
}
