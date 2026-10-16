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
