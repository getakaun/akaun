import type { LeafPermission } from "./catalog.js";

/**
 * OAuth scopes: coarse on the wire, exact on the server.
 *
 * A connected app asks for and holds `<area>:read|write|delete`. That keeps
 * the consent page short and the scope strings stable for clients and for
 * grants already issued, while each scope still names one area and one tier
 * (never an omnibus scope). On every request the scopes are expanded to the
 * catalog leaves below and intersected with the user's role and their groups'
 * delegation ceiling (`effectivePermissions`), so the catalog stays the single
 * source of what anything may do.
 *
 * There are no scopes for dashboard, settings or users: an OAuth token is for
 * `/mcp` alone (its audience), and none of those are offered there.
 *
 * `records:adjust` is the one scope outside the three tiers. It stands for the
 * explicit, sensitive `records.adjust` leaf, which lets the books say anything
 * and still add up, so an app gets it only when the user ticks it by name —
 * never as part of "change records".
 */
export const READ_SCOPES = [
  "records:read",
  "accounts:read",
  "contacts:read",
  "reports:read",
  "import:read",
  "invoices:read",
  "quotations:read",
  "reconciliation:read",
] as const;
export const WRITE_RESOURCES = [
  "records",
  "accounts",
  "contacts",
  "invoices",
  "quotations",
  "reconciliation",
  "import",
] as const;
export const WRITE_SCOPES = [
  "records:write",
  "accounts:write",
  "contacts:write",
  "invoices:write",
  "quotations:write",
  "reconciliation:write",
  "import:write",
] as const;
export const DELETE_SCOPES = [
  "records:delete",
  "accounts:delete",
  "contacts:delete",
  "invoices:delete",
  "quotations:delete",
  "import:delete",
] as const;
export const ADJUST_SCOPES = ["records:adjust"] as const;
export const OAUTH_SCOPES = [
  ...READ_SCOPES,
  ...WRITE_SCOPES,
  ...DELETE_SCOPES,
  ...ADJUST_SCOPES,
] as const;
export type OAuthScope = (typeof OAUTH_SCOPES)[number];

export const SCOPE_PERMISSIONS: Record<OAuthScope, readonly LeafPermission[]> =
  {
    "records:read": ["records.read"],
    "records:write": ["records.create", "records.update"],
    "records:delete": ["records.delete"],
    "records:adjust": ["records.adjust"],
    "accounts:read": ["accounts.read"],
    "accounts:write": ["accounts.create", "accounts.update"],
    "accounts:delete": ["accounts.delete"],
    "contacts:read": ["contacts.read"],
    "contacts:write": ["contacts.create", "contacts.update"],
    // Merging contacts has no MCP tool, so no scope offers it.
    "contacts:delete": ["contacts.delete"],
    "reports:read": ["reports.read"],
    "import:read": ["import.read"],
    // Uploading and profile management have no MCP tool, so no scope offers them.
    "import:write": ["import.update", "import.confirm"],
    "import:delete": ["import.delete"],
    "invoices:read": ["invoices.read"],
    "invoices:write": [
      "invoices.create",
      "invoices.update",
      "invoices.issue",
      "invoices.void",
    ],
    "invoices:delete": ["invoices.delete"],
    "quotations:read": ["quotations.read"],
    "quotations:write": [
      "quotations.create",
      "quotations.update",
      "quotations.revise",
      "quotations.convert",
    ],
    "quotations:delete": ["quotations.delete"],
    "reconciliation:read": ["reconciliation.read"],
    // Editing and deleting statement lines have no MCP tool: an app that could
    // rewrite the bank's evidence could also make it agree with the books.
    // Nor is there a reconciliation delete scope any more.
    "reconciliation:write": ["reconciliation.create", "reconciliation.match"],
  };

export function isOAuthScope(value: string): value is OAuthScope {
  return (OAUTH_SCOPES as readonly string[]).includes(value);
}

/** The catalog leaves a set of granted scopes stands for. */
export function expandScopes(scopes: Iterable<string>): LeafPermission[] {
  const leaves = new Set<LeafPermission>();
  for (const scope of scopes)
    if (isOAuthScope(scope))
      for (const leaf of SCOPE_PERMISSIONS[scope]) leaves.add(leaf);
  return [...leaves];
}

/** What each scope lets a connected app do, in the consent screen's words. */
export const SCOPE_LABELS: Record<OAuthScope, string> = {
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
  "contacts:write": "Create and change contacts",
  "invoices:write": "Create, change, send and void invoices",
  "quotations:write": "Create, change, revise and convert quotations",
  "reconciliation:write":
    "Match bank statement lines, and record transfers from them",
  "import:write":
    "Review import jobs, and confirm them into records or skip them",
  "records:delete":
    "Delete records, reverse allocations, and clear opening balances",
  "accounts:delete": "Delete accounts",
  "contacts:delete": "Delete contacts",
  "invoices:delete": "Delete draft invoices",
  "quotations:delete": "Delete quotations",
  "import:delete": "Discard import jobs",
  "records:adjust":
    "Make adjustments: journals and records between any accounts, which can change any balance",
};

export type ScopeTier = "read" | "write" | "delete" | "adjust";

export function scopeTier(scope: string): ScopeTier {
  return scope.split(":")[1] as ScopeTier;
}
