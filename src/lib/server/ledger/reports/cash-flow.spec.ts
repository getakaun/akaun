import { describe, expect, it } from "vitest";
import {
  AccountSubType,
  AccountType,
  ExpenseSubType,
  LiabilitySubType,
  type AccountSubTypeCode,
  type AccountTypeCode,
} from "$lib/enums.js";
import { cashFlow, type CashFlowInput, type CashFlowRow } from "./cash-flow.js";
import { CASH_AND_EQUIVALENT_SUBTYPES } from "../account-type.js";
import type { Minor } from "../types.js";

/**
 * These tests state whole records, not the rows the query would hand over,
 * and the fixture narrows them the way `queries/reports.ts` does: keep the
 * records that touched a "fund" account (cash-and-equivalent, or a
 * needs-review Asset with `subType: null`), then keep the sides that are not
 * themselves cash-and-equivalent. A fixture that pre-selected the rows would
 * prove the arithmetic and nothing about the rule.
 */

const BANK = 1;
const RECEIVABLE = 2;
const INVENTORY = 3;
const EQUIPMENT = 4;
const PAYABLE = 5;
const EQUITY = 6;
const EXPENSE = 7;
const REVENUE = 8;
const OTHER_CURRENT = 9;
const NEEDS_REVIEW = 10;

type Side = {
  accountId: number;
  type: AccountTypeCode;
  subType: AccountSubTypeCode | null;
  amountMinor: Minor;
};

const side =
  (accountId: number, type: AccountTypeCode, subType: AccountSubTypeCode | null) =>
  (amountMinor: Minor): Side => ({ accountId, type, subType, amountMinor });

const bank = side(BANK, AccountType.Asset, AccountSubType.Bank);
const receivable = side(RECEIVABLE, AccountType.Asset, AccountSubType.Receivable);
const inventory = side(INVENTORY, AccountType.Asset, AccountSubType.Inventory);
const equipment = side(EQUIPMENT, AccountType.Asset, AccountSubType.Equipment);
const otherCurrent = side(OTHER_CURRENT, AccountType.Asset, AccountSubType.OtherCurrentAsset);
const needsReview = side(NEEDS_REVIEW, AccountType.Asset, null);
const payable = side(PAYABLE, AccountType.Liability, null);
const accountsPayable = side(PAYABLE, AccountType.Liability, LiabilitySubType.AccountsPayable);
const LONG_TERM_LOAN = 11;
const longTermLoan = side(LONG_TERM_LOAN, AccountType.Liability, LiabilitySubType.LongTermLoan);
const equity = side(EQUITY, AccountType.Equity, null);
const expense = side(EXPENSE, AccountType.Expense, null);
const COGS = 12;
const costOfGoodsSold = side(COGS, AccountType.Expense, ExpenseSubType.CostOfGoodsSold);
const revenue = side(REVENUE, AccountType.Revenue, null);

/** Every record's sides sum to zero, or the fixture is not a record. */
function record(...sides: Side[]): Side[] {
  const sum = sides.reduce((running, s) => running + s.amountMinor, 0);
  if (sum !== 0)
    throw new Error(`fixture is not a balanced record: sides sum to ${sum}`);
  return sides;
}

function isCashAndEquivalent(s: Side): boolean {
  return (
    s.type === AccountType.Asset &&
    s.subType !== null &&
    CASH_AND_EQUIVALENT_SUBTYPES.includes(s.subType)
  );
}

function isFundAccount(s: Side): boolean {
  return isCashAndEquivalent(s) || (s.type === AccountType.Asset && s.subType === null);
}

/** Cash and cash equivalents' own movement — the independent opening/closing read. */
function cashMinor(records: Side[][]): Minor {
  return records
    .flat()
    .filter(isCashAndEquivalent)
    .reduce((running, s) => running + s.amountMinor, 0);
}

/**
 * The needs-review Asset accounts' own movement — independent of `rows`.
 * A needs-review Liability's contribution is NOT included here: `cashFlow`
 * derives that from `rows` itself, since (unlike Asset) most Liability
 * activity never touches a fund account at all.
 */
function needsReviewMinorOf(records: Side[][]): Minor {
  return records
    .flat()
    .filter((s) => s.type === AccountType.Asset && s.subType === null)
    .reduce((running, s) => running + s.amountMinor, 0);
}

