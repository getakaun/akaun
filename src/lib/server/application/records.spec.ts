import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AccountSubType,
  AccountType,
  DefaultAccountPurpose,
  LedgerRecordKind,
  StatementDirection,
} from "$lib/enums.js";
import * as schema from "../db/schema.js";
import {
  accountDefaults,
  auditLog,
  contacts,
  ledgerMovements,
  ledgerRecords,
  recordAttachments,
  settlements,
  users,
} from "../db/schema.js";
import { createAccount } from "../services/accounts.js";
import { ledgerEvents } from "../ledger/events.js";
import { LEAF_PERMISSIONS } from "$lib/permissions/catalog.js";
import { localsFor } from "../permissions/test-locals.js";
import type { LedgerDb } from "../ledger/types.js";
import type { AppContext } from "./context.js";
import { createRecord, deleteRecord, updateRecord } from "./records.js";
import { recordVersion, recordVersions } from "./version.js";
import { setExtractedText } from "../queries/ledger.js";
import { getRecord } from "../queries/ledger.js";
import {
  correctRecordDate,
  prepareRecordDateCorrection,
} from "./record-date-correction.js";
import { accountTotalsBetween, accountTotalsUpTo } from "../queries/reports.js";
import { runInAuditScope, scopeFromLocals } from "../audit-context.js";

let sqlite: Database;
let db: LedgerDb;
const userId = 1;
let bank: number;
let savings: number;
let fuel: number;
let paper: number;
let payable: number;
let equity: number;
let supplier: number;

function account(name: string, type: number, subType?: number) {
  const result = createAccount(db, userId, {
    name,
    type: type as never,
    subType: subType as never,
  });
  if (!result.ok) throw new Error(result.reason);
  return result.value.id;
}

/** Every permission except the ones `deny` names. */
function ctx(deny: string[] = []): AppContext {
  return {
    db,
    locals: localsFor(
      LEAF_PERMISSIONS.filter((leaf) => !deny.includes(leaf)),
      {
        userId,
      },
    ),
  };
}

const base = {
  date: "2026-03-01",
  description: "Fuel",
  amount: 50,
  currency: "MYR",
  exchangeRate: 1,
};

beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema }) as unknown as LedgerDb;
  migrate(db as never, { migrationsFolder: "drizzle" });
  db.insert(users)
    .values({ email: "u@test", username: "u", passwordHash: "x" })
    .run();
  bank = account("Bank", AccountType.Asset, AccountSubType.Bank);
  savings = account("Savings", AccountType.Asset, AccountSubType.Bank);
  fuel = account("Fuel", AccountType.Expense);
  paper = account("Paper", AccountType.Expense);
  equity = account("Owner capital", AccountType.Equity);
  const receivable = account(
    "Accounts Receivable",
    AccountType.Asset,
    AccountSubType.Receivable,
  );
  payable = account(
    "Accounts Payable",
    AccountType.Liability,
    AccountSubType.AccountsPayable,
  );
  const opening = account("Opening Balances", AccountType.Equity);
  db.insert(accountDefaults)
    .values([
      {
        purpose: DefaultAccountPurpose.Receivable,
        accountId: receivable,
        updatedBy: userId,
      },
      {
        purpose: DefaultAccountPurpose.Payable,
        accountId: payable,
        updatedBy: userId,
      },
      {
        purpose: DefaultAccountPurpose.OpeningBalances,
        accountId: opening,
        updatedBy: userId,
      },
    ])
    .run();
  supplier = db
    .insert(contacts)
    .values({ entityType: 2, legalName: "Supplier" })
    .returning({ id: contacts.id })
    .get().id;
});
afterEach(() => sqlite.close());

