import { fail, redirect, type Actions } from "@sveltejs/kit";
import { db } from "$lib/server/db/client.js";
import { hasPermission } from "$lib/server/permissions.js";
import {
  canonicalAccountId,
  listAccounts,
  defaultAccountId,
  openingBalanceFor,
} from "$lib/server/queries/accounts.js";
import { listRecords } from "$lib/server/queries/ledger.js";
import {
  createAccount,
  patchAccount,
  removeAccount,
} from "$lib/server/services/accounts.js";
import { setOpeningBalance as setOpeningBalanceOp } from "$lib/server/application/accounts.js";
import { toMinor } from "$lib/server/ledger/money.js";
import { listStatementSummaries } from "$lib/server/services/reconciliation.js";
import { isValidDate } from "$lib/server/date.js";
import {
  AccountType,
  type AccountSubTypeCode,
  type AccountTypeCode,
} from "$lib/enums.js";
import type { AccountView as AccountApiView } from "$lib/components/accounts/account-types.js";

function toRoleFreeAccount(account: ReturnType<typeof listAccounts>[number]): AccountApiView {
  return {
    id: account.id,
    code: account.code!,
    name: account.name,
    type: account.type,
    subType: account.subType,
    active: account.active!,
    postingEligible: account.postingEligible!,
  };
}

const LIST_PATH = "/accounts";

/** The four abilities both the chart and one account's page ask about. */
function accountPerms(locals: App.Locals) {
  return {
    add: hasPermission(locals, "accounts", "add"),
    change: hasPermission(locals, "accounts", "change"),
    delete: hasPermission(locals, "accounts", "delete"),
    // Whether to offer the way in to reconciling at all (FR-049).
    reconcile: hasPermission(locals, "reconciliation", "view"),
  };
}

/** The chart of accounts — all five types on one page (FR-022). */
export function loadAccountsPage(locals: App.Locals) {
  if (!hasPermission(locals, "accounts", "view"))
    throw redirect(302, "/dashboard");

  const accounts = listAccounts(db, { includeArchived: true });

  return {
    accounts,
    // Canonical role-free contract. `accounts` remains during the UI migration
    // so the current chart can render while the new unified page is wired.
    accountViews: accounts.map(toRoleFreeAccount),
    defaultAccountId: defaultAccountId(db),
    perms: accountPerms(locals),
  };
}

/**
 * One account, for `/accounts/[id]`.
 *
 * An account is the entity with the most around it and the least in it — three
 * fields name it, but its balance, its children, what it still has to reconcile
 * and what has moved through it are the reasons anyone opens it. A 500px drawer
 * could hold the three fields, so for a while that is all the app showed.
 *
 * The merged-account redirect lives here rather than in the route, so there is
 * one place that decides which id is the real one.
 */
export function loadAccountDetail(locals: App.Locals, requestedId: number) {
  if (!hasPermission(locals, "accounts", "view"))
    throw redirect(302, "/dashboard");

  const canonical = canonicalAccountId(db, requestedId);
  if (canonical === null) throw redirect(302, LIST_PATH);
  if (canonical !== requestedId) throw redirect(302, `/accounts/${canonical}`);

  const chart = listAccounts(db, { includeArchived: true });
  const account = chart.find((a) => a.id === canonical);
  if (!account) throw redirect(302, LIST_PATH);

  /**
   * How many statements this account has still to finish (FR-053).
   *
   * There is no top-level Reconciliation list any more where a half-done
   * statement would be noticed. If the only way in is through the account, the
   * account has to say whether there is anything waiting.
   *
   * Only read when the user may reconcile at all; there is nothing to tell
   * somebody who cannot open the surface it points at.
   */
  const unfinishedStatements = hasPermission(locals, "reconciliation", "view")
    ? listStatementSummaries(db, locals).filter(
        (s) => !s.completed && s.accountId === canonical,
      ).length
    : 0;

  // Newest first, the same order and the same rows as the Records list. Not
  // `accountHistory`, which orders oldest-first by design so its running
  // balance can accumulate — the statement with the running balance lives at
  // `/records?account=<id>` (D-05) and this page links to it rather than
  // computing a second one.
  const recent = listRecords(db, { accountId: canonical, limit: RECENT_LIMIT });

  return {
    account,
    accounts: chart,
    openingBalance: openingBalanceFor(db, canonical),
    unfinishedStatements,
    recent: recent.records,
    recentTotal: recent.total,
    defaultAccountId: defaultAccountId(db),
    perms: accountPerms(locals),
  };
}