/** What `queries/reports.ts` selects: the non-cash sides of fund-touching records. */
function rowsFrom(records: Side[][]): CashFlowRow[] {
  return records
    .filter((sides) => sides.some(isFundAccount))
    .flatMap((sides) => sides.filter((s) => !isCashAndEquivalent(s)));
}

const OPENING = 100_00;

function reportFor(records: Side[][]): ReturnType<typeof cashFlow> {
  const input: CashFlowInput = {
    dateFrom: "2026-01-01",
    dateTo: "2026-01-31",
    openingCashMinor: OPENING,
    closingCashMinor: OPENING + cashMinor(records),
    needsReviewMinor: needsReviewMinorOf(records),
    rows: rowsFrom(records),
  };
  return cashFlow(input);
}

function lineIn(
  report: ReturnType<typeof cashFlow>,
  section: "operating" | "investing" | "financing",
  label: string,
): Minor | undefined {
  return report[section].lines.find((l) => l.label === label)?.amountMinor;
}

describe("cashFlow", () => {
  it("classifies a cash sale as operating revenue", () => {
    const records = [record(bank(1000), revenue(-1000))];
    const report = reportFor(records);
    expect(lineIn(report, "operating", "Revenue")).toBe(1000);
    expect(report.investing.lines).toEqual([]);
    expect(report.financing.lines).toEqual([]);
    expect(report.ties).toBe(true);
  });

  it("classifies an equipment purchase as investing", () => {
    const records = [record(bank(-40000), equipment(40000))];
    const report = reportFor(records);
    expect(lineIn(report, "investing", "Capital expenditure")).toBe(-40000);
    expect(report.operating.lines).toEqual([]);
    expect(report.ties).toBe(true);
  });

  it("classifies an owner's equity movement as financing", () => {
    const records = [record(bank(50000), equity(-50000))];
    const report = reportFor(records);
    expect(lineIn(report, "financing", "Owner contributions and drawings")).toBe(50000);
    expect(report.operating.lines).toEqual([]);
    expect(report.investing.lines).toEqual([]);
  });

  it("classifies operating expenses and trade payables as operating", () => {
    const records = [
      record(bank(-500), expense(500)),
      record(payable(300), expense(-300)),
    ];
    const report = reportFor(records);
    expect(lineIn(report, "operating", "Operating expenses")).toBe(-500);
    expect(report.ties).toBe(true);
  });

  it("does not show an unpaid invoice as cash received", () => {
    // Issuing an invoice touches only Receivable and Revenue — no fund account
    // — so it must not appear on the statement at all (quickstart Scenario 2).
    const records = [record(receivable(1000), revenue(-1000))];
    const report = reportFor(records);
    expect(report.operating.lines).toEqual([]);
    expect(report.investing.lines).toEqual([]);
    expect(report.financing.lines).toEqual([]);
    expect(report.netChangeMinor).toBe(0);
    expect(report.ties).toBe(true);
  });

  it("surfaces a receivable settlement as its own 'change in receivables' line (FR-012)", () => {
    // The later payment, once it actually touches cash.
    const records = [record(bank(1000), receivable(-1000))];
    const report = reportFor(records);
    expect(lineIn(report, "operating", "Change in receivables")).toBe(1000);
    expect(report.ties).toBe(true);
  });

  it("surfaces a change in inventory and other current assets as their own operating lines", () => {
    const records = [
      record(bank(-300), inventory(300)),
      record(bank(-150), otherCurrent(150)),
    ];
    const report = reportFor(records);
    expect(lineIn(report, "operating", "Change in inventory")).toBe(-300);
    expect(lineIn(report, "operating", "Change in other current assets")).toBe(
      -150,
    );
  });

  it("excludes a needs-review cash-side movement from every section and tracks it separately (FR-005)", () => {
    // An expense paid from an account nobody has classified yet: the expense
    // side is genuinely an operating expense and is shown as one, but the
    // needs-review side never becomes a section line of its own — it is
    // tracked apart, in `needsReviewMinor`.
    const records = [record(needsReview(-500), expense(500))];
    const report = reportFor(records);
    // The only section line is the correctly-classified expense side — no
    // "needs review" or "other current asset" line leaks in for the
    // unclassified account.
    expect(report.operating.lines).toEqual([
      { accountId: null, label: "Operating expenses", amountMinor: -500 },
    ]);
    expect(report.investing.lines).toEqual([]);
    expect(report.financing.lines).toEqual([]);
    expect(report.needsReviewMinor).toBe(-500);
    expect(report.notes.some((n) => n.includes("no sub-type"))).toBe(
      true,
    );
    // The identity still holds: the needs-review side and the operating side
    // are the same real movement, so the tie-out is unaffected by it.
    expect(report.ties).toBe(true);
  });

  it("keeps a needs-review-to-bank transfer out of the sections without breaking the tie-out", () => {
    const records = [record(bank(1000), needsReview(-1000))];
    const report = reportFor(records);
    expect(report.operating.lines).toEqual([]);
    expect(report.needsReviewMinor).toBe(-1000);
    expect(report.ties).toBe(true);
  });

  it("nets a bank-to-bank transfer to nothing (both sides are cash)", () => {
    const bank2 = side(20, AccountType.Asset, AccountSubType.Bank);
    const records = [record(bank(-1000), bank2(1000))];
    const report = reportFor(records);
    expect(report.operating.lines).toEqual([]);
    expect(report.investing.lines).toEqual([]);
    expect(report.financing.lines).toEqual([]);
    expect(report.netChangeMinor).toBe(0);
    expect(report.ties).toBe(true);
  });

  it("sets ties=false and reports the difference when the figures do not add up", () => {
    const report = cashFlow({
      dateFrom: "2026-01-01",
      dateTo: "2026-01-31",
      openingCashMinor: OPENING,
      // The rows explain a change of 1000; this closing figure claims 999 more
      // than that, so the mismatch is exactly 999.
      closingCashMinor: OPENING + 1000 + 999,
      needsReviewMinor: 0,
      rows: [{ accountId: REVENUE, type: AccountType.Revenue, subType: null, amountMinor: -1000 }],
    });
    expect(report.ties).toBe(false);
    expect(report.differenceMinor).toBe(999);
    expect(report.notes[0]).toContain("does not reconcile");
  });

  it("classifies paying down a current liability (accounts payable) as operating", () => {
    const records = [record(bank(-250), accountsPayable(250))];
    const report = reportFor(records);
    expect(lineIn(report, "operating", "Change in payables and other current liabilities")).toBe(
      -250,
    );
    expect(report.financing.lines).toEqual([]);
    expect(report.ties).toBe(true);
  });

  it("classifies repaying long-term loan principal as financing, not operating (a real reclassification)", () => {
    const records = [record(bank(-5000), longTermLoan(5000))];
    const report = reportFor(records);
    expect(lineIn(report, "financing", "Long-term debt")).toBe(-5000);
    expect(report.operating.lines).toEqual([]);
    expect(report.ties).toBe(true);
  });

  it("excludes a needs-review liability movement from every section and tracks it separately, same as a needs-review asset", () => {
    const records = [record(bank(-800), payable(800))];
    const report = reportFor(records);
    expect(report.operating.lines).toEqual([]);
    expect(report.financing.lines).toEqual([]);
    expect(report.needsReviewMinor).toBe(800);
    expect(report.notes.some((n) => n.includes("liability accounts"))).toBe(true);
    expect(report.ties).toBe(true);
  });

  it("splits expense lines into Cost of Goods Sold and Operating expenses", () => {
    const records = [
      record(bank(-1200), costOfGoodsSold(1200)),
      record(bank(-500), expense(500)),
    ];
    const report = reportFor(records);
    expect(lineIn(report, "operating", "Cost of goods sold")).toBe(-1200);
    expect(lineIn(report, "operating", "Operating expenses")).toBe(-500);
    expect(report.ties).toBe(true);
  });

  it("propagates the history-gap note", () => {
    const report = cashFlow({
      dateFrom: "2026-01-01",
      dateTo: "2026-01-31",
      openingCashMinor: 0,
      closingCashMinor: 0,
      needsReviewMinor: 0,
      rows: [],
      trackingStartedOn: "2026-01-15",
    });
    expect(report.notes.some((n) => n.includes("2026-01-15"))).toBe(true);
  });
});
