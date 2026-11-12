import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AccountType,
  AccountSubType,
  DefaultAccountPurpose,
} from "$lib/enums.js";
import {
  taxDecimal,
  taxMoneyMinor,
  formatTaxMinor,
} from "$lib/tax-worksheet.js";
import * as schema from "../db/schema.js";
import {
  users,
  accountDefaults,
  taxWorksheetAdjustments,
  taxWorksheets,
  auditLog,
  ledgerMovements,
} from "../db/schema.js";
import type { LedgerDb } from "../ledger/types.js";
import { createAccount } from "../services/accounts.js";
import { createRecord, updateRecord, voidRecord } from "./records.js";
import { recordVersion } from "./version.js";
import { localsFor } from "../permissions/test-locals.js";
import { setSetting, SETTING_KEYS } from "../settings.js";
import {
  balanceSheetReport,
  profitLossReport,
  cashFlowReport,
} from "../queries/reports.js";
import {
  taxWorksheetCsv,
  taxWorksheetHtml,
} from "../queries/tax-worksheets.js";
import { toCsv } from "../ledger/reports/csv.js";
import {
  createTaxWorksheet,
  addTaxAdjustment,
  changeTaxWorksheet,
  readTaxWorksheet,
  readTaxWorksheets,
  taxWorksheetEvents,
} from "./tax-worksheets.js";

let sqlite: Database;
let db: LedgerDb;
let bank: number;
let fuel: number;
const key = () => crypto.randomUUID();
const ctx = (
  permissions = [
    "tax",
    "tax.finalise",
    "tax.amend",
    "records",
    "records.adjust",
    "records.void",
    "accounts",
  ],
) => ({ db, locals: localsFor(permissions) });
function value<T>(
  result: { ok: true; value: T } | { ok: false; reason: string },
): T {
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}
function account(
  name: string,
  type: 1 | 2 | 3 | 4 | 5,
  subType?: number,
  percentage?: number,
) {
  return value(
    createAccount(db, 1, {
      name,
      type,
      subType: subType as never,
      defaultTaxPercentageBps: percentage,
    }),
  ).id;
}
function expense(amount = 1000, percentage = 5000) {
  return value(
    createRecord(ctx(), {
      kind: "expense",
      date: "2025-01-15",
      description: "Fuel",
      amount,
      currency: "MYR",
      exchangeRate: 1,
      categoryAccountId: fuel,
      paidFromAccountId: bank,
      taxOverrides: [
        {
          accountId: fuel,
          occurrence: 0,
          percentageBps: percentage,
          treatment:
            percentage === 10000
              ? "ordinary_deductible"
              : percentage === 0
                ? "non_deductible"
                : "partial",
          reason: "Business use from reviewed receipt",
        },
      ],
    }),
  ).record;
}
const period = () => ({
  ya: 2025,
  dateFrom: "2025-01-01",
  dateTo: "2025-12-31",
  requestKey: key(),
});
const create = () => value(createTaxWorksheet(ctx(), period()));
function correction(
  d: ReturnType<typeof create>,
  percentage = 10000,
  requestKey = key(),
) {
  return {
    kind: "source",
    sourceMovementId: d.totals.lines.find((l) => !l.voided)!.movementId,
    percentageBps: percentage,
    treatment:
      percentage === 10000
        ? "ordinary_deductible"
        : percentage === 0
          ? "non_deductible"
          : "partial",
    reason: "Annual accountant review of business use",
    evidence: "Accountant memo 2025-01",
    requestKey,
    expectedVersion: d.revision.version,
  };
}
const statements = () =>
  JSON.stringify({
    pl: profitLossReport(db, "2025-01-01", "2025-12-31"),
    bs: balanceSheetReport(db, "2025-12-31"),
    cash: cashFlowReport(db, "2025-01-01", "2025-12-31"),
    ledger: db.select().from(ledgerMovements).all(),
  });
