import { isContraRevenueAccount } from "$lib/account-classification.js";
import {
  AccountSubType,
  AccountType,
  type AccountSubTypeCode,
} from "$lib/enums.js";
import type { AccountView } from "../ledger/types.js";
import { isPurchaseAssetAccount } from "../ledger/account-type.js";

const TRANSACTION_ASSET_SUBTYPES = new Set<AccountSubTypeCode>([
  AccountSubType.Cash,
  AccountSubType.Bank,
  AccountSubType.Wallet,
  AccountSubType.Card,
  AccountSubType.Clearing,
]);

function posting(account: AccountView): boolean {
  return account.postingEligible === true && (account.active ?? true);
}

export function isImportTransactionAsset(account: AccountView): boolean {
  return (
    posting(account) &&
    account.type === AccountType.Asset &&
    account.subType !== null &&
    TRANSACTION_ASSET_SUBTYPES.has(account.subType)
  );
}

export function isImportPurchaseSource(
  account: AccountView,
  payableAccountId: number | null,
): boolean {
  return (
    isImportTransactionAsset(account) ||
    (posting(account) && account.id === payableAccountId) ||
    (posting(account) &&
      account.type === AccountType.Liability &&
      account.subType === AccountSubType.CreditCard)
  );
}

export function isImportPurchaseTarget(account: AccountView): boolean {
  return (
    posting(account) &&
    (account.type === AccountType.Expense || isPurchaseAssetAccount(account))
  );
}

export function isImportIncomeSource(account: AccountView): boolean {
  return (
    posting(account) &&
    account.type === AccountType.Revenue &&
    !isContraRevenueAccount(account)
  );
}

export function isImportIncomeTarget(
  account: AccountView,
  receivableAccountId: number | null,
): boolean {
  return (
    isImportTransactionAsset(account) ||
    (posting(account) &&
      (account.id === receivableAccountId || isContraRevenueAccount(account)))
  );
}

export function importKindForSource(
  account: AccountView,
  payableAccountId: number | null,
): "expense" | "income" | null {
  if (isImportIncomeSource(account)) return "income";
  if (isImportPurchaseSource(account, payableAccountId)) return "expense";
  return null;
}

export function validateImportAccountPair(
  from: AccountView,
  to: AccountView,
  payableAccountId: number | null,
  receivableAccountId: number | null,
): { ok: true; kind: "expense" | "income" } | { ok: false; reason: string } {
  if (from.id === to.id) {
    return {
      ok: false,
      reason: "Source and target must be different accounts.",
    };
  }
  const kind = importKindForSource(from, payableAccountId);
  if (kind == null) {
    return {
      ok: false,
      reason: "That account cannot be used as an import source.",
    };
  }
  const targetIsValid =
    kind === "income"
      ? isImportIncomeTarget(to, receivableAccountId)
      : isImportPurchaseTarget(to);
  return targetIsValid
    ? { ok: true, kind }
    : {
        ok: false,
        reason:
          "Those source and target accounts are not valid for this document.",
      };
}

/**
 * Whether two accounts can be the two sides of an imported transfer (006
 * FR-058): money moved between two of the business's own accounts that hold
 * money, such as the marketplace wallet and the bank. `from` is the account
 * the money left, `to` the one it went into.
 *
 * Only an item a profile's transfer section read is checked here. A receipt,
 * or an income or expense item, is checked by `validateImportAccountPair`,
 * which never accepts two money accounts, so it can never become a transfer.
 */
export function validateTransferPair(
  from: AccountView,
  to: AccountView,
): { ok: true } | { ok: false; reason: string } {
  if (from.id === to.id) {
    return {
      ok: false,
      reason: "A transfer needs two different accounts.",
    };
  }
  if (!isImportTransactionAsset(from) || !isImportTransactionAsset(to)) {
    return {
      ok: false,
      reason:
        "Both sides of a transfer must be accounts that hold money, such as a bank account, cash, a card or a wallet.",
    };
  }
  return { ok: true };
}