/** How many movements the account page shows before sending you to the full list. */
const RECENT_LIMIT = 25;

export const accountsActions: Actions = {
  create: async ({ locals, request }) => {
    if (!hasPermission(locals, "accounts", "add"))
      return fail(403, { error: "Forbidden" });
    const data = await request.formData();

    const type = parseInt(String(data.get("type") ?? "0")) as AccountTypeCode;
    const name = String(data.get("name") ?? "").trim();
    if (!Object.values(AccountType).includes(type))
      return fail(400, { error: "Choose one of the five account types." });
    if (!name) return fail(400, { error: "Give the account a name." });

    const codeRaw = String(data.get("code") ?? "").trim();
    if (codeRaw && !/^\d+$/.test(codeRaw))
      return fail(400, { error: "Enter a whole number for the account code." });

    const result = createAccount(db, locals.user!.id, {
      code: codeRaw ? Number(codeRaw) : undefined,
      type,
      name,
      subType: data.get("subType")
        ? (parseInt(String(data.get("subType"))) as AccountSubTypeCode)
        : undefined,
    });
    if (!result.ok) return fail(409, { error: result.reason });
    return { success: true, id: result.value.id };
  },

  update: async ({ locals, request }) => {
    if (!hasPermission(locals, "accounts", "change"))
      return fail(403, { error: "Forbidden" });
    const data = await request.formData();
    const id = parseInt(String(data.get("id") ?? "0"));
    if (!id) return fail(400, { error: "That account no longer exists." });

    const activeRaw = data.get("active");
    const result = patchAccount(db, id, locals.user!.id, {
      name: data.has("name")
        ? String(data.get("name") ?? "").trim()
        : undefined,
      type: data.has("type") ? parseInt(String(data.get("type"))) as AccountTypeCode : undefined,
      active: activeRaw === null ? undefined : activeRaw === "true",
      subType: data.has("subType")
        ? (parseInt(String(data.get("subType"))) as AccountSubTypeCode)
        : undefined,
      code: data.has("code") ? parseInt(String(data.get("code"))) : undefined,
    });
    if (!result.ok) return fail(409, { error: result.reason });
    return { success: true, id };
  },

  delete: async ({ locals, request }) => {
    if (!hasPermission(locals, "accounts", "delete"))
      return fail(403, { error: "Forbidden" });
    const data = await request.formData();
    const id = parseInt(String(data.get("id") ?? "0"));
    if (!id) return fail(400, { error: "That account no longer exists." });

    const result = removeAccount(db, id, locals.user!.id);
    if (!result.ok) return fail(409, { error: result.reason });
    // The account's own page is now a real address. Returning success from
    // there would leave the user looking at an account that no longer exists,
    // so the server, which knows it is gone, says where to go instead.
    throw redirect(303, LIST_PATH);
  },

  openingBalance: async ({ locals, request }) => {
    if (!hasPermission(locals, "accounts", "change"))
      return fail(403, { error: "Forbidden" });
    const data = await request.formData();
    const id = parseInt(String(data.get("id") ?? "0"));
    if (!id) return fail(400, { error: "That account no longer exists." });

    const date = String(data.get("date") ?? "").trim();
    if (!isValidDate(date))
      return fail(400, { error: "Pick a date for the opening balance." });

    const amount = parseFloat(String(data.get("amount") ?? "0"));
    if (Number.isNaN(amount)) return fail(400, { error: "Enter an amount." });

    // An opening balance is always in the main currency, so the rate is 1.
    // The operation asks for `records` too: the opening balance is a record.
    const result = setOpeningBalanceOp({ db, locals }, id, {
      date,
      amountMinor: toMinor(amount, 1),
    });
    if (!result.ok)
      return fail(result.code === "FORBIDDEN" ? 403 : 409, {
        error: result.reason,
      });
    return { success: true, id };
  },
};