function adjustment(
  d: ReturnType<typeof create>,
  overrides: Record<string, unknown> = {},
) {
  return {
    kind: "other",
    direction: "decrease",
    amountMinor: 1000,
    balanceMinor: 0,
    originYa: null,
    reason: "Reviewed annual tax computation adjustment",
    evidence: "Annual schedule A",
    requestKey: key(),
    expectedVersion: d.revision.version,
    ...overrides,
  };
}
function finalise(d: ReturnType<typeof create>) {
  const reviewed = value(
    changeTaxWorksheet(ctx(), d.worksheet.id, {
      action: "review",
      expectedVersion: d.revision.version,
    }),
  );
  return value(
    changeTaxWorksheet(ctx(), d.worksheet.id, {
      action: "finalise",
      expectedVersion: reviewed.revision.version,
    }),
  );
}
beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema }) as LedgerDb;
  migrate(db, { migrationsFolder: "drizzle" });
  sqlite.exec("PRAGMA foreign_keys = ON");
  db.insert(users)
    .values({
      id: 1,
      email: "u@test",
      username: "Accountant",
      passwordHash: "x",
    })
    .run();
  bank = account("Bank", AccountType.Asset, AccountSubType.Bank);
  fuel = account("Fuel", AccountType.Expense, undefined, 5000);
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

