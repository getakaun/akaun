import { eq, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import {
  settings,
  ledgerRecords,
  quotations,
  invoices,
  contacts,
} from "./db/schema.js";

export const SETTING_KEYS = {
  // Which account new records pre-select as the one that paid or received
  // (FR-011). Written by the ledger upgrade's account seeding, changeable in
  // Settings once more than one account exists.
  ledgerDefaultAccountId: "ledger_default_account_id",
  reimbursementDefaultPayeeContactId: "reimbursements.defaultPayeeContactId",
  // The ledger upgrade's phase, before-snapshot, backup path and report (D-15).
  ledgerUpgradeState: "ledger_upgrade_state",
  // Set once `expenses` + `income` have been merged into `records` and
  // `journal` renamed to `adjustments`. The merge is idempotent, but a rerun
  // would re-grant a permission an administrator deliberately removed
  // afterwards, so it runs exactly once (data-model.md §3).
  recordsPermissionMerged: "permissions.recordsMerged",
  currencyCode: "display.currencyCode",
  autoImportApiKey: "autoImport.apiKey",
  autoImportModel: "autoImport.model",
  autoImportEnabled: "autoImport.enabled",
  autoImportParallelTasks: "autoImport.parallelTasks",
  autoImportCategoryHints: "autoImport.categoryHints",
  autoImportRateLimitMs: "autoImport.rateLimitMs",
  autoImportFreeModelsOnly: "autoImport.freeModelsOnly",
  autoImportCustomInstructions: "autoImport.customInstructions",
  autoImportDuplicateThreshold: "autoImport.duplicateThreshold",
  // The OAuth client id Sign in with ChatGPT issued this installation on its
  // first sign-in. Reused for later sign-ins, so each one does not register
  // Akaun with OpenAI again.
  companyName: "company.name",
  companyAddress: "company.address",
  companyRegistrationNo: "company.registrationNo",
  companyLogoPath: "company.logoPath",
  companyLetterheadPath: "company.letterheadPath",
  pdfInvoiceLayoutKey: "pdf.invoiceLayoutKey",
  pdfQuotationLayoutKey: "pdf.quotationLayoutKey",
  pdfThemeColor: "pdf.themeColor",
  // What a PDF prints at the top: the company name as text, or the letterhead
  // image. A choice of content, so it is one setting for every layout.
  pdfHeader: "pdf.header",
  sequenceTemplate: "documentNumbers.template",
  // Days from issue to due (invoices) and to expiry (quotations) that a new
  // document starts with. Read through `documentDefaults` in
  // sales/defaults.ts, which owns the parsing: unset means 30, empty means none.
  invoiceDueDays: "documents.invoiceDueDays",
  quotationValidDays: "documents.quotationValidDays",
  // Set once the default groups have been written, so a default group an
  // administrator deleted is not written again (admin/seed-groups.ts).
  groupsSeeded: "groups.seeded",
} as const;

export function getSetting(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: BunSQLiteDatabase<any>,
  key: string,
): string | null {
  const row = db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, key))
    .get();
  return row?.value ?? null;
}

export function setSetting(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: BunSQLiteDatabase<any>,
  key: string,
  value: string,
): void {
  db.insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value },
    })
    .run();
}

// True once the business has issued any real document — at that point currency
// and sequence-number-format settings must become immutable, since changing
// either after the fact would corrupt historical amounts/numbering.
export function hasAnyDocuments(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: BunSQLiteDatabase<any>,
): boolean {
  return [ledgerRecords, quotations, invoices].some(
    (table) =>
      (db
        .select({ n: sql<number>`count(*)` })
        .from(table)
        .get()?.n ?? 0) > 0,
  );
}

/** A stale or cleared default never silently selects a different recipient. */
export function defaultReimbursementPayeeId(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: BunSQLiteDatabase<any>,
): number | null {
  const id = Number(
    getSetting(db, SETTING_KEYS.reimbursementDefaultPayeeContactId),
  );
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return (
    db
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.id, id))
      .get()?.id ?? null
  );
}
