import { isContraRevenueAccount } from "$lib/account-classification.js";
import {
  AccountRole,
  AccountSubType,
  AccountType,
  ExpenseSubType,
  LiabilitySubType,
  RevenueSubType,
} from "$lib/enums.js";
import type {
  AccountRoleCode,
  AccountSubTypeCode,
  AccountTypeCode,
} from "$lib/enums.js";

export type NormalBalance = "debit" | "credit";
export type FinancialStatement = "balance_sheet" | "income_statement";

const TYPE_RULES: Record<
  AccountTypeCode,
  { normalBalance: NormalBalance; financialStatement: FinancialStatement }
> = {
  [AccountType.Asset]: {
    normalBalance: "debit",
    financialStatement: "balance_sheet",
  },
  [AccountType.Liability]: {
    normalBalance: "credit",
    financialStatement: "balance_sheet",
  },
  [AccountType.Equity]: {
    normalBalance: "credit",
    financialStatement: "balance_sheet",
  },
  [AccountType.Revenue]: {
    normalBalance: "credit",
    financialStatement: "income_statement",
  },
  [AccountType.Expense]: {
    normalBalance: "debit",
    financialStatement: "income_statement",
  },
};

const TYPE_BY_LEGACY_ROLE: Record<AccountRoleCode, AccountTypeCode> = {
  [AccountRole.Bank]: AccountType.Asset,
  [AccountRole.Wallet]: AccountType.Asset,
  [AccountRole.Cash]: AccountType.Asset,
  [AccountRole.Card]: AccountType.Asset,
  [AccountRole.Equipment]: AccountType.Asset,
  [AccountRole.Receivable]: AccountType.Asset,
  [AccountRole.Payable]: AccountType.Liability,
  [AccountRole.OpeningBalances]: AccountType.Equity,
  [AccountRole.PartnerCapital]: AccountType.Equity,
  [AccountRole.PartnerDrawings]: AccountType.Equity,
  [AccountRole.IncomeCategory]: AccountType.Revenue,
  [AccountRole.ExpenseCategory]: AccountType.Expense,
};

/** Type default only; use normalBalanceForAccount for an individual account. */
export function normalBalanceFor(type: AccountTypeCode): NormalBalance {
  return TYPE_RULES[type].normalBalance;
}

/** Expected balance, independent of the signed contribution to financial reports. */
export function normalBalanceForAccount(
  account: TypeAndSubType,
): NormalBalance {
  return isContraRevenueAccount(account)
    ? "debit"
    : normalBalanceFor(account.type);
}

export function financialStatementFor(
  type: AccountTypeCode,
): FinancialStatement {
  return TYPE_RULES[type].financialStatement;
}

export function displaySignForAccountType(type: AccountTypeCode): 1 | -1 {
  return normalBalanceFor(type) === "credit" ? -1 : 1;
}

export function accountTypeForLegacyRole(
  role: AccountRoleCode,
): AccountTypeCode {
  return TYPE_BY_LEGACY_ROLE[role];
}

/** Storage compatibility for the conversion release while `accounts.role` is retained. */
export function legacyRoleForAccountType(
  type: AccountTypeCode,
): AccountRoleCode {
  return (
    {
      [AccountType.Asset]: AccountRole.Bank,
      [AccountType.Liability]: AccountRole.Payable,
      [AccountType.Equity]: AccountRole.OpeningBalances,
      [AccountType.Revenue]: AccountRole.IncomeCategory,
      [AccountType.Expense]: AccountRole.ExpenseCategory,
    } as Record<AccountTypeCode, AccountRoleCode>
  )[type];
}

/** @deprecated Conversion-only alias; new accounting behavior reads account.type. */
export const accountTypeFor = accountTypeForLegacyRole;

/**
 * The two sides of every everyday record: a place money sits, and a statement of
 * what the money was for.
 *
 * For four of the five types these are the same question as the type. Assets are
 * the exception, and equipment is why: something the business buys and keeps is
 * an asset on the balance sheet (002 FR-006b), but on the everyday form it is
 * still what the money was *for* — it is offered beside the categories, not
 * beside the bank accounts. Reading `type === Asset` as "holds money" therefore
 * makes buying a laptop look like moving cash between two pots, which is how it
 * ends up needing the `adjustments` ability that no seeded group grants.
 *
 * `subType` is the only column that tells the two apart for an Asset account
 * (005 research.md §12 — this used to be `role`, now inert for Asset rows).
 * Everything that splits the chart into pots and categories must go through
 * these two, so the split cannot drift between the record form, the records
 * list, the dashboard and the importer.
 */
export type TypeAndSubType = {
  type: AccountTypeCode;
  /**
   * Absent for Equity. For Asset/Liability, `null` means "needs review"
   * (`isNeedsReview` below). For Expense/Revenue, `null` defaults safely to
   * Operating (`expenseBucket`/`revenueBucket` below).
   */
  subType: AccountSubTypeCode | null;
};

/** Something the business keeps, recorded as an asset but chosen as a category. */
export function isEquipmentAccount(account: TypeAndSubType): boolean {
  return (
    account.type === AccountType.Asset &&
    account.subType === AccountSubType.FixedAsset
  );
}

/** Canonical name; retained beside the old helper during the terminology migration. */
export const isFixedAssetAccount = isEquipmentAccount;

export const PURCHASE_ASSET_SUBTYPES: AccountSubTypeCode[] = [
  AccountSubType.Inventory,
  AccountSubType.PrepaymentsAndDeposits,
  AccountSubType.TaxReceivable,
  AccountSubType.OtherCurrentAsset,
  AccountSubType.FixedAsset,
  AccountSubType.IntangibleAsset,
  AccountSubType.OtherNonCurrentAsset,
];

