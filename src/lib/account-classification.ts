import {
  AccountSubType,
  AccountType,
  type AccountSubTypeCode,
  type AccountTypeCode,
} from "$lib/enums.js";

/** Contra revenue stays on the income statement, with a debit normal balance. */
export function isContraRevenueAccount(account: {
  type: AccountTypeCode;
  subType: AccountSubTypeCode | null;
}): boolean {
  return (
    account.type === AccountType.Revenue &&
    (account.subType === AccountSubType.ContraOperatingRevenue ||
      account.subType === AccountSubType.ContraOtherRevenue)
  );
}

export type TypeAndSubType = {
  type: AccountTypeCode;
  /**
   * Absent for Equity. For Asset/Liability, `null` means "needs review"
   * in the chart. For Expense/Revenue, `null` defaults safely to Operating.
   */
  subType: AccountSubTypeCode | null;
};

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

/** Shared everyday category classification for manual records and imports. */
export function everydayCategoryKind(
  account: TypeAndSubType,
): "expense" | "income" | null {
  if (
    account.type === AccountType.Expense ||
    isPurchaseAssetAccount(account) ||
    isContraRevenueAccount(account)
  )
    return "expense";
  if (account.type === AccountType.Revenue) return "income";
  return null;
}
