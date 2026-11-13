import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AccountSubType,
  AccountType,
  DefaultAccountPurpose,
  LedgerRecordKind,
  StatementDirection,
  StatementExtractionState,
} from "$lib/enums.js";
import { LEAF_PERMISSIONS } from "$lib/permissions/catalog.js";
import * as schema from "../db/schema.js";
import type { LedgerDb, RecordView } from "../ledger/types.js";
import { localsFor } from "../permissions/test-locals.js";
import { createAccount } from "../services/accounts.js";
import { setSetting, SETTING_KEYS } from "../settings.js";
import { getRecord } from "../queries/ledger.js";
import { accountBalanceMinor } from "../queries/accounts.js";
import { contactBalances, getSide } from "../queries/settlements.js";
import { ledgerEvents } from "../ledger/events.js";
import type { AppContext } from "./context.js";
import { createRecord, prepareVoidRecord, voidRecord } from "./records.js";
import {
  correctSettledAmount,
  prepareSettledAmountCorrection,
} from "./record-amount-correction.js";

let sqlite: Database;
let db: LedgerDb;
let ctx: AppContext;
let bank: number;
let goods: number;
let freight: number;
let payable: number;
let receivable: number;
let sales: number;
let acme: number;
const reason = "Freight was left off the supplier invoice.";
const day = "2026-09-02";

function account(name: string, type: number, subType?: number) {
  const r = createAccount(db, 1, {
    name,
    type: type as never,
    subType: subType as never,
  });
  if (!r.ok) throw new Error(r.reason);
  return r.value.id;
}
function value<T>(r: { ok: true; value: T } | { ok: false; reason: string }) {
  if (!r.ok) throw new Error(r.reason);
  return r.value;
}
function bill(amount: number, date = day): RecordView {
  return value(
    createRecord(ctx, {
      kind: "expense",
      date,
      amount,
      currency: "MYR",
      exchangeRate: 1,
      description: "Acme goods",
      categoryAccountId: goods,
      paidFromAccountId: null,
      contactId: acme,
    }),
  ).record;
}
function owedSide(record: RecordView) {
  return record.movements.find((m) => m.accountId === payable)!;
}
function pay(
  amount: number,
  allocations: { owed: RecordView; minor: number }[],
) {
  return value(
    createRecord(ctx, {
      kind: "payment",
      date: day,
      amount,
      currency: "MYR",
      exchangeRate: 1,
      description: "Acme payment",
      paidFromAccountId: bank,
      contactId: acme,
      direction: "we-pay",
      settlements: allocations.map((a) => ({
        owedMovementId: owedSide(a.owed).id,
        amountMinor: a.minor,
      })),
    }),
  ).record;
}
function paySide(payment: RecordView) {
  return getSide(db, owedSide(payment).id)!;
}
function version(id: number) {
  return value(prepareSettledAmountCorrection(ctx, id)).version;
}
function settlementRows() {
  return db.select().from(schema.settlements).all();
}
function auditFor(id: number) {
  return db
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.recordId, String(id)))
    .all();
}

/** Row count and an order-independent digest of every row, per table. */
function snapshot(): Record<string, { count: number; digest: string }> {
  const names = (
    sqlite
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[]
  ).map((r) => r.name);
  const out: Record<string, { count: number; digest: string }> = {};
  for (const name of names) {
    const rows = sqlite
      .query(`SELECT * FROM "${name.replaceAll('"', '""')}"`)
      .all()
      .map((row) =>
        JSON.stringify(row, (_k, v) =>
          v instanceof Uint8Array ? Buffer.from(v).toString("hex") : v,
        ),
      )
      .sort();
    out[name] = {
      count: rows.length,
      digest: createHash("sha256").update(rows.join("\n")).digest("hex"),
    };
  }
  return out;
}

/** The freight case: 1,200.00 owed, a 1,285.00 payment allocated 1,200.00. */
function freightCase() {
  const expense = bill(1200);
  const payment = pay(1285, [{ owed: expense, minor: 120_000 }]);
  return { expense, payment };
}

