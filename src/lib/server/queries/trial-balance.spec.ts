import { afterEach, describe, expect, it } from "vitest";
import { AccountType, type AccountTypeCode } from "$lib/enums.js";
import { createAccount } from "../services/accounts.js";
import {
  releaseBook,
  resultValue,
} from "../application/__fixtures__/release-book.js";
import {
  createRecord,
  prepareVoidRecord,
  voidRecord,
} from "../application/records.js";
import { accountTotalsUpTo } from "./reports.js";
import { trialBalance } from "./trial-balance.js";

/**
 * `trialBalance` over a small book built on `releaseBook` (in memory, never
 * `db/client.ts`). Every figure is whole minor units worked out by hand from
 * the records `seed` writes.
 */

type Book = ReturnType<typeof releaseBook>;
let book: Book | undefined;
afterEach(() => {
  book?.raw.close();
  book = undefined;
});

function seed() {
  book = releaseBook();
  const { db, ctx, bank, expense } = book;
  const account = (name: string, type: AccountTypeCode) =>
    resultValue(createAccount(db, 1, { name, type })).id;
  const meals = account("Meals", AccountType.Expense);
  const sales = account("Sales", AccountType.Revenue);
  const unused = account("Never used", AccountType.Expense);
  const myr = { currency: "MYR", exchangeRate: 1 };
  const write = (input: Parameters<typeof createRecord>[1]) =>
    resultValue(createRecord(ctx, input)).record;

  // Bank in 1,000.00, out 100.00 + 40.00 + 25.50 (the last one voided later).
  write({
    ...myr,
    kind: "income",
    date: "2026-01-10",
    amount: 1000,
    description: "Consulting",
    categoryAccountId: sales,
    receivedIntoAccountId: bank,
  });
  write({
    ...myr,
    kind: "expense",
    date: "2026-02-05",
    amount: 100,
    description: "Printer paper",
    categoryAccountId: expense,
    paidFromAccountId: bank,
  });
  write({
    ...myr,
    kind: "expense",
    date: "2026-03-20",
    amount: 40,
    description: "Lunch",
    categoryAccountId: expense,
    paidFromAccountId: bank,
  });
  const mistake = write({
    ...myr,
    kind: "expense",
    date: "2026-03-25",
    amount: 25.5,
    description: "Entered twice",
    categoryAccountId: meals,
    paidFromAccountId: bank,
  });
  voidRecord(ctx, mistake.id, {
    reason: "Entered twice by mistake.",
    expectedVersion: resultValue(prepareVoidRecord(ctx, mistake.id)).version,
  });
  return { ...book, meals, sales, unused };
}