/** An asset acquired from a document rather than an account used to pay. */
export function isPurchaseAssetAccount(account: TypeAndSubType): boolean {
  return (
    account.type === AccountType.Asset &&
    account.subType !== null &&
    PURCHASE_ASSET_SUBTYPES.includes(account.subType)
  );
}

/** A place money actually sits or is owed. */
export function isMoneyPotAccount(account: TypeAndSubType): boolean {
  return account.type === AccountType.Asset && !isPurchaseAssetAccount(account);
}

/** What a record is "for": a spending or earning category, or equipment. */
export function isCategoryAccount(account: TypeAndSubType): boolean {
  return (
    account.type === AccountType.Expense ||
    account.type === AccountType.Revenue ||
    isPurchaseAssetAccount(account)
  );
}

/**
 * "Cash and cash equivalents" for the Cash Flow Statement (FR-006) — money that
 * is, for practical purposes, already cash.
 */
export const CASH_AND_EQUIVALENT_SUBTYPES: AccountSubTypeCode[] = [
  AccountSubType.Cash,
  AccountSubType.Bank,
  AccountSubType.Wallet,
  AccountSubType.Card,
];

/** Current assets that are never cash. */
export const OTHER_CURRENT_ASSET_SUBTYPES: AccountSubTypeCode[] = [
  AccountSubType.Receivable,
  AccountSubType.Inventory,
  AccountSubType.PrepaymentsAndDeposits,
  AccountSubType.Clearing,
  AccountSubType.TaxReceivable,
  AccountSubType.OtherCurrentAsset,
];

export const NON_CURRENT_ASSET_SUBTYPES: AccountSubTypeCode[] = [
  AccountSubType.FixedAsset,
  AccountSubType.IntangibleAsset,
  AccountSubType.OtherNonCurrentAsset,
];

/** Liabilities due within the normal operating cycle, for the Balance Sheet. */
export const CURRENT_LIABILITY_SUBTYPES: AccountSubTypeCode[] = [
  LiabilitySubType.AccountsPayable,
  LiabilitySubType.AccruedLiabilities,
  LiabilitySubType.ShortTermLoan,
  LiabilitySubType.OtherCurrentLiability,
  LiabilitySubType.CreditCard,
  LiabilitySubType.TaxPayable,
];

/** Liabilities due beyond the normal operating cycle, for the Balance Sheet. */
export const NON_CURRENT_LIABILITY_SUBTYPES: AccountSubTypeCode[] = [
  LiabilitySubType.LongTermLoan,
  LiabilitySubType.OtherNonCurrentLiability,
];

export const COGS_SUBTYPES: AccountSubTypeCode[] = [
  ExpenseSubType.CostOfGoodsSold,
];
export const OTHER_EXPENSE_SUBTYPES: AccountSubTypeCode[] = [
  ExpenseSubType.OtherExpense,
];
export const OTHER_REVENUE_SUBTYPES: AccountSubTypeCode[] = [
  RevenueSubType.OtherRevenue,
  RevenueSubType.ContraOtherRevenue,
];

/**
 * Types with no safe default classification — a new account of one of these
 * types must be classified at creation (`services/accounts.ts`), and an
 * unclassified existing one shows as "needs review" (`isNeedsReview` below).
 */
export const NEEDS_REVIEW_TYPES: AccountTypeCode[] = [
  AccountType.Asset,
  AccountType.Liability,
];

/**
 * An Asset or Liability account with no sub-type set yet (FR-005). Expense
 * and Revenue are absent here on purpose: an unclassified one defaults
 * safely to Operating (see `expenseBucket`/`revenueBucket` below) instead of
 * needing review, because unlike Asset/Liability there is no statement
 * section or cash-flow activity that a wrong guess could misplace it into.
 */
export function isNeedsReview(account: TypeAndSubType): boolean {
  return NEEDS_REVIEW_TYPES.includes(account.type) && account.subType == null;
}

export type AssetBucket = "current" | "nonCurrent" | "needsReview";

/** Where an Asset line belongs on a classified Balance Sheet. */
export function assetBucket(subType: AccountSubTypeCode | null): AssetBucket {
  if (subType == null) return "needsReview";
  if (NON_CURRENT_ASSET_SUBTYPES.includes(subType)) return "nonCurrent";
  return "current"; // cash-and-equivalent or another current-asset subtype
}

export type LiabilityBucket = "current" | "nonCurrent" | "needsReview";

/** Where a Liability line belongs on a classified Balance Sheet, or the Cash Flow Statement. */
export function liabilityBucket(
  subType: AccountSubTypeCode | null,
): LiabilityBucket {
  if (subType == null) return "needsReview";
  if (CURRENT_LIABILITY_SUBTYPES.includes(subType)) return "current";
  return "nonCurrent"; // only NON_CURRENT_LIABILITY_SUBTYPES values remain
}

export type ExpenseBucket = "cogs" | "operating" | "other";

/** Where an Expense line belongs for Gross Profit / Operating Income. */
export function expenseBucket(
  subType: AccountSubTypeCode | null,
): ExpenseBucket {
  if (subType === ExpenseSubType.CostOfGoodsSold) return "cogs";
  if (subType === ExpenseSubType.OtherExpense) return "other";
  return "operating"; // OperatingExpense, or null — the soft default
}

export type RevenueBucket = "operating" | "other";

/** Where a Revenue line belongs for Gross Profit / Operating Income. */
export function revenueBucket(
  subType: AccountSubTypeCode | null,
): RevenueBucket {
  return subType === RevenueSubType.OtherRevenue ||
    subType === RevenueSubType.ContraOtherRevenue
    ? "other"
    : "operating"; // Operating and contra operating revenue, or null
}
