import { isContraRevenueAccount } from "$lib/account-classification.js";
import {
  AccountSubType,
  AccountType,
  type AccountSubTypeCode,
} from "$lib/enums.js";
import type { AccountView } from "$lib/server/ledger/types.js";

const TRANSACTION_ASSET_SUBTYPES = new Set<AccountSubTypeCode>([
  AccountSubType.Cash,
  AccountSubType.Bank,
  AccountSubType.Wallet,
  AccountSubType.Card,
  AccountSubType.Clearing,
]);

const PURCHASE_ASSET_SUBTYPES = new Set<AccountSubTypeCode>([
  AccountSubType.Inventory,
  AccountSubType.PrepaymentsAndDeposits,
  AccountSubType.TaxReceivable,
  AccountSubType.OtherCurrentAsset,
  AccountSubType.FixedAsset,
  AccountSubType.IntangibleAsset,
  AccountSubType.OtherNonCurrentAsset,
]);

function posting(account: AccountView): boolean {
  return (
    account.postingEligible !== false &&
    (account.active ?? account.archivedAt == null)
  );
}

function transactionAsset(account: AccountView): boolean {
  return (
    posting(account) &&
    account.type === AccountType.Asset &&
    account.subType !== null &&
    TRANSACTION_ASSET_SUBTYPES.has(account.subType)
  );
}

function purchaseSource(
  account: AccountView,
  payableAccountId: number | null,
): boolean {
  return (
    transactionAsset(account) ||
    (posting(account) && account.id === payableAccountId) ||
    (posting(account) &&
      account.type === AccountType.Liability &&
      account.subType === AccountSubType.CreditCard)
  );
}

function purchaseTarget(account: AccountView): boolean {
  return (
    posting(account) &&
    (account.type === AccountType.Expense ||
      (account.type === AccountType.Asset &&
        account.subType !== null &&
        PURCHASE_ASSET_SUBTYPES.has(account.subType)))
  );
}

export type ImportSourceGroups = {
  income: AccountView[];
  payment: AccountView[];
};

/** Source choices are the safe union that can establish income or purchase direction. */
export function groupImportSourceAccounts(
  accounts: AccountView[],
  payableAccountId: number | null,
): ImportSourceGroups {
  return {
    income: accounts.filter(
      (account) =>
        posting(account) &&
        account.type === AccountType.Revenue &&
        !isContraRevenueAccount(account),
    ),
    payment: accounts.filter((account) =>
      purchaseSource(account, payableAccountId),
    ),
  };
}

/** The valid destination after the selected source has established direction. */
export function targetAccountsForImportSource(
  accounts: AccountView[],
  sourceAccountId: number | null,
  payableAccountId: number | null,
  receivableAccountId: number | null,
): AccountView[] {
  const source = accounts.find((account) => account.id === sourceAccountId);
  if (!source || !posting(source)) return [];

  if (source.type === AccountType.Revenue && !isContraRevenueAccount(source)) {
    return accounts.filter(
      (account) =>
        account.id !== source.id &&
        (transactionAsset(account) ||
          (posting(account) &&
            (account.id === receivableAccountId ||
              isContraRevenueAccount(account)))),
    );
  }

  if (!purchaseSource(source, payableAccountId)) return [];
  return accounts.filter(
    (account) => account.id !== source.id && purchaseTarget(account),
  );
}

export function importSourceIsIncome(
  accounts: AccountView[],
  sourceAccountId: number | null,
): boolean {
  return (
    accounts.find((account) => account.id === sourceAccountId)?.type ===
    AccountType.Revenue
  );
}

/** Pick the deterministic unpaid/category destination after the source sets direction. */
export function defaultTargetForImportSource(
  accounts: AccountView[],
  sourceAccountId: number | null,
  receivableAccountId: number | null,
  uncategorisedExpenseAccountId: number | null,
): number | null {
  return importSourceIsIncome(accounts, sourceAccountId)
    ? receivableAccountId
    : uncategorisedExpenseAccountId;
}

/** Live detection may replace an automatic fallback, but never a reviewer edit. */
export function syncImportAccountSelection(
  currentAccountId: number | null | undefined,
  detectedAccountId: number | null,
  reviewerTouched: boolean,
): number | null {
  return reviewerTouched ? (currentAccountId ?? null) : detectedAccountId;
}
