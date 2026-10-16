import { describe, expect, it } from "vitest";
import {
  AccountRole,
  AccountType,
  ExpenseSubType,
  RevenueSubType,
  type AccountRoleCode,
  type AccountSubTypeCode,
} from "$lib/enums.js";
import { profitLoss } from "./profit-loss.js";
import { accountTypeFor } from "../account-type.js";
import type { AccountTotal, Minor } from "../types.js";

/**
 * One account's total, the way `queries/reports.ts` hands it over. Raw signs:
 * positive when value went into that account, negative when it left.
 */
function total(
  accountId: number,
  accountName: string,
  role: AccountRoleCode,
  amountMinor: Minor,
  subType: AccountSubTypeCode | null = null,
): AccountTotal {
  return {
    accountId,
    code: accountId,
    accountName,
    type: accountTypeFor(role),
    role,
    subType,
    contactId: null,
    amountMinor,
  };
}

/**
 * A dated side of a record, only for the tests that turn on *when* something
 * happened. The report module never sees dates on a movement — the query has
 * already narrowed to the range — so this fixture stands in for that query.
 */
type DatedMovement = {
  date: string;
  accountId: number;
  accountName: string;
  role: AccountRoleCode;
  amountMinor: Minor;
};

function totalsBetween(
  movements: DatedMovement[],
  dateFrom: string,
  dateTo: string,
): AccountTotal[] {
  const byAccount = new Map<number, AccountTotal>();
  for (const m of movements) {
    if (m.date < dateFrom || m.date > dateTo) continue;
    const existing = byAccount.get(m.accountId);
    if (existing) existing.amountMinor += m.amountMinor;
    else
      byAccount.set(
        m.accountId,
        total(m.accountId, m.accountName, m.role, m.amountMinor),
      );
  }
  return [...byAccount.values()];
}

const CONSULTING = 10;
const SALES = 11;
const SOFTWARE = 20;
const TRAVEL = 21;
const BANK = 30;
const WALLET = 31;
const RECEIVABLE = 40;

describe("lines grouped by category account", () => {
  const report = profitLoss({
    dateFrom: "2026-01-01",
    dateTo: "2026-01-31",
    totals: [
      total(CONSULTING, "Consulting", AccountRole.IncomeCategory, -150_000),
      total(SALES, "Sales", AccountRole.IncomeCategory, -25_000),
      total(SOFTWARE, "Software", AccountRole.ExpenseCategory, 4_500),
      total(TRAVEL, "Travel", AccountRole.ExpenseCategory, 12_000),
    ],
  });

  it("gives one line per category account, naming it", () => {
    expect(report.income.map((l) => l.accountName)).toEqual([
      "Consulting",
      "Sales",
    ]);
    expect(report.expenses.map((l) => l.accountName)).toEqual([
      "Software",
      "Travel",
    ]);
  });

  it("keeps the account id on every line, so a line can be opened", () => {
    expect(report.income.map((l) => l.accountId)).toEqual([CONSULTING, SALES]);
  });

  it("shows money coming in the way a reader expects it, not as a negative", () => {
    // Income sits at a negative balance under the one sign convention; the
    // report is the place that flips it.
    expect(report.income[0].amountMinor).toBe(150_000);
    expect(report.totalIncomeMinor).toBe(175_000);
  });

  it("shows money going out as a positive figure too", () => {
    expect(report.totalExpensesMinor).toBe(16_500);
  });

  it("takes what went out off what came in", () => {
    expect(report.resultMinor).toBe(158_500);
  });

  it("echoes the period it covers", () => {
    expect(report.dateFrom).toBe("2026-01-01");
    expect(report.dateTo).toBe("2026-01-31");
  });
});

