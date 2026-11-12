import { Database } from "bun:sqlite";
import { readdirSync } from "fs";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountRole, AccountSubType, AccountType } from "$lib/enums.js";
import { applyMigrationRange } from "./auto-upgrade.js";
import { applyContraRevenueReclassification } from "./contra-revenue-reclassification.js";
import { accountTotalsBetween } from "../queries/reports.js";
import { profitLoss } from "../ledger/reports/profit-loss.js";
import { nextNumber } from "../running-number.js";
import * as schema from "./schema.js";

// Fail before any configured database can be opened, even through a future import.
vi.mock("./client.js", () => {
  throw new Error("Only fixture databases are allowed");
});
/** The index of the newest migration in `drizzle/`. */
const LATEST =
  readdirSync("drizzle").filter((name) => /^\d{4}_.*\.sql$/.test(name)).length -
  1;

let raw: Database;
afterEach(() => raw?.close());
function fixture() {
  raw = new Database(":memory:");
  // Every migration: client.ts runs this repair after `migrate`, and the
  // fixture below inserts through the current schema. A fixed upper bound went
  // stale when 0041+ added columns to `accounts`, so read it from `drizzle/`.
  applyMigrationRange(raw, 0, LATEST);
  const db = drizzle(raw, { schema });
  for (const [id, name, type, role, subType] of [
    [
      36,
      "Shopee Clearing",
      AccountType.Asset,
      AccountRole.Bank,
      AccountSubType.Bank,
    ],
    [
      39,
      "Contra Revenue",
      AccountType.Revenue,
      AccountRole.IncomeCategory,
      AccountSubType.ContraOperatingRevenue,
    ],
    [
      40,
      "Sales",
      AccountType.Revenue,
      AccountRole.IncomeCategory,
      AccountSubType.OperatingRevenue,
    ],
    [
      41,
      "Expense",
      AccountType.Expense,
      AccountRole.ExpenseCategory,
      AccountSubType.OperatingExpense,
    ],
    [
      42,
      "Other Contra",
      AccountType.Revenue,
      AccountRole.IncomeCategory,
      AccountSubType.ContraOtherRevenue,
    ],
  ] as const)
    db.insert(schema.accounts)
      .values({
        id,
        name,
        type,
        role,
        subType,
        code: id + 4000,
        rank: String(id),
      })
      .run();
  function record(id: number, category = 39, date = "2026-01-31") {
    db.insert(schema.ledgerRecords)
      .values({
        id,
        kind: 2,
        date,
        recordNumber: `IN${date.replaceAll("-", "")}-${String(id - 640).padStart(3, "0")}`,
        amount: 10,
        currency: "MYR",
        description: "Test",
        remark: "Keep this",
      })
      .run();
    db.insert(schema.ledgerMovements)
      .values([
        {
          recordId: id,
          accountId: 36,
          amountMinor: category === 40 ? 1000 : -1000,
          sortOrder: 0,
        },
        {
          recordId: id,
          accountId: category,
          amountMinor: category === 40 ? -1000 : 1000,
          sortOrder: 1,
        },
      ])
      .run();
  }
  record(642);
  record(643, 40);
  record(644, 41); // unrelated misclassification must remain income
  db.insert(schema.appSequences)
    .values([
      {
        documentType: schema.SEQUENCE_DOCUMENT_TYPE.expense,
        bucketKey: "EX20260131-",
        lastSequence: 7,
      },
      {
        documentType: schema.SEQUENCE_DOCUMENT_TYPE.income,
        bucketKey: "IN20260131-",
        lastSequence: 20,
      },
    ])
    .run();
  return { db, record, log: { warn: vi.fn() } };
}
const row = (id: number) =>
  raw.query("SELECT * FROM ledger_records WHERE id = ?").get(id) as Record<
    string,
    unknown
  >;
const snapshot = () => ({
  records: raw.query("SELECT * FROM ledger_records").all(),
  lines: raw.query("SELECT * FROM ledger_movements").all(),
  sequences: raw.query("SELECT * FROM app_sequences").all(),
  audit: raw.query("SELECT * FROM audit_log").all(),
  search: raw.query("SELECT * FROM record_search_text").all(),
});

