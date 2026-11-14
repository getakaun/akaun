import { read, readTool, write, writeTool } from "./define.js";

/** Accounts: `list_accounts` and `change_accounts`. */

/**
 * `ACCOUNT_TAX_PERMISSIONS` in `application/account-tax-classification.ts`,
 * which its overview, preview and apply all ask for. Restated so this table
 * imports no application code; the spec keeps the two equal.
 */
const ACCOUNT_TAX = write(
  ["accounts:read", "accounts:write", "records:read", "records:write"],
  ["accounts.read", "accounts.update", "records.read", "records.update"],
);

/**
 * v1 `list_accounts`. The count of unclassified entries a tax default could
 * fill comes from `accountTaxOverview`, which asks for more than a read: it
 * is a check, shown only to a caller who passes it.
 */
export const LIST_ACCOUNTS = readTool(read(["accounts:read"]), {
  tax_overview: ACCOUNT_TAX,
});

export const CHANGE_ACCOUNTS = writeTool(
  {
    // v1 `create_account`.
    create: write(["accounts:write"], ["accounts.create"]),
    // v1 `update_account`, including archiving and the tax default (which
    // only sets what new lines capture).
    update: write(["accounts:write"], ["accounts.update"]),
    // v1 `delete_account`.
    delete: write(["accounts:delete"], ["accounts.delete"]),
    // v1 `set_opening_balance`. Also records.create, records.update or (set
    // to zero) records.delete, decided by whether one exists: the checks
    // below.
    set_opening_balance: write(
      ["accounts:write", "records:write"],
      ["accounts.update"],
    ),
    // No v1 tool. `PUT /api/settings/account-defaults` asks for
    // accounts.update; `setAccountDefault` is not merged yet.
    set_default: write(["accounts:write"], ["accounts.update"]),
    // The app's "Apply default to unclassified entries".
    apply_tax_default: ACCOUNT_TAX,
  },
  {
    // `setOpeningBalance` when the account has none yet.
    opening_balance_create: write(
      ["accounts:write", "records:write"],
      ["accounts.update", "records.create"],
    ),
    // When it has one and the new amount is not zero.
    opening_balance_change: write(
      ["accounts:write", "records:write"],
      ["accounts.update", "records.update"],
    ),
    // Zero deletes the opening balance record.
    opening_balance_clear: write(
      ["accounts:write", "records:delete"],
      ["accounts.update", "records.delete"],
    ),
  },
);