describe("fixed types", () => {
  it("classifies Revenue and Expense by fixed type even when a transitional role disagrees", () => {
    const report = profitLoss({
      dateFrom: "2026-01-01",
      dateTo: "2026-01-31",
      totals: [
        {
          ...total(70, "Custom revenue", AccountRole.Bank, -2_000),
          type: AccountType.Revenue,
        },
        {
          ...total(71, "Custom expense", AccountRole.Bank, 500),
          type: AccountType.Expense,
        },
      ],
    });
    expect(report.income.map((line) => line.accountId)).toEqual([70]);
    expect(report.expenses.map((line) => line.accountId)).toEqual([71]);
    expect(report.resultMinor).toBe(1_500);
  });

  it("gives each account its own line, with the total the plain sum", () => {
    const report = profitLoss({
      dateFrom: "2026-01-01",
      dateTo: "2026-01-31",
      totals: [
        {
          accountId: 81,
          code: 4010,
          accountName: "Online",
          type: AccountType.Revenue,
          role: AccountRole.IncomeCategory,
          subType: null,
          contactId: null,
          amountMinor: -900,
        },
        {
          accountId: 82,
          code: 4020,
          accountName: "Retail",
          type: AccountType.Revenue,
          role: AccountRole.IncomeCategory,
          subType: null,
          contactId: null,
          amountMinor: -600,
        },
        {
          accountId: 83,
          code: 5000,
          accountName: "Fees",
          type: AccountType.Expense,
          role: AccountRole.ExpenseCategory,
          subType: null,
          contactId: null,
          amountMinor: 200,
        },
      ],
    });
    expect(report.income.map((line) => line.accountId)).toEqual([81, 82]);
    expect(report.totalIncomeMinor).toBe(1_500);
    expect(report.resultMinor).toBe(1_300);
  });

  it("drops an account whose active balance nets to zero", () => {
    const report = profitLoss({
      dateFrom: "2026-01-01",
      dateTo: "2026-01-31",
      totals: [
        {
          ...total(90, "Other revenue", AccountRole.IncomeCategory, 0),
          type: AccountType.Revenue,
        },
        {
          ...total(91, "Gain", AccountRole.IncomeCategory, -500),
          type: AccountType.Revenue,
        },
        {
          ...total(92, "Refund", AccountRole.IncomeCategory, 500),
          type: AccountType.Revenue,
        },
      ],
    });

    expect(report.income.map((line) => line.accountId)).toEqual([91, 92]);
    expect(report.totalIncomeMinor).toBe(0);
  });
});

describe("accounts with nothing in them", () => {
  it("leaves a category that moved nothing off the report", () => {
    const report = profitLoss({
      dateFrom: "2026-01-01",
      dateTo: "2026-01-31",
      totals: [
        total(CONSULTING, "Consulting", AccountRole.IncomeCategory, -150_000),
        total(SALES, "Sales", AccountRole.IncomeCategory, 0),
        total(SOFTWARE, "Software", AccountRole.ExpenseCategory, 0),
      ],
    });
    expect(report.income.map((l) => l.accountName)).toEqual(["Consulting"]);
    expect(report.expenses).toEqual([]);
  });

  it("reports a period with nothing in it as a flat zero", () => {
    const report = profitLoss({
      dateFrom: "2026-01-01",
      dateTo: "2026-01-31",
      totals: [],
    });
    expect(report.income).toEqual([]);
    expect(report.expenses).toEqual([]);
    expect(report.totalIncomeMinor).toBe(0);
    expect(report.totalExpensesMinor).toBe(0);
    expect(report.resultMinor).toBe(0);
  });
});