function statementLine(accountId: number, amount: number) {
  const statementId = db
    .insert(schema.bankStatements)
    .values({
      originalFilename: "sept.pdf",
      storedFilePath: "reconciliation/sept.pdf",
      extractionState: StatementExtractionState.Ready,
      uploadedBy: 1,
      accountId,
    })
    .returning()
    .get()!.id;
  return db
    .insert(schema.bankStatementLines)
    .values({
      statementId,
      date: day,
      amount,
      direction: StatementDirection.Out,
    })
    .returning()
    .get()!.id;
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema }) as unknown as LedgerDb;
  migrate(db as never, { migrationsFolder: "drizzle" });
  sqlite.exec("PRAGMA foreign_keys = ON");
  db.insert(schema.users)
    .values({ email: "amount@test", username: "amount", passwordHash: "x" })
    .run();
  ctx = { db, locals: localsFor(LEAF_PERMISSIONS, { userId: 1 }) };
  setSetting(db, SETTING_KEYS.currencyCode, "MYR");
  bank = account("Bank", AccountType.Asset, AccountSubType.Bank);
  goods = account("Goods", AccountType.Expense);
  freight = account("Freight", AccountType.Expense);
  payable = account(
    "Supplier payable",
    AccountType.Liability,
    AccountSubType.AccountsPayable,
  );
  receivable = account(
    "Receivable",
    AccountType.Asset,
    AccountSubType.Receivable,
  );
  sales = account("Sales", AccountType.Revenue);
  const opening = account("Opening", AccountType.Equity);
  db.insert(schema.accountDefaults)
    .values([
      {
        purpose: DefaultAccountPurpose.Payable,
        accountId: payable,
        updatedBy: 1,
      },
      {
        purpose: DefaultAccountPurpose.Receivable,
        accountId: receivable,
        updatedBy: 1,
      },
      {
        purpose: DefaultAccountPurpose.OpeningBalances,
        accountId: opening,
        updatedBy: 1,
      },
    ])
    .run();
  acme = db
    .insert(schema.contacts)
    .values({ legalName: "Acme", entityType: 2 })
    .returning()
    .get()!.id;
});
afterEach(() => sqlite.close());

