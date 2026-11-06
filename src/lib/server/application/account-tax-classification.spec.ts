import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { eq } from "drizzle-orm";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountType, AccountSubType, LedgerRecordKind } from "$lib/enums.js";
import { LEAF_PERMISSIONS } from "$lib/permissions/catalog.js";
import { ACCOUNT_TAX_BATCH_LIMIT } from "$lib/account-tax-classification.js";
import type { ExpenseTaxSnapshot, TaxTreatment } from "$lib/expense-tax.js";
import * as schema from "../db/schema.js";
import type { LedgerDb } from "../ledger/types.js";
import { localsFor } from "../permissions/test-locals.js";
import { createAccount } from "../services/accounts.js";
import { insertRecord, getRecord } from "../queries/ledger.js";
import {
  expenseTaxReport,
  expenseTaxCsv,
} from "../queries/expense-tax-report.js";
import { profitLossReport, balanceSheetReport } from "../queries/reports.js";
import { ledgerEvents, accountEvents } from "../ledger/events.js";
import { auditEvents } from "../audit-events.js";
import { parseChanges } from "../audit.js";
import { scopeFromLocals, runInAuditScope } from "../audit-context.js";
import { setSetting } from "../settings.js";
import { updateAccount } from "./accounts.js";
import { updateRecord, voidRecord } from "./records.js";
import { accountVersion, recordVersion } from "./version.js";
import { previewClosing, closeMonth, reopenMonths } from "./closing.js";
import {
  ACCOUNT_TAX_PERMISSIONS,
  accountTaxOverview,
  previewAccountTaxDefault,
  applyAccountTaxDefault,
} from "./account-tax-classification.js";
import { toResponse } from "./http.js";
import type { AppResult } from "./result.js";

let sqlite: Database;
let db: LedgerDb;
let expense: number;
let bank: number;
const reason = "Apply reviewed account policy to untouched expense entries";
const ctx = (permissions: readonly string[] = LEAF_PERMISSIONS) => ({
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
function tax(id: number) {
  return getRecord(db, id)!
    .movements.filter((m) => m.accountId === expense)
    .map((m) => m.taxClassification);
}
function defaultTo(percentageBps = 10000) {
  return value(
    updateAccount(ctx(), expense, {
      defaultTaxPercentageBps: percentageBps,
      defaultTaxTreatment:
        percentageBps === 10000 ? "ordinary_deductible" : "partial",
    }),
  );
}
function review() {
  return value(previewAccountTaxDefault(ctx(), expense, { reason }));
}
function apply() {
  const p = review();
  return applyAccountTaxDefault(ctx(), expense, {
    reason,
    revision: p.revision,
  });
}
function report() {
  return expenseTaxReport(db, "2026-01-01", "2026-12-31");
}
function books() {
  return {
    pnl: profitLossReport(db, "2026-01-01", "2026-12-31"),
    balance: balanceSheetReport(db, "2026-12-31"),
  };
}
function snapshot() {
  return {
    records: db.select().from(schema.ledgerRecords).all(),
    movements: db.select().from(schema.ledgerMovements).all(),
    accounts: db.select().from(schema.accounts).all(),
    audit: db.select().from(schema.auditLog).all(),
    settings: db.select().from(schema.settings).all(),
    settlements: db.select().from(schema.settlements).all(),
    allocations: db.select().from(schema.reconciliationAllocations).all(),
  };
}
function override(
  id: number,
  treatment: TaxTreatment,
  percentageBps: number | null = null,
) {
  return value(
    updateRecord(ctx(), id, {
      taxOverrides: [
        {
          accountId: expense,
          occurrence: 0,
          treatment,
          percentageBps,
          reason: "Individual choice from supporting evidence",
        },
      ],
    }),
  );
}
beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema }) as LedgerDb;
  migrate(db, { migrationsFolder: "drizzle" });
  sqlite.exec("PRAGMA foreign_keys=ON");
  db.insert(schema.users)
    .values({
      id: 1,
      email: "account-tax@test",
      username: "account-tax",
      passwordHash: "x",
    })
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

