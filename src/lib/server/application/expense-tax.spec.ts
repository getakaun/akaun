import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AccountSubType,
  AccountType,
  DefaultAccountPurpose,
} from "$lib/enums.js";
import type { TaxOverride } from "$lib/expense-tax.js";
import * as schema from "../db/schema.js";
import {
  accountDefaults,
  auditLog,
  ledgerMovements,
  users,
} from "../db/schema.js";
import { createRecord as createRecordService } from "../services/ledger.js";
import { createAccount, patchAccount } from "../services/accounts.js";
import { getAccount } from "../queries/accounts.js";
import {
  getRecord,
  insertRecord,
  updateRecord as queryUpdate,
} from "../queries/ledger.js";
import {
  expenseTaxCsv,
  expenseTaxReport,
} from "../queries/expense-tax-report.js";
import { accountTotalsBetween } from "../queries/reports.js";
import { localsFor } from "../permissions/test-locals.js";
import { setSetting, SETTING_KEYS } from "../settings.js";
import type { LedgerDb, RecordView } from "../ledger/types.js";
import type { AppResult } from "./result.js";
import { createRecord, updateRecord, voidRecord } from "./records.js";
import { updateAccount } from "./accounts.js";
import { recordVersion } from "./version.js";

let sqlite: Database;
let db: LedgerDb;
let bank: number;
let fuel: number;
let paper: number;
const ctx = (
  permissions = [
    "records.read",
    "records.create",
    "records.update",
    "records.adjust",
    "records.void",
    "accounts.update",
  ],
) => ({ db, locals: localsFor(permissions) });
function value<T>(result: AppResult<T>): T {
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}
function account(
  name: string,
  type: 1 | 2 | 3 | 4 | 5,
  subType?: number,
  percentage?: number,
) {
  const result = createAccount(db, 1, {
    name,
    type,
    subType: subType as never,
    defaultTaxPercentageBps: percentage,
  });
  if (!result.ok) throw new Error(result.reason);
  return result.value.id;
}
function override(
  accountId = fuel,
  percentageBps = 2500,
  occurrence = 0,
): TaxOverride {
  return {
    accountId,
    occurrence,
    percentageBps,
    treatment:
      percentageBps === 0
        ? "non_deductible"
        : percentageBps === 10000
          ? "ordinary_deductible"
          : "partial",
    reason: "Business use reviewed against receipt",
  };
}
function expense(taxOverrides?: TaxOverride[]): RecordView {
  return value(
    createRecord(ctx(), {
      kind: "expense",
      date: "2026-01-15",
      description: "Fuel",
      amount: 1000,
      currency: "MYR",
      exchangeRate: 1,
      categoryAccountId: fuel,
      paidFromAccountId: bank,
      taxOverrides,
    }),
  ).record;
}
function tax(record: RecordView) {
  return record.movements.find((m) => m.accountId === fuel)?.taxClassification;
}
function report() {
  return expenseTaxReport(db, "2026-01-01", "2026-12-31");
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema }) as LedgerDb;
  migrate(db, { migrationsFolder: "drizzle" });
  sqlite.exec("PRAGMA foreign_keys = ON");
  db.insert(users)
    .values({ id: 1, email: "u@test", username: "u", passwordHash: "x" })
    .run();
  bank = account("Bank", AccountType.Asset, AccountSubType.Bank);
  fuel = account("Fuel", AccountType.Expense, undefined, 5000);
  paper = account("Paper", AccountType.Expense, undefined, 10000);
  const receivable = account(
    "Receivable",
    AccountType.Asset,
    AccountSubType.Receivable,
  );
  const payable = account(
    "Payable",
    AccountType.Liability,
    AccountSubType.AccountsPayable,
  );
  const opening = account("Opening", AccountType.Equity);
  db.insert(accountDefaults)
    .values([
      { purpose: DefaultAccountPurpose.Receivable, accountId: receivable },
      { purpose: DefaultAccountPurpose.Payable, accountId: payable },
      { purpose: DefaultAccountPurpose.OpeningBalances, accountId: opening },
    ])
    .run();
});
afterEach(() => sqlite.close());

