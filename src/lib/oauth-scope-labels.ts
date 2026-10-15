/**
 * What each OAuth scope lets a connected app do, in the words the consent
 * screen shows. Kept beside, not inside, `$lib/server/oauth/config.ts` so a
 * page can import it.
 */
export const SCOPE_LABELS: Record<string, string> = {
  "records:read":
    "Read records, their attached files, statements and outstanding amounts",
  "accounts:read": "Read accounts and balances",
  "contacts:read": "Read contacts",
  "reports:read": "Read financial reports",
  "import:read": "Read import jobs and extracted documents",
  "invoices:read": "Read invoices",
  "quotations:read": "Read quotations",
  "reconciliation:read": "Read bank statements and their matches",
  "records:write":
    "Record and change records, payments and settlements, and attach files",
  "accounts:write":
    "Create and change accounts, categories and opening balances",
  "contacts:write": "Create and change contacts, and merge them",
  "invoices:write": "Create, change, send and void invoices",
  "quotations:write": "Create, change, revise and convert quotations",
  "reconciliation:write": "Match bank statement lines and edit them",
  "import:write":
    "Review import jobs, and confirm them into records or skip them",
  "records:delete": "Delete records, attachments and settlements",
  "accounts:delete": "Delete accounts",
  "contacts:delete": "Delete contacts, including those merged away",
  "invoices:delete": "Delete draft invoices",
  "quotations:delete": "Delete quotations",
  "reconciliation:delete": "Delete bank statement lines",
  "import:delete": "Discard import jobs",
};

export type ScopeTier = "read" | "write" | "delete";

export function scopeTier(scope: string): ScopeTier {
  return scope.split(":")[1] as ScopeTier;
}
