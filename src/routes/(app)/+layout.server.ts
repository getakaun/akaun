import type { LayoutServerLoad } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import { getSetting, SETTING_KEYS } from "$lib/server/settings.js";
import { listRecords } from "$lib/server/queries/ledger.js";
import { LedgerRecordKind } from "$lib/enums.js";
import { getUserNavOrder } from "$lib/server/navPreferences.js";
import { DEFAULT_CURRENCY } from "$lib/currency.js";
import { can } from "$lib/server/permissions.js";

export const load: LayoutServerLoad = async ({ locals }) => {
  const mainCurrency =
    getSetting(db, SETTING_KEYS.currencyCode) ?? DEFAULT_CURRENCY;

  // The nav badge counts expenses somebody is still owed for. Nothing stores
  // that any more — it is derived from the settlements against each record's
  // side on the shared owed account (FR-012) — so this asks the store the
  // question rather than reading a status column. `limit: 1` because only
  // `total` is wanted; the count is its own aggregate either way.
  //
  // Still expenses only, deliberately: FR-024 moves the count that was shown
  // against Expenses onto Records rather than redefining it. Widening it to
  // every kind would also count what customers owe the business, which is a
  // different question from what the business has not paid.
  const unpaidCount = listRecords(db, {
    kind: LedgerRecordKind.Expense,
    paid: false,
    limit: 1,
  }).total;

  const navItems = getUserNavOrder(db, locals.user!.id).filter((item) =>
    can(locals, item.permission),
  );

  return {
    user: locals.user,
    mainCurrency,
    unpaidCount,
    // What the shell offers. Never a superuser flag: a page decides what it
    // shows from a permission, so a group can be given exactly that.
    canManageUsers: can(locals, "users.manage"),
    canSeeSettings: can(locals, "settings.read"),
    canReadAudit: can(locals, "audit.read"),
    navItems,
  };
};
