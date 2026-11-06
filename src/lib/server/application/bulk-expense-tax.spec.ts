import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { eq } from "drizzle-orm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { AccountSubType, AccountType, LedgerRecordKind } from "$lib/enums.js";
import { LEAF_PERMISSIONS } from "$lib/permissions/catalog.js";
import { type BulkTaxInput, BULK_TAX_LIMIT } from "$lib/bulk-expense-tax.js";
import * as schema from "../db/schema.js";
import type { LedgerDb } from "../ledger/types.js";
import { localsFor } from "../permissions/test-locals.js";
import { createAccount, patchAccount } from "../services/accounts.js";
import { getRecord, insertRecord } from "../queries/ledger.js";
import {
  expenseTaxReport,
  expenseTaxCsv,
} from "../queries/expense-tax-report.js";
import { balanceSheetReport, profitLossReport } from "../queries/reports.js";
import { ledgerEvents, accountEvents } from "../ledger/events.js";
import { auditEvents } from "../audit-events.js";
import { parseChanges } from "../audit.js";
import { scopeFromLocals, runInAuditScope } from "../audit-context.js";
import { setSetting } from "../settings.js";
import { applyBulkTax, previewBulkTax } from "./bulk-expense-tax.js";
import { previewClosing, closeMonth, reopenMonths } from "./closing.js";
import { updateRecord, voidRecord } from "./records.js";
import { recordVersion } from "./version.js";
import { type AppResult } from "./result.js";
import { toResponse } from "./http.js";

let sqlite: Database;
let db: LedgerDb;
let expense: number;
let bank: number;
const ctx = (permissions: string[] = [...LEAF_PERMISSIONS]) => ({
  db,
  locals: localsFor(permissions, { userId: 1 }),
});
function value<T>(result: AppResult<T>): T {
  if (!result.ok) throw Error(result.reason);
  return result.value;
}
function entry(amountMinor = 100000, date = "2026-01-15", split = false) {
  const row = insertRecord(
    db,
    1,
    {
      kind: LedgerRecordKind.Journal,
      date,
      description: "Receipt",
      amount: Math.abs(amountMinor) / 100,
      currency: "MYR",
      exchangeRate: 1,
    },
    [
      { accountId: expense, amountMinor, sortOrder: 0, label: "First" },
      {
        accountId: bank,
        amountMinor: split ? -amountMinor * 2 : -amountMinor,
        sortOrder: 1,
        label: null,
      },
      ...(split
        ? [{ accountId: expense, amountMinor, sortOrder: 2, label: "Second" }]
        : []),
    ],
  );
  return getRecord(db, row.id)!;
}
function input(
  ids: number[],
  action: BulkTaxInput["action"] = {
    kind: "treatment",
    treatment: "ordinary_deductible",
    percentageBps: 10000,
  },
): BulkTaxInput {
  return {
    dateFrom: "2026-01-01",
    dateTo: "2026-01-31",
    accountId: null,
    movementIds: ids,
    action,
    reason: "Reviewed business receipts as a batch",
  };
}
function movement(row: ReturnType<typeof entry>, occurrence = 0) {
  return row.movements.filter((m) => m.accountId === expense)[occurrence].id;
}
function apply(data: BulkTaxInput) {
  const p = value(previewBulkTax(ctx(), data));
  return applyBulkTax(ctx(), { ...data, revision: p.revision });
}
function snapshot() {
  return {
    records: db.select().from(schema.ledgerRecords).all(),
    movements: db.select().from(schema.ledgerMovements).all(),
    audit: db.select().from(schema.auditLog).all(),
    settings: db.select().from(schema.settings).all(),
    allocations: db.select().from(schema.reconciliationAllocations).all(),
    settlements: db.select().from(schema.settlements).all(),
  };
}
function report() {
  return expenseTaxReport(db, "2026-01-01", "2026-01-31");
}
function books() {
  return {
    pnl: profitLossReport(db, "2026-01-01", "2026-01-31"),
    balance: balanceSheetReport(db, "2026-01-31"),
  };
}
beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema }) as LedgerDb;
  migrate(db, { migrationsFolder: "drizzle" });
  sqlite.exec("PRAGMA foreign_keys=ON");
  db.insert(schema.users)
    .values({ id: 1, email: "bulk@test", username: "bulk", passwordHash: "x" })
    .run();
  const a = createAccount(db, 1, { name: "Costs", type: AccountType.Expense });
  const b = createAccount(db, 1, {
    name: "Bank",
    type: AccountType.Asset,
    subType: AccountSubType.Bank,
  });
  if (!a.ok || !b.ok) throw Error("Fixture failed");
  expense = a.value.id;
  bank = b.value.id;
});
afterEach(() => sqlite.close());