describe("createRecord", () => {
  it("derives an everyday expense from two accounts", () => {
    const result = createRecord(ctx(), {
      ...base,
      fromAccountId: bank,
      toAccountId: fuel,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.record.movements).toHaveLength(2);
    expect(result.value.version).toBe(
      recordVersion(db, result.value.record.id),
    );
  });

  it("gates a journal sent with an explicit kind on adjustments", () => {
    const journal = {
      ...base,
      kind: "journal" as const,
      movements: [
        { accountId: bank, amountMinor: -5000 },
        { accountId: equity, amountMinor: 5000 },
      ],
    };
    const refused = createRecord(ctx(["records.adjust"]), journal);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("FORBIDDEN");
    expect(db.select().from(ledgerRecords).all()).toHaveLength(0);
    expect(createRecord(ctx(), journal).ok).toBe(true);
  });

  it("gates two money pots with a third side, but not a split bill", () => {
    const noAdjust = ctx(["records.adjust"]);
    const split = createRecord(noAdjust, {
      ...base,
      fromAccountId: bank,
      toAccountId: fuel,
      extraSides: [{ accountId: paper, amountMinor: 1000 }],
      categoryAmountMinor: 4000,
    });
    expect(split.ok).toBe(true);
    const rearrange = createRecord(noAdjust, {
      ...base,
      fromAccountId: bank,
      toAccountId: fuel,
      extraSides: [{ accountId: savings, amountMinor: 1000 }],
      categoryAmountMinor: 4000,
    });
    expect(rearrange.ok).toBe(false);
  });

  it("refuses an opening balance or invoice posting through this door", () => {
    const result = createRecord(ctx(), {
      ...base,
      kind: "opening-balance",
      accountId: bank,
    });
    expect(result.ok).toBe(false);
  });

  it("keeps a payment and its settlements together or not at all", () => {
    const bill = createRecord(ctx(), {
      ...base,
      kind: "expense",
      categoryAccountId: fuel,
      paidFromAccountId: null,
      contactId: supplier,
    });
    if (!bill.ok) throw new Error(bill.reason);
    const owed = bill.value.record.movements.find(
      (m) => m.accountId === payable,
    )!;

    let events = 0;
    const listener = () => events++;
    ledgerEvents.on("record-update", listener);
    try {
      const tooMuch = createRecord(ctx(), {
        ...base,
        kind: "payment",
        paidFromAccountId: bank,
        contactId: supplier,
        direction: "we-pay",
        settlements: [{ owedMovementId: owed.id, amountMinor: 999_999 }],
      });
      expect(tooMuch.ok).toBe(false);
      expect(db.select().from(ledgerRecords).all()).toHaveLength(1);
      expect(events).toBe(0);

      const paid = createRecord(ctx(), {
        ...base,
        kind: "payment",
        paidFromAccountId: bank,
        contactId: supplier,
        direction: "we-pay",
        settlements: [{ owedMovementId: owed.id, amountMinor: 5000 }],
      });
      expect(paid.ok).toBe(true);
      expect(db.select().from(settlements).all()).toHaveLength(1);
      expect(events).toBeGreaterThan(0);
    } finally {
      ledgerEvents.off("record-update", listener);
    }
  });

  it("stores nothing and emits nothing on a dry run", () => {
    const auditBefore = db.select().from(auditLog).all().length;
    let events = 0;
    const listener = () => events++;
    ledgerEvents.on("record-update", listener);
    try {
      const result = createRecord(
        ctx(),
        { ...base, fromAccountId: bank, toAccountId: fuel },
        { dryRun: true },
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.record.movements).toHaveLength(2);
    } finally {
      ledgerEvents.off("record-update", listener);
    }
    expect(events).toBe(0);
    expect(db.select().from(ledgerRecords).all()).toHaveLength(0);
    expect(db.select().from(auditLog).all()).toHaveLength(auditBefore);
  });
});

describe("updateRecord", () => {
  function expense() {
    const result = createRecord(ctx(), {
      ...base,
      fromAccountId: bank,
      toAccountId: fuel,
    });
    if (!result.ok) throw new Error(result.reason);
    return result.value;
  }

  it("refuses a stale version and leaves the record as it was", () => {
    const written = expense();
    const first = updateRecord(
      ctx(),
      written.record.id,
      { description: "Diesel" },
      written.version,
    );
    expect(first.ok).toBe(true);
    const stale = updateRecord(
      ctx(),
      written.record.id,
      { description: "Petrol" },
      written.version,
    );
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.code).toBe("CONFLICT");
      expect(stale.currentVersion).toBe(recordVersion(db, written.record.id));
    }
  });

  it("gates extra lines restated without both accounts", () => {
    const written = expense();
    const refused = updateRecord(ctx(["records.adjust"]), written.record.id, {
      extraSides: [{ accountId: savings, amountMinor: 1000 }],
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("FORBIDDEN");

    const everyday = updateRecord(ctx(["records.adjust"]), written.record.id, {
      extraSides: [{ accountId: paper, amountMinor: 1000 }],
    });
    expect(everyday.ok).toBe(true);
  });

  it("checks records:change and records:delete", () => {
    const written = expense();
    const change = updateRecord(ctx(["records.update"]), written.record.id, {
      description: "x",
    });
    expect(change.ok).toBe(false);
    const remove = deleteRecord(ctx(["records.delete"]), written.record.id);
    expect(remove.ok).toBe(false);
    if (!remove.ok) expect(remove.code).toBe("FORBIDDEN");
    expect(deleteRecord(ctx(), written.record.id).ok).toBe(true);
  });
});

describe("the adjustments gate on kinds and single accounts", () => {
  const noAdjust = () => ctx(["records.adjust"]);

  it("refuses an explicit expense paid from equity, or a payment out of a category", () => {
    const expense = createRecord(noAdjust(), {
      ...base,
      kind: "expense",
      categoryAccountId: fuel,
      paidFromAccountId: equity,
    });
    expect(expense.ok).toBe(false);
    if (!expense.ok) expect(expense.code).toBe("FORBIDDEN");
    const payment = createRecord(noAdjust(), {
      ...base,
      kind: "payment",
      paidFromAccountId: fuel,
      contactId: supplier,
      direction: "we-pay",
      settlements: [],
    });
    expect(payment.ok).toBe(false);
    const transfer = createRecord(noAdjust(), {
      ...base,
      kind: "transfer",
      fromAccountId: bank,
      toAccountId: savings,
    });
    expect(transfer.ok).toBe(true);
    expect(db.select().from(ledgerRecords).all()).toHaveLength(1);
  });

  it("refuses an explicit transfer the two accounts would not make", () => {
    const sales = account("Sales", AccountType.Revenue);
    // Revenue into the bank derives income, and equity into it derives a
    // journal: filed as a "transfer", either is an adjustment.
    for (const fromAccountId of [sales, equity]) {
      const transfer = createRecord(noAdjust(), {
        ...base,
        kind: "transfer",
        fromAccountId,
        toAccountId: bank,
      });
      expect(transfer.ok).toBe(false);
      if (!transfer.ok) expect(transfer.code).toBe("FORBIDDEN");
    }
    expect(db.select().from(ledgerRecords).all()).toHaveLength(0);
  });

  it("refuses moving one side of an expense onto equity without the ability", () => {
    const written = createRecord(ctx(), {
      ...base,
      fromAccountId: bank,
      toAccountId: fuel,
    });
    if (!written.ok) throw new Error(written.reason);
    const id = written.value.record.id;
    const onEquity = updateRecord(noAdjust(), id, {
      categoryAccountId: equity,
    });
    expect(onEquity.ok).toBe(false);
    if (!onEquity.ok) expect(onEquity.code).toBe("FORBIDDEN");
    const paidFromCategory = updateRecord(noAdjust(), id, {
      paidFromAccountId: paper,
    });
    expect(paidFromCategory.ok).toBe(false);
    expect(updateRecord(noAdjust(), id, { categoryAccountId: paper }).ok).toBe(
      true,
    );
    expect(updateRecord(ctx(), id, { categoryAccountId: equity }).ok).toBe(
      true,
    );
  });

  it("keeps a record's version when only its search text is rewritten", () => {
    const written = createRecord(ctx(), {
      ...base,
      fromAccountId: bank,
      toAccountId: fuel,
    });
    if (!written.ok) throw new Error(written.reason);
    setExtractedText(db, written.value.record.id, "OCR text");
    expect(recordVersion(db, written.value.record.id)).toBe(
      written.value.version,
    );
  });
});

describe("record versions read in bulk", () => {
  /** The per-record hash as it was before the batch existed, kept verbatim. */
  function oneByOne(id: number): string {
    const found = db
      .select()
      .from(ledgerRecords)
      .where(eq(ledgerRecords.id, id))
      .get();
    if (!found) return "absent";
    const { extractedText: _searchText, ...row } = found;
    void _searchText;
    const movements = db
      .select({
        id: ledgerMovements.id,
        accountId: ledgerMovements.accountId,
        amountMinor: ledgerMovements.amountMinor,
        label: ledgerMovements.label,
      })
      .from(ledgerMovements)
      .where(eq(ledgerMovements.recordId, id))
      .orderBy(asc(ledgerMovements.id))
      .all();
    const attachments = db
      .select({ id: recordAttachments.id })
      .from(recordAttachments)
      .where(eq(recordAttachments.recordId, id))
      .orderBy(asc(recordAttachments.id))
      .all();
    return createHash("sha256")
      .update(JSON.stringify([row, movements, attachments]))
      .digest("hex")
      .slice(0, 16);
  }

  it("gives each record the version a single read gives, unchanged from before", () => {
    const ids = [fuel, paper].map((to) => {
      const written = createRecord(ctx(), {
        ...base,
        fromAccountId: bank,
        toAccountId: to,
      });
      if (!written.ok) throw new Error(written.reason);
      return written.value.record.id;
    });
    db.insert(recordAttachments)
      .values([
        { recordId: ids[0], filename: "a.pdf", displayName: "a.pdf" },
        { recordId: ids[0], filename: "b.pdf", displayName: "b.pdf" },
      ])
      .run();

    const batch = recordVersions(db, [...ids, 99_999]);
    for (const id of ids) {
      expect(batch[id]).toBe(recordVersion(db, id));
      expect(batch[id]).toBe(oneByOne(id));
    }
    expect(batch[99_999]).toBe("absent");
    expect(batch[ids[0]]).not.toBe(batch[ids[1]]);
    expect(recordVersions(db, [])).toEqual({});
  });
});

describe("controlled settled date correction", () => {
  function settled(income = false, allocation = 5000, foreign = false) {
    const revenue = income ? account("Sales", AccountType.Revenue) : fuel;
    const receivable = db
      .select()
      .from(accountDefaults)
      .where(eq(accountDefaults.purpose, DefaultAccountPurpose.Receivable))
      .get()!.accountId;
    const written = createRecord(ctx(), {
      ...base,
      currency: foreign ? "USD" : "MYR",
      exchangeRate: foreign ? 4 : 1,
      fromAccountId: income ? revenue : payable,
      toAccountId: income ? receivable : fuel,
      contactId: supplier,
    });
    if (!written.ok) throw new Error(written.reason);
    const owed = written.value.record.movements.find(
      (m) => m.accountId === (income ? receivable : payable),
    )!;
    const payment = createRecord(ctx(), {
      ...base,
      date: "2026-03-15",
      amount: allocation / 100,
      kind: "payment",
      direction: income ? "we-receive" : "we-pay",
      paidFromAccountId: bank,
      contactId: supplier,
      settlements: [{ owedMovementId: owed.id, amountMinor: allocation }],
    });
    if (!payment.ok) throw new Error(payment.reason);
    return { id: written.value.record.id, paymentId: payment.value.record.id };
  }

  function input(id: number, date = "2026-02-28") {
    return {
      date,
      reason: "Corrected against original receipt",
      expectedVersion: recordVersion(db, id),
      acknowledgePeriodChange: true,
    };
  }

  it.each([
    [false, 5000],
    [false, 2000],
    [true, 5000],
    [true, 2000],
  ])(
    "corrects expense/income (income=%s, allocated=%s) without touching money or payments",
    (income, allocation) => {
      const { id, paymentId } = settled(income, allocation);
      const before = getRecord(db, id)!;
      const payment = getRecord(db, paymentId)!;
      const allocations = db.select().from(settlements).all();
      const allTime = accountTotalsUpTo(db, "2099-12-31");
      const oldVersion = recordVersion(db, id);
      const result = correctRecordDate(ctx(), id, input(id));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.record.date).toBe("2026-02-28");
      expect(result.value.version).not.toBe(oldVersion);
      expect(result.value.version).toBe(recordVersion(db, id));
      expect(result.value.record.movements).toEqual(before.movements);
      expect(result.value.record.paid).toBe(before.paid);
      expect(result.value.record.outstandingMinor).toBe(
        before.outstandingMinor,
      );
      expect(result.value.record.locked).toBe(true);
      expect(getRecord(db, paymentId)).toEqual(payment);
      expect(db.select().from(settlements).all()).toEqual(allocations);
      expect(accountTotalsUpTo(db, "2099-12-31")).toEqual(allTime);
      const posted = income
        ? before.movements.find((m) => m.amountMinor < 0)!
        : before.movements.find((m) => m.accountId === fuel)!;
      expect(
        accountTotalsBetween(db, "2026-02-01", "2026-02-28").find(
          (a) => a.accountId === posted.accountId,
        )!.amountMinor,
      ).toBe(posted.amountMinor);
      expect(
        accountTotalsBetween(db, "2026-03-01", "2026-03-31").find(
          (a) => a.accountId === posted.accountId,
        )!.amountMinor,
      ).toBe(0);
    },
  );

  it("preserves foreign currency, exchange rate and stored amounts", () => {
    const { id } = settled(false, 10000, true);
    const before = getRecord(db, id)!;
    expect(correctRecordDate(ctx(), id, input(id)).ok).toBe(true);
    const after = getRecord(db, id)!;
    expect([
      after.currency,
      after.exchangeRate,
      after.amount,
      after.amountMinor,
      after.movements,
    ]).toEqual([
      before.currency,
      before.exchangeRate,
      before.amount,
      before.amountMinor,
      before.movements,
    ]);
  });

  it("requires the separate permission, ordinary update permission and browser authentication", () => {
    const { id } = settled();
    for (const denied of [
      "records.correctDate",
      "records.update",
      "records.read",
    ]) {
      expect(correctRecordDate(ctx([denied]), id, input(id))).toMatchObject({
        ok: false,
        code: "FORBIDDEN",
      });
    }
    const anonymous = ctx();
    anonymous.locals.user = null;
    expect(correctRecordDate(anonymous, id, input(id))).toMatchObject({
      code: "FORBIDDEN",
    });
    for (const credential of [
      { kind: "pat", tokenId: 1 },
      { kind: "oauth", grantId: "g", clientId: "c" },
    ] as const) {
      const context = ctx();
      context.locals.credential = credential;
      expect(correctRecordDate(context, id, input(id))).toMatchObject({
        code: "FORBIDDEN",
      });
      expect(prepareRecordDateCorrection(context, id)).toMatchObject({
        code: "FORBIDDEN",
      });
    }
    expect(updateRecord(ctx(), id, { date: "2026-02-28" })).toMatchObject({
      ok: false,
      code: "REFUSED",
    });
    expect(getRecord(db, id)!.date).toBe(base.date);
  });

  it.each([
    { date: "2026-02-30" },
    { date: "2026-3-2" },
    { date: base.date },
    { reason: "short" },
    { reason: "          " },
    { reason: "x".repeat(501) },
    { expectedVersion: undefined },
    { expectedVersion: "" },
    { acknowledgePeriodChange: undefined },
    { acknowledgePeriodChange: false },
    { amount: 99 },
    { exchangeRate: 2 },
  ])("rejects invalid or incomplete requests: %j", (patch) => {
    const { id } = settled();
    const before = db.select().from(auditLog).all();
    expect(
      correctRecordDate(ctx(), id, { ...input(id), ...patch }),
    ).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(getRecord(db, id)!.date).toBe(base.date);
    expect(db.select().from(auditLog).all()).toEqual(before);
  });

  it("allows same-month corrections without the period acknowledgement, and requires it across years", () => {
    const { id } = settled();
    expect(
      correctRecordDate(ctx(), id, {
        ...input(id, "2026-03-02"),
        acknowledgePeriodChange: false,
      }).ok,
    ).toBe(true);
    expect(
      correctRecordDate(ctx(), id, {
        ...input(id, "2025-12-31"),
        acknowledgePeriodChange: false,
      }),
    ).toMatchObject({ code: "INVALID_INPUT" });
    expect(correctRecordDate(ctx(), id, input(id, "2025-12-31")).ok).toBe(true);
  });

  it("requires a fresh version and a new reasoned correction for a subsequent change", () => {
    const { id } = settled();
    const request = input(id);
    expect(prepareRecordDateCorrection(ctx(), id)).toMatchObject({
      ok: true,
      value: { version: request.expectedVersion },
    });
    expect(correctRecordDate(ctx(), id, request).ok).toBe(true);
    expect(correctRecordDate(ctx(), id, request)).toMatchObject({
      code: "CONFLICT",
    });
    expect(correctRecordDate(ctx(), id, input(id, base.date)).ok).toBe(true);
  });

  it("refuses payment, invoice and unsettled records", () => {
    const { id, paymentId } = settled();
    expect(correctRecordDate(ctx(), paymentId, input(paymentId))).toMatchObject(
      { code: "REFUSED" },
    );
    db.update(ledgerRecords)
      .set({ kind: LedgerRecordKind.InvoiceIssue })
      .where(eq(ledgerRecords.id, id))
      .run();
    expect(correctRecordDate(ctx(), id, input(id))).toMatchObject({
      code: "REFUSED",
    });
    const ordinary = createRecord(ctx(), {
      ...base,
      fromAccountId: bank,
      toAccountId: fuel,
    });
    if (!ordinary.ok) throw new Error(ordinary.reason);
    expect(
      correctRecordDate(
        ctx(),
        ordinary.value.record.id,
        input(ordinary.value.record.id),
      ),
    ).toMatchObject({ code: "REFUSED" });
    expect(correctRecordDate(ctx(), 999999, input(id))).toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("rechecks new partial bank matches even when the version is unchanged", () => {
    const { id } = settled();
    const request = input(id);
    const statement = db
      .insert(schema.bankStatements)
      .values({
        originalFilename: "test.pdf",
        storedFilePath: "test.pdf",
        accountId: payable,
      })
      .returning()
      .get();
    const line = db
      .insert(schema.bankStatementLines)
      .values({
        statementId: statement.id,
        date: base.date,
        amount: 50,
        direction: StatementDirection.Out,
      })
      .returning()
      .get();
    const movement = getRecord(db, id)!.movements.find(
      (m) => m.accountId === payable,
    )!;
    db.insert(schema.reconciliationAllocations)
      .values({
        lineId: line.id,
        movementId: movement.id,
        amount: 1,
        itemAmountSnapshot: 50,
      })
      .run();
    expect(recordVersion(db, id)).toBe(request.expectedVersion);
    expect(getRecord(db, id)!.cleared).toBe(false);
    expect(correctRecordDate(ctx(), id, request)).toMatchObject({
      code: "REFUSED",
      reason: expect.stringContaining("Unmatch"),
    });
  });

  it("rechecks settlement removal even when the version is unchanged", () => {
    const { id } = settled();
    const request = input(id);
    db.delete(settlements).run();
    expect(recordVersion(db, id)).toBe(request.expectedVersion);
    expect(correctRecordDate(ctx(), id, request)).toMatchObject({
      code: "REFUSED",
    });
  });

  it("records one audit entry and emits the corrected record after commit", () => {
    const { id } = settled();
    const before = db.select().from(auditLog).all().length;
    const seen: string[] = [];
    const listener = ({ record }: { record: { id: number; date: string } }) => {
      if (record.id === id) {
        expect(sqlite.inTransaction).toBe(false);
        seen.push(record.date);
      }
    };
    ledgerEvents.on("record-update", listener);
    try {
      const context = ctx();
      const scope = scopeFromLocals(
        context.locals,
        "POST /api/records/1/date-correction",
      );
      expect(
        runInAuditScope(scope, () =>
          correctRecordDate(context, id, {
            ...input(id),
            reason: "  Original receipt has February date  ",
          }),
        ).ok,
      ).toBe(true);
      const entries = db.select().from(auditLog).all();
      expect(entries).toHaveLength(before + 1);
      const entry = entries.at(-1)!;
      expect(entry).toMatchObject({
        recordType: "record",
        recordId: String(id),
        userId,
        via: "session",
      });
      expect(JSON.parse(entry.changes!)).toEqual([
        { field: "date", before: base.date, after: "2026-02-28" },
        {
          field: "dateCorrectionReason",
          before: null,
          after: "Original receipt has February date",
        },
      ]);
      expect(seen).toEqual(["2026-02-28"]);
    } finally {
      ledgerEvents.off("record-update", listener);
    }
  });

  it("rolls back the date and emits nothing if audit insertion fails", () => {
    const { id } = settled();
    const request = input(id);
    const before = getRecord(db, id);
    sqlite.exec(
      "CREATE TRIGGER reject_correction_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END",
    );
    let events = 0;
    const listener = () => events++;
    ledgerEvents.on("record-update", listener);
    try {
      expect(() => correctRecordDate(ctx(), id, request)).toThrow(
        "audit unavailable",
      );
      expect(getRecord(db, id)).toEqual(before);
      expect(recordVersion(db, id)).toBe(request.expectedVersion);
      expect(events).toBe(0);
    } finally {
      ledgerEvents.off("record-update", listener);
    }
  });
});
