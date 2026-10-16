import { AccountType, type AccountTypeCode } from "$lib/enums.js";
import {
  isImportIncomeSource,
  isImportPurchaseTarget,
} from "./account-policy.js";
import { listAccounts } from "../queries/accounts.js";
import type { LedgerDb } from "../ledger/types.js";

/**
 * Which account the category read off an imported document belongs to.
 *
 * A category is an account now (FR-006a), so the AI is offered the names in the
 * chart of accounts and its answer is matched back against them. It is only
 * ever matched, never created: one misread word would otherwise leave a
 * category in the chart of accounts forever, and nobody would know where it
 * came from.
 */

export type DocumentKind = "expense" | "income";

export type CategoryChoice = {
  id: number;
  name: string;
  code: number;
  path: string;
};

/** What each kind of document calls a category — the same lists the two screens offer. */
const CATEGORY_TYPES: Record<DocumentKind, AccountTypeCode> = {
  expense: AccountType.Expense,
  income: AccountType.Revenue,
};

/** The categories a document of this kind can be filed under. */
export function categoryChoices(
  db: LedgerDb,
  kind: DocumentKind,
): CategoryChoice[] {
  return listAccounts(db, {})
    .filter(
      (a) =>
        a.postingEligible &&
        // Purchasable assets are on this list for the same reason fixed assets
        // were historically offered beside expense categories: a purchase
        // document may capitalise value instead of putting it on the P&L.
        (kind === "income"
          ? isImportIncomeSource(a)
          : a.type === CATEGORY_TYPES[kind] || isImportPurchaseTarget(a)),
    )
    .map((a) => ({
      id: a.id,
      name: a.name,
      code: a.code ?? a.id,
      path: a.name,
    }));
}

export function categoryAccountForImport(
  kind: DocumentKind,
  choices: CategoryChoice[],
  selectedAccountId: number | null | undefined,
  uncategorisedAccountId: number | null,
):
  | { ok: true; value: { accountId: number; uncategorised: boolean } }
  | { ok: false; reason: string } {
  const selected = choices.find((choice) => choice.id === selectedAccountId);
  if (selected) {
    return {
      ok: true,
      value: { accountId: selected.id, uncategorised: false },
    };
  }
  if (uncategorisedAccountId !== null) {
    return {
      ok: true,
      value: { accountId: uncategorisedAccountId, uncategorised: true },
    };
  }
  return {
    ok: false,
    reason:
      kind === "income"
        ? "Choose a valid saved account for income whose category is not known."
        : "Choose a valid saved account for expenses whose category is not known.",
  };
}

/**
 * A reviewer who picked Accounts Payable as the paying side is saying "I paid
 * this personally, the business owes it instead" (FR-008, FR-011) — the same
 * choice the manual Records form makes via `sides-from-accounts.ts`. A null
 * paying side is what `entry-builder.ts` reads as owed rather than already
 * paid. Income has no equivalent: `receivedIntoAccountId` is never null.
 */
export function resolvePaidFromAccountId(
  accountId: number,
  isIncome: boolean,
  payableAccountId: number | null,
): number | null {
  if (isIncome || payableAccountId == null || accountId !== payableAccountId) {
    return accountId;
  }
  return null;
}

/**
 * The account a category name refers to, or null when none of them do.
 *
 * Matched ignoring case and surrounding spaces, because "office supplies" off a
 * receipt and "Office Supplies" in the chart of accounts are the same category
 * to everyone except a string comparison.
 */
export function matchCategoryAccount(
  choices: CategoryChoice[],
  name: string | null | undefined,
): number | null {
  const wanted = (name ?? "").trim().toLowerCase();
  if (!wanted) return null;
  return (
    choices.find((c) => c.name.trim().toLowerCase() === wanted)?.id ?? null
  );
}
