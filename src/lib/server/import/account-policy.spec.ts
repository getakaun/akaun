import { describe, expect, it } from "vitest";
import {
  AccountSubType,
  AccountType,
  LedgerRecordKindLabels,
} from "$lib/enums.js";
import type { AccountView } from "../ledger/types.js";
import {
  isImportIncomeSource,
  isImportIncomeTarget,
  isImportPurchaseSource,
  isImportPurchaseTarget,
  importKindForSource,
  validateImportAccountPair,
} from "./account-policy.js";

import { sidesFromAccounts } from "../ledger/sides-from-accounts.js";

function account(
  id: number,
  type: number,
  subType: number | null,
  postingEligible = true,
): AccountView {
  return { id, type, subType, postingEligible, active: true } as AccountView;
}

describe("auto-import account policy", () => {
  const bank = account(1, AccountType.Asset, AccountSubType.Bank);
  const clearing = account(2, AccountType.Asset, AccountSubType.Clearing);
  const inventory = account(3, AccountType.Asset, AccountSubType.Inventory);
  const fixedAsset = account(4, AccountType.Asset, AccountSubType.FixedAsset);
  const intangible = account(
    5,
    AccountType.Asset,
    AccountSubType.IntangibleAsset,
  );
  const receivable = account(6, AccountType.Asset, AccountSubType.Receivable);
  const payable = account(
    7,
    AccountType.Liability,
    AccountSubType.AccountsPayable,
  );
  const creditCard = account(
    8,
    AccountType.Liability,
    AccountSubType.CreditCard,
  );
  const loan = account(9, AccountType.Liability, AccountSubType.ShortTermLoan);
  const expense = account(
    10,
    AccountType.Expense,
    AccountSubType.OperatingExpense,
  );
  const revenue = account(
    11,
    AccountType.Revenue,
    AccountSubType.OperatingRevenue,
  );

  it("offers safe purchase funding accounts", () => {
    expect(isImportPurchaseSource(bank, payable.id)).toBe(true);
    expect(isImportPurchaseSource(clearing, payable.id)).toBe(true);
    expect(isImportPurchaseSource(payable, payable.id)).toBe(true);
    expect(isImportPurchaseSource(creditCard, payable.id)).toBe(true);
    expect(isImportPurchaseSource(loan, payable.id)).toBe(false);
    expect(isImportPurchaseSource(inventory, payable.id)).toBe(false);
  });

  it("offers expenses and purchasable assets as purchase targets", () => {
    expect(isImportPurchaseTarget(expense)).toBe(true);
    expect(isImportPurchaseTarget(inventory)).toBe(true);
    expect(isImportPurchaseTarget(fixedAsset)).toBe(true);
    expect(isImportPurchaseTarget(intangible)).toBe(true);
    expect(isImportPurchaseTarget(bank)).toBe(false);
    expect(isImportPurchaseTarget(receivable)).toBe(false);
  });

  it("offers revenue into transaction assets or the configured receivable", () => {
    expect(isImportIncomeSource(revenue)).toBe(true);
    expect(isImportIncomeSource(expense)).toBe(false);
    expect(isImportIncomeTarget(bank, receivable.id)).toBe(true);
    expect(isImportIncomeTarget(clearing, receivable.id)).toBe(true);
    expect(isImportIncomeTarget(receivable, receivable.id)).toBe(true);
    expect(isImportIncomeTarget(inventory, receivable.id)).toBe(false);
  });

  it("never offers headings", () => {
    expect(
      isImportPurchaseTarget(
        account(20, AccountType.Asset, AccountSubType.FixedAsset, false),
      ),
    ).toBe(false);
  });

  it("derives the record kind from the source account", () => {
    expect(importKindForSource(revenue, payable.id)).toBe("income");
    expect(importKindForSource(bank, payable.id)).toBe("expense");
    expect(importKindForSource(payable, payable.id)).toBe("expense");
    expect(importKindForSource(loan, payable.id)).toBeNull();
  });

  it("validates complete direction-driven account pairs", () => {
    expect(
      validateImportAccountPair(revenue, bank, payable.id, receivable.id),
    ).toEqual({
      ok: true,
      kind: "income",
    });
    expect(
      validateImportAccountPair(bank, expense, payable.id, receivable.id),
    ).toEqual({
      ok: true,
      kind: "expense",
    });
    expect(
      validateImportAccountPair(revenue, expense, payable.id, receivable.id).ok,
    ).toBe(false);
    expect(
      validateImportAccountPair(bank, bank, payable.id, receivable.id).ok,
    ).toBe(false);
  });
});