describe("trialBalance", () => {
  it("balances: total debits equal total credits", () => {
    const s = seed();
    const report = trialBalance(s.db, { asAt: "2026-12-31" });
    expect(report.asAt).toBe("2026-12-31");
    expect(report.totals.debitMinor).toBe(report.totals.creditMinor);
    // Debits: bank 860.00 + expenses 140.00. Credits: sales 1,000.00.
    expect(report.totals).toEqual({ debitMinor: 100000, creditMinor: 100000 });
    // Each record is balanced on its own date, so every earlier date balances
    // too, with or without the zero rows.
    for (const asAt of [
      "2026-01-09",
      "2026-01-10",
      "2026-02-28",
      "2026-03-24",
    ]) {
      const { totals } = trialBalance(s.db, { asAt });
      expect(totals.debitMinor).toBe(totals.creditMinor);
    }
  });

  it("puts a positive balance in debit and a negative one in credit", () => {
    const s = seed();
    const { rows } = trialBalance(s.db, { asAt: "2026-12-31" });
    const byId = new Map(rows.map((row) => [row.accountId, row]));
    expect(byId.get(s.bank)).toMatchObject({
      debitMinor: 86000,
      creditMinor: 0,
    });
    expect(byId.get(s.sales)).toMatchObject({
      debitMinor: 0,
      creditMinor: 100000,
    });
    expect(byId.get(s.expense)).toMatchObject({
      debitMinor: 14000,
      creditMinor: 0,
    });
  });

  it("agrees with accountTotalsUpTo for every account", () => {
    const s = seed();
    const asAt = "2026-02-28";
    const totals = new Map(
      accountTotalsUpTo(s.db, asAt).map((total) => [total.accountId, total]),
    );
    const { rows } = trialBalance(s.db, { asAt, includeZero: true });
    expect(rows).toHaveLength(totals.size);
    for (const row of rows) {
      const total = totals.get(row.accountId)!;
      expect(row.debitMinor - row.creditMinor).toBe(total.amountMinor);
      expect(row.debitMinor === 0 || row.creditMinor === 0).toBe(true);
      expect(row).toMatchObject({
        code: total.code,
        name: total.accountName,
        type: total.type,
        subType: total.subType,
      });
    }
    // On this date: bank 1000 - 100, paper 100, sales 1000.
    expect(rows.find((row) => row.accountId === s.bank)!.debitMinor).toBe(
      90000,
    );
  });

  it("leaves out an account with a zero balance unless includeZero is set", () => {
    const s = seed();
    const asAt = "2026-12-31";
    const ids = (includeZero?: boolean) =>
      trialBalance(s.db, { asAt, includeZero }).rows.map(
        (row) => row.accountId,
      );
    // Never used: no movements. Meals: used, then voided, so nets to zero.
    for (const quiet of [s.unused, s.meals]) {
      expect(ids()).not.toContain(quiet);
      expect(ids(false)).not.toContain(quiet);
      expect(ids(true)).toContain(quiet);
    }
    const zero = trialBalance(s.db, { asAt, includeZero: true }).rows.find(
      (row) => row.accountId === s.meals,
    )!;
    expect(zero).toMatchObject({ debitMinor: 0, creditMinor: 0 });
    // Including zero rows changes no total.
    expect(trialBalance(s.db, { asAt, includeZero: true }).totals).toEqual(
      trialBalance(s.db, { asAt }).totals,
    );
  });

  it("counts only records dated on or before asAt", () => {
    const s = seed();
    expect(trialBalance(s.db, { asAt: "2026-01-09" })).toEqual({
      asAt: "2026-01-09",
      rows: [],
      totals: { debitMinor: 0, creditMinor: 0 },
    });
    // The first record's own date is included.
    const onTheDay = trialBalance(s.db, { asAt: "2026-01-10" });
    expect(onTheDay.rows.map((row) => row.accountId).sort()).toEqual(
      [s.bank, s.sales].sort(),
    );
    expect(onTheDay.totals).toEqual({
      debitMinor: 100000,
      creditMinor: 100000,
    });
  });

  it("orders rows by account code, then name", () => {
    const s = seed();
    const { rows } = trialBalance(s.db, {
      asAt: "2026-12-31",
      includeZero: true,
    });
    const sorted = [...rows].sort(
      (a, b) => a.code - b.code || a.name.localeCompare(b.name),
    );
    expect(rows.map((row) => row.accountId)).toEqual(
      sorted.map((row) => row.accountId),
    );
    expect(new Set(rows.map((row) => row.code)).size).toBe(rows.length);
  });

  it("refuses a date that is not YYYY-MM-DD", () => {
    const s = seed();
    for (const asAt of ["2026-3-1", "March 2026", "2026-03", ""])
      expect(() => trialBalance(s.db, { asAt })).toThrow(RangeError);
  });

  it("changes no row", () => {
    const s = seed();
    const changes = () =>
      (s.raw.query("SELECT total_changes() AS n").get() as { n: number }).n;
    const before = changes();
    trialBalance(s.db, { asAt: "2026-12-31", includeZero: true });
    expect(changes()).toBe(before);
  });
});