describe("expense tax snapshots across authorized write paths", () => {
  it("captures defaults and preserves old lines across default, amount and description edits", () => {
    const old = expense();
    expect(tax(old)).toMatchObject({
      percentageBps: 5000,
      source: "account_default",
      treatment: "partial",
      classifiedBy: 1,
    });
    expect(report()).toMatchObject({
      expenseMinor: 100000,
      deductibleMinor: 50000,
      addBackMinor: 50000,
      unresolvedMinor: 0,
    });
    value(updateAccount(ctx(), fuel, { defaultTaxPercentageBps: 10000 }));
    expect(tax(expense())?.percentageBps).toBe(10000);
    expect(
      tax(
        value(
          updateRecord(ctx(), old.id, { amount: 1200, description: "Updated" }),
        ).record,
      ),
    ).toEqual(tax(old));
    expect(report()).toMatchObject({
      expenseMinor: 220000,
      deductibleMinor: 160000,
      addBackMinor: 60000,
    });
  });
  it("saves creation and edit overrides, reason, source and audit without altering the default", () => {
    const created = expense([override()]);
    expect(tax(created)).toMatchObject({
      percentageBps: 2500,
      source: "override",
      reason: override().reason,
    });
    expect(getAccount(db, fuel)?.defaultTaxPercentageBps).toBe(5000);
    const beforeVersion = recordVersion(db, created.id);
    value(
      updateRecord(
        ctx(),
        created.id,
        { taxOverrides: [override(fuel, 0)] },
        beforeVersion,
      ),
    );
    expect(recordVersion(db, created.id)).not.toBe(beforeVersion);
    const audit = db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.recordType, "record"),
          eq(auditLog.recordId, String(created.id)),
          eq(auditLog.action, "update"),
        ),
      )
      .get();
    expect(JSON.stringify(audit?.changes)).toContain("taxClassification");
    expect(report()).toMatchObject({
      deductibleMinor: 0,
      addBackMinor: 100000,
    });
  });
  it("classifies split journal lines independently, including repeated account IDs", () => {
    const created = value(
      createRecord(ctx(), {
        kind: "journal",
        date: "2026-01-01",
        description: "Split",
        amount: 1000,
        currency: "MYR",
        exchangeRate: 1,
        movements: [
          { accountId: bank, amountMinor: -100000 },
          { accountId: fuel, amountMinor: 60000 },
          { accountId: fuel, amountMinor: 40000 },
        ],
        taxOverrides: [override(fuel, 10000), override(fuel, 0, 1)],
      }),
    ).record;
    expect(
      created.movements
        .filter((m) => m.accountId === fuel)
        .map((m) => m.taxClassification?.percentageBps),
    ).toEqual([10000, 0]);
    expect(report()).toMatchObject({
      expenseMinor: 100000,
      deductibleMinor: 60000,
      addBackMinor: 40000,
    });
  });
  it("handles the same split through the everyday form payload and preserves snapshots on save", () => {
    const input = {
      date: "2026-01-01",
      description: "Form split",
      amount: 1000,
      currency: "MYR",
      exchangeRate: 1,
      fromAccountId: bank,
      toAccountId: fuel,
      categoryAmountMinor: 60000,
      extraSides: [{ accountId: paper, amountMinor: 40000 }],
      taxOverrides: [override(fuel, 10000), override(paper, 0)],
    };
    const created = value(createRecord(ctx(), input)).record;
    expect(report().deductibleMinor).toBe(60000);
    const updated = value(
      updateRecord(ctx(), created.id, { ...input, taxOverrides: undefined }),
    ).record;
    expect(updated.movements.map((m) => m.taxClassification)).toEqual(
      created.movements.map((m) => m.taxClassification),
    );
  });
  it("reverses signed refunds and copies the original snapshot on a void after a default change", () => {
    const original = expense();
    value(updateAccount(ctx(), fuel, { defaultTaxPercentageBps: 10000 }));
    const pair = value(
      voidRecord(ctx(), original.id, {
        reason: "Duplicate receipt",
        expectedVersion: recordVersion(db, original.id),
      }),
    );
    expect(pair).toBeDefined();
    const reversed = report().rows.find((r) => r.expenseMinor < 0)!;
    expect(reversed.classification).toEqual(tax(original));
    expect(report()).toMatchObject({
      expenseMinor: 0,
      deductibleMinor: 0,
      addBackMinor: 0,
    });
    value(
      createRecord(ctx(), {
        kind: "journal",
        date: "2026-02-01",
        description: "Credit note",
        amount: 100,
        currency: "MYR",
        exchangeRate: 1,
        movements: [
          { accountId: fuel, amountMinor: -10000 },
          { accountId: bank, amountMinor: 10000 },
        ],
        taxOverrides: [override(fuel, 5000)],
      }),
    );
    expect(report()).toMatchObject({
      expenseMinor: -10000,
      deductibleMinor: -5000,
      addBackMinor: -5000,
    });
  });
  it("leaves historical NULL snapshots unreviewed through unrelated movement rebuilds and voids", () => {
    const old = expense();
    db.update(ledgerMovements)
      .set({ taxClassification: null })
      .where(eq(ledgerMovements.recordId, old.id))
      .run();
    expect(report()).toMatchObject({
      unresolvedMinor: 100000,
      deductibleMinor: 0,
      addBackMinor: 0,
    });
    expect(
      tax(value(updateRecord(ctx(), old.id, { amount: 1100 })).record),
    ).toBeNull();
    value(
      voidRecord(ctx(), old.id, {
        reason: "Historical duplicate",
        expectedVersion: recordVersion(db, old.id),
      }),
    );
    expect(
      report().rows.every(
        (r) => r.classification === null && r.deductibleMinor === null,
      ),
    ).toBe(true);
    expect(report().unresolvedMinor).toBe(0);
  });
  it("exposes unconfigured and requires-review lines separately from classified zero deductions", () => {
    const unknown = account("Unknown", AccountType.Expense);
    value(
      createRecord(ctx(), {
        kind: "expense",
        date: "2026-01-01",
        description: "",
        amount: 10,
        currency: "MYR",
        exchangeRate: 1,
        categoryAccountId: unknown,
        paidFromAccountId: bank,
      }),
    );
    expense([{ ...override(), treatment: "requires_review" }]);
    expect(report()).toMatchObject({
      expenseMinor: 101000,
      deductibleMinor: 0,
      addBackMinor: 0,
      unresolvedMinor: 101000,
      unresolvedLineCount: 2,
    });
    expect(report().rows.every((r) => r.deductibleMinor === null)).toBe(true);
    expect(expenseTaxCsv(report()).notes?.join(" ")).toContain(
      "not accountant-approved",
    );
  });
  it("captures a new default only when the expense account is explicitly changed", () => {
    const old = expense();
    const updated = value(
      updateRecord(ctx(), old.id, { categoryAccountId: paper }),
    ).record;
    expect(
      updated.movements.find((m) => m.accountId === paper)?.taxClassification,
    ).toMatchObject({ percentageBps: 10000, provenance: "account_change" });
  });
  it("guards closed tax writes at both application and query boundaries, but permits prospective defaults", () => {
    const old = expense();
    setSetting(db, SETTING_KEYS.accountingClosedThrough, "2026-01-31");
    const before = recordVersion(db, old.id);
    const auditCount = db.select().from(auditLog).all().length;
    const refused = updateRecord(ctx(), old.id, { taxOverrides: [override()] });
    expect(refused).toMatchObject({ ok: false, code: "REFUSED" });
    expect(() =>
      queryUpdate(db, old.id, 1, { taxOverrides: [override()] }),
    ).toThrow("closed through");
    expect(recordVersion(db, old.id)).toBe(before);
    expect(db.select().from(auditLog).all().length).toBe(auditCount);
    value(updateAccount(ctx(), fuel, { defaultTaxPercentageBps: 10000 }));
    expect(tax(getRecord(db, old.id)!)?.percentageBps).toBe(5000);
    expect(report().deductibleMinor).toBe(50000);
    setSetting(db, SETTING_KEYS.accountingClosedThrough, "");
    expect(updateRecord(ctx(), old.id, { taxOverrides: [override()] }).ok).toBe(
      true,
    );
  });
  it("rejects forbidden, non-expense, missing, duplicate and invalid overrides without partial writes", () => {
    const old = expense();
    expect(
      updateRecord(ctx([]), old.id, { taxOverrides: [override()] }),
    ).toMatchObject({ ok: false, code: "FORBIDDEN" });
    const before = recordVersion(db, old.id);
    for (const taxOverrides of [
      [override(bank)],
      [override(99999)],
      [override(), override()],
      [{ ...override(), percentageBps: 10001 }],
      [{ ...override(), reason: "" }],
    ]) {
      expect(updateRecord(ctx(), old.id, { taxOverrides }).ok).toBe(false);
      expect(recordVersion(db, old.id)).toBe(before);
    }
    const count = db.select().from(schema.ledgerRecords).all().length;
    expect(
      createRecord(ctx(), {
        kind: "expense",
        date: "2026-01-01",
        description: "",
        amount: 100,
        currency: "MYR",
        exchangeRate: 1,
        categoryAccountId: fuel,
        paidFromAccountId: bank,
        taxOverrides: [override(bank)],
      }).ok,
    ).toBe(false);
    expect(db.select().from(schema.ledgerRecords).all().length).toBe(count);
  });
  it("captures defaults even for low-level/import-style insertions, and cannot classify non-expense defaults", () => {
    const row = insertRecord(
      db,
      1,
      {
        kind: 1,
        date: "2026-01-01",
        description: "Import",
        amount: 10,
        currency: "MYR",
        exchangeRate: 1,
      },
      [
        { accountId: fuel, amountMinor: 1000, sortOrder: 0, label: null },
        { accountId: bank, amountMinor: -1000, sortOrder: 1, label: null },
      ],
    );
    expect(tax(getRecord(db, row.id)!)?.percentageBps).toBe(5000);
    expect(
      patchAccount(db, bank, 1, { defaultTaxPercentageBps: 10000 }).ok,
    ).toBe(false);
    expect(() =>
      sqlite.exec(
        `UPDATE accounts SET default_tax_percentage_bps = 10001 WHERE id = ${fuel}`,
      ),
    ).toThrow();
    expect(() =>
      sqlite.exec(
        `UPDATE ledger_movements SET tax_classification = '{}' WHERE record_id = ${row.id}`,
      ),
    ).toThrow();
  });
  it("records the import confirmer separately from the original record owner and converts money only once", () => {
    db.insert(users)
      .values({
        id: 2,
        email: "reviewer@test",
        username: "reviewer",
        passwordHash: "x",
      })
      .run();
    const created = createRecordService(
      db,
      1,
      {
        kind: "expense",
        date: "2026-01-01",
        description: "Confirmed import",
        amount: 1000,
        currency: "USD",
        exchangeRate: 4.5,
        categoryAccountId: fuel,
        paidFromAccountId: bank,
      },
      [],
      2,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(tax(created.value)).toMatchObject({
      classifiedBy: 2,
      percentageBps: 5000,
    });
    expect(report()).toMatchObject({
      expenseMinor: 450000,
      deductibleMinor: 225000,
      addBackMinor: 225000,
    });
    const audit = db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.recordType, "record"),
          eq(auditLog.recordId, String(created.value.id)),
        ),
      )
      .get();
    expect(audit?.userId).toBe(2);
    expect(JSON.stringify(audit?.changes)).toContain("taxClassification");
  });

  it("rolls back a tax edit if its audit cannot be saved", () => {
    const old = expense();
    const before = recordVersion(db, old.id);
    sqlite.exec(
      "CREATE TRIGGER refuse_tax_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END",
    );
    expect(() =>
      updateRecord(ctx(), old.id, { taxOverrides: [override()] }),
    ).toThrow();
    expect(recordVersion(db, old.id)).toBe(before);
    expect(tax(getRecord(db, old.id)!)).toEqual(tax(old));
  });

  it("never changes financial amounts when classifying and reconciles report totals to expense movements", () => {
    const old = expense();
    const financialBefore = accountTotalsBetween(
      db,
      "2026-01-01",
      "2026-12-31",
    );
    value(updateRecord(ctx(), old.id, { taxOverrides: [override()] }));
    expect(accountTotalsBetween(db, "2026-01-01", "2026-12-31")).toEqual(
      financialBefore,
    );
    const r = report();
    expect(r.deductibleMinor + r.addBackMinor + r.unresolvedMinor).toBe(
      r.expenseMinor,
    );
    const other = new Database(":memory:");
    try {
      const otherDb = drizzle(other, { schema }) as LedgerDb;
      migrate(otherDb, { migrationsFolder: "drizzle" });
      expect(
        expenseTaxReport(otherDb, "2026-01-01", "2026-12-31").rows,
      ).toEqual([]);
    } finally {
      other.close();
    }
  });
});