describe("annual tax preparation", () => {
  it("corrects a closed source once without touching accounting statements or saved classifications", () => {
    expense();
    setSetting(db, SETTING_KEYS.accountingClosedThrough, "2025-01-31");
    const before = statements();
    const d = create();
    const payload = correction(d);
    const adjusted = value(addTaxAdjustment(ctx(), d.worksheet.id, payload));
    expect(adjusted.totals).toMatchObject({
      baseAddBackMinor: 50000,
      correctionMinor: -50000,
      addBackMinor: 0,
      resultMinor: -100000,
    });
    expect(adjusted.totals.lines[0].classification?.percentageBps).toBe(5000);
    const count = db.select().from(auditLog).all().length;
    expect(
      value(addTaxAdjustment(ctx(), d.worksheet.id, payload)).totals
        .resultMinor,
    ).toBe(-100000);
    expect(db.select().from(auditLog).all().length).toBe(count);
    expect(statements()).toBe(before);
    expect(JSON.stringify(db.select().from(auditLog).all())).toContain(
      "Annual accountant review",
    );
  });
  it("supersedes corrections, retains evidence and clears reviewed status", () => {
    expense();
    let d = create();
    d = value(addTaxAdjustment(ctx(), d.worksheet.id, correction(d, 2500)));
    d = value(
      changeTaxWorksheet(ctx(), d.worksheet.id, {
        action: "review",
        expectedVersion: d.revision.version,
      }),
    );
    d = value(addTaxAdjustment(ctx(), d.worksheet.id, correction(d, 10000)));
    expect(d.revision.status).toBe("draft");
    expect(d.totals.correctionMinor).toBe(-50000);
    expect(d.adjustments).toHaveLength(2);
    expect(d.adjustments.filter((a) => a.withdrawnAt === null)).toHaveLength(1);
  });
  it("rejects reused retry keys with changed payloads and duplicate YA/overlapping periods", () => {
    expense();
    const p = period();
    const d = value(createTaxWorksheet(ctx(), p));
    expect(value(createTaxWorksheet(ctx(), p)).worksheet.id).toBe(
      d.worksheet.id,
    );
    expect(createTaxWorksheet(ctx(), { ...p, ya: 2026 }).ok).toBe(false);
    expect(createTaxWorksheet(ctx(), period()).ok).toBe(false);
    expect(
      createTaxWorksheet(ctx(), {
        ...period(),
        ya: 2026,
        dateFrom: "2025-06-01",
        dateTo: "2026-05-31",
      }).ok,
    ).toBe(false);
    const a = correction(d);
    value(addTaxAdjustment(ctx(), d.worksheet.id, a));
    expect(
      addTaxAdjustment(ctx(), d.worksheet.id, {
        ...a,
        evidence: "Changed evidence",
      }).ok,
    ).toBe(false);
  });
  it("blocks unresolved lines, allowing annual resolution without classifying the source", () => {
    const record = expense();
    db.update(ledgerMovements)
      .set({ taxClassification: null })
      .where(
        eq(
          ledgerMovements.id,
          record.movements.find((m) => m.accountId === fuel)!.id,
        ),
      )
      .run();
    const d = create();
    expect(d.totals.unresolvedCount).toBe(1);
    expect(
      changeTaxWorksheet(ctx(), d.worksheet.id, {
        action: "review",
        expectedVersion: d.revision.version,
      }).ok,
    ).toBe(false);
    const resolved = value(
      addTaxAdjustment(ctx(), d.worksheet.id, correction(d)),
    );
    expect(resolved.totals.unresolvedCount).toBe(0);
    expect(resolved.totals.lines[0].classification).toBeNull();
    expect(finalise(resolved).revision.status).toBe("finalised");
  });
  it("requires explicit refresh and re-review when accounting changes after review", () => {
    const record = expense();
    let d = create();
    d = value(
      changeTaxWorksheet(ctx(), d.worksheet.id, {
        action: "review",
        expectedVersion: d.revision.version,
      }),
    );
    const oldHash = d.liveHash;
    value(
      updateRecord(ctx(), record.id, {
        description: "Updated fuel receipt",
      }),
    );
    expect(
      changeTaxWorksheet(ctx(), d.worksheet.id, {
        action: "finalise",
        expectedVersion: d.revision.version,
      }).ok,
    ).toBe(false);
    expect(
      changeTaxWorksheet(ctx(), d.worksheet.id, {
        action: "refresh",
        expectedVersion: d.revision.version,
        liveHash: oldHash,
        reason: "Include updated source evidence",
      }).ok,
    ).toBe(false);
    const live = value(readTaxWorksheet(ctx(), d.worksheet.id));
    expect(live.stale).toBe(true);
    expect(live.changes).toHaveLength(1);
    const fresh = value(
      changeTaxWorksheet(ctx(), d.worksheet.id, {
        action: "refresh",
        expectedVersion: d.revision.version,
        liveHash: live.liveHash,
        reason: "Include updated source evidence",
      }),
    );
    expect(fresh.stale).toBe(false);
    expect(fresh.revision.status).toBe("draft");
  });
  it("requires withdrawing affected corrections before refreshing changed sources", () => {
    const record = expense();
    let d = create();
    d = value(addTaxAdjustment(ctx(), d.worksheet.id, correction(d)));
    value(
      updateRecord(ctx(), record.id, {
        description: "Source details changed",
      }),
    );
    d = value(readTaxWorksheet(ctx(), d.worksheet.id));
    expect(
      changeTaxWorksheet(ctx(), d.worksheet.id, {
        action: "refresh",
        expectedVersion: d.revision.version,
        liveHash: d.liveHash,
        reason: "Refresh changed source evidence",
      }).ok,
    ).toBe(false);
    d = value(
      changeTaxWorksheet(ctx(), d.worksheet.id, {
        action: "withdraw",
        expectedVersion: d.revision.version,
        adjustmentId: d.adjustments[0].id,
        reason: "Withdraw before reviewing changed source",
      }),
    );
    expect(
      value(
        changeTaxWorksheet(ctx(), d.worksheet.id, {
          action: "refresh",
          expectedVersion: d.revision.version,
          liveHash: d.liveHash,
          reason: "Refresh changed source evidence",
        }),
      ).stale,
    ).toBe(false);
  });
  it("freezes finalised CSV/print evidence and creates an idempotent amendment", () => {
    expense();
    let d = create();
    d = value(addTaxAdjustment(ctx(), d.worksheet.id, correction(d)));
    d = finalise(d);
    const csv = toCsv(taxWorksheetCsv(d));
    const html = taxWorksheetHtml(d);
    expect(addTaxAdjustment(ctx(), d.worksheet.id, adjustment(d)).ok).toBe(
      false,
    );
    expect(
      changeTaxWorksheet(ctx(), d.worksheet.id, {
        action: "withdraw",
        expectedVersion: d.revision.version,
        adjustmentId: d.adjustments[0].id,
        reason: "Attempt to change finalised correction",
      }).ok,
    ).toBe(false);
    expense(200);
    const changed = value(readTaxWorksheet(ctx(), d.worksheet.id));
    expect(changed.stale).toBe(true);
    expect(toCsv(taxWorksheetCsv(changed))).toBe(csv);
    expect(taxWorksheetHtml(changed)).toBe(html);
    const command = {
      action: "amend",
      expectedVersion: d.revision.version,
      requestKey: key(),
      reason: "Include subsequently recorded expense",
    };
    const amended = value(changeTaxWorksheet(ctx(), d.worksheet.id, command));
    expect(amended.revision.revision).toBe(2);
    expect(amended.revision.status).toBe("draft");
    expect(amended.adjustments).toHaveLength(1);
    expect(
      value(changeTaxWorksheet(ctx(), d.worksheet.id, command)).revision.id,
    ).toBe(amended.revision.id);
    expect(
      toCsv(taxWorksheetCsv(value(readTaxWorksheet(ctx(), d.worksheet.id, 1)))),
    ).toBe(csv);
  });
  it("enforces finalisation and history locks in SQLite including direct adjustment insert", () => {
    expense();
    let d = create();
    d = value(addTaxAdjustment(ctx(), d.worksheet.id, correction(d)));
    d = finalise(d);
    expect(() =>
      sqlite.run(
        "UPDATE tax_worksheet_revisions SET status = 'draft' WHERE id = ?",
        [d.revision.id],
      ),
    ).toThrow();
    expect(() =>
      sqlite.run("DELETE FROM tax_worksheet_revisions WHERE id = ?", [
        d.revision.id,
      ]),
    ).toThrow();
    expect(() =>
      sqlite.run(
        "UPDATE tax_worksheet_adjustments SET withdrawn_at = 'now' WHERE id = ?",
        [d.adjustments[0].id],
      ),
    ).toThrow();
    expect(() =>
      sqlite.run("DELETE FROM tax_worksheet_adjustments WHERE id = ?", [
        d.adjustments[0].id,
      ]),
    ).toThrow();
    expect(() =>
      db
        .insert(taxWorksheetAdjustments)
        .values({
          revisionId: d.revision.id,
          kind: "other",
          amountMinor: 100,
          reason: "Direct write",
          evidence: "test",
          requestKey: key(),
          actorName: "test",
          createdAt: "now",
        })
        .run(),
    ).toThrow();
  });
  it("uses separate explicit finalise/amend permissions and refuses credential authority", () => {
    expense();
    const d = create();
    expect(readTaxWorksheet(ctx([]), d.worksheet.id).ok).toBe(false);
    expect(readTaxWorksheets(ctx(["reports.read"])).ok).toBe(false);
    expect(createTaxWorksheet(ctx(["tax.read"]), period()).ok).toBe(false);
    expect(
      addTaxAdjustment(ctx(["tax.read"]), d.worksheet.id, correction(d)).ok,
    ).toBe(false);
    const reviewed = value(
      changeTaxWorksheet(ctx(), d.worksheet.id, {
        action: "review",
        expectedVersion: d.revision.version,
      }),
    );
    expect(
      changeTaxWorksheet(ctx(["tax"]), d.worksheet.id, {
        action: "finalise",
        expectedVersion: reviewed.revision.version,
      }).ok,
    ).toBe(false);
    const credential = ctx();
    credential.locals.credential = { kind: "pat", tokenId: 1 };
    expect(
      changeTaxWorksheet(credential, d.worksheet.id, {
        action: "finalise",
        expectedVersion: reviewed.revision.version,
      }).ok,
    ).toBe(false);
  });
  it("rejects stale worksheet versions without adjustments, audits or emitted signals", () => {
    expense();
    const d = create();
    value(addTaxAdjustment(ctx(), d.worksheet.id, correction(d)));
    const auditCount = db.select().from(auditLog).all().length;
    let emitted = 0;
    const listener = () => emitted++;
    taxWorksheetEvents.on("changed", listener);
    try {
      expect(addTaxAdjustment(ctx(), d.worksheet.id, adjustment(d)).ok).toBe(
        false,
      );
      expect(emitted).toBe(0);
    } finally {
      taxWorksheetEvents.off("changed", listener);
    }
    expect(db.select().from(auditLog).all()).toHaveLength(auditCount);
    expect(db.select().from(taxWorksheetAdjustments).all()).toHaveLength(1);
  });
  it("distinguishes loss balances from utilisation and refuses manual allowance totals", () => {
    expense();
    let d = create();
    expect(
      addTaxAdjustment(
        ctx(),
        d.worksheet.id,
        adjustment(d, {
          kind: "loss_brought_forward",
          originYa: 2024,
          balanceMinor: 500,
          amountMinor: 600,
        }),
      ).ok,
    ).toBe(false);
    d = value(
      addTaxAdjustment(
        ctx(),
        d.worksheet.id,
        adjustment(d, {
          kind: "loss_brought_forward",
          originYa: 2024,
          balanceMinor: 5000,
          amountMinor: 600,
        }),
      ),
    );
    expect(d.totals.adjustmentMinor).toBe(-600);
    expect(
      addTaxAdjustment(
        ctx(),
        d.worksheet.id,
        adjustment(d, {
          kind: "loss_brought_forward",
          originYa: 2024,
          balanceMinor: 5000,
          amountMinor: 200,
        }),
      ).ok,
    ).toBe(false);
    expect(
      addTaxAdjustment(
        ctx(),
        d.worksheet.id,
        adjustment(d, {
          kind: "loss_brought_forward",
          originYa: 2025,
          balanceMinor: 5000,
        }),
      ).ok,
    ).toBe(false);
    expect(
      addTaxAdjustment(
        ctx(),
        d.worksheet.id,
        adjustment(d, { kind: "capital_allowance", amountMinor: 1000 }),
      ).ok,
    ).toBe(false);
    expect(d.totals.adjustmentMinor).toBe(-600);
  });
  it("retains signed line rounding and one depreciation add-back, and void pairs cancel", () => {
    const r = expense();
    value(
      voidRecord(ctx(), r.id, {
        reason: "Remove duplicate original expense",
        expectedVersion: recordVersion(db, r.id),
      }),
    );
    expense(0.01, 5000);
    expense(333.33, 0);
    const d = create();
    expect(d.totals.unresolvedCount).toBe(0);
    expect(d.totals.addBackMinor).toBe(33333);
    expect(d.totals.resultMinor).toBe(-1);
    expect(d.totals.lines.filter((l) => l.voided)).toHaveLength(2);
    expect(
      addTaxAdjustment(ctx(), d.worksheet.id, {
        ...correction(d),
        sourceMovementId: d.totals.lines.find((l) => l.voided)!.movementId,
      }).ok,
    ).toBe(false);
  });
  it("retains tax evidence when a live source is removed and after source-free restart migration", () => {
    const record = expense();
    const d = finalise(create());
    const csv = toCsv(taxWorksheetCsv(d));
    sqlite.run("DELETE FROM record_search_text WHERE record_id = ?", [
      record.id,
    ]);
    sqlite.run("DELETE FROM ledger_records WHERE id = ?", [record.id]);
    const retained = value(readTaxWorksheet(ctx(), d.worksheet.id));
    expect(retained.stale).toBe(true);
    expect(toCsv(taxWorksheetCsv(retained))).toBe(csv);
    migrate(db, { migrationsFolder: "drizzle" });
    expect(db.select().from(taxWorksheets).all()).toHaveLength(1);
  });
  it("escapes hostile source evidence in print and spreadsheet exports", () => {
    const record = expense();
    value(
      updateRecord(ctx(), record.id, {
        description: '<script>alert("x")</script>',
      }),
    );
    const d = create();
    expect(taxWorksheetHtml(d)).not.toContain("<script>alert");
    expect(taxWorksheetHtml(d)).toContain("&lt;script&gt;");
    expect(taxDecimal(Number.MAX_SAFE_INTEGER)).toBe("90071992547409.91");
    expect(taxMoneyMinor("90071992547409.91")).toBe(Number.MAX_SAFE_INTEGER);
    expect(taxMoneyMinor("90071992547409.92")).toBeNull();
    expect(taxMoneyMinor("0.001")).toBeNull();
  });
  it("rolls back overflow after an attempted write, including the audit and version", () => {
    expense();
    let d = create();
    d = value(
      addTaxAdjustment(
        ctx(),
        d.worksheet.id,
        adjustment(d, {
          direction: "increase",
          amountMinor: Number.MAX_SAFE_INTEGER,
        }),
      ),
    );
    const count = db.select().from(auditLog).all().length;
    expect(
      addTaxAdjustment(
        ctx(),
        d.worksheet.id,
        adjustment(d, { direction: "increase", amountMinor: 1000000 }),
      ).ok,
    ).toBe(false);
    expect(db.select().from(auditLog).all()).toHaveLength(count);
    expect(
      value(readTaxWorksheet(ctx(), d.worksheet.id)).revision.version,
    ).toBe(d.revision.version);
  });
  it("reverses refunds at line precision and does not infer current defaults", () => {
    expense(1000);
    const refund = value(
      createRecord(ctx(), {
        kind: "journal",
        date: "2025-02-01",
        description: "Partial refund",
        amount: 100,
        currency: "MYR",
        exchangeRate: 1,
        movements: [
          { accountId: fuel, amountMinor: -10000 },
          { accountId: bank, amountMinor: 10000 },
        ],
        taxOverrides: [
          {
            accountId: fuel,
            occurrence: 0,
            percentageBps: 5000,
            treatment: "partial",
            reason: "Reverse original expense treatment",
          },
        ],
      }),
    ).record;
    let d = create();
    expect(d.totals.addBackMinor).toBe(45000);
    const line = d.totals.lines.find((l) => l.recordId === refund.id)!;
    d = value(
      addTaxAdjustment(ctx(), d.worksheet.id, {
        ...correction(d, 0),
        sourceMovementId: line.movementId,
      }),
    );
    expect(d.totals.addBackMinor).toBe(40000);
    db.update(schema.accounts)
      .set({
        defaultTaxPercentageBps: 10000,
        defaultTaxTreatment: "ordinary_deductible",
      })
      .where(eq(schema.accounts.id, fuel))
      .run();
    const unchanged = value(readTaxWorksheet(ctx(), d.worksheet.id));
    expect(unchanged.stale).toBe(false);
    expect(unchanged.totals.addBackMinor).toBe(40000);
  });
  it("rejects invalid treatments, percentages, unsafe amounts and foreign source IDs", () => {
    expense();
    const d = create();
    const base = correction(d);
    for (const bad of [
      { ...base, percentageBps: 10001 },
      { ...base, percentageBps: 1.5 },
      { ...base, treatment: "requires_review" },
      { ...base, sourceMovementId: 999999 },
      adjustment(d, { amountMinor: 0.5 }),
      adjustment(d, { amountMinor: Number.MAX_SAFE_INTEGER + 1 }),
    ]) {
      expect(addTaxAdjustment(ctx(), d.worksheet.id, bad).ok).toBe(false);
    }
    expect(db.select().from(taxWorksheetAdjustments).all()).toEqual([]);
  });
  it("rolls back correction supersession when audit insertion fails", () => {
    expense();
    let d = create();
    d = value(addTaxAdjustment(ctx(), d.worksheet.id, correction(d, 2500)));
    const before = JSON.stringify(
      db.select().from(taxWorksheetAdjustments).all(),
    );
    sqlite.exec(
      "CREATE TRIGGER reject_tax_audit BEFORE INSERT ON audit_log WHEN NEW.record_type = 'tax_worksheet' BEGIN SELECT RAISE(ABORT, 'simulated audit failure'); END",
    );
    expect(() =>
      addTaxAdjustment(ctx(), d.worksheet.id, correction(d, 10000)),
    ).toThrow();
    expect(
      JSON.stringify(db.select().from(taxWorksheetAdjustments).all()),
    ).toBe(before);
    expect(
      value(readTaxWorksheet(ctx(), d.worksheet.id)).revision.version,
    ).toBe(d.revision.version);
  });
  it("exports retained evidence without depending on current ledger calculations", () => {
    const record = expense();
    const d = finalise(create());
    const csv = toCsv(taxWorksheetCsv(d));
    const movementId = record.movements.find((m) => m.accountId === fuel)!.id;
    db.update(ledgerMovements)
      .set({ amountMinor: Number.MAX_SAFE_INTEGER })
      .where(eq(ledgerMovements.id, movementId))
      .run();
    expense(1);
    const evidence = value(readTaxWorksheet(ctx(), d.worksheet.id, 1, false));
    expect(toCsv(taxWorksheetCsv(evidence))).toBe(csv);
    expect(formatTaxMinor(Number.MAX_SAFE_INTEGER, "MYR")).toBe(
      "RM 90,071,992,547,409.91",
    );
  });
  it("never accepts a previous revision's version after an amendment", () => {
    expense();
    const initial = create();
    const final = finalise(initial);
    const amended = value(
      changeTaxWorksheet(ctx(), initial.worksheet.id, {
        action: "amend",
        expectedVersion: final.revision.version,
        requestKey: key(),
        reason: "Review a new annual tax decision",
      }),
    );
    expect(amended.revision.version).toBeGreaterThan(final.revision.version);
    expect(
      addTaxAdjustment(ctx(), initial.worksheet.id, adjustment(initial)).ok,
    ).toBe(false);
    expect(
      addTaxAdjustment(ctx(), initial.worksheet.id, adjustment(final)).ok,
    ).toBe(false);
    expect(
      value(readTaxWorksheet(ctx(), initial.worksheet.id)).adjustments,
    ).toHaveLength(0);
  });
  it("does not expose another book's worksheets through a separate database context", () => {
    expense();
    const d = create();
    const other = new Database(":memory:");
    try {
      const otherDb = drizzle(other, { schema }) as LedgerDb;
      migrate(otherDb, { migrationsFolder: "drizzle" });
      expect(value(readTaxWorksheets({ ...ctx(), db: otherDb }))).toEqual([]);
      expect(
        readTaxWorksheet({ ...ctx(), db: otherDb }, d.worksheet.id).ok,
      ).toBe(false);
    } finally {
      other.close();
    }
  });
});
