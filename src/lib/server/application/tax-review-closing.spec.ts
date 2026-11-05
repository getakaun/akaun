import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccountType, AccountSubType, LedgerRecordKind } from "$lib/enums.js";
import { LEAF_PERMISSIONS } from "$lib/permissions/catalog.js";
import * as schema from "../db/schema.js";
import type { LedgerDb } from "../ledger/types.js";
import { localsFor } from "../permissions/test-locals.js";
import { createAccount, patchAccount } from "../services/accounts.js";
import { insertRecord, getRecord } from "../queries/ledger.js";
import {
  expenseTaxReport,
  expenseTaxCsv,
} from "../queries/expense-tax-report.js";
import { closingEvents } from "../closing/events.js";
import { setSetting } from "../settings.js";
import { closeMonth, previewClosing, readClosingStatus } from "./closing.js";
import { updateRecord, voidRecord } from "./records.js";
import { recordVersion } from "./version.js";

let sqlite: Database;
let db: LedgerDb;
let expense: number;
let bank: number;
const ctx = (permissions: string[] = [...LEAF_PERMISSIONS]) => ({
  db,
  locals: localsFor(permissions),
});
function preview(monthEnd = "2024-10-31") {
  const result = previewClosing(ctx(), { monthEnd });
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}
function close() {
  const r = preview();
  return closeMonth(ctx(), { monthEnd: r.monthEnd, revision: r.revision });
}
function line(amountMinor = 10000, date = "2024-10-01") {
  return insertRecord(
    db,
    1,
    {
      kind: LedgerRecordKind.Journal,
      date,
      description: "Tax review fixture",
      amount: Math.abs(amountMinor) / 100,
      currency: "MYR",
      exchangeRate: 1,
    },
    [
      { accountId: expense, amountMinor, sortOrder: 0, label: "Expense" },
      { accountId: bank, amountMinor: -amountMinor, sortOrder: 1, label: null },
    ],
  );
}
function classify(id: number) {
  const result = updateRecord(ctx(), id, {
    taxOverrides: [
      {
        accountId: expense,
        occurrence: 0,
        percentageBps: 10000,
        treatment: "ordinary_deductible",
        reason: "Checked business expense",
      },
    ],
  });
  if (!result.ok) throw new Error(result.reason);
}
function report(reviewOnly = false) {
  return expenseTaxReport(db, "2024-01-01", "2024-10-31", reviewOnly);
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema }) as LedgerDb;
  migrate(db, { migrationsFolder: "drizzle" });
  sqlite.exec("PRAGMA foreign_keys = ON");
  db.insert(schema.users)
    .values({ id: 1, email: "u@test", username: "u", passwordHash: "x" })
    .run();
  const a = createAccount(db, 1, {
    name: "Expense",
    type: AccountType.Expense,
  });
  const b = createAccount(db, 1, {
    name: "Bank",
    type: AccountType.Asset,
    subType: AccountSubType.Bank,
  });
  if (!a.ok || !b.ok) throw new Error("Fixture accounts failed");
  expense = a.value.id;
  bank = b.value.id;
});
afterEach(() => {
  sqlite.close();
  closingEvents.removeAllListeners();
});