describe("reviewed bulk expense tax classification", () => {
  it("returns actionable HTTP validation, permission and stale-preview refusals", async () => {
    const row = entry();
    const data = input([movement(row)]);
    const p = value(previewBulkTax(ctx(), data));
    expect(
      toResponse(previewBulkTax(ctx(), { ...data, reason: "" })).status,
    ).toBe(400);
    expect(
      toResponse(
        applyBulkTax(ctx(["reports.read", "records.read"]), {
          ...data,
          revision: p.revision,
        }),
      ).status,
    ).toBe(403);
    value(updateRecord(ctx(), row.id, { remark: "Changed" }));
    const response = toResponse(
      applyBulkTax(ctx(), { ...data, revision: p.revision }),
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("Refresh the preview");
  });
  it("previews historical NULL lines without writes and keeps signed refunds and zero-net counts visible", () => {
    const a = entry(),
      b = entry(-100000);
    db.update(schema.ledgerMovements)
      .set({ taxClassification: null })
      .where(eq(schema.ledgerMovements.accountId, expense))
      .run();
    const before = snapshot();
    const p = value(previewBulkTax(ctx(), input([movement(a), movement(b)])));
    expect(snapshot()).toEqual(before);
    expect(p).toMatchObject({
      eligibleLineCount: 2,
      recordCount: 2,
      expenseMinor: 100000,
      refundMinor: -100000,
      deductibleMinor: 0,
      addBackMinor: 0,
      unresolvedBefore: 2,
      unresolvedAfter: 0,
    });
    expect(
      p.lines.every(
        (l) => l.before === null && l.after?.percentageBps === 10000,
      ),
    ).toBe(true);
  });
  it("classifies by stable movement ID, preserves every unselected split and the financial statements", () => {
    const row = entry(100000, "2026-01-15", true);
    const before = books();
    const original = getRecord(db, row.id)!;
    value(
      apply(
        input([movement(row, 1)], {
          kind: "treatment",
          treatment: "partial",
          percentageBps: 5000,
        }),
      ),
    );
    const after = getRecord(db, row.id)!;
    expect(
      after.movements.find((m) => m.id === movement(row))?.taxClassification,
    ).toEqual(
      original.movements.find((m) => m.id === movement(row))?.taxClassification,
    );
    expect(
      after.movements.find((m) => m.id === movement(row, 1))?.taxClassification,
    ).toMatchObject({
      percentageBps: 5000,
      source: "override",
      classifiedBy: 1,
      provenance: "line_override",
    });
    expect(
      after.movements.map(({ id, accountId, amountMinor, label }) => ({
        id,
        accountId,
        amountMinor,
        label,
      })),
    ).toEqual(
      original.movements.map(({ id, accountId, amountMinor, label }) => ({
        id,
        accountId,
        amountMinor,
        label,
      })),
    );
    expect(books()).toEqual(before);
  });
  it("adopts account defaults explicitly and leaves unresolved defaults and existing resolved overrides untouched", () => {
    const a = entry(),
      b = entry();
    value(
      updateRecord(ctx(), b.id, {
        taxOverrides: [
          {
            accountId: expense,
            occurrence: 0,
            treatment: "non_deductible",
            percentageBps: 0,
            reason: "Personal portion",
          },
        ],
      }),
    );
    expect(
      value(
        previewBulkTax(
          ctx(),
          input([movement(a)], { kind: "account-default" }),
        ),
      ).eligibleLineCount,
    ).toBe(0);
    const changed = patchAccount(db, expense, 1, {
      defaultTaxPercentageBps: 5000,
    });
    expect(changed.ok).toBe(true);
    const data = input([movement(a), movement(b)], { kind: "account-default" });
    const p = value(previewBulkTax(ctx(), data));
    expect(p).toMatchObject({ eligibleLineCount: 1, skippedLineCount: 1 });
    value(applyBulkTax(ctx(), { ...data, revision: p.revision }));
    expect(
      getRecord(db, a.id)?.movements.find((m) => m.id === movement(a))
        ?.taxClassification,
    ).toMatchObject({
      source: "account_default",
      percentageBps: 5000,
      provenance: "account_default_reset",
    });
    expect(
      getRecord(db, b.id)?.movements.find((m) => m.id === movement(b))
        ?.taxClassification,
    ).toMatchObject({
      source: "override",
      percentageBps: 0,
      reason: "Personal portion",
    });
  });
  it("allows explicitly selected Requires-review overrides to be resolved with their old evidence retained", () => {
    const row = entry();
    value(
      updateRecord(ctx(), row.id, {
        taxOverrides: [
          {
            accountId: expense,
            occurrence: 0,
            treatment: "requires_review",
            percentageBps: null,
            reason: "Waiting for receipts",
          },
        ],
      }),
    );
    value(apply(input([movement(row)])));
    const audit = db
      .select()
      .from(schema.auditLog)
      .all()
      .filter(
        (a) => a.recordType === "record" && a.recordId === String(row.id),
      );
    expect(JSON.stringify(audit)).toContain("Waiting for receipts");
    expect(report().unresolvedLineCount).toBe(0);
  });
  it("retains the close blocker until all unresolved lines are classified, then permits closing", () => {
    const a = entry(),
      b = entry();
    const first = value(previewClosing(ctx(), { monthEnd: "2026-01-31" }));
    expect(
      closeMonth(ctx(), { monthEnd: first.monthEnd, revision: first.revision }),
    ).toMatchObject({ ok: false, code: "REFUSED" });
    value(apply(input([movement(a)])));
    expect(
      value(previewClosing(ctx(), { monthEnd: "2026-01-31" })).taxReview
        .unresolvedLineCount,
    ).toBe(1);
    value(apply(input([movement(b)])));
    const last = value(previewClosing(ctx(), { monthEnd: "2026-01-31" }));
    expect(
      closeMonth(ctx(), { monthEnd: last.monthEnd, revision: last.revision }),
    ).toMatchObject({ ok: true });
  });
  it.each(["record", "default", "close", "selection", "reason"])(
    "refuses a stale or altered preview atomically: %s",
    (change) => {
      const a = entry(),
        b = entry();
      const data = input([movement(a), movement(b)], {
        kind: "account-default",
      });
      expect(
        patchAccount(db, expense, 1, { defaultTaxPercentageBps: 5000 }).ok,
      ).toBe(true);
      const p = value(previewBulkTax(ctx(), data));
      if (change === "record")
        value(updateRecord(ctx(), b.id, { remark: "Changed after preview" }));
      if (change === "default")
        expect(
          patchAccount(db, expense, 1, { defaultTaxPercentageBps: 10000 }).ok,
        ).toBe(true);
      if (change === "close")
        setSetting(db, "accounting.closedThrough", "2026-01-31");
      const before = snapshot();
      const changed = {
        ...data,
        ...(change === "selection" ? { movementIds: [movement(a)] } : {}),
        ...(change === "reason" ? { reason: "Different reason" } : {}),
      };
      expect(
        applyBulkTax(ctx(), { ...changed, revision: p.revision }),
      ).toMatchObject({ ok: false, code: "CONFLICT" });
      expect(snapshot()).toEqual(before);
    },
  );
  it("shows closed, voided and already-classified lines as excluded and requires reopening before a closed source changes", () => {
    const a = entry(),
      b = entry();
    value(
      voidRecord(ctx(), b.id, {
        reason: "Duplicate receipt",
        expectedVersion: recordVersion(db, b.id),
      }),
    );
    setSetting(db, "accounting.closedThrough", "2026-01-31");
    const data = input([movement(a), movement(b)]);
    const before = snapshot();
    const p = value(previewBulkTax(ctx(), data));
    expect(p.eligibleLineCount).toBe(0);
    expect(
      applyBulkTax(ctx(), { ...data, revision: p.revision }),
    ).toMatchObject({ ok: false, code: "REFUSED" });
    expect(snapshot()).toEqual(before);
    value(
      reopenMonths(ctx(), {
        fromMonth: "2026-01",
        expectedClosedThrough: "2026-01-31",
        reason: "Review historic classifications with original receipts",
      }),
    );
    const refreshed = value(previewBulkTax(ctx(), data));
    expect(refreshed).toMatchObject({
      eligibleLineCount: 1,
      skippedLineCount: 1,
    });
    value(applyBulkTax(ctx(), { ...data, revision: refreshed.revision }));
    expect(report().unresolvedLineCount).toBe(0);
  });
  it("groups line changes into one audited update per record and rejects duplicate apply", () => {
    const a = entry(100000, "2026-01-15", true),
      b = entry();
    const data = input([movement(a), movement(a, 1), movement(b)]);
    const p = value(previewBulkTax(ctx(), data));
    const context = ctx();
    const result = value(
      runInAuditScope(
        scopeFromLocals(
          context.locals,
          "POST /api/records/tax-classification/apply",
        ),
        () => applyBulkTax(context, { ...data, revision: p.revision }),
      ),
    );
    const audits = db
      .select()
      .from(schema.auditLog)
      .all()
      .filter((a) => a.recordType === "record");
    expect(audits).toHaveLength(2);
    expect(audits.every((a) => a.via === "session" && a.userId === 1)).toBe(
      true,
    );
    expect(
      audits.map(
        (a) =>
          parseChanges(a.changes)?.find((c) => c.field === "taxReviewBatch")
            ?.after,
      ),
    ).toEqual([
      { id: result.batchId, movementIds: [movement(a), movement(a, 1)] },
      { id: result.batchId, movementIds: [movement(b)] },
    ]);
    const saved = snapshot();
    expect(
      applyBulkTax(context, { ...data, revision: p.revision }),
    ).toMatchObject({ ok: false, code: "CONFLICT" });
    expect(snapshot()).toEqual(saved);
  });
  it("rolls back earlier records and emits no record/account/audit success events if a later audit fails", async () => {
    const a = entry(),
      b = entry();
    await Promise.resolve();
    const data = input([movement(a), movement(b)]);
    const p = value(previewBulkTax(ctx(), data));
    const before = snapshot();
    sqlite.exec(
      `CREATE TRIGGER fail_second_bulk_audit BEFORE INSERT ON audit_log WHEN NEW.record_type='record' AND NEW.record_id='${b.id}' BEGIN SELECT RAISE(ABORT,'audit failed'); END`,
    );
    const seen: string[] = [];
    const record = () => {
      seen.push("record");
    };
    const account = () => {
      seen.push("account");
    };
    const audit = () => {
      seen.push("audit");
    };
    ledgerEvents.on("record-update", record);
    accountEvents.on("account-update", account);
    auditEvents.on("entry-added", audit);
    try {
      expect(() =>
        applyBulkTax(ctx(), { ...data, revision: p.revision }),
      ).toThrow();
      await Promise.resolve();
      expect(snapshot()).toEqual(before);
      expect(seen).toEqual([]);
    } finally {
      ledgerEvents.off("record-update", record);
      accountEvents.off("account-update", account);
      auditEvents.off("entry-added", audit);
    }
  });
  it("publishes events only once the entire batch and all audit rows are committed", async () => {
    const a = entry(),
      b = entry();
    await Promise.resolve();
    let seen = 0;
    const listener = () => {
      seen++;
      expect(report().unresolvedLineCount).toBe(0);
      expect(
        db
          .select()
          .from(schema.auditLog)
          .all()
          .filter((a) => a.recordType === "record"),
      ).toHaveLength(2);
    };
    ledgerEvents.on("record-update", listener);
    try {
      value(apply(input([movement(a), movement(b)])));
      expect(seen).toBe(2);
    } finally {
      ledgerEvents.off("record-update", listener);
    }
  });
  it("enforces permissions, valid dates, unique bounded selections and resolved treatments", () => {
    const row = entry();
    const data = input([movement(row)]);
    const before = snapshot();
    for (const missing of ["records.read", "records.update", "reports.read"])
      expect(
        previewBulkTax(
          ctx(LEAF_PERMISSIONS.filter((p) => p !== missing)),
          data,
        ),
      ).toMatchObject({ ok: false, code: "FORBIDDEN" });
    for (const changed of [
      { ...data, movementIds: [] },
      { ...data, movementIds: [movement(row), movement(row)] },
      {
        ...data,
        movementIds: Array.from(
          { length: BULK_TAX_LIMIT + 1 },
          (_, i) => i + 1,
        ),
      },
      { ...data, reason: "" },
      { ...data, dateFrom: "2026-02-30" },
      {
        ...data,
        action: {
          kind: "treatment",
          treatment: "requires_review",
          percentageBps: null,
        },
      },
      {
        ...data,
        action: {
          kind: "treatment",
          treatment: "partial",
          percentageBps: 10000,
        },
      },
      { ...data, amount: 500 },
    ])
      expect(previewBulkTax(ctx(), changed).ok).toBe(false);
    expect(
      previewBulkTax(
        ctx(),
        input([row.movements.find((m) => m.accountId === bank)!.id]),
      ),
    ).toMatchObject({ ok: false, code: "REFUSED" });
    expect(snapshot()).toEqual(before);
  });
  it("never selects outside the requested date/account scope or another injected book", () => {
    const row = entry();
    const data = input([movement(row)]);
    const p = value(previewBulkTax(ctx(), data));
    expect(
      previewBulkTax(ctx(), { ...data, dateFrom: "2026-01-16" }),
    ).toMatchObject({ ok: false, code: "REFUSED" });
    expect(previewBulkTax(ctx(), { ...data, accountId: bank })).toMatchObject({
      ok: false,
      code: "REFUSED",
    });
    const otherSqlite = new Database(":memory:");
    const other = drizzle(otherSqlite, { schema }) as LedgerDb;
    migrate(other, { migrationsFolder: "drizzle" });
    try {
      expect(
        applyBulkTax(
          { ...ctx(), db: other },
          { ...data, revision: p.revision },
        ),
      ).toMatchObject({ ok: false, code: "CONFLICT" });
      expect(other.select().from(schema.ledgerRecords).all()).toEqual([]);
    } finally {
      otherSqlite.close();
    }
  });
  it("filters report, CSV and remaining review counts by account ID even when names are identical", () => {
    const a = entry();
    const other = createAccount(db, 1, {
      name: "Costs",
      type: AccountType.Expense,
    });
    if (!other.ok) throw Error(other.reason);
    const b = entry();
    db.update(schema.ledgerMovements)
      .set({ accountId: other.value.id })
      .where(eq(schema.ledgerMovements.id, movement(b)))
      .run();
    const p = value(
      previewBulkTax(ctx(), { ...input([movement(a)]), accountId: expense }),
    );
    expect(p).toMatchObject({ unresolvedBefore: 1, unresolvedAfter: 0 });
    const filtered = expenseTaxReport(
      db,
      "2026-01-01",
      "2026-01-31",
      true,
      expense,
    );
    expect(filtered.rows.map((r) => r.recordId)).toEqual([a.id]);
    expect(expenseTaxCsv(filtered).rows).toHaveLength(1);
  });

  it("classifies open paid and reconciled expenses while preserving their allocations", () => {
    const payable = createAccount(db, 1, {
      name: "Payable",
      type: AccountType.Liability,
      subType: AccountSubType.AccountsPayable,
    });
    if (!payable.ok) throw Error(payable.reason);
    const supplier = db
      .insert(schema.contacts)
      .values({ legalName: "Supplier", entityType: 2 })
      .returning()
      .get()!;
    const purchase = insertRecord(
      db,
      1,
      {
        kind: LedgerRecordKind.Expense,
        date: "2026-01-15",
        description: "Unpaid purchase",
        amount: 1000,
        currency: "MYR",
        exchangeRate: 1,
        contactId: supplier.id,
        supplierContactId: supplier.id,
        expensePaymentSource: "unpaid",
      },
      [
        { accountId: expense, amountMinor: 100000, sortOrder: 0, label: null },
        {
          accountId: payable.value.id,
          amountMinor: -100000,
          sortOrder: 1,
          label: null,
        },
      ],
    );
    const payment = insertRecord(
      db,
      1,
      {
        kind: LedgerRecordKind.Payment,
        date: "2026-01-20",
        description: "Paid supplier",
        amount: 1000,
        currency: "MYR",
        exchangeRate: 1,
        contactId: supplier.id,
      },
      [
        {
          accountId: payable.value.id,
          amountMinor: 100000,
          sortOrder: 0,
          label: null,
        },
        { accountId: bank, amountMinor: -100000, sortOrder: 1, label: null },
      ],
    );
    const a = getRecord(db, purchase.id)!,
      paid = getRecord(db, payment.id)!;
    db.insert(schema.settlements)
      .values({
        paymentMovementId: paid.movements.find(
          (m) => m.accountId === payable.value.id,
        )!.id,
        owedMovementId: a.movements.find(
          (m) => m.accountId === payable.value.id,
        )!.id,
        amountMinor: 100000,
        createdBy: 1,
      })
      .run();
    const b = entry();
    const statement = db
      .insert(schema.bankStatements)
      .values({
        accountId: bank,
        originalFilename: "fixture.csv",
        storedFilePath: "fixture.csv",
      })
      .returning()
      .get()!;
    const statementLine = db
      .insert(schema.bankStatementLines)
      .values({
        statementId: statement.id,
        date: "2026-01-15",
        amount: 1000,
        direction: 2,
      })
      .returning()
      .get()!;
    db.insert(schema.reconciliationAllocations)
      .values({
        lineId: statementLine.id,
        movementId: b.movements.find((m) => m.accountId === bank)!.id,
        amount: 1000,
        itemAmountSnapshot: 1000,
        createdBy: 1,
      })
      .run();
    expect(getRecord(db, a.id)?.locked).toBe(true);
    expect(getRecord(db, b.id)?.locked).toBe(true);
    const before = snapshot(),
      financials = books();
    value(apply(input([movement(a), movement(b)])));
    expect(getRecord(db, a.id)?.locked).toBe(true);
    expect(getRecord(db, b.id)?.locked).toBe(true);
    expect(snapshot().settlements).toEqual(before.settlements);
    expect(snapshot().allocations).toEqual(before.allocations);
    expect(books()).toEqual(financials);
  });

  it("accepts the full 200-line batch with precise per-line rounding", () => {
    const records = Array.from({ length: BULK_TAX_LIMIT }, () => entry(1));
    const data = input(
      records.map((r) => movement(r)),
      { kind: "treatment", treatment: "partial", percentageBps: 5000 },
    );
    const p = value(previewBulkTax(ctx(), data));
    expect(p).toMatchObject({
      eligibleLineCount: 200,
      recordCount: 200,
      expenseMinor: 200,
      deductibleMinor: 200,
      addBackMinor: 0,
      unresolvedAfter: 0,
    });
    expect(
      value(applyBulkTax(ctx(), { ...data, revision: p.revision })),
    ).toMatchObject({ updatedLineCount: 200, updatedRecordCount: 200 });
    expect(report()).toMatchObject({
      expenseMinor: 200,
      deductibleMinor: 200,
      addBackMinor: 0,
      unresolvedLineCount: 0,
    });
  });

  it("refuses a stale WAL reader after another connection classifies and closes the period", () => {
    const root = mkdtempSync(join(tmpdir(), "akaun-bulk-wal-"));
    const first = new Database(join(root, "book.db"));
    first.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=0");
    const a = drizzle(first, { schema }) as LedgerDb;
    migrate(a, { migrationsFolder: "drizzle" });
    a.insert(schema.users).values(db.select().from(schema.users).all()).run();
    a.insert(schema.accounts)
      .values(db.select().from(schema.accounts).all())
      .run();
    const second = new Database(join(root, "book.db"));
    second.exec("PRAGMA busy_timeout=0");
    const b = drizzle(second, { schema }) as LedgerDb;
    const memory = db;
    try {
      db = a;
      const row = entry();
      const data = input([movement(row)]);
      const p = value(previewBulkTax(ctx(), data));
      const reader = ctx();
      first
        .transaction(() => {
          expect(getRecord(a, row.id)?.periodClosedThrough).toBeNull();
          db = b;
          value(applyBulkTax(ctx(), { ...data, revision: p.revision }));
          const closing = value(
            previewClosing(ctx(), { monthEnd: "2026-01-31" }),
          );
          value(
            closeMonth(ctx(), {
              monthEnd: closing.monthEnd,
              revision: closing.revision,
            }),
          );
          expect(
            applyBulkTax(reader, { ...data, revision: p.revision }),
          ).toMatchObject({ ok: false, code: "CONFLICT" });
        })
        .deferred();
      expect(getRecord(a, row.id)?.periodClosedThrough).toBe("2026-01-31");
      expect(
        a
          .select()
          .from(schema.auditLog)
          .all()
          .filter((r) => r.recordType === "record"),
      ).toHaveLength(1);
      expect(
        applyBulkTax(reader, { ...data, revision: p.revision }),
      ).toMatchObject({ ok: false, code: "CONFLICT" });
    } finally {
      db = memory;
      second.close();
      first.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