describe("explicit adoption of current account tax defaults", () => {
  function useDefault(
    percentageBps: number | null = 5000,
    treatment: TaxOverride["treatment"] = "partial",
  ): TaxOverride {
    return {
      accountId: fuel,
      occurrence: 0,
      percentageBps,
      treatment,
      source: "account_default",
      reason: "Apply current account policy",
    };
  }
  it("re-snapshots the current default with reason, actor and audit without changing financial amounts or the account", () => {
    const old = expense([override()]);
    const accountBefore = getAccount(db, fuel);
    const amountsBefore = accountTotalsBetween(db, "2026-01-01", "2026-12-31");
    const updated = value(
      updateRecord(ctx(), old.id, { taxOverrides: [useDefault()] }),
    ).record;
    expect(tax(updated)).toMatchObject({
      percentageBps: 5000,
      treatment: "partial",
      source: "account_default",
      provenance: "account_default_reset",
      reason: "Apply current account policy",
      classifiedBy: 1,
    });
    expect(
      updated.movements.map((m) => [m.id, m.accountId, m.amountMinor, m.label]),
    ).toEqual(
      old.movements.map((m) => [m.id, m.accountId, m.amountMinor, m.label]),
    );
    expect(getAccount(db, fuel)).toEqual(accountBefore);
    expect(accountTotalsBetween(db, "2026-01-01", "2026-12-31")).toEqual(
      amountsBefore,
    );
    const audit = db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.recordType, "record"),
          eq(auditLog.recordId, String(old.id)),
        ),
      )
      .all()
      .at(-1)!;
    expect(audit.changes).toContain("account_default_reset");
    expect(audit.changes).toContain("Apply current account policy");
  });
  it("changes saved override provenance even when its values already match today's default", () => {
    const old = expense([override(fuel, 5000)]);
    expect(tax(old)?.source).toBe("override");
    const updated = value(
      updateRecord(ctx(), old.id, { taxOverrides: [useDefault()] }),
    ).record;
    expect(tax(updated)?.source).toBe("account_default");
    expect(tax(updated)?.percentageBps).toBe(5000);
  });
  it("refuses a stale or spoofed default without changing the record, its version or audit", () => {
    const old = expense([override()]);
    value(updateAccount(ctx(), fuel, { defaultTaxPercentageBps: 10000 }));
    const version = recordVersion(db, old.id);
    const auditBefore = db.select().from(auditLog).all();
    const result = updateRecord(ctx(), old.id, {
      taxOverrides: [useDefault()],
    });
    expect(result).toMatchObject({
      ok: false,
      code: "REFUSED",
      reason: expect.stringContaining("default changed"),
    });
    expect(recordVersion(db, old.id)).toBe(version);
    expect(db.select().from(auditLog).all()).toEqual(auditBefore);
    expect(tax(getRecord(db, old.id)!)).toEqual(tax(old));
    expect(
      tax(
        value(
          updateRecord(ctx(), old.id, {
            taxOverrides: [useDefault(10000, "ordinary_deductible")],
          }),
        ).record,
      )?.percentageBps,
    ).toBe(10000);
  });
  it("checks treatment as well as percentage when adopting zero-percent defaults", () => {
    const old = expense([override()]);
    value(
      updateAccount(ctx(), fuel, {
        defaultTaxPercentageBps: 0,
        defaultTaxTreatment: "capital_expenditure",
      }),
    );
    const before = recordVersion(db, old.id);
    expect(
      updateRecord(ctx(), old.id, {
        taxOverrides: [useDefault(0, "non_deductible")],
      }).ok,
    ).toBe(false);
    expect(recordVersion(db, old.id)).toBe(before);
    expect(
      tax(
        value(
          updateRecord(ctx(), old.id, {
            taxOverrides: [useDefault(0, "capital_expenditure")],
          }),
        ).record,
      )?.treatment,
    ).toBe("capital_expenditure");
  });
  it("can return to an unconfigured default as unreviewed, never as a confirmed zero deduction", () => {
    const old = expense([override()]);
    value(
      updateAccount(ctx(), fuel, {
        defaultTaxPercentageBps: null,
        defaultTaxTreatment: null,
      }),
    );
    const updated = value(
      updateRecord(ctx(), old.id, {
        taxOverrides: [useDefault(null, "unclassified")],
      }),
    ).record;
    expect(tax(updated)).toMatchObject({
      source: "unreviewed",
      percentageBps: null,
      treatment: "unclassified",
      provenance: "account_default_reset",
    });
    expect(report()).toMatchObject({
      unresolvedLineCount: 1,
      unresolvedMinor: 100000,
      deductibleMinor: 0,
      addBackMinor: 0,
    });
  });
  it("preserves a current default's legacy tentative review percentage and still reports it unresolved", () => {
    const old = expense([override()]);
    value(
      updateAccount(ctx(), fuel, {
        defaultTaxPercentageBps: 2500,
        defaultTaxTreatment: "requires_review",
      }),
    );
    const updated = value(
      updateRecord(ctx(), old.id, {
        taxOverrides: [useDefault(2500, "requires_review")],
      }),
    ).record;
    expect(tax(updated)).toMatchObject({
      percentageBps: 2500,
      treatment: "requires_review",
      source: "account_default",
    });
    expect(report().unresolvedLineCount).toBe(1);
  });
  it("requires the existing permission and reason and respects the month lock through both API operation and query boundaries", () => {
    const old = expense([override()]);
    const before = recordVersion(db, old.id);
    expect(
      updateRecord(ctx([]), old.id, { taxOverrides: [useDefault()] }),
    ).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(
      updateRecord(ctx(), old.id, {
        taxOverrides: [{ ...useDefault(), reason: "" }],
      }).ok,
    ).toBe(false);
    setSetting(db, SETTING_KEYS.accountingClosedThrough, "2026-01-31");
    expect(
      updateRecord(ctx(), old.id, { taxOverrides: [useDefault()] }),
    ).toMatchObject({ ok: false, code: "REFUSED" });
    expect(() =>
      queryUpdate(db, old.id, 1, { taxOverrides: [useDefault()] }),
    ).toThrow("closed through");
    expect(recordVersion(db, old.id)).toBe(before);
  });
  it("targets the displayed occurrence even when historical movement IDs are in a different order", () => {
    const original = value(
      createRecord(ctx(), {
        kind: "journal",
        date: "2026-01-01",
        description: "Reordered split",
        amount: 1000,
        currency: "MYR",
        exchangeRate: 1,
        movements: [
          { accountId: bank, amountMinor: -100000 },
          { accountId: fuel, amountMinor: 60000 },
          { accountId: fuel, amountMinor: 40000 },
        ],
        taxOverrides: [override(fuel, 10000), override(fuel, 0, 1)],
      }),
    ).record;
    const fuelLines = original.movements.filter((m) => m.accountId === fuel);
    db.update(ledgerMovements)
      .set({ sortOrder: 2 })
      .where(eq(ledgerMovements.id, fuelLines[0].id))
      .run();
    db.update(ledgerMovements)
      .set({ sortOrder: 1 })
      .where(eq(ledgerMovements.id, fuelLines[1].id))
      .run();
    const updated = value(
      updateRecord(ctx(), original.id, { taxOverrides: [useDefault()] }),
    ).record;
    expect(
      updated.movements
        .filter((m) => m.accountId === fuel)
        .map((m) => [m.id, m.taxClassification?.percentageBps]),
    ).toEqual([
      [fuelLines[1].id, 5000],
      [fuelLines[0].id, 10000],
    ]);
    expect(report().deductibleMinor).toBe(80000);
  });
  it("keeps split default-reset and manual override targets independent", () => {
    const created = value(
      createRecord(ctx(), {
        kind: "journal",
        date: "2026-01-01",
        description: "Split",
        amount: 1000,
        currency: "MYR",
        exchangeRate: 1,
        movements: [
          { accountId: bank, amountMinor: -100000 },
          { accountId: fuel, amountMinor: 60000 },
          { accountId: fuel, amountMinor: 40000 },
        ],
        taxOverrides: [override(fuel, 10000), override(fuel, 0, 1)],
      }),
    ).record;
    const updated = value(
      updateRecord(ctx(), created.id, { taxOverrides: [useDefault()] }),
    ).record;
    expect(
      updated.movements
        .filter((m) => m.accountId === fuel)
        .map((m) => [
          m.taxClassification?.percentageBps,
          m.taxClassification?.source,
        ]),
    ).toEqual([
      [5000, "account_default"],
      [0, "override"],
    ]);
    expect(report()).toMatchObject({
      expenseMinor: 100000,
      deductibleMinor: 30000,
      addBackMinor: 70000,
    });
  });
});
