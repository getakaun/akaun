import { describe, expect, it } from "vitest";
import {
  AccountRole,
  AccountSubType,
  AccountType,
  AccountTypeLabels,
  ExpenseSubType,
  LiabilitySubType,
  RevenueSubType,
  type AccountRoleCode,
} from "$lib/enums.js";
import {
  accountTypeFor,
  accountTypeForLegacyRole,
  assetBucket,
  expenseBucket,
  financialStatementFor,
  isCategoryAccount,
  isMoneyPotAccount,
  isNeedsReview,
  liabilityBucket,
  normalBalanceFor,
  normalBalanceForAccount,
  revenueBucket,
} from "./account-type.js";

describe("everyday account roles", () => {
  it("keeps transaction assets separate from assets bought by documents", () => {
    expect(
      isMoneyPotAccount({
        type: AccountType.Asset,
        subType: AccountSubType.Bank,
      }),
    ).toBe(true);
    expect(
      isMoneyPotAccount({
        type: AccountType.Asset,
        subType: AccountSubType.Inventory,
      }),
    ).toBe(false);
    expect(
      isCategoryAccount({
        type: AccountType.Asset,
        subType: AccountSubType.FixedAsset,
      }),
    ).toBe(true);
    expect(
      isCategoryAccount({
        type: AccountType.Asset,
        subType: AccountSubType.IntangibleAsset,
      }),
    ).toBe(true);
  });
});

describe("fixed account types", () => {
  it("AccountType_WhenEnumerated_ShouldContainExactlyFiveStableTypes", () => {
    expect(AccountType).toEqual({
      Asset: 1,
      Liability: 2,
      Equity: 3,
      Revenue: 4,
      Expense: 5,
    });
    expect(AccountTypeLabels).toEqual({
      1: "asset",
      2: "liability",
      3: "equity",
      4: "revenue",
      5: "expense",
    });
  });

  it("NormalBalance_WhenTypeVaries_ShouldFollowAccountingRules", () => {
    expect(normalBalanceFor(AccountType.Asset)).toBe("debit");
    expect(normalBalanceFor(AccountType.Expense)).toBe("debit");
    expect(normalBalanceFor(AccountType.Liability)).toBe("credit");
    expect(normalBalanceFor(AccountType.Equity)).toBe("credit");
    expect(normalBalanceFor(AccountType.Revenue)).toBe("credit");
  });

  it("FinancialStatement_WhenTypeVaries_ShouldUseFixedPlacement", () => {
    expect(financialStatementFor(AccountType.Asset)).toBe("balance_sheet");
    expect(financialStatementFor(AccountType.Liability)).toBe("balance_sheet");
    expect(financialStatementFor(AccountType.Equity)).toBe("balance_sheet");
    expect(financialStatementFor(AccountType.Revenue)).toBe("income_statement");
    expect(financialStatementFor(AccountType.Expense)).toBe("income_statement");
  });
});

describe("legacy role conversion", () => {
  it("LegacyRole_WhenConverted_ShouldMapEveryRetiredRoleDeterministically", () => {
    const expected = new Map<AccountRoleCode, number>([
      [AccountRole.Bank, AccountType.Asset],
      [AccountRole.Wallet, AccountType.Asset],
      [AccountRole.Cash, AccountType.Asset],
      [AccountRole.Card, AccountType.Asset],
      [AccountRole.Equipment, AccountType.Asset],
      [AccountRole.Receivable, AccountType.Asset],
      [AccountRole.Payable, AccountType.Liability],
      [AccountRole.OpeningBalances, AccountType.Equity],
      [AccountRole.PartnerCapital, AccountType.Equity],
      [AccountRole.PartnerDrawings, AccountType.Equity],
      [AccountRole.IncomeCategory, AccountType.Revenue],
      [AccountRole.ExpenseCategory, AccountType.Expense],
    ]);

    for (const [role, type] of expected) {
      expect(accountTypeForLegacyRole(role)).toBe(type);
      expect(accountTypeFor(role)).toBe(type);
    }
  });
});