describe("account-based application of saved tax defaults", () => {
  it("skips read-only invoice and reimbursement records without preventing other eligible entries", () => {
    const invoice = entry(),
      reimbursement = entry(),
      open = entry();
    db.update(schema.ledgerRecords)
      .set({ kind: LedgerRecordKind.InvoiceIssue })
      .where(eq(schema.ledgerRecords.id, invoice.id))
      .run();
    const group = db
      .insert(schema.reimbursements)
      .values({ payableRecordId: reimbursement.id })
      .returning()
      .get()!;
    db.insert(schema.reimbursementEntries)
      .values({
        groupId: group.id,
        recordId: reimbursement.id,
        role: "supplier",
      })
      .run();
    const protectedBefore = [tax(invoice.id), tax(reimbursement.id)];
    defaultTo();
    expect(review()).toMatchObject({
      selectedCount: 1,
      protected: { readOnly: 2 },
    });
    value(apply());
    expect([tax(invoice.id), tax(reimbursement.id)]).toEqual(protectedBefore);
    expect(tax(open.id)[0]?.percentageBps).toBe(10000);
  });
  it("protects an inherited legacy review hold after an explicit same-value individual choice", () => {
    const record = entry();
    db.update(schema.ledgerMovements)
      .set({
        taxClassification: {
          ...tax(record.id)[0]!,
          treatment: "requires_review",
        },
      })
      .where(eq(schema.ledgerMovements.id, record.movements[0].id))
      .run();
    override(record.id, "requires_review");
    defaultTo();
    expect(tax(record.id)[0]).toMatchObject({
      treatment: "requires_review",
      source: "override",
      provenance: "line_override",
    });
    expect(review()).toMatchObject({
      selectedCount: 0,
      protected: { individual: 1 },
    });
    expect(apply().ok).toBe(false);
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
    defaultTo();
    value(apply());
    expect(getRecord(db, a.id)?.locked).toBe(true);
    expect(getRecord(db, b.id)?.locked).toBe(true);
    expect(snapshot().settlements).toEqual(before.settlements);
    expect(snapshot().allocations).toEqual(before.allocations);
    expect(books()).toEqual(financials);
  });

  it("shows unset accounts and new/NULL historical lines as Unclassified without inventing a percentage", () => {
    const a = entry(),
      b = entry();
    db.update(schema.ledgerMovements)
      .set({ taxClassification: null })
      .where(eq(schema.ledgerMovements.id, b.movements[0].id))
      .run();
    expect(tax(a.id)[0]).toMatchObject({
      treatment: "unclassified",
      percentageBps: null,
      source: "unreviewed",
    });
    expect(tax(b.id)[0]).toBeNull();
    expect(value(accountTaxOverview(ctx(), expense))).toMatchObject({
      eligibleCount: 2,
      hasResolvedDefault: false,
    });
    expect(previewAccountTaxDefault(ctx(), expense, { reason })).toMatchObject({
      ok: false,
      code: "REFUSED",
    });
    expect(report()).toMatchObject({
      unresolvedLineCount: 2,
      deductibleMinor: 0,
      addBackMinor: 0,
    });
    expect(report().rows.every((r) => r.reviewStatus === "unclassified")).toBe(
      true,
    );
    expect(
      expenseTaxCsv(report()).rows.every((r) => r[10] === "Unclassified"),
    ).toBe(true);
  });
  it("saves future defaults separately, applies only after confirmation and preserves captured values on later changes", () => {
    const old = entry();
    const original = tax(old.id);
    const financials = books();
    defaultTo(5000);
    expect(tax(old.id)).toEqual(original);
    const next = entry();
    expect(tax(next.id)[0]?.percentageBps).toBe(5000);
    const before = snapshot();
    const p = review();
    expect(snapshot()).toEqual(before);
    expect(p).toMatchObject({
      selectedCount: 1,
      remainingCount: 0,
      treatment: { percentageBps: 5000, treatment: "partial" },
    });
    value(
      applyAccountTaxDefault(ctx(), expense, { reason, revision: p.revision }),
    );
    expect(tax(old.id)[0]).toMatchObject({
      percentageBps: 5000,
      source: "account_default",
      provenance: "account_default_reset",
      reason,
      classifiedBy: 1,
    });
    const saved = report();
    defaultTo();
    expect(report()).toEqual(saved);
    expect(tax(next.id)[0]?.percentageBps).toBe(5000);
    // Two entries now exist, but classification itself has left each financial posting untouched.
    expect(books().pnl).not.toEqual(financials.pnl);
    expect(
      snapshot().movements.map((row) => ({ ...row, taxClassification: null })),
    ).toEqual(
      before.movements.map((row) => ({ ...row, taxClassification: null })),
    );
  });
  it("protects manual review, manual Unclassified, explicit default resets, resolved values and ambiguous provenance", () => {
    const untouched = entry(),
      historical = entry(),
      inherited = entry(),
      manual = entry(),
      manualUnset = entry(),
      reset = entry(),
      ambiguous = entry(),
      resolved = entry();
    db.update(schema.ledgerMovements)
      .set({ taxClassification: null })
      .where(eq(schema.ledgerMovements.id, historical.movements[0].id))
      .run();
    const inheritedTax = {
      ...tax(inherited.id)[0]!,
      treatment: "requires_review" as const,
    };
    db.update(schema.ledgerMovements)
      .set({ taxClassification: inheritedTax })
      .where(eq(schema.ledgerMovements.id, inherited.movements[0].id))
      .run();
    override(manual.id, "requires_review");
    override(manualUnset.id, "unclassified");
    override(resolved.id, "non_deductible", 0);
    value(
      updateRecord(ctx(), reset.id, {
        taxOverrides: [
          {
            accountId: expense,
            occurrence: 0,
            source: "account_default",
            percentageBps: null,
            treatment: "unclassified",
            reason: "Explicitly leave this entry unresolved",
          },
        ],
      }),
    );
    const ambiguousTax = { ...tax(ambiguous.id)[0]! };
    delete (ambiguousTax as Partial<ExpenseTaxSnapshot>).provenance;
    db.update(schema.ledgerMovements)
      .set({ taxClassification: ambiguousTax })
      .where(eq(schema.ledgerMovements.id, ambiguous.movements[0].id))
      .run();
    const protectedIds = [
      manual.id,
      manualUnset.id,
      reset.id,
      ambiguous.id,
      resolved.id,
    ];
    const before = protectedIds.map(tax);
    defaultTo();
    const p = review();
    expect(p).toMatchObject({
      eligibleCount: 3,
      selectedCount: 3,
      protected: { individual: 3, ambiguous: 1, resolved: 1 },
    });
    value(
      applyAccountTaxDefault(ctx(), expense, { reason, revision: p.revision }),
    );
    expect(protectedIds.map(tax)).toEqual(before);
    expect(
      [untouched, historical, inherited].every(
        (r) => tax(r.id)[0]?.percentageBps === 10000,
      ),
    ).toBe(true);
    expect(report().unresolvedLineCount).toBe(4);
  });
  it("preserves default-captured resolved lines and supports explicit individual correction", () => {
    defaultTo(5000);
    const a = entry();
    defaultTo();
    const b = entry();
    expect(review()).toMatchObject({
      eligibleCount: 0,
      protected: { resolved: 2 },
    });
    expect(apply().ok).toBe(false);
    expect(tax(a.id)[0]?.percentageBps).toBe(5000);
    expect(tax(b.id)[0]?.percentageBps).toBe(10000);
    override(a.id, "partial", 7500);
    expect(tax(a.id)[0]).toMatchObject({
      percentageBps: 7500,
      source: "override",
    });
  });
  it("keeps signed expense/refund totals and line counts visible when they cancel", () => {
    entry();
    entry(-100000);
    defaultTo(5000);
    expect(review()).toMatchObject({
      selectedCount: 2,
      expenseMinor: 100000,
      refundMinor: -100000,
      deductibleMinor: 0,
      addBackMinor: 0,
    });
    value(apply());
    expect(report()).toMatchObject({
      unresolvedLineCount: 0,
      expenseMinor: 0,
      deductibleMinor: 0,
      addBackMinor: 0,
    });
  });
  it("targets the right duplicate-account split even when protected lines have a different display order", () => {
    const row = entry(100000, "2026-01-15", true);
    override(row.id, "requires_review");
    const protectedLine = row.movements[0],
      target = row.movements.find((m) => m.label === "Second")!;
    db.update(schema.ledgerMovements)
      .set({ sortOrder: 3 })
      .where(eq(schema.ledgerMovements.id, protectedLine.id))
      .run();
    defaultTo(7500);
    const before = snapshot(),
      financials = books();
    expect(review().selectedCount).toBe(1);
    value(apply());
    expect(
      db
        .select()
        .from(schema.ledgerMovements)
        .all()
        .find((m) => m.id === protectedLine.id)?.taxClassification,
    ).toEqual(
      before.movements.find((m) => m.id === protectedLine.id)
        ?.taxClassification,
    );
    expect(
      db
        .select()
        .from(schema.ledgerMovements)
        .all()
        .find((m) => m.id === target.id)?.taxClassification?.percentageBps,
    ).toBe(7500);
    expect(books()).toEqual(financials);
    expect(
      snapshot().movements.map((row) => ({ ...row, taxClassification: null })),
    ).toEqual(
      before.movements.map((row) => ({ ...row, taxClassification: null })),
    );
  });
  it.each(["record", "default", "new-entry", "boundary", "reason", "rename"])(
    "rejects the entire stale confirmation: %s",
    (change) => {
      const a = entry();
      entry();
      defaultTo();
      const p = review();
      if (change === "record")
        value(updateRecord(ctx(), a.id, { remark: "Changed" }));
      if (change === "default") defaultTo(5000);
      if (change === "new-entry") {
        const extra = entry();
        db.update(schema.ledgerMovements)
          .set({ taxClassification: null })
          .where(eq(schema.ledgerMovements.id, extra.movements[0].id))
          .run();
      }
      if (change === "boundary")
        setSetting(db, "accounting.closedThrough", "2025-12-31");
      if (change === "rename")
        value(updateAccount(ctx(), expense, { name: "Renamed account" }));
      const before = snapshot();
      expect(
        applyAccountTaxDefault(ctx(), expense, {
          reason: change === "reason" ? "Changed reason" : reason,
          revision: p.revision,
        }),
      ).toMatchObject({ ok: false, code: "CONFLICT" });
      expect(snapshot()).toEqual(before);
    },
  );
  it("preserves closed/voided entries and requires authorised reopening before applying", () => {
    const a = entry(),
      b = entry();
    value(
      voidRecord(ctx(), b.id, {
        reason: "Duplicate receipt",
        expectedVersion: recordVersion(db, b.id),
      }),
    );
    defaultTo();
    setSetting(db, "accounting.closedThrough", "2026-01-31");
    const before = snapshot();
    expect(review()).toMatchObject({
      selectedCount: 0,
      protected: { closed: 1, voided: 2 },
    });
    expect(apply().ok).toBe(false);
    expect(snapshot()).toEqual(before);
    value(
      reopenMonths(ctx(), {
        fromMonth: "2026-01",
        expectedClosedThrough: "2026-01-31",
        reason: "Review January tax classifications with receipts",
      }),
    );
    value(apply());
    expect(tax(a.id)[0]?.percentageBps).toBe(10000);
    expect(report().unresolvedLineCount).toBe(0);
  });
  it("keeps closing blocked for Unclassified and deliberate Requires review after account cleanup", () => {
    const a = entry(),
      b = entry();
    override(b.id, "requires_review");
    defaultTo();
    value(apply());
    const p = value(previewClosing(ctx(), { monthEnd: "2026-01-31" }));
    expect(p.taxReview.unresolvedLineCount).toBe(1);
    expect(
      closeMonth(ctx(), { monthEnd: p.monthEnd, revision: p.revision }),
    ).toMatchObject({ ok: false, code: "REFUSED" });
    override(b.id, "ordinary_deductible", 10000);
    const final = value(previewClosing(ctx(), { monthEnd: "2026-01-31" }));
    value(
      closeMonth(ctx(), { monthEnd: final.monthEnd, revision: final.revision }),
    );
    expect(getRecord(db, a.id)?.periodClosedThrough).toBe("2026-01-31");
  });
  it("groups audit entries per record and retains actor, reason, exact targets and batch ID", () => {
    const a = entry(100000, "2026-01-15", true),
      b = entry();
    defaultTo();
    const p = review();
    const context = ctx();
    const result = value(
      runInAuditScope(
        scopeFromLocals(
          context.locals,
          "POST /api/accounts/:id/tax-classification/apply",
        ),
        () =>
          applyAccountTaxDefault(context, expense, {
            reason,
            revision: p.revision,
          }),
      ),
    );
    const audit = db
      .select()
      .from(schema.auditLog)
      .all()
      .filter((r) => r.recordType === "record");
    expect(audit).toHaveLength(2);
    expect(audit.every((r) => r.userId === 1 && r.via === "session")).toBe(
      true,
    );
    const batch = audit.map(
      (r) =>
        parseChanges(r.changes)?.find((c) => c.field === "taxReviewBatch")
          ?.after,
    );
    expect(batch).toEqual([
      {
        id: result.batchId,
        movementIds: a.movements
          .filter((m) => m.accountId === expense)
          .map((m) => m.id),
      },
      { id: result.batchId, movementIds: [b.movements[0].id] },
    ]);
    expect(audit.every((r) => r.changes?.includes(reason))).toBe(true);
    const before = snapshot();
    expect(
      applyAccountTaxDefault(ctx(), expense, { reason, revision: p.revision }),
    ).toMatchObject({ ok: false, code: "CONFLICT" });
    expect(snapshot()).toEqual(before);
  });
  it("rolls back every record and suppresses all notifications when a later audit fails", async () => {
    entry();
    const last = entry();
    defaultTo();
    await Promise.resolve();
    const p = review();
    const before = snapshot();
    sqlite.exec(
      `CREATE TRIGGER refuse_later_account_cleanup BEFORE INSERT ON audit_log WHEN NEW.record_type='record' AND NEW.record_id='${last.id}' BEGIN SELECT RAISE(ABORT,'audit failed'); END`,
    );
    const seen: string[] = [];
    const record = () => {
        seen.push("record");
      },
      account = () => {
        seen.push("account");
      },
      audit = () => {
        seen.push("audit");
      };
    ledgerEvents.on("record-update", record);
    accountEvents.on("account-update", account);
    auditEvents.on("entry-added", audit);
    try {
      expect(() =>
        applyAccountTaxDefault(ctx(), expense, {
          reason,
          revision: p.revision,
        }),
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
  it("emits success only after every classification and audit has committed", async () => {
    entry();
    entry();
    defaultTo();
    await Promise.resolve();
    let count = 0;
    const listener = () => {
      count++;
      expect(report().unresolvedLineCount).toBe(0);
      expect(
        db
          .select()
          .from(schema.auditLog)
          .all()
          .filter((r) => r.recordType === "record"),
      ).toHaveLength(2);
    };
    ledgerEvents.on("record-update", listener);
    try {
      value(apply());
      expect(count).toBe(2);
    } finally {
      ledgerEvents.off("record-update", listener);
    }
  });
  it("does not turn account-edit permission into permission to change historical records", () => {
    entry();
    const role = ctx(["accounts.read", "accounts.update"]);
    value(updateAccount(role, expense, { defaultTaxPercentageBps: 10000 }));
    expect(previewAccountTaxDefault(role, expense, { reason })).toMatchObject({
      ok: false,
      code: "FORBIDDEN",
    });
    const p = review();
    for (const permission of ACCOUNT_TAX_PERMISSIONS) {
      const restricted = ctx(
        ACCOUNT_TAX_PERMISSIONS.filter((p) => p !== permission),
      );
      expect(accountTaxOverview(restricted, expense)).toMatchObject({
        ok: false,
        code: "FORBIDDEN",
      });
      expect(
        applyAccountTaxDefault(restricted, expense, {
          reason,
          revision: p.revision,
        }),
      ).toMatchObject({ ok: false, code: "FORBIDDEN" });
    }
    // Reports and journal-adjustment permissions are not required for account-based tax-only cleanup.
    value(
      applyAccountTaxDefault(ctx(ACCOUNT_TAX_PERMISSIONS), expense, {
        reason,
        revision: p.revision,
      }),
    );
  });
  it("rejects arbitrary selections/treatments and invalid requests with HTTP errors", async () => {
    entry();
    defaultTo();
    const before = snapshot();
    for (const data of [
      { reason: "" },
      { reason, movementIds: [1] },
      { reason, action: { kind: "treatment", percentageBps: 10000 } },
      { reason, percentageBps: 0 },
    ])
      expect(
        toResponse(previewAccountTaxDefault(ctx(), expense, data)).status,
      ).toBe(400);
    expect(previewAccountTaxDefault(ctx(), bank, { reason })).toMatchObject({
      ok: false,
      code: "REFUSED",
    });
    expect(previewAccountTaxDefault(ctx(), 999, { reason })).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });
    const p = review();
    expect(
      toResponse(
        applyAccountTaxDefault(ctx(), expense, {
          reason,
          revision: p.revision,
          movementIds: [1],
        }),
      ).status,
    ).toBe(400);
    const response = toResponse(
      applyAccountTaxDefault(ctx(), expense, {
        reason,
        revision: "0".repeat(64),
      }),
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("Refresh the confirmation");
    expect(snapshot()).toEqual(before);
  });
  it("keeps account and book scope isolated even when account names match", () => {
    const a = entry();
    const other = createAccount(db, 1, {
      name: "Costs",
      type: AccountType.Expense,
    });
    if (!other.ok) throw Error(other.reason);
    const b = entry();
    db.update(schema.ledgerMovements)
      .set({ accountId: other.value.id })
      .where(eq(schema.ledgerMovements.id, b.movements[0].id))
      .run();
    defaultTo();
    const p = review();
    expect(p.selectedCount).toBe(1);
    value(
      applyAccountTaxDefault(ctx(), expense, { reason, revision: p.revision }),
    );
    expect(tax(a.id)[0]?.percentageBps).toBe(10000);
    expect(
      db
        .select()
        .from(schema.ledgerMovements)
        .all()
        .find((m) => m.id === b.movements[0].id)?.taxClassification
        ?.percentageBps,
    ).toBeNull();
    const sql2 = new Database(":memory:");
    const db2 = drizzle(sql2, { schema }) as LedgerDb;
    migrate(db2, { migrationsFolder: "drizzle" });
    try {
      expect(
        applyAccountTaxDefault({ ...ctx(), db: db2 }, expense, {
          reason,
          revision: p.revision,
        }),
      ).toMatchObject({ ok: false, code: "NOT_FOUND" });
      expect(db2.select().from(schema.ledgerRecords).all()).toEqual([]);
    } finally {
      sql2.close();
    }
  });
  it("uses account versions to refuse a stale default edit without reclassifying any records", () => {
    const a = entry();
    const version = accountVersion(db, expense);
    value(updateAccount(ctx(), expense, { name: "Changed" }));
    const before = snapshot();
    expect(
      updateAccount(
        ctx(),
        expense,
        { defaultTaxPercentageBps: 10000 },
        version,
      ),
    ).toMatchObject({ ok: false, code: "CONFLICT" });
    expect(snapshot()).toEqual(before);
    expect(tax(a.id)[0]?.treatment).toBe("unclassified");
  });
  it("runs large backlogs as explicit next-200 batches with precise line rounding", () => {
    for (let i = 0; i < ACCOUNT_TAX_BATCH_LIMIT + 1; i++) entry(1);
    defaultTo(5000);
    const p = review();
    expect(p).toMatchObject({
      eligibleCount: 201,
      selectedCount: 200,
      remainingCount: 1,
      deductibleMinor: 200,
      addBackMinor: 0,
    });
    expect(
      value(
        applyAccountTaxDefault(ctx(), expense, {
          reason,
          revision: p.revision,
        }),
      ),
    ).toMatchObject({ updatedLineCount: 200, remainingCount: 1 });
    expect(report().unresolvedLineCount).toBe(1);
    expect(review()).toMatchObject({ selectedCount: 1, remainingCount: 0 });
    value(apply());
    expect(report()).toMatchObject({
      deductibleMinor: 201,
      unresolvedLineCount: 0,
    });
  });
  it("handles a stale WAL reader after another connection classifies and closes the month", () => {
    const root = mkdtempSync(join(tmpdir(), "akaun-account-tax-wal-"));
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
      defaultTo();
      const p = review(),
        reader = ctx();
      first
        .transaction(() => {
          expect(getRecord(a, row.id)?.periodClosedThrough).toBeNull();
          db = b;
          value(
            applyAccountTaxDefault(ctx(), expense, {
              reason,
              revision: p.revision,
            }),
          );
          const close = value(
            previewClosing(ctx(), { monthEnd: "2026-01-31" }),
          );
          value(
            closeMonth(ctx(), {
              monthEnd: close.monthEnd,
              revision: close.revision,
            }),
          );
          expect(
            applyAccountTaxDefault(reader, expense, {
              reason,
              revision: p.revision,
            }),
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
    } finally {
      db = memory;
      second.close();
      first.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
