import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The dashboard's batched reads (007 FR-001) must be the reports' own reads,
 * not a second sum: each month of `accountTotalsByRanges` equals
 * `accountTotalsBetween` for that month, and each of `cashBalancesAsAt` equals
 * the Cash Flow Statement's closing cash for a period ending that day.
 *
 * The database is a file under `os.tmpdir()`, migrated from `drizzle/`, and
 * `db/client.ts` is mocked so nothing here can reach `data/`. Every figure is
 * made up.
 */

const sandbox = mkdtempSync(join(tmpdir(), "akaun-reports-ranges-spec-"));

vi.mock("$lib/server/env.js", () => ({
  STORAGE_PATH: join(sandbox, "storage"),
  DATABASE_PATH: "/dev/null",
  OCR_CACHE_PATH: "/dev/null",
}));

vi.mock("$lib/server/db/client.js", () => ({
  get db() {
    throw new Error("reports-ranges.spec must not touch the real database");
  },
}));

const { AccountRole, AccountSubType, AccountType, LedgerRecordKind } =
  await import("$lib/enums.js");
const schema = await import("../db/schema.js");
const { accounts, ledgerMovements, ledgerRecords } = schema;
const {
  accountTotalsBetween,
  accountTotalsByRanges,
  cashBalancesAsAt,
  cashFlowReport,
  cashOnHandAsAt,
} = await import("./reports.js");
type LedgerDb = import("../ledger/types.js").LedgerDb;

let sqlite: Database;
let db: LedgerDb;

function account(
  name: string,
  code: number,
  type: number,
  subType: number | null,
  archived = false,
): number {
  return db
    .insert(accounts)
    .values({
      name,
      code,
      type,
      subType,
      role: AccountRole.ExpenseCategory,
      rank: String(code),
      archivedAt: archived ? "2026-01-01 00:00:00" : null,
    })
    .returning({ id: accounts.id })
    .get().id;
}

/** One balanced record: `minor` into `to`, out of `from`. */
function record(date: string, minor: number, to: number, from: number): void {
  const { id } = db
    .insert(ledgerRecords)
    .values({
      kind: LedgerRecordKind.Journal,
      date,
      amount: minor / 100,
      description: `fixture ${date}`,
    })
    .returning({ id: ledgerRecords.id })
    .get();
  db.insert(ledgerMovements)
    .values([
      { recordId: id, accountId: to, amountMinor: minor, sortOrder: 0 },
      { recordId: id, accountId: from, amountMinor: -minor, sortOrder: 1 },
    ])
    .run();
}

beforeAll(() => {
  sqlite = new Database(join(sandbox, "test.db"));
  sqlite.exec("PRAGMA foreign_keys = ON;");
  db = drizzle(sqlite, { schema }) as unknown as LedgerDb;
  migrate(db as never, { migrationsFolder: "drizzle" });

  const bank = account("Spec bank", 1981, AccountType.Asset, AccountSubType.Bank);
  const cash = account("Spec cash", 1982, AccountType.Asset, AccountSubType.Cash);
  const unclassified = account("Spec unclassified", 1983, AccountType.Asset, null);
  const sales = account("Spec sales", 4981, AccountType.Revenue, null);
  const rent = account("Spec rent", 5981, AccountType.Expense, null);
  const oldCost = account("Spec retired cost", 5982, AccountType.Expense, null, true);

  record("2025-12-31", 50_000, bank, sales); // before the window
  record("2026-01-01", 12_345, bank, sales); // first day of a month
  record("2026-01-31", 2_000, rent, bank); // last day of a month
  record("2026-02-28", 700, oldCost, cash); // archived account, month end
  record("2026-02-15", 9_900, cash, sales);
  record("2026-03-10", 4_000, unclassified, bank); // not cash: not counted
  record("2026-03-16", 1_111, rent, cash); // the day after "today" below
});

afterAll(() => {
  sqlite?.close();
  rmSync(sandbox, { recursive: true, force: true });
});

const RANGES = [
  { dateFrom: "2026-01-01", dateTo: "2026-01-31" },
  { dateFrom: "2026-02-01", dateTo: "2026-02-28" },
  { dateFrom: "2026-03-01", dateTo: "2026-03-15" },
  // Ranges may overlap and need not start on the first of a month.
  { dateFrom: "2026-01-15", dateTo: "2026-03-16" },
];

describe("accountTotalsByRanges", () => {
  it("equals accountTotalsBetween for every range", () => {
    const batched = accountTotalsByRanges(db, RANGES);
    expect(batched).toHaveLength(RANGES.length);
    RANGES.forEach((range, i) => {
      expect(batched[i]).toEqual(
        accountTotalsBetween(db, range.dateFrom, range.dateTo),
      );
    });
  });

  it("returns nothing for no ranges", () => {
    expect(accountTotalsByRanges(db, [])).toEqual([]);
  });
});

describe("cashBalancesAsAt", () => {
  const DAYS = ["2025-12-30", "2026-01-31", "2026-02-28", "2026-03-15", "2026-03-16"];

  it("equals the cash flow statement's closing cash on each day", () => {
    const balances = cashBalancesAsAt(db, DAYS);
    DAYS.forEach((day, i) => {
      expect(balances[i]).toBe(cashFlowReport(db, "2026-01-01", day).closingCashMinor);
      expect(balances[i]).toBe(cashOnHandAsAt(db, day));
    });
  });

  it("keeps the order it was given", () => {
    const reversed = [...DAYS].reverse();
    expect(cashBalancesAsAt(db, reversed)).toEqual(
      cashBalancesAsAt(db, DAYS).reverse(),
    );
  });
});