describe("correctSettledAmount", () => {
  it("corrects the freight case: reverses, rebuilds the split and reapplies the same payment", () => {
    const { expense, payment } = freightCase();
    const owedId = owedSide(expense).id;
    expect(contactBalances(db, "we-owe", acme)[0]?.creditsMinor).toBe(8500);
    const preview = value(prepareSettledAmountCorrection(ctx, expense.id));
    expect(preview.blockers).toEqual([]);
    expect(preview.settlements).toHaveLength(1);
    const emitted: number[] = [];
    const listener = ({ record }: { record: RecordView }) =>
      emitted.push(record.id);
    ledgerEvents.on("record-update", listener);
    let result;
    try {
      result = value(
        correctSettledAmount(ctx, {
          recordId: expense.id,
          expectedVersion: preview.version,
          amount: 1285,
          lines: [
            { accountId: goods, amountMinor: 120_000 },
            { accountId: freight, amountMinor: 8_500, label: "Freight" },
          ],
          reason,
        }),
      );
    } finally {
      ledgerEvents.off("record-update", listener);
    }
    expect(result.reversed.map((r) => r.amountMinor)).toEqual([120_000]);
    expect(result.reapplied.map((r) => r.amountMinor)).toEqual([128_500]);
    expect(result.reapplied[0].payment.recordId).toBe(payment.id);
    expect(result.leftoverCredit).toEqual([]);
    expect(result.rematched).toBeUndefined();
    expect(result.version).not.toBe(preview.version);
    expect(emitted).toContain(expense.id);

    const after = getRecord(db, expense.id)!;
    expect(after.kind).toBe(LedgerRecordKind.Expense);
    expect(after.amountMinor).toBe(128_500);
    expect(after.outstandingMinor).toBe(0);
    expect(after.paid).toBe(true);
    // The owed side kept its id, so old and new allocation rows share it.
    expect(owedSide(after).id).toBe(owedId);
    expect(
      after.movements
        .filter((m) => m.amountMinor > 0)
        .map((m) => [m.accountId, m.amountMinor])
        .sort(),
    ).toEqual(
      [
        [goods, 120_000],
        [freight, 8_500],
      ].sort(),
    );
    expect(after.movements.reduce((s, m) => s + m.amountMinor, 0)).toBe(0);

    expect(paySide(payment).settledMinor).toBe(128_500);
    expect(accountBalanceMinor(db, payable)).toBe(0);
    expect(contactBalances(db, "we-owe", acme)[0]?.outstandingMinor ?? 0).toBe(
      0,
    );
    const rows = settlementRows();
    expect(rows).toHaveLength(2);
    const reversedRow = rows.find((r) => r.reversedAt !== null)!;
    expect(reversedRow).toMatchObject({
      amountMinor: 120_000,
      owedMovementId: owedId,
      reversalReason: reason,
    });
    expect(rows.find((r) => r.reversedAt === null)).toMatchObject({
      amountMinor: 128_500,
      owedMovementId: owedId,
    });
    const audit = auditFor(expense.id).filter((a) =>
      a.changes?.includes("settledAmountCorrectionReason"),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].changes).toContain(reason);
  });

  it("reapplies only up to a lower total and leaves the rest as payment credit", () => {
    const { expense, payment } = freightCase();
    const result = value(
      correctSettledAmount(ctx, {
        recordId: expense.id,
        expectedVersion: version(expense.id),
        amount: 1000,
        reason,
      }),
    );
    expect(result.reversed.map((r) => r.amountMinor)).toEqual([120_000]);
    expect(result.reapplied.map((r) => r.amountMinor)).toEqual([100_000]);
    // Only the 200.00 this correction freed; the 85.00 was free already.
    expect(result.leftoverCredit).toEqual([
      {
        payment: expect.objectContaining({ recordId: payment.id }),
        amountMinor: 20_000,
      },
    ]);
    const after = getRecord(db, expense.id)!;
    expect(after.amountMinor).toBe(100_000);
    expect(after.outstandingMinor).toBe(0);
    expect(paySide(payment).settledMinor).toBe(100_000);
    expect(contactBalances(db, "we-owe", acme)[0]?.creditsMinor).toBe(28_500);
  });

  it("corrects a settled income the same way, on the receivable side", () => {
    const income = value(
      createRecord(ctx, {
        kind: "income",
        date: day,
        amount: 500,
        currency: "MYR",
        exchangeRate: 1,
        description: "Acme sale",
        categoryAccountId: sales,
        receivedIntoAccountId: receivable,
        contactId: acme,
      }),
    ).record;
    const owed = income.movements.find((m) => m.accountId === receivable)!;
    const receipt = value(
      createRecord(ctx, {
        kind: "payment",
        date: day,
        amount: 550,
        currency: "MYR",
        exchangeRate: 1,
        description: "Acme receipt",
        paidFromAccountId: bank,
        contactId: acme,
        direction: "we-receive",
        settlements: [{ owedMovementId: owed.id, amountMinor: 50_000 }],
      }),
    ).record;
    const result = value(
      correctSettledAmount(ctx, {
        recordId: income.id,
        expectedVersion: version(income.id),
        amount: 550,
        reason,
      }),
    );
    expect(result.reapplied).toEqual([
      {
        payment: expect.objectContaining({ recordId: receipt.id }),
        amountMinor: 55_000,
      },
    ]);
    const after = getRecord(db, income.id)!;
    expect(after.kind).toBe(LedgerRecordKind.Income);
    expect(after.outstandingMinor).toBe(0);
    expect(
      after.movements.find((m) => m.accountId === receivable),
    ).toMatchObject({
      id: owed.id,
      amountMinor: 55_000,
    });
    expect(
      after.movements.find((m) => m.accountId === sales)?.amountMinor,
    ).toBe(-55_000);
    expect(accountBalanceMinor(db, receivable)).toBe(0);
  });

  it("reapplies two payments in their original order", () => {
    const expense = bill(1000);
    const first = pay(600, [{ owed: expense, minor: 60_000 }]);
    const second = pay(400, [{ owed: expense, minor: 40_000 }]);
    const result = value(
      correctSettledAmount(ctx, {
        recordId: expense.id,
        expectedVersion: version(expense.id),
        amount: 700,
        reason,
      }),
    );
    expect(
      result.reversed.map((r) => [r.payment.recordId, r.amountMinor]),
    ).toEqual([
      [first.id, 60_000],
      [second.id, 40_000],
    ]);
    // The first payment is applied in full before the second gets anything.
    expect(
      result.reapplied.map((r) => [r.payment.recordId, r.amountMinor]),
    ).toEqual([
      [first.id, 60_000],
      [second.id, 10_000],
    ]);
    expect(
      result.leftoverCredit.map((r) => [r.payment.recordId, r.amountMinor]),
    ).toEqual([[second.id, 30_000]]);
    expect(getRecord(db, expense.id)!.outstandingMinor).toBe(0);
  });

  it("gives each payment back what it had on this record before spreading free credit (review finding 3)", () => {
    const expense = bill(1200);
    // P1 is 1,000.00: 700.00 on this record and 300.00 free. P2 is 500.00, all on it.
    const p1 = pay(1000, [{ owed: expense, minor: 70_000 }]);
    const p2 = pay(500, [{ owed: expense, minor: 50_000 }]);
    expect(paySide(p1).amountMinor - paySide(p1).settledMinor).toBe(30_000);
    const result = value(
      correctSettledAmount(ctx, {
        recordId: expense.id,
        expectedVersion: version(expense.id),
        amount: 1100,
        reason,
      }),
    );
    expect(
      result.reapplied.map((r) => [r.payment.recordId, r.amountMinor]),
    ).toEqual([
      [p1.id, 70_000],
      [p2.id, 40_000],
    ]);
    // P1 keeps the 300.00 it already had free; only P2's 100.00 is new.
    expect(
      result.leftoverCredit.map((r) => [r.payment.recordId, r.amountMinor]),
    ).toEqual([[p2.id, 10_000]]);
    expect(paySide(p1).settledMinor).toBe(70_000);
    expect(paySide(p2).settledMinor).toBe(40_000);
    expect(getRecord(db, expense.id)!.outstandingMinor).toBe(0);
  });

  it("spreads an increase over the payments' free credit, oldest payment first", () => {
    const expense = bill(1200);
    const p1 = pay(1000, [{ owed: expense, minor: 70_000 }]);
    const p2 = pay(600, [{ owed: expense, minor: 50_000 }]);
    const result = value(
      correctSettledAmount(ctx, {
        recordId: expense.id,
        expectedVersion: version(expense.id),
        amount: 1450,
        reason,
      }),
    );
    // Each takes back its 700 and 500, then P1's 300 free and P2's 100 free
    // cover the 250 increase, P1's first.
    expect(
      result.reapplied.map((r) => [r.payment.recordId, r.amountMinor]),
    ).toEqual([
      [p1.id, 95_000],
      [p2.id, 50_000],
    ]);
    expect(result.leftoverCredit).toEqual([]);
    expect(
      settlementRows()
        .filter((row) => row.reversedAt === null)
        .map((row) => row.amountMinor)
        .sort((a, b) => a - b),
    ).toEqual([50_000, 95_000]);
  });

  it("refuses a split record without lines, and lines that do not add up", () => {
    const { expense } = freightCase();
    const split = value(
      correctSettledAmount(ctx, {
        recordId: expense.id,
        expectedVersion: version(expense.id),
        amount: 1285,
        lines: [
          { accountId: goods, amountMinor: 120_000 },
          { accountId: freight, amountMinor: 8_500 },
        ],
        reason,
      }),
    );
    const noLines = correctSettledAmount(ctx, {
      recordId: expense.id,
      expectedVersion: split.version,
      amount: 1300,
      reason,
    });
    expect(noLines).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    const wrongSum = correctSettledAmount(ctx, {
      recordId: expense.id,
      expectedVersion: split.version,
      amount: 1300,
      lines: [{ accountId: goods, amountMinor: 120_000 }],
      reason,
    });
    expect(wrongSum).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    const bankLine = correctSettledAmount(ctx, {
      recordId: expense.id,
      expectedVersion: split.version,
      amount: 1300,
      lines: [{ accountId: bank, amountMinor: 130_000 }],
      reason,
    });
    expect(bankLine).toMatchObject({ ok: false, code: "REFUSED" });
  });

  it("refuses an unsettled record, a voided one and a closed month", () => {
    const open = bill(50);
    const unsettled = correctSettledAmount(ctx, {
      recordId: open.id,
      expectedVersion: version(open.id),
      amount: 60,
      reason,
    });
    expect(unsettled).toMatchObject({ ok: false, code: "REFUSED" });
    expect(!unsettled.ok && unsettled.reason).toMatch(/ordinary update/);

    const voided = value(
      voidRecord(ctx, open.id, {
        reason: "Entered twice by mistake.",
        expectedVersion: value(prepareVoidRecord(ctx, open.id)).version,
      }),
    );
    const onVoided = correctSettledAmount(ctx, {
      recordId: open.id,
      expectedVersion: voided.version,
      amount: 60,
      reason,
    });
    expect(onVoided).toMatchObject({ ok: false, code: "REFUSED" });

    const { expense } = freightCase();
    const v = version(expense.id);
    setSetting(db, SETTING_KEYS.accountingClosedThrough, "2026-10-31");
    const before = snapshot();
    const closed = correctSettledAmount(ctx, {
      recordId: expense.id,
      expectedVersion: v,
      amount: 1285,
      reason,
    });
    expect(closed).toMatchObject({ ok: false, code: "REFUSED" });
    expect(!closed.ok && closed.reason).toMatch(/closed through 2026-10-31/);
    expect(snapshot()).toEqual(before);
  });

  it("gives CONFLICT with the current version when expectedVersion is stale", () => {
    const { expense } = freightCase();
    const before = snapshot();
    const stale = correctSettledAmount(ctx, {
      recordId: expense.id,
      expectedVersion: "stale-version",
      amount: 1285,
      reason,
    });
    expect(stale).toMatchObject({
      ok: false,
      code: "CONFLICT",
      currentVersion: version(expense.id),
    });
    expect(snapshot()).toEqual(before);
  });

  it("refuses a caller without the correction permissions, before any lookup", () => {
    const { expense } = freightCase();
    for (const missing of [
      ["records.update"],
      ["records.create"],
      ["records.correctAllocations", "records.delete"],
    ]) {
      const leaves = LEAF_PERMISSIONS.filter((p) => !missing.includes(p));
      const limited = { db, locals: localsFor(leaves, { userId: 1 }) };
      for (const recordId of [expense.id, 999_999]) {
        const result = correctSettledAmount(limited, {
          recordId,
          expectedVersion: "x",
          amount: 1285,
          reason,
        });
        expect(result).toMatchObject({ ok: false, code: "FORBIDDEN" });
      }
    }
    // Either correction ability is enough.
    const viaDelete = {
      db,
      locals: localsFor(
        LEAF_PERMISSIONS.filter((p) => p !== "records.correctAllocations"),
        { userId: 1 },
      ),
    };
    expect(
      correctSettledAmount(viaDelete, {
        recordId: expense.id,
        expectedVersion: version(expense.id),
        amount: 1285,
        reason,
      }).ok,
    ).toBe(true);
    const noMatch = {
      db,
      locals: localsFor(
        LEAF_PERMISSIONS.filter((p) => p !== "reconciliation.match"),
        { userId: 1 },
      ),
    };
    expect(
      correctSettledAmount(noMatch, {
        recordId: expense.id,
        expectedVersion: "x",
        amount: 1300,
        reason,
        releaseBankMatches: true,
      }),
    ).toMatchObject({ ok: false, code: "FORBIDDEN" });
  });

  it("refuses a bank-matched record without releaseBankMatches, and unmatches and rematches with it", () => {
    const { expense } = freightCase();
    const owedId = owedSide(expense).id;
    // A statement on the owed account, so the settled side itself is matched.
    const lineId = statementLine(payable, 1300);
    db.insert(schema.reconciliationAllocations)
      .values({
        lineId,
        movementId: owedId,
        amount: 1200,
        itemAmountSnapshot: 1200,
        createdBy: 1,
      })
      .run();
    const preview = value(prepareSettledAmountCorrection(ctx, expense.id));
    expect(preview.bankMatches).toHaveLength(1);
    expect(preview.blockers.join(" ")).toMatch(/releaseBankMatches/);
    const refused = correctSettledAmount(ctx, {
      recordId: expense.id,
      expectedVersion: preview.version,
      amount: 1285,
      reason,
    });
    expect(refused).toMatchObject({ ok: false, code: "REFUSED" });
    expect(!refused.ok && refused.reason).toMatch(/releaseBankMatches/);

    const result = value(
      correctSettledAmount(ctx, {
        recordId: expense.id,
        expectedVersion: preview.version,
        amount: 1285,
        reason,
        releaseBankMatches: true,
      }),
    );
    // Matched again in full, up to what the line had: 1,285.00 of 1,300.00.
    expect(result.rematched).toEqual([
      {
        line: expect.objectContaining({ lineId, movementId: owedId }),
        amountMinor: 128_500,
      },
    ]);
    const matches = db.select().from(schema.reconciliationAllocations).all();
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      lineId,
      movementId: owedId,
      amount: 1285,
    });
  });

  it("dryRun reports the same result and leaves every table unchanged", () => {
    const { expense } = freightCase();
    const v = version(expense.id);
    const before = snapshot();
    const emitted: number[] = [];
    const listener = ({ record }: { record: RecordView }) =>
      emitted.push(record.id);
    ledgerEvents.on("record-update", listener);
    let dry;
    try {
      dry = value(
        correctSettledAmount(
          ctx,
          {
            recordId: expense.id,
            expectedVersion: v,
            amount: 1285,
            lines: [
              { accountId: goods, amountMinor: 120_000 },
              { accountId: freight, amountMinor: 8_500 },
            ],
            reason,
          },
          { dryRun: true },
        ),
      );
    } finally {
      ledgerEvents.off("record-update", listener);
    }
    expect(snapshot()).toEqual(before);
    expect(emitted).toEqual([]);
    expect(dry.reversed.map((r) => r.amountMinor)).toEqual([120_000]);
    expect(dry.reapplied.map((r) => r.amountMinor)).toEqual([128_500]);
    expect(dry.record.amountMinor).toBe(128_500);
    // The real run, from the same version, gives the same answer.
    const real = value(
      correctSettledAmount(ctx, {
        recordId: expense.id,
        expectedVersion: v,
        amount: 1285,
        lines: [
          { accountId: goods, amountMinor: 120_000 },
          { accountId: freight, amountMinor: 8_500 },
        ],
        reason,
      }),
    );
    expect(real.reapplied.map((r) => r.amountMinor)).toEqual([128_500]);
  });

  it("persists nothing when called inside an outer transaction that throws", () => {
    const { expense } = freightCase();
    const v = version(expense.id);
    const before = snapshot();
    class Sentinel extends Error {}
    const sentinel = new Sentinel("roll it back");
    let caught: unknown;
    try {
      db.transaction(() => {
        const inner = correctSettledAmount(ctx, {
          recordId: expense.id,
          expectedVersion: v,
          amount: 1285,
          reason,
        });
        expect(inner.ok).toBe(true);
        expect(getRecord(db, expense.id)!.amountMinor).toBe(128_500);
        throw sentinel;
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(sentinel);
    expect(sqlite.inTransaction).toBe(false);
    expect(snapshot()).toEqual(before);
  });
});

describe("voidRecord release", () => {
  function voidWith(id: number, release?: "none" | "allocations" | "all") {
    return voidRecord(ctx, id, {
      reason: "Not a claimable company expense.",
      expectedVersion: value(prepareVoidRecord(ctx, id)).version,
      ...(release ? { release } : {}),
    });
  }

  it("refuses an allocated expense without release, exactly as before", () => {
    const { expense } = freightCase();
    const preview = value(prepareVoidRecord(ctx, expense.id));
    expect(preview.blockedReason).toMatch(/Reverse the allocation/);
    expect("release" in preview).toBe(false);
    const before = snapshot();
    const result = voidWith(expense.id);
    expect(result).toMatchObject({ ok: false, code: "REFUSED" });
    expect(snapshot()).toEqual(before);
  });

  it("voids an allocated expense with release allocations; the payment becomes credit", () => {
    const { expense, payment } = freightCase();
    const preview = value(
      prepareVoidRecord(ctx, expense.id, { release: "allocations" }),
    );
    expect(preview.blockedReason).toBeNull();
    expect(preview.release?.allocations).toEqual([
      expect.objectContaining({
        side: "owed",
        otherRecordId: payment.id,
        amountMinor: 120_000,
      }),
    ]);
    const result = value(voidWith(expense.id, "allocations"));
    expect(result.reversal.reversesRecordId).toBe(expense.id);
    expect(result.released?.allocations).toHaveLength(1);
    expect(getRecord(db, expense.id)!.voidedByRecordId).toBe(
      result.reversal.id,
    );
    expect(paySide(payment).settledMinor).toBe(0);
    expect(contactBalances(db, "we-owe", acme)[0]?.creditsMinor).toBe(128_500);
    const rows = settlementRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].reversedAt).not.toBeNull();
    expect(
      auditFor(expense.id).some((a) =>
        a.changes?.includes("releasedAllocations"),
      ),
    ).toBe(true);
  });

  it("voids the payment side with release allocations; the expense is owed again", () => {
    const { expense, payment } = freightCase();
    value(voidWith(payment.id, "allocations"));
    expect(getRecord(db, expense.id)!.outstandingMinor).toBe(120_000);
  });

  it("needs a correction ability for release, and reconciliation.match for all", () => {
    const { expense } = freightCase();
    const noCorrection = {
      db,
      locals: localsFor(
        LEAF_PERMISSIONS.filter(
          (p) => p !== "records.correctAllocations" && p !== "records.delete",
        ),
        { userId: 1 },
      ),
    };
    expect(
      voidRecord(noCorrection, expense.id, {
        reason: "Not a claimable company expense.",
        expectedVersion: "x",
        release: "allocations",
      }),
    ).toMatchObject({ ok: false, code: "FORBIDDEN" });
    const noMatch = {
      db,
      locals: localsFor(
        LEAF_PERMISSIONS.filter((p) => p !== "reconciliation.match"),
        { userId: 1 },
      ),
    };
    expect(
      voidRecord(noMatch, expense.id, {
        reason: "Not a claimable company expense.",
        expectedVersion: "x",
        release: "all",
      }),
    ).toMatchObject({ ok: false, code: "FORBIDDEN" });
  });

  it("release all voids a bank-matched record; allocations alone still refuses it", () => {
    const expense = value(
      createRecord(ctx, {
        kind: "expense",
        date: day,
        amount: 40,
        currency: "MYR",
        exchangeRate: 1,
        description: "Paid from the bank",
        categoryAccountId: goods,
        paidFromAccountId: bank,
      }),
    ).record;
    const bankSide = expense.movements.find((m) => m.accountId === bank)!;
    const lineId = statementLine(bank, 40);
    db.insert(schema.reconciliationAllocations)
      .values({
        lineId,
        movementId: bankSide.id,
        amount: 40,
        itemAmountSnapshot: 40,
        createdBy: 1,
      })
      .run();
    const partial = voidWith(expense.id, "allocations");
    expect(partial).toMatchObject({ ok: false, code: "REFUSED" });
    expect(!partial.ok && partial.reason).toMatch(/release its bank matches/);
    const preview = value(
      prepareVoidRecord(ctx, expense.id, { release: "all" }),
    );
    expect(preview.blockedReason).toBeNull();
    expect(preview.release?.bankMatches).toEqual([
      { movementId: bankSide.id, lineId, amount: 40 },
    ]);
    const result = value(voidWith(expense.id, "all"));
    expect(result.released?.bankMatches).toHaveLength(1);
    expect(db.select().from(schema.reconciliationAllocations).all()).toEqual(
      [],
    );
    expect(getRecord(db, expense.id)!.voidedByRecordId).toBe(
      result.reversal.id,
    );
  });

  it("still refuses a closed month and rolls the release back", () => {
    const { expense } = freightCase();
    const v = value(prepareVoidRecord(ctx, expense.id)).version;
    setSetting(db, SETTING_KEYS.accountingClosedThrough, "2026-10-31");
    const before = snapshot();
    const result = voidRecord(ctx, expense.id, {
      reason: "Not a claimable company expense.",
      expectedVersion: v,
      release: "allocations",
    });
    expect(result).toMatchObject({ ok: false, code: "REFUSED" });
    expect(!result.ok && result.reason).toMatch(/2026-10-31/);
    expect(snapshot()).toEqual(before);
  });
});