describe("mandatory tax review at month close", () => {
  it("blocks two unresolved refund/expense lines even when their amount nets to zero, with no audit/boundary/event changes", () => {
    line();
    line(-10000);
    const r = preview();
    expect(r.integrity.ok).toBe(true);
    expect(r.taxReview).toMatchObject({
      ok: false,
      unresolvedLineCount: 2,
      unresolvedMinor: 0,
    });
    const before = db.select().from(schema.auditLog).all();
    const events: unknown[] = [];
    closingEvents.on("closing-changed", (v) => events.push(v));
    expect(close()).toMatchObject({
      ok: false,
      code: "REFUSED",
      reason: expect.stringContaining("tax review"),
    });
    expect(readClosingStatus(ctx())).toEqual({
      ok: true,
      value: { closedThrough: null },
    });
    expect(db.select().from(schema.auditLog).all()).toEqual(before);
    expect(events).toEqual([]);
    expect(report(true)).toMatchObject({
      unresolvedLineCount: 2,
      expenseMinor: 0,
      deductibleMinor: 0,
    });
  });
  it("lets explicit review be saved without a percentage and keeps tentative historical review values unresolved", () => {
    const a = line();
    const b = line();
    expect(
      updateRecord(ctx(), a.id, {
        taxOverrides: [
          {
            accountId: expense,
            occurrence: 0,
            percentageBps: null,
            treatment: "requires_review",
            reason: "Accountant decision pending",
          },
        ],
      }).ok,
    ).toBe(true);
    expect(
      updateRecord(ctx(), b.id, {
        taxOverrides: [
          {
            accountId: expense,
            occurrence: 0,
            percentageBps: 2500,
            treatment: "requires_review",
            reason: "Tentative business-use percentage",
          },
        ],
      }).ok,
    ).toBe(true);
    expect(
      getRecord(db, a.id)?.movements[0].taxClassification?.percentageBps,
    ).toBeNull();
    expect(report()).toMatchObject({
      unresolvedLineCount: 2,
      deductibleMinor: 0,
      addBackMinor: 0,
    });
    expect(preview().taxReview.unresolvedLineCount).toBe(2);
  });
  it("does not treat changing the account default as reviewing existing lines, but later lines inherit the configured default", () => {
    const old = line();
    expect(
      patchAccount(db, expense, 1, { defaultTaxPercentageBps: 10000 }).ok,
    ).toBe(true);
    line();
    expect(preview().taxReview.unresolvedLineCount).toBe(1);
    expect(preview().taxReview.items[0].ref).toEqual({
      kind: "record",
      id: old.id,
    });
    expect(report(true).rows.map((r) => r.recordId)).toEqual([old.id]);
  });
  it("rejects a stale review after correction, then closes successfully with recorded tax-check evidence", () => {
    const a = line();
    const r = preview();
    classify(a.id);
    expect(
      closeMonth(ctx(), { monthEnd: r.monthEnd, revision: r.revision }),
    ).toMatchObject({ ok: false, code: "CONFLICT" });
    expect(close()).toEqual({
      ok: true,
      value: { closedThrough: "2024-10-31" },
    });
    const audit = db.select().from(schema.auditLog).all().at(-1)!;
    expect(audit.changes).toContain("taxReviewCheck");
    expect(
      previewClosing(ctx(["closing.close"]), { monthEnd: "2024-11-30" }).ok,
    ).toBe(false);
  });
  it("ignores true void pairs but keeps an independent unresolved refund in the queue", () => {
    const original = line();
    expect(
      voidRecord(ctx(), original.id, {
        reason: "Duplicate expense receipt",
        expectedVersion: recordVersion(db, original.id),
      }).ok,
    ).toBe(true);
    expect(preview().taxReview.ok).toBe(true);
    expect(report(true).rows).toEqual([]);
    expect(report().unresolvedLineCount).toBe(0);
    line(-10000);
    expect(preview().taxReview.unresolvedLineCount).toBe(1);
    expect(report(true).rows).toHaveLength(1);
  });
  it("checks all earlier history at first close, excludes future lines and checks only newly protected dates on later closes", () => {
    const old = line(10000, "2024-01-01");
    const now = line();
    line(10000, "2024-11-01");
    expect(preview().taxReview.unresolvedLineCount).toBe(2);
    setSetting(db, "accounting.closedThrough", "2024-09-30");
    expect(preview().taxReview.unresolvedLineCount).toBe(1);
    expect(preview().taxReview.items[0].ref).toEqual({
      kind: "record",
      id: now.id,
    });
    expect(
      preview().taxReview.items.some(
        (i) => i.ref?.kind === "record" && i.ref.id === old.id,
      ),
    ).toBe(false);
  });
  it("rechecks a classification change with no audit event rather than accepting a previously passing preview", () => {
    const a = line();
    classify(a.id);
    const r = preview();
    db.update(schema.ledgerMovements)
      .set({ taxClassification: null })
      .where(eq(schema.ledgerMovements.recordId, a.id))
      .run();
    expect(
      closeMonth(ctx(), { monthEnd: r.monthEnd, revision: r.revision }),
    ).toMatchObject({ ok: false, code: "CONFLICT" });
    expect(close().ok).toBe(false);
  });
  it("keeps report and CSV filtered to actionable unreviewed lines, including historical NULL snapshots", () => {
    const a = line();
    const b = line();
    classify(b.id);
    db.update(schema.ledgerMovements)
      .set({ taxClassification: null })
      .where(eq(schema.ledgerMovements.recordId, a.id))
      .run();
    const r = report(true);
    expect(r.rows.map((row) => row.recordId)).toEqual([a.id]);
    expect(r).toMatchObject({
      reviewOnly: true,
      expenseMinor: 10000,
      unresolvedMinor: 10000,
      unresolvedLineCount: 1,
    });
    expect(expenseTaxCsv(r).rows).toHaveLength(1);
    expect(expenseTaxCsv(r).rows[0].at(-1)).toBe("Yes");
  });
  it("caps preview details while counting every unresolved line", () => {
    for (let n = 0; n < 23; n++) line();
    expect(preview().taxReview).toMatchObject({ unresolvedLineCount: 23 });
    expect(preview().taxReview.items).toHaveLength(20);
  });
  it("refuses unauthorized closes and rolls back a resolved close when its audit fails", () => {
    const a = line();
    classify(a.id);
    const r = preview();
    expect(
      closeMonth(ctx(["reports.read"]), {
        monthEnd: r.monthEnd,
        revision: r.revision,
      }),
    ).toMatchObject({ ok: false, code: "FORBIDDEN" });
    sqlite.exec(
      "CREATE TRIGGER refuse_close_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END",
    );
    expect(() => close()).toThrow();
    expect(readClosingStatus(ctx())).toEqual({
      ok: true,
      value: { closedThrough: null },
    });
  });
});