describe("contra revenue startup reclassification", () => {
  it("repairs #642 with the next expense number and system audit, preserving amounts, lines, IN counter and P&L; rerun is a no-op", () => {
    const { db, log } = fixture();
    const before = snapshot();
    const report = () =>
      profitLoss({
        dateFrom: "2026-01-01",
        dateTo: "2026-01-31",
        totals: accountTotalsBetween(db, "2026-01-01", "2026-01-31"),
      });
    const pnl = report();
    expect(applyContraRevenueReclassification(raw, log)).toBe(1);
    expect(row(642)).toMatchObject({
      kind: 1,
      record_number: "EX20260131-008",
      amount: 10,
      remark:
        "Keep this\ncontra-revenue reclassification: previous number IN20260131-002",
    });
    expect(snapshot().lines).toEqual(before.lines);
    expect(row(643)).toEqual(before.records[1]);
    expect(row(644)).toEqual(before.records[2]);
    expect(report()).toEqual(pnl);
    const audit = raw.query("SELECT * FROM audit_log").get() as {
      via: string;
      operation: string;
      changes: string;
    };
    expect(audit).toMatchObject({
      via: "system",
      operation: "contra-revenue reclassification",
    });
    expect(JSON.parse(audit.changes)).toEqual(
      expect.arrayContaining([
        { field: "kind", before: "income", after: "expense" },
        {
          field: "recordNumber",
          before: "IN20260131-002",
          after: "EX20260131-008",
        },
        {
          field: "reason",
          before: null,
          after: "contra-revenue reclassification",
        },
      ]),
    );
    const once = snapshot();
    expect(applyContraRevenueReclassification(raw, log)).toBe(0);
    expect(snapshot()).toEqual(once);
    expect(nextNumber(db, "income", "2026-01-31")).toBe("IN20260131-021");
  });

  it("skips and logs settled and reconciled records without allocating numbers", () => {
    const { db, record, log } = fixture();
    record(645);
    const movements = db.select().from(schema.ledgerMovements).all();
    const money = (id: number) =>
      movements.find((m) => m.recordId === id && m.accountId === 36)!.id;
    db.insert(schema.settlements)
      .values({
        owedMovementId: money(642),
        paymentMovementId: money(645),
        amountMinor: 1000,
      })
      .run();
    db.insert(schema.bankStatements)
      .values({
        id: 1,
        accountId: 36,
        originalFilename: "fixture.csv",
        storedFilePath: "fixture.csv",
      })
      .run();
    db.insert(schema.bankStatementLines)
      .values({
        id: 1,
        statementId: 1,
        date: "2026-01-31",
        amount: 10,
        direction: 2,
      })
      .run();
    db.insert(schema.reconciliationAllocations)
      .values({
        lineId: 1,
        movementId: money(645),
        amount: 10,
        itemAmountSnapshot: 10,
      })
      .run();
    const before = snapshot();
    expect(applyContraRevenueReclassification(raw, log)).toBe(0);
    expect(snapshot()).toEqual(before);
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ recordId: 642, settled: true }),
      expect.stringContaining("Skipped locked record"),
    );
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ recordId: 645, reconciled: true }),
      expect.stringContaining("Skipped locked record"),
    );
  });

  it("uses each record's date bucket and supports other contra revenue", () => {
    const { record, log } = fixture();
    record(645, 42, "2026-02-01");
    expect(applyContraRevenueReclassification(raw, log)).toBe(2);
    expect(row(645).record_number).toBe("EX20260201-001");
  });

  it("rolls back the whole repair including numbers if audit insertion fails", () => {
    const { log } = fixture();
    const before = snapshot();
    raw.exec(
      "CREATE TRIGGER reject_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'fixture audit failure'); END",
    );
    expect(() => applyContraRevenueReclassification(raw, log)).toThrow(
      "fixture audit failure",
    );
    expect(snapshot()).toEqual(before);
  });
});
