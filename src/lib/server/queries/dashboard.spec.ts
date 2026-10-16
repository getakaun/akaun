import { describe, expect, it } from "vitest";
import {
  cashBridge,
  delta,
  monthlySeries,
  netMarginPct,
  runwayMonths,
  topLinesWithOther,
} from "./dashboard.js";
import { profitLoss } from "../ledger/reports/profit-loss.js";
import { AccountRole, AccountType } from "$lib/enums.js";
import type {
  AccountTotal,
  CashFlowReport,
  ProfitLossReport,
  ReportLine,
} from "../ledger/types.js";

const line = (accountId: number, accountName: string, amountMinor: number): ReportLine => ({
  accountId,
  accountName,
  amountMinor,
});

describe("delta", () => {
  it("gives the change and its share of the comparison", () => {
    expect(delta(150, 100)).toEqual({ diffMinor: 50, pct: 0.5 });
    expect(delta(-50, -100)).toEqual({ diffMinor: 50, pct: 0.5 });
  });

  it("gives no percentage off a zero base", () => {
    expect(delta(100, 0)).toEqual({ diffMinor: 100, pct: null });
  });
});

describe("netMarginPct", () => {
  it("is the result over income, and null with no income", () => {
    expect(netMarginPct({ totalIncomeMinor: 1000, resultMinor: 250 } as ProfitLossReport)).toBe(0.25);
    expect(netMarginPct({ totalIncomeMinor: 0, resultMinor: -250 } as ProfitLossReport)).toBeNull();
  });
});

describe("topLinesWithOther", () => {
  const lines = [
    line(1, "Rent", 5000),
    line(2, "Wages", 9000),
    line(3, "Fuel", 1200),
    line(4, "Bank fees", 1200),
    line(5, "Refunds", -300),
  ];
  const previous = [line(1, "Rent", 5000), line(3, "Fuel", 800), line(9, "Gone", 400)];

  it("keeps the report's total", () => {
    const top = topLinesWithOther(lines, previous, 2);
    const sum = (xs: { amountMinor: number }[]) => xs.reduce((s, x) => s + x.amountMinor, 0);
    expect(sum(top)).toBe(sum(lines));
    expect(top.map((t) => t.name)).toEqual(["Wages", "Rent", "Other"]);
    expect(top[2].amountMinor).toBe(1200 + 1200 - 300);
    expect(top[2].prevMinor).toBe(800 + 400);
  });

  it("orders equal amounts by name, then id", () => {
    const top = topLinesWithOther(lines, previous, 4);
    expect(top.map((t) => t.name)).toEqual(["Wages", "Rent", "Bank fees", "Fuel", "Other"]);
  });

  it("folds a negative line into Other rather than listing it", () => {
    const top = topLinesWithOther(lines, previous, 10);
    expect(top.at(-1)).toMatchObject({ accountId: null, name: "Other", amountMinor: -300 });
  });

  it("has no Other line when nothing is left over", () => {
    expect(topLinesWithOther([line(1, "Rent", 10)], [], 6)).toEqual([
      { accountId: 1, name: "Rent", amountMinor: 10, prevMinor: 0 },
    ]);
  });
});

describe("runwayMonths", () => {
  const year = (tail: number[]) => [...Array(12 - tail.length).fill(100_000), ...tail];

  it("divides cash by the average fall over the last three complete months", () => {
    // Three months back 90k, last month-end 60k: 10k a month out; 50k today.
    expect(runwayMonths(year([90_000, 80_000, 70_000, 60_000, 50_000]))).toEqual({
      months: 5,
      burnMinor: 10_000,
    });
  });

  it("is null while cash is growing, or gone", () => {
    expect(runwayMonths(year([60_000, 70_000, 80_000, 90_000, 95_000]))).toBeNull();
    expect(runwayMonths(year([90_000, 80_000, 70_000, 60_000, -5_000]))).toBeNull();
  });
});

describe("monthlySeries", () => {
  it("is the profit and loss run once per month", () => {
    const total = (accountId: number, type: number, amountMinor: number): AccountTotal => ({
      accountId,
      code: accountId,
      accountName: `A${accountId}`,
      type: type as AccountTotal["type"],
      role: AccountRole.ExpenseCategory as AccountTotal["role"],
      subType: null,
      contactId: null,
      amountMinor,
    });
    const months = [
      { key: "2026-01", label: "Jan", from: "2026-01-01", to: "2026-01-31" },
      { key: "2026-02", label: "Feb", from: "2026-02-01", to: "2026-02-10" },
    ];
    const totals = [
      [total(1, AccountType.Revenue, -10_000), total(2, AccountType.Expense, 4_000)],
      [total(1, AccountType.Revenue, 0), total(2, AccountType.Expense, 1_500)],
    ];
    const series = monthlySeries(months, totals);
    series.forEach((point, i) => {
      const report = profitLoss({ dateFrom: months[i].from, dateTo: months[i].to, totals: totals[i] });
      expect(point.incomeMinor).toBe(report.totalIncomeMinor);
      expect(point.expensesMinor).toBe(report.totalExpensesMinor);
      expect(point.resultMinor).toBe(report.resultMinor);
    });
    expect(series[0]).toMatchObject({ incomeMinor: 10_000, expensesMinor: 4_000, resultMinor: 6_000 });
  });
});

describe("cashBridge", () => {
  it("reads every step off the two statements", () => {
    const section = (label: "Operating" | "Investing" | "Financing", totalMinor: number) => ({
      label,
      lines: [],
      totalMinor,
    });
    const cf = {
      operating: section("Operating", 7_000),
      investing: section("Investing", -20_000),
      financing: section("Financing", 15_000),
      netChangeMinor: 2_000,
      needsReviewMinor: 0,
    } as unknown as CashFlowReport;
    const bridge = cashBridge({ resultMinor: 9_000 } as ProfitLossReport, cf);
    expect(bridge).toEqual({
      netProfitMinor: 9_000,
      operatingMinor: 7_000,
      investingMinor: -20_000,
      freeCashFlowMinor: -13_000,
      financingMinor: 15_000,
      netChangeMinor: 2_000,
      needsReviewMinor: 0,
    });
  });
});