describe("a transfer between two of the business's own accounts", () => {
  it("appears nowhere at all", () => {
    // Moving 500.00 from the bank to the wallet touches no category, so there
    // is nothing for the profit and loss to say about it (FR-007).
    const report = profitLoss({
      dateFrom: "2026-01-01",
      dateTo: "2026-01-31",
      totals: [
        total(BANK, "Bank", AccountRole.Bank, -50_000),
        total(WALLET, "Wallet", AccountRole.Wallet, 50_000),
      ],
    });
    expect(report.income).toEqual([]);
    expect(report.expenses).toEqual([]);
    expect(report.resultMinor).toBe(0);
  });

  it("does not change the result of a period that also had real income", () => {
    const withoutTransfer = profitLoss({
      dateFrom: "2026-01-01",
      dateTo: "2026-01-31",
      totals: [
        total(CONSULTING, "Consulting", AccountRole.IncomeCategory, -150_000),
      ],
    });
    const withTransfer = profitLoss({
      dateFrom: "2026-01-01",
      dateTo: "2026-01-31",
      totals: [
        total(CONSULTING, "Consulting", AccountRole.IncomeCategory, -150_000),
        total(BANK, "Bank", AccountRole.Bank, -50_000),
        total(WALLET, "Wallet", AccountRole.Wallet, 50_000),
      ],
    });
    expect(withTransfer.resultMinor).toBe(withoutTransfer.resultMinor);
    expect(withTransfer.expenses).toEqual([]);
  });
});

describe("money earned in one month and taken out in the next", () => {
  // Invoiced and earned on 20 January; the customer's money is moved out of the
  // business on 3 February. The income belongs to January (US2 AC3).
  const movements: DatedMovement[] = [
    {
      date: "2026-01-20",
      accountId: CONSULTING,
      accountName: "Consulting",
      role: AccountRole.IncomeCategory,
      amountMinor: -100_000,
    },
    {
      date: "2026-01-20",
      accountId: RECEIVABLE,
      accountName: "Money owed to us",
      role: AccountRole.Receivable,
      amountMinor: 100_000,
    },
    {
      date: "2026-02-03",
      accountId: RECEIVABLE,
      accountName: "Money owed to us",
      role: AccountRole.Receivable,
      amountMinor: -100_000,
    },
    {
      date: "2026-02-03",
      accountId: BANK,
      accountName: "Bank",
      role: AccountRole.Bank,
      amountMinor: 100_000,
    },
  ];

  it("counts the income in the month it was earned", () => {
    const january = profitLoss({
      dateFrom: "2026-01-01",
      dateTo: "2026-01-31",
      totals: totalsBetween(movements, "2026-01-01", "2026-01-31"),
    });
    expect(january.totalIncomeMinor).toBe(100_000);
    expect(january.resultMinor).toBe(100_000);
  });

  it("counts it again nowhere in the month it was taken out", () => {
    const february = profitLoss({
      dateFrom: "2026-02-01",
      dateTo: "2026-02-28",
      totals: totalsBetween(movements, "2026-02-01", "2026-02-28"),
    });
    expect(february.income).toEqual([]);
    expect(february.totalIncomeMinor).toBe(0);
    expect(february.resultMinor).toBe(0);
  });
});

describe("a period reaching back before the app kept these books", () => {
  it("says so in plain words rather than implying complete history", () => {
    const report = profitLoss({
      dateFrom: "2025-06-01",
      dateTo: "2026-01-31",
      totals: [],
      trackingStartedOn: "2026-01-01",
    });
    expect(report.notes).toHaveLength(1);
    expect(report.notes[0]).toMatch(/2026-01-01/);
    expect(report.notes[0]).toMatch(/invoice/i);
  });

  it("says nothing when the whole period is inside what the app tracked", () => {
    const report = profitLoss({
      dateFrom: "2026-01-01",
      dateTo: "2026-01-31",
      totals: [],
      trackingStartedOn: "2026-01-01",
    });
    expect(report.notes).toEqual([]);
  });

  it("says nothing when there is no upgrade date to compare against", () => {
    const report = profitLoss({
      dateFrom: "2020-01-01",
      dateTo: "2026-01-31",
      totals: [],
      trackingStartedOn: null,
    });
    expect(report.notes).toEqual([]);
  });
});