describe("needs review", () => {
  it("flags an unclassified Asset or Liability account", () => {
    expect(isNeedsReview({ type: AccountType.Asset, subType: null })).toBe(
      true,
    );
    expect(isNeedsReview({ type: AccountType.Liability, subType: null })).toBe(
      true,
    );
    expect(
      isNeedsReview({ type: AccountType.Asset, subType: AccountSubType.Bank }),
    ).toBe(false);
  });

  it("never flags an unclassified Expense or Revenue account: they default to Operating", () => {
    expect(isNeedsReview({ type: AccountType.Expense, subType: null })).toBe(
      false,
    );
    expect(isNeedsReview({ type: AccountType.Revenue, subType: null })).toBe(
      false,
    );
  });

  it("never flags Equity: it has no sub-type", () => {
    expect(isNeedsReview({ type: AccountType.Equity, subType: null })).toBe(
      false,
    );
  });
});

describe("statement buckets", () => {
  it("assetBucket: operating assets are current and long-lived assets are non-current", () => {
    expect(assetBucket(AccountSubType.Bank)).toBe("current");
    expect(assetBucket(AccountSubType.Receivable)).toBe("current");
    expect(assetBucket(AccountSubType.FixedAsset)).toBe("nonCurrent");
    expect(assetBucket(AccountSubType.IntangibleAsset)).toBe("nonCurrent");
    expect(assetBucket(AccountSubType.PrepaymentsAndDeposits)).toBe("current");
    expect(assetBucket(null)).toBe("needsReview");
  });

  it("liabilityBucket: a current-liability sub-type is current, a long-term one is non-current, unclassified needs review", () => {
    expect(liabilityBucket(LiabilitySubType.AccountsPayable)).toBe("current");
    expect(liabilityBucket(LiabilitySubType.CreditCard)).toBe("current");
    expect(liabilityBucket(LiabilitySubType.TaxPayable)).toBe("current");
    expect(liabilityBucket(LiabilitySubType.LongTermLoan)).toBe("nonCurrent");
    expect(liabilityBucket(null)).toBe("needsReview");
  });

  it("expenseBucket: Cost of Goods Sold and Other Expense are named, everything else (including unclassified) is Operating", () => {
    expect(expenseBucket(ExpenseSubType.CostOfGoodsSold)).toBe("cogs");
    expect(expenseBucket(ExpenseSubType.OtherExpense)).toBe("other");
    expect(expenseBucket(ExpenseSubType.OperatingExpense)).toBe("operating");
    expect(expenseBucket(null)).toBe("operating");
  });

  it("revenueBucket: Other Revenue is named, everything else (including unclassified) is Operating", () => {
    expect(revenueBucket(RevenueSubType.OtherRevenue)).toBe("other");
    expect(revenueBucket(RevenueSubType.OperatingRevenue)).toBe("operating");
    expect(revenueBucket(null)).toBe("operating");
  });
});

describe("contra revenue classification", () => {
  it("derives debit normal balance independently of the reporting bucket", () => {
    for (const subType of [
      RevenueSubType.ContraOperatingRevenue,
      RevenueSubType.ContraOtherRevenue,
    ]) {
      expect(
        normalBalanceForAccount({ type: AccountType.Revenue, subType }),
      ).toBe("debit");
    }
    expect(
      normalBalanceForAccount({ type: AccountType.Revenue, subType: null }),
    ).toBe("credit");
    expect(
      normalBalanceForAccount({
        type: AccountType.Asset,
        subType: AccountSubType.Bank,
      }),
    ).toBe("debit");
    expect(revenueBucket(RevenueSubType.ContraOperatingRevenue)).toBe(
      "operating",
    );
    expect(revenueBucket(RevenueSubType.ContraOtherRevenue)).toBe("other");
  });
});