// The picker and confirmation API must offer the same account pairs.
describe("contra revenue import eligibility", () => {
  it("agrees with client choices across sources, targets and lifecycle states", async () => {
    const { targetAccountsForImportSource, groupImportSourceAccounts } =
      await import("$lib/import-account-groups.js");
    const choices = [
      account(1, AccountType.Revenue, AccountSubType.OperatingRevenue),
      account(2, AccountType.Revenue, AccountSubType.OtherRevenue),
      account(3, AccountType.Revenue, null),
      account(4, AccountType.Revenue, AccountSubType.ContraOperatingRevenue),
      account(5, AccountType.Revenue, AccountSubType.ContraOtherRevenue),
      account(6, AccountType.Asset, AccountSubType.Bank),
      account(7, AccountType.Asset, AccountSubType.Receivable),
      account(8, AccountType.Expense, AccountSubType.OperatingExpense),
      account(11, AccountType.Asset, AccountSubType.Clearing),
      account(12, AccountType.Liability, AccountSubType.CreditCard),
      account(13, AccountType.Liability, AccountSubType.AccountsPayable),
      account(14, AccountType.Asset, AccountSubType.Inventory),
      {
        ...account(9, AccountType.Revenue, AccountSubType.ContraOtherRevenue),
        active: false,
      },
      account(
        10,
        AccountType.Revenue,
        AccountSubType.ContraOtherRevenue,
        false,
      ),
    ];
    const sources = groupImportSourceAccounts(choices, 13);
    expect(sources.income.map((a) => a.id)).toEqual([1, 2, 3]);
    expect(
      targetAccountsForImportSource(choices, 1, null, 7).map((a) => a.id),
    ).toEqual([6, 7, 11]);
    expect(
      targetAccountsForImportSource(choices, 11, 13, 7).map((a) => a.id),
    ).toEqual([4, 5, 8, 14]);
    expect(validateImportAccountPair(choices[0], choices[3], 13, 7).ok).toBe(
      false,
    );
    for (const source of choices) {
      const targets = targetAccountsForImportSource(choices, source.id, 13, 7);
      for (const target of choices) {
        expect(
          validateImportAccountPair(source, target, 13, 7).ok,
          `${source.id} → ${target.id}`,
        ).toBe(targets.includes(target));
      }
    }
  });
});

describe("manual and importer category classification", () => {
  it.each([
    [AccountType.Revenue, AccountSubType.ContraOperatingRevenue, "expense"],
    [AccountType.Revenue, AccountSubType.ContraOtherRevenue, "expense"],
    [AccountType.Expense, AccountSubType.OperatingExpense, "expense"],
    [AccountType.Asset, AccountSubType.Inventory, "expense"],
    [AccountType.Asset, AccountSubType.FixedAsset, "expense"],
    [AccountType.Revenue, AccountSubType.OperatingRevenue, "income"],
    [AccountType.Revenue, AccountSubType.OtherRevenue, "income"],
    [AccountType.Revenue, null, "income"],
  ] as const)(
    "type %s subtype %s derives %s in both paths",
    (type, subType, kind) => {
      const money = {
        ...account(1, AccountType.Asset, AccountSubType.Clearing),
        role: 1,
        archived: false,
      };
      const category = {
        ...account(2, type, subType),
        role: 1,
        archived: false,
      };
      const [from, to] =
        kind === "expense" ? [money, category] : [category, money];
      expect(validateImportAccountPair(from, to, 90, 91)).toEqual({
        ok: true,
        kind,
      });
      const manual = sidesFromAccounts(
        { fromAccountId: from.id, toAccountId: to.id, amountMinor: 1000 },
        {
          accountById: (id) =>
            [money, category].find((a) => a.id === id) ?? null,
          canAdjust: false,
          payableAccountId: 90,
          receivableAccountId: 91,
          openingBalancesAccountId: 92,
        },
      );
      expect(manual.ok).toBe(true);
      if (!manual.ok) throw new Error(manual.reason);
      expect(
        manual.value.kind === "journal" && manual.value.storedKind !== undefined
          ? LedgerRecordKindLabels[manual.value.storedKind]
          : manual.value.kind,
      ).toBe(kind);
    },
  );
});