describe("Gross profit and Operating income", () => {
  it("takes Cost of Goods Sold off revenue for gross profit, then Operating expense for operating income", () => {
    const report = profitLoss({
      dateFrom: "2026-01-01",
      dateTo: "2026-01-31",
      totals: [
        total(
          SALES,
          "Sales",
          AccountRole.IncomeCategory,
          -100_000,
          RevenueSubType.OperatingRevenue,
        ),
        total(
          SOFTWARE,
          "Cost of Goods Sold",
          AccountRole.ExpenseCategory,
          40_000,
          ExpenseSubType.CostOfGoodsSold,
        ),
        total(
          TRAVEL,
          "Rent",
          AccountRole.ExpenseCategory,
          20_000,
          ExpenseSubType.OperatingExpense,
        ),
      ],
    });
    expect(report.subtotals).toEqual([
      { label: "Gross profit", amountMinor: 60_000 },
      { label: "Operating income", amountMinor: 40_000 },
    ]);
    expect(report.resultMinor).toBe(40_000);
  });

  it("treats an unclassified Expense or Revenue account as Operating, with no needs-review warning", () => {
    const report = profitLoss({
      dateFrom: "2026-01-01",
      dateTo: "2026-01-31",
      totals: [
        total(SALES, "Sales", AccountRole.IncomeCategory, -50_000),
        total(SOFTWARE, "Software", AccountRole.ExpenseCategory, 5_000),
      ],
    });
    expect(report.subtotals).toEqual([
      { label: "Gross profit", amountMinor: 50_000 },
      { label: "Operating income", amountMinor: 45_000 },
    ]);
    expect(report.notes).toEqual([]);
  });

  it("keeps Other Expense and Other Revenue out of gross profit and operating income", () => {
    const report = profitLoss({
      dateFrom: "2026-01-01",
      dateTo: "2026-01-31",
      totals: [
        total(
          SALES,
          "Sales",
          AccountRole.IncomeCategory,
          -50_000,
          RevenueSubType.OperatingRevenue,
        ),
        total(
          CONSULTING,
          "Gain on sale",
          AccountRole.IncomeCategory,
          -1_000,
          RevenueSubType.OtherRevenue,
        ),
        total(
          SOFTWARE,
          "Write-off",
          AccountRole.ExpenseCategory,
          2_000,
          ExpenseSubType.OtherExpense,
        ),
      ],
    });
    expect(report.subtotals).toEqual([
      { label: "Gross profit", amountMinor: 50_000 },
      { label: "Operating income", amountMinor: 50_000 },
    ]);
    expect(report.resultMinor).toBe(49_000);
  });
});

describe("contra revenue reporting", () => {
  it("deducts debit balances and keeps contra other revenue outside operating profit", () => {
    const report = profitLoss({
      dateFrom: "2026-01-01",
      dateTo: "2026-12-31",
      totals: [
        total(
          1,
          "Sales",
          AccountRole.IncomeCategory,
          -10000,
          RevenueSubType.OperatingRevenue,
        ),
        total(
          2,
          "Discounts",
          AccountRole.IncomeCategory,
          1000,
          RevenueSubType.ContraOperatingRevenue,
        ),
        total(
          3,
          "Other income",
          AccountRole.IncomeCategory,
          -2000,
          RevenueSubType.OtherRevenue,
        ),
        total(
          4,
          "Other deductions",
          AccountRole.IncomeCategory,
          500,
          RevenueSubType.ContraOtherRevenue,
        ),
      ],
    });
    expect(report.income.map((line) => line.amountMinor)).toEqual([
      10000, -1000, 2000, -500,
    ]);
    expect(report.totalIncomeMinor).toBe(10500);
    expect(report.resultMinor).toBe(10500);
    expect(report.subtotals).toEqual([
      { label: "Gross profit", amountMinor: 9000 },
      { label: "Operating income", amountMinor: 9000 },
    ]);
  });
});
