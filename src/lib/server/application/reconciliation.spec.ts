import { createHash } from "node:crypto";
import type { EventEmitter } from "node:events";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import {
  AccountSubType,
  AccountType,
  DefaultAccountPurpose,
  LedgerRecordKind,
  StatementDirection,
  StatementExtractionState,
  type AccountSubTypeCode,
  type AccountTypeCode,
  type StatementDirectionCode,
} from "$lib/enums.js";
import * as schema from "../db/schema.js";
import { accountEvents, ledgerEvents } from "../ledger/events.js";
import type { RecordView } from "../ledger/types.js";
import { reconciliationEvents } from "../reconciliation/events.js";
import { auditEvents } from "../audit-events.js";
import { localsFor } from "../permissions/test-locals.js";
import { getRecord } from "../queries/ledger.js";
import { createAccount } from "../services/accounts.js";
import { ensureReimbursementsPayableAccount } from "../services/account-defaults.js";
import { contactBalances } from "../queries/settlements.js";
import { SETTING_KEYS, setSetting } from "../settings.js";
import { runUnitOfWork } from "../unit-of-work.js";
import { runBatch } from "./batch.js";
import type { AppContext } from "./context.js";
import { releaseBook, resultValue } from "./__fixtures__/release-book.js";
import { createRecord } from "./records.js";
import { setOpeningBalance } from "./accounts.js";
import {
  autoMatchTolerant,
  createRecordFromLines,
  recordTransferFromLine,
  setMovementMatches,
} from "./reconciliation.js";
import { statementLineVersion } from "./version.js";

/**
 * B6: a record of any everyday kind made from bank lines and matched to them
 * in one transaction, and tolerant one-to-one automatic matching. Every spec
 * runs against its own migrated in-memory book (`releaseBook`), never
 * `db/client.ts`.
 */

type Book = ReturnType<typeof releaseBook>;
let book: Book | undefined;
afterEach(() => {
  book?.raw.close();
  book = undefined;
});

function statementOn(db: Book["db"], accountId: number) {
  return db
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
}

function seed() {
  book = releaseBook();
  const { db, bank } = book;
  const account = (
    name: string,
    type: AccountTypeCode,
    subType?: AccountSubTypeCode,
  ) => resultValue(createAccount(db, 1, { name, type, subType })).id;
  const defaultFor = (purpose: number) =>
    db
      .select()
      .from(schema.accountDefaults)
      .where(eq(schema.accountDefaults.purpose, purpose))
      .get()!.accountId;
  const statementId = statementOn(db, bank);
  return {
    ...book,
    interest: account("Interest received", AccountType.Revenue),
    charges: account("Bank charges", AccountType.Expense),
    cash: account("Petty cash", AccountType.Asset, AccountSubType.Cash),
    payable: defaultFor(DefaultAccountPurpose.Payable),
    equity: defaultFor(DefaultAccountPurpose.OpeningBalances),
    supplier: db
      .insert(schema.contacts)
      .values({ legalName: "Acme Supplies Sdn Bhd", entityType: 2 })
      .returning()
      .get()!.id,
    statementId,
    /** A line on the bank statement; returns its id. */
    line: (
      date: string,
      amount: number,
      direction: StatementDirectionCode,
      description = "",
      onStatement = statementId,
    ) =>
      db
        .insert(schema.bankStatementLines)
        .values({
          statementId: onStatement,
          date,
          amount,
          direction,
          description,
        })
        .returning()
        .get()!.id,
  };
}
type Seeded = ReturnType<typeof seed>;

const OUT = StatementDirection.Out;
const IN = StatementDirection.In;

/** An expense paid from the bank, as an everyday record a line could be. */
function spend(s: Seeded, date: string, amount: number): RecordView {
  return resultValue(
    createRecord(s.ctx, {
      kind: "expense",
      date,
      amount,
      currency: "MYR",
      exchangeRate: 1,
      description: "Software subscription",
      categoryAccountId: s.charges,
      paidFromAccountId: s.bank,
    }),
  ).record;
}

/** A supplier bill nobody has paid yet, owed through Payable. */
function unpaidBill(s: Seeded, amount: number): RecordView {
  return resultValue(
    createRecord(s.ctx, {
      kind: "expense",
      date: "2026-09-01",
      amount,
      currency: "MYR",
      exchangeRate: 1,
      description: "Paper and toner",
      categoryAccountId: s.charges,
      paidFromAccountId: null,
      contactId: s.supplier,
      supplierContactId: s.supplier,
      expensePaymentSource: "unpaid",
    }),
  ).record;
}

const bankSide = (s: Seeded, record: RecordView) =>
  record.movements.find((m) => m.accountId === s.bank)!.id;

/** account id → signed cents, for a record with one side per account. */
const sides = (record: RecordView) =>
  Object.fromEntries(record.movements.map((m) => [m.accountId, m.amountMinor]));

function allocationsOf(s: Seeded, lineId: number) {
  return s.db
    .select()
    .from(schema.reconciliationAllocations)
    .where(eq(schema.reconciliationAllocations.lineId, lineId))
    .all();
}

/** The audit rows that record a bank match on this record. */
function matchAudits(s: Seeded, recordId: number) {
  return s.db
    .select()
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.recordType, "record"),
        eq(schema.auditLog.recordId, String(recordId)),
      ),
    )
    .all()
    .filter((row) => row.changes?.includes('"allocations:movement:'));
}

const count = (s: Seeded, table: string) =>
  (
    s.raw.query(`SELECT COUNT(*) AS n FROM "${table}"`).get() as {
      n: number;
    }
  ).n;

/** Row count and an order-independent digest of every row, per table. */
function snapshot(
  s: Seeded,
): Record<string, { count: number; digest: string }> {
  const names = (
    s.raw
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[]
  ).map((r) => r.name);
  const out: Record<string, { count: number; digest: string }> = {};
  for (const name of names) {
    const rows = s.raw
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

/** Lets `recordAudit`'s queued microtask emits run before anything is asserted. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Every event actually delivered to a listener from now on. A listener, not a
 * patched `emit`: inside a unit of work `emit` queues, and only delivery
 * counts. The setup's own audit emits are queued microtasks, so they are let
 * through first rather than counted.
 */
async function deliveries() {
  await settle();
  const watched: [string, EventEmitter, string][] = [
    ["ledger", ledgerEvents, "record-update"],
    ["ledger", ledgerEvents, "settlement-changed"],
    ["account", accountEvents, "account-update"],
    ["reconciliation", reconciliationEvents, "allocation-update"],
    ["reconciliation", reconciliationEvents, "allocations-bulk-update"],
    ["audit", auditEvents, "entry-added"],
  ];
  const fired: string[] = [];
  const stops = watched.map(([label, emitter, event]) => {
    const listener = () => fired.push(`${label}:${event}`);
    emitter.on(event, listener);
    return () => emitter.off(event, listener);
  });
  return { fired, stop: () => stops.forEach((stop) => stop()) };
}

class Sentinel extends Error {}

describe("createRecordFromLines", () => {
  it("records an unmatched interest line as income on a category and matches it", () => {
    const s = seed();
    const lineId = s.line("2026-09-30", 1.37, IN, "INTEREST CREDIT");
    const linesBefore = snapshot(s).bank_statement_lines;

    const made = resultValue(
      createRecordFromLines(s.ctx, {
        lineIds: [lineId],
        kind: "income",
        categoryAccountId: s.interest,
      }),
    );

    expect(made.record).toMatchObject({
      kind: LedgerRecordKind.Income,
      date: "2026-09-30",
      description: "INTEREST CREDIT",
      amountMinor: 137,
      reconciled: true,
      cleared: true,
    });
    expect(sides(made.record)).toEqual({ [s.bank]: 137, [s.interest]: -137 });
    expect(made.amountMinor).toBe(137);
    expect(made.movementId).toBe(bankSide(s, made.record));
    expect(allocationsOf(s, lineId)).toEqual([
      expect.objectContaining({
        movementId: made.movementId,
        amount: 1.37,
        itemAmountSnapshot: 1.37,
      }),
    ]);
    expect(made.lineVersions).toEqual({
      [lineId]: statementLineVersion(s.db, lineId),
    });
    // The match is in the record's history; the bank's lines are untouched.
    expect(matchAudits(s, made.record.id)).toHaveLength(1);
    expect(snapshot(s).bank_statement_lines).toEqual(linesBefore);
  });

  it("records a service charge as an expense paid from the bank", () => {
    const s = seed();
    const lineId = s.line("2026-09-15", 5, OUT, "SERVICE CHARGE");

    const made = resultValue(
      createRecordFromLines(s.ctx, {
        lineIds: [lineId],
        kind: "expense",
        categoryAccountId: s.charges,
        description: "Monthly service charge",
      }),
    );

    expect(made.record).toMatchObject({
      kind: LedgerRecordKind.Expense,
      date: "2026-09-15",
      description: "Monthly service charge",
      amountMinor: 500,
      cleared: true,
    });
    expect(sides(made.record)).toEqual({ [s.charges]: 500, [s.bank]: -500 });
    expect(allocationsOf(s, lineId)).toEqual([
      expect.objectContaining({ movementId: made.movementId, amount: 5 }),
    ]);
  });

  it("turns a line into a payment that settles an open payable", () => {
    const s = seed();
    const bill = unpaidBill(s, 120);
    expect(bill.paid).toBe(false);
    const owed = bill.movements.find((m) => m.accountId === s.payable)!;
    const lineId = s.line("2026-09-20", 120, OUT, "ACME SUPPLIES");

    const made = resultValue(
      createRecordFromLines(s.ctx, {
        lineIds: [lineId],
        kind: "payment",
        contactId: s.supplier,
        allocations: [{ owedMovementId: owed.id, amountMinor: 12000 }],
      }),
    );

    expect(made.record).toMatchObject({
      kind: LedgerRecordKind.Payment,
      contactId: s.supplier,
      date: "2026-09-20",
      amountMinor: 12000,
      cleared: true,
    });
    expect(sides(made.record)).toEqual({
      [s.payable]: 12000,
      [s.bank]: -12000,
    });
    expect(getRecord(s.db, bill.id)).toMatchObject({
      paid: true,
      outstandingMinor: 0,
    });
    expect(allocationsOf(s, lineId)).toEqual([
      expect.objectContaining({ movementId: made.movementId, amount: 120 }),
    ]);
  });

  it("records two lines as one record, dated the earliest, each matched in full", () => {
    const s = seed();
    const charge = s.line("2026-09-16", 5, OUT, "SERVICE CHARGE");
    const duty = s.line("2026-09-15", 0.5, OUT, "STAMP DUTY");
    const recordsBefore = count(s, "ledger_records");

    const made = resultValue(
      createRecordFromLines(s.ctx, {
        lineIds: [charge, duty],
        kind: "expense",
        categoryAccountId: s.charges,
      }),
    );

    expect(count(s, "ledger_records")).toBe(recordsBefore + 1);
    expect(made.record).toMatchObject({
      date: "2026-09-15",
      description: "SERVICE CHARGE; STAMP DUTY",
      amountMinor: 550,
      cleared: true,
    });
    expect(made.allocations.map((a) => [a.lineId, a.amount])).toEqual([
      [charge, 5],
      [duty, 0.5],
    ]);
    for (const lineId of [charge, duty])
      expect(allocationsOf(s, lineId)).toEqual([
        expect.objectContaining({ movementId: made.movementId }),
      ]);
    // One audit row names both matches.
    expect(matchAudits(s, made.record.id)).toHaveLength(1);
  });

  it("records only what is still unmatched on a partly matched line", () => {
    const s = seed();
    const lineId = s.line("2026-09-20", 100, OUT, "ACME AND FEE");
    const goods = spend(s, "2026-09-20", 60);
    resultValue(
      setMovementMatches(s.ctx, bankSide(s, goods), [{ lineId, amount: 60 }]),
    );
    const input = {
      lineIds: [lineId],
      kind: "expense" as const,
      categoryAccountId: s.charges,
      description: "Bank fee",
    };

    const made = resultValue(createRecordFromLines(s.ctx, input));

    expect(made.amountMinor).toBe(4000);
    expect(sides(made.record)).toEqual({ [s.charges]: 4000, [s.bank]: -4000 });
    expect(
      allocationsOf(s, lineId)
        .map((a) => a.amount)
        .sort((x, y) => x - y),
    ).toEqual([40, 60]);
    // Now matched in full, so it cannot be recorded a second time.
    expect(createRecordFromLines(s.ctx, input)).toMatchObject({
      ok: false,
      code: "REFUSED",
    });
  });

  it("uses the date it is given, so a line in a closed month can be booked in an open one", () => {
    const s = seed();
    const lineId = s.line("2026-09-15", 5, OUT, "SERVICE CHARGE");
    setSetting(s.db, SETTING_KEYS.accountingClosedThrough, "2026-09-30");
    const before = snapshot(s);
    const input = {
      lineIds: [lineId],
      kind: "expense" as const,
      categoryAccountId: s.charges,
    };

    expect(createRecordFromLines(s.ctx, input)).toMatchObject({
      ok: false,
      code: "REFUSED",
      reason: expect.stringContaining("closed through 2026-09-30"),
    });
    expect(snapshot(s)).toEqual(before);

    const made = resultValue(
      createRecordFromLines(s.ctx, { ...input, date: "2026-10-01" }),
    );
    expect(made.record.date).toBe("2026-10-01");
    expect(allocationsOf(s, lineId)).toHaveLength(1);
  });
});

describe("the Transfer sheet's route, now one case of createRecordFromLines", () => {
  it("still records a line as a transfer and matches it, with the same answer", () => {
    const s = seed();
    const lineId = s.line("2026-09-05", 40, OUT, "TO CASH");

    const result = resultValue(
      recordTransferFromLine(
        s.ctx,
        lineId,
        { otherAccountId: s.cash },
        statementLineVersion(s.db, lineId),
      ),
    );

    expect(Object.keys(result).sort()).toEqual([
      "allocation",
      "lineVersion",
      "movement",
      "record",
      "recordVersion",
    ]);
    expect(result.record).toMatchObject({
      kind: LedgerRecordKind.Transfer,
      date: "2026-09-05",
      description: "TO CASH",
      amountMinor: 4000,
    });
    expect(sides(result.record)).toEqual({ [s.cash]: 4000, [s.bank]: -4000 });
    expect(result.allocation).toMatchObject({
      lineId,
      movementId: bankSide(s, result.record),
      amount: 40,
    });
    expect(result.movement).toMatchObject({
      movementId: result.allocation.movementId,
      accountId: s.bank,
      amountMinor: -4000,
      remainingAmount: 0,
    });
    expect(result.lineVersion).toBe(statementLineVersion(s.db, lineId));
    expect(matchAudits(s, result.record.id)).toHaveLength(1);

    // Matched now, so the route refuses it exactly as it always has.
    expect(
      recordTransferFromLine(
        s.ctx,
        lineId,
        { otherAccountId: s.cash },
        result.lineVersion,
      ),
    ).toEqual({
      ok: false,
      code: "REFUSED",
      reason:
        "This transaction is already matched. Undo the match before recording it as a transfer.",
    });
  });

  it("keeps the route's refusals: a stale version, a partly matched line, the same account", () => {
    const s = seed();
    const lineId = s.line("2026-09-05", 40, OUT, "TO CASH");
    const version = statementLineVersion(s.db, lineId);
    const goods = spend(s, "2026-09-05", 10);
    resultValue(
      setMovementMatches(s.ctx, bankSide(s, goods), [{ lineId, amount: 10 }]),
    );

    expect(
      recordTransferFromLine(
        s.ctx,
        lineId,
        { otherAccountId: s.cash },
        version,
      ),
    ).toMatchObject({ ok: false, code: "CONFLICT" });
    const current = statementLineVersion(s.db, lineId);
    expect(
      recordTransferFromLine(
        s.ctx,
        lineId,
        { otherAccountId: s.cash },
        current,
      ),
    ).toMatchObject({
      ok: false,
      code: "REFUSED",
      reason: expect.stringContaining("already matched"),
    });
    expect(
      recordTransferFromLine(
        s.ctx,
        lineId,
        { otherAccountId: s.bank },
        current,
      ),
    ).toEqual({
      ok: false,
      code: "REFUSED",
      reason: "A transfer needs two different accounts.",
    });
    expect(
      recordTransferFromLine(s.ctx, 9999, { otherAccountId: s.cash }),
    ).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("records money in as a transfer from the other account", () => {
    const s = seed();
    const lineId = s.line("2026-09-06", 25, IN, "FROM CASH");

    const made = resultValue(
      createRecordFromLines(s.ctx, {
        lineIds: [lineId],
        kind: "transfer",
        otherAccountId: s.cash,
      }),
    );

    expect(made.record.kind).toBe(LedgerRecordKind.Transfer);
    expect(sides(made.record)).toEqual({ [s.bank]: 2500, [s.cash]: -2500 });
  });

  it("refuses a transfer into equity or a category without Adjustments, by either door", () => {
    const s = seed();
    const lineId = s.line("2026-09-05", 40, OUT, "TO OWNER");
    // Every everyday ability, and neither of the explicit ones.
    const clerk: AppContext = {
      db: s.db,
      locals: localsFor(["reconciliation", "records"]),
    };
    const before = snapshot(s);

    for (const other of [s.equity, s.charges]) {
      expect(
        recordTransferFromLine(
          clerk,
          lineId,
          { otherAccountId: other },
          statementLineVersion(s.db, lineId),
        ),
      ).toMatchObject({
        ok: false,
        code: "FORBIDDEN",
        reason: expect.stringContaining("Adjustments"),
      });
      expect(
        createRecordFromLines(clerk, {
          lineIds: [lineId],
          kind: "transfer",
          otherAccountId: other,
        }),
      ).toMatchObject({
        ok: false,
        code: "FORBIDDEN",
        reason: expect.stringContaining("Adjustments"),
      });
    }
    expect(snapshot(s)).toEqual(before);

    // Between two places money sits, the same clerk may.
    resultValue(
      createRecordFromLines(clerk, {
        lineIds: [lineId],
        kind: "transfer",
        otherAccountId: s.cash,
      }),
    );
  });
});

describe("createRecordFromLines refuses, and leaves nothing behind", () => {
  it("refuses a line already matched in full", () => {
    const s = seed();
    const lineId = s.line("2026-09-15", 12.5, OUT, "SOFTWARE CO");
    const existing = spend(s, "2026-09-15", 12.5);
    resultValue(
      setMovementMatches(s.ctx, bankSide(s, existing), [
        { lineId, amount: 12.5 },
      ]),
    );
    const before = snapshot(s);

    expect(
      createRecordFromLines(s.ctx, {
        lineIds: [lineId],
        kind: "expense",
        categoryAccountId: s.charges,
      }),
    ).toEqual({
      ok: false,
      code: "REFUSED",
      reason: `Statement line ${lineId} is already matched in full. Undo its match first, or leave the line out.`,
    });
    expect(snapshot(s)).toEqual(before);
  });

  it("refuses lines that mix directions or accounts, and a kind that runs the other way", () => {
    const s = seed();
    const out = s.line("2026-09-15", 5, OUT, "SERVICE CHARGE");
    const into = s.line("2026-09-30", 1.37, IN, "INTEREST CREDIT");
    const elsewhere = s.line(
      "2026-09-15",
      5,
      OUT,
      "CASH COUNT",
      statementOn(s.db, s.cash),
    );
    const before = snapshot(s);

    const refused = (input: Parameters<typeof createRecordFromLines>[1]) =>
      createRecordFromLines(s.ctx, input);
    expect(
      refused({
        lineIds: [out, into],
        kind: "transfer",
        otherAccountId: s.cash,
      }),
    ).toMatchObject({
      ok: false,
      code: "REFUSED",
      reason: expect.stringContaining("both ways"),
    });
    expect(
      refused({
        lineIds: [out, elsewhere],
        kind: "expense",
        categoryAccountId: s.charges,
      }),
    ).toMatchObject({
      ok: false,
      code: "REFUSED",
      reason: expect.stringContaining("different accounts"),
    });
    expect(
      refused({
        lineIds: [into],
        kind: "expense",
        categoryAccountId: s.charges,
      }),
    ).toMatchObject({
      ok: false,
      code: "REFUSED",
      reason: expect.stringContaining("An expense is money out"),
    });
    expect(
      refused({
        lineIds: [out],
        kind: "income",
        categoryAccountId: s.interest,
      }),
    ).toMatchObject({
      ok: false,
      code: "REFUSED",
      reason: expect.stringContaining("Income is money in"),
    });
    expect(
      refused({ lineIds: [out], kind: "expense", categoryAccountId: s.bank }),
    ).toMatchObject({ ok: false, code: "REFUSED" });
    expect(snapshot(s)).toEqual(before);
  });

  it("refuses a kind without the category, contact or account it needs", () => {
    const s = seed();
    const out = s.line("2026-09-15", 5, OUT, "SERVICE CHARGE");
    const into = s.line("2026-09-30", 1.37, IN, "INTEREST CREDIT");
    const before = snapshot(s);

    const cases: [Parameters<typeof createRecordFromLines>[1], string][] = [
      [{ lineIds: [out], kind: "expense" }, "category"],
      [{ lineIds: [into], kind: "income" }, "category"],
      [{ lineIds: [out], kind: "payment" }, "contact"],
      [{ lineIds: [out], kind: "transfer" }, "other account"],
      [
        {
          lineIds: [out],
          kind: "transfer",
          otherAccountId: s.cash,
          contactId: s.supplier,
        },
        "names no contact",
      ],
      [
        {
          lineIds: [out],
          kind: "payment",
          contactId: s.supplier,
          categoryAccountId: s.charges,
        },
        "Only an expense or income",
      ],
      [
        {
          lineIds: [out],
          kind: "expense",
          categoryAccountId: s.charges,
          allocations: [{ owedMovementId: 1, amountMinor: 100 }],
        },
        "Only a payment",
      ],
      [
        { lineIds: [out, out], kind: "expense", categoryAccountId: s.charges },
        "only appear once",
      ],
    ];
    for (const [input, says] of cases)
      expect(createRecordFromLines(s.ctx, input)).toMatchObject({
        ok: false,
        code: "INVALID_INPUT",
        reason: expect.stringContaining(says),
      });
    expect(
      createRecordFromLines(s.ctx, {
        lineIds: [],
        kind: "expense",
        categoryAccountId: s.charges,
      }),
    ).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(
      createRecordFromLines(s.ctx, {
        lineIds: [9999],
        kind: "expense",
        categoryAccountId: s.charges,
      }),
    ).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(snapshot(s)).toEqual(before);
  });

  it("asks for reconciliation.create and records.create before looking anything up", () => {
    const s = seed();
    const lineId = s.line("2026-09-15", 5, OUT, "SERVICE CHARGE");
    const as = (permissions: string[]): AppContext => ({
      db: s.db,
      locals: localsFor(permissions),
    });
    const input = { kind: "expense" as const, categoryAccountId: s.charges };

    for (const ctx of [
      as(["reconciliation.read", "reconciliation.match", "records"]),
      as(["reconciliation", "records.read"]),
    ]) {
      // An id that does not exist is still FORBIDDEN, not NOT_FOUND.
      expect(
        createRecordFromLines(ctx, { ...input, lineIds: [9999] }),
      ).toMatchObject({
        ok: false,
        code: "FORBIDDEN",
      });
      expect(
        createRecordFromLines(ctx, { ...input, lineIds: [lineId] }),
      ).toMatchObject({
        ok: false,
        code: "FORBIDDEN",
      });
    }
    resultValue(
      createRecordFromLines(
        as(["reconciliation.create", "reconciliation.match", "records.create"]),
        { ...input, lineIds: [lineId] },
      ),
    );
  });

  it("asks for reconciliation.match too, except for a transfer (review L2)", () => {
    const s = seed();
    const out = s.line("2026-09-15", 5, OUT, "SERVICE CHARGE");
    const into = s.line("2026-09-30", 1.37, IN, "INTEREST CREDIT");
    const toCash = s.line("2026-09-16", 20, OUT, "TO CASH");
    const bill = unpaidBill(s, 5);
    // May record from a statement, but not match lines to records.
    const clerk: AppContext = {
      db: s.db,
      locals: localsFor([
        "reconciliation.read",
        "reconciliation.create",
        "records",
      ]),
    };
    const before = snapshot(s);
    for (const input of [
      {
        lineIds: [out],
        kind: "expense" as const,
        categoryAccountId: s.charges,
      },
      {
        lineIds: [into],
        kind: "income" as const,
        categoryAccountId: s.interest,
      },
      {
        lineIds: [out],
        kind: "payment" as const,
        contactId: bill.contactId!,
      },
    ])
      expect(createRecordFromLines(clerk, input), input.kind).toMatchObject({
        ok: false,
        code: "FORBIDDEN",
      });
    expect(snapshot(s)).toEqual(before);

    // A transfer from a line keeps what v1 and REST always asked.
    const made = resultValue(
      createRecordFromLines(clerk, {
        lineIds: [toCash],
        kind: "transfer",
        otherAccountId: s.cash,
      }),
    );
    expect(made.record.kind).toBe(LedgerRecordKind.Transfer);
  });

  it("rolls the record back when its settlements refuse", () => {
    const s = seed();
    const bill = unpaidBill(s, 120);
    const owed = bill.movements.find((m) => m.accountId === s.payable)!;
    const lineId = s.line("2026-09-20", 100, OUT, "ACME SUPPLIES");
    const before = snapshot(s);

    // Settles more than the line paid.
    expect(
      createRecordFromLines(s.ctx, {
        lineIds: [lineId],
        kind: "payment",
        contactId: s.supplier,
        allocations: [{ owedMovementId: owed.id, amountMinor: 12000 }],
      }),
    ).toMatchObject({ ok: false, code: "REFUSED" });
    expect(snapshot(s)).toEqual(before);
  });
});

describe("dry runs", () => {
  it("createRecordFromLines reports the record and changes no table and no stream", async () => {
    const s = seed();
    const lineId = s.line("2026-09-30", 1.37, IN, "INTEREST CREDIT");
    const input = {
      lineIds: [lineId],
      kind: "income" as const,
      categoryAccountId: s.interest,
    };
    const before = snapshot(s);
    const events = await deliveries();
    const dry = resultValue(
      createRecordFromLines(s.ctx, input, { dryRun: true }),
    );
    try {
      await settle();
      expect(events.fired).toEqual([]);
    } finally {
      events.stop();
    }

    expect(snapshot(s)).toEqual(before);
    expect(dry.record).toMatchObject({
      kind: LedgerRecordKind.Income,
      amountMinor: 137,
      cleared: true,
    });
    expect(dry.allocations).toHaveLength(1);

    // What it reported is what a save stores.
    const saved = resultValue(createRecordFromLines(s.ctx, input));
    const shape = (made: typeof saved) => ({
      kind: made.record.kind,
      date: made.record.date,
      description: made.record.description,
      recordNumber: made.record.recordNumber,
      sides: sides(made.record),
      amountMinor: made.amountMinor,
      allocations: made.allocations.map((a) => [a.lineId, a.amount]),
    });
    expect(shape(dry)).toEqual(shape(saved));
  });

  it("autoMatchTolerant reports the matches and changes no table and no stream", async () => {
    const s = seed();
    s.line("2026-09-03", 59, OUT, "SOFTWARE CO");
    s.line("2026-09-22", 59, OUT, "SOFTWARE CO");
    spend(s, "2026-09-03", 59);
    spend(s, "2026-09-22", 59);
    const before = snapshot(s);
    const events = await deliveries();
    const dry = resultValue(
      autoMatchTolerant(
        s.ctx,
        { accountId: s.bank, maxDays: 0 },
        { dryRun: true },
      ),
    );
    try {
      await settle();
      expect(events.fired).toEqual([]);
    } finally {
      events.stop();
    }

    expect(snapshot(s)).toEqual(before);
    expect(dry.matched).toHaveLength(2);
    expect(
      resultValue(autoMatchTolerant(s.ctx, { accountId: s.bank, maxDays: 0 })),
    ).toEqual(dry);
  });
});

describe("autoMatchTolerant", () => {
  it("matches the decoy pair at maxDays 0, and skips both as ambiguous at maxDays 30", () => {
    const s = seed();
    const early = s.line("2026-09-03", 59, OUT, "SOFTWARE CO");
    const late = s.line("2026-09-22", 59, OUT, "SOFTWARE CO");
    const first = spend(s, "2026-09-03", 59);
    const second = spend(s, "2026-09-22", 59);
    const before = snapshot(s);

    const wide = resultValue(
      autoMatchTolerant(s.ctx, { accountId: s.bank, maxDays: 30 }),
    );
    expect(wide).toEqual({
      matched: [],
      skipped: [
        { lineId: early, reason: "ambiguous_line" },
        { lineId: late, reason: "ambiguous_line" },
      ],
    });
    expect(snapshot(s)).toEqual(before);

    const exact = resultValue(
      autoMatchTolerant(s.ctx, { accountId: s.bank, maxDays: 0 }),
    );
    expect(exact).toEqual({
      matched: [
        {
          lineId: early,
          recordId: first.id,
          movementId: bankSide(s, first),
          amountMinor: -5900,
          days: 0,
        },
        {
          lineId: late,
          recordId: second.id,
          movementId: bankSide(s, second),
          amountMinor: -5900,
          days: 0,
        },
      ],
      skipped: [],
    });
    expect(allocationsOf(s, early)).toEqual([
      expect.objectContaining({ movementId: bankSide(s, first), amount: 59 }),
    ]);
    expect(allocationsOf(s, late)).toEqual([
      expect.objectContaining({ movementId: bankSide(s, second), amount: 59 }),
    ]);
    for (const record of [first, second]) {
      expect(matchAudits(s, record.id)).toHaveLength(1);
      expect(getRecord(s.db, record.id)!.cleared).toBe(true);
    }
  });

  it("never pairs a line with an opening balance of the same amount (review finding 5)", () => {
    const s = seed();
    // The bank opened with 500.00 on 1 September; the statement shows a
    // 500.00 deposit two days later. They are different events.
    resultValue(
      setOpeningBalance(s.ctx, s.bank, {
        date: "2026-09-01",
        amountMinor: 50000,
      }),
    );
    const deposit = s.line("2026-09-03", 500, IN, "CASH DEPOSIT");

    const result = resultValue(
      autoMatchTolerant(s.ctx, { accountId: s.bank, maxDays: 3 }),
    );

    expect(result).toEqual({
      matched: [],
      skipped: [{ lineId: deposit, reason: "no_candidate" }],
    });
    expect(count(s, "reconciliation_allocations")).toBe(0);
  });

  it("skips a line no record fits exactly, and two lines that fit one record", () => {
    const s = seed();
    const a = s.line("2026-09-08", 59, OUT, "SOFTWARE CO");
    const b = s.line("2026-09-12", 59, OUT, "SOFTWARE CO");
    spend(s, "2026-09-10", 59);
    const lonely = s.line("2026-09-15", 12.34, OUT, "UNKNOWN");
    // Within the suggestion's one-percent band of a record that day, never exact.
    const near = s.line("2026-09-20", 59.5, OUT, "SOFTWARE CO");
    spend(s, "2026-09-20", 59);

    const result = resultValue(
      autoMatchTolerant(s.ctx, { accountId: s.bank, maxDays: 3 }),
    );

    expect(result).toEqual({
      matched: [],
      skipped: [
        { lineId: a, reason: "ambiguous_movement" },
        { lineId: b, reason: "ambiguous_movement" },
        { lineId: lonely, reason: "no_candidate" },
        { lineId: near, reason: "no_candidate" },
      ],
    });
    expect(count(s, "reconciliation_allocations")).toBe(0);
  });

  it("matches a few days apart, the same way only, and never touches a match", () => {
    const s = seed();
    const lineId = s.line("2026-09-15", 80, OUT, "SOFTWARE CO");
    const record = spend(s, "2026-09-17", 80);
    // Money in on the line's own day, for the same amount: the wrong way.
    resultValue(
      createRecord(s.ctx, {
        kind: "income",
        date: "2026-09-15",
        amount: 80,
        currency: "MYR",
        exchangeRate: 1,
        description: "Refund",
        categoryAccountId: s.interest,
        receivedIntoAccountId: s.bank,
      }),
    );
    // Already matched: neither the line nor the record is offered again.
    const taken = s.line("2026-09-15", 25, OUT, "SOFTWARE CO");
    const takenRecord = spend(s, "2026-09-15", 25);
    resultValue(
      setMovementMatches(s.ctx, bankSide(s, takenRecord), [
        { lineId: taken, amount: 25 },
      ]),
    );
    spend(s, "2026-09-16", 25);

    expect(
      resultValue(autoMatchTolerant(s.ctx, { accountId: s.bank, maxDays: 1 })),
    ).toEqual({
      matched: [],
      skipped: [{ lineId, reason: "no_candidate" }],
    });
    expect(
      resultValue(autoMatchTolerant(s.ctx, { accountId: s.bank, maxDays: 2 })),
    ).toEqual({
      matched: [
        {
          lineId,
          recordId: record.id,
          movementId: bankSide(s, record),
          amountMinor: -8000,
          days: 2,
        },
      ],
      skipped: [],
    });
    expect(allocationsOf(s, taken)).toEqual([
      expect.objectContaining({ movementId: bankSide(s, takenRecord) }),
    ]);
  });

  it("acts only on lines in the period, but judges ties against the whole account", () => {
    const s = seed();
    const inside = s.line("2026-09-29", 59, OUT, "SOFTWARE CO");
    s.line("2026-10-01", 59, OUT, "SOFTWARE CO");
    spend(s, "2026-09-30", 59);
    const lonely = s.line("2026-08-31", 12.34, OUT, "UNKNOWN");

    expect(
      resultValue(
        autoMatchTolerant(s.ctx, {
          accountId: s.bank,
          from: "2026-09-01",
          to: "2026-09-30",
          maxDays: 1,
        }),
      ),
    ).toEqual({
      matched: [],
      skipped: [{ lineId: inside, reason: "ambiguous_movement" }],
    });
    expect(
      resultValue(
        autoMatchTolerant(s.ctx, {
          accountId: s.bank,
          to: "2026-08-31",
          maxDays: 1,
        }),
      ).skipped,
    ).toEqual([{ lineId: lonely, reason: "no_candidate" }]);
  });

  it("refuses without reconciliation.match, and refuses a bad window or account", () => {
    const s = seed();
    const reader: AppContext = {
      db: s.db,
      locals: localsFor([
        "reconciliation.read",
        "reconciliation.create",
        "records",
      ]),
    };
    expect(
      autoMatchTolerant(reader, { accountId: s.bank, maxDays: 0 }),
    ).toMatchObject({ ok: false, code: "FORBIDDEN" });
    for (const maxDays of [-1, 1.5, 32])
      expect(
        autoMatchTolerant(s.ctx, { accountId: s.bank, maxDays }),
      ).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(
      autoMatchTolerant(s.ctx, {
        accountId: s.bank,
        from: "2026-09-30",
        to: "2026-09-01",
        maxDays: 0,
      }),
    ).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(
      autoMatchTolerant(s.ctx, { accountId: 9999, maxDays: 0 }),
    ).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });
});

describe("inside an outer transaction", () => {
  function scene() {
    const s = seed();
    const interestLine = s.line("2026-09-30", 1.37, IN, "INTEREST CREDIT");
    s.line("2026-09-03", 59, OUT, "SOFTWARE CO");
    s.line("2026-09-22", 59, OUT, "SOFTWARE CO");
    spend(s, "2026-09-03", 59);
    spend(s, "2026-09-22", 59);
    const both = () => {
      resultValue(
        createRecordFromLines(s.ctx, {
          lineIds: [interestLine],
          kind: "income",
          categoryAccountId: s.interest,
        }),
      );
      expect(
        resultValue(autoMatchTolerant(s.ctx, { accountId: s.bank, maxDays: 0 }))
          .matched,
      ).toHaveLength(2);
      expect(s.raw.inTransaction).toBe(true);
    };
    return { s, both };
  }

  it("leaves nothing behind when the outer transaction throws", () => {
    const { s, both } = scene();
    const before = snapshot(s);
    const sentinel = new Sentinel("roll it all back");
    let caught: unknown;
    try {
      s.db.transaction(() => {
        both();
        throw sentinel;
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(sentinel);
    expect(s.raw.inTransaction).toBe(false);
    expect(snapshot(s)).toEqual(before);
  });

  it("in a unit of work, delivers events only after the outer commit, and none on a rollback", async () => {
    const { s, both } = scene();
    const before = snapshot(s);
    const events = await deliveries();
    try {
      const sentinel = new Sentinel("roll it all back");
      expect(() =>
        runUnitOfWork("write", () =>
          s.db.transaction(() => {
            both();
            throw sentinel;
          }),
        ),
      ).toThrow(sentinel);
      await settle();
      expect(events.fired).toEqual([]);
      expect(snapshot(s)).toEqual(before);

      let deliveredInside: string[] = [];
      runUnitOfWork("write", () =>
        s.db.transaction(() => {
          both();
          deliveredInside = [...events.fired];
        }),
      );
      await settle();
      expect(deliveredInside).toEqual([]);
      expect(events.fired).toEqual(
        expect.arrayContaining([
          "ledger:record-update",
          "reconciliation:allocation-update",
          "reconciliation:allocations-bulk-update",
          "audit:entry-added",
        ]),
      );
    } finally {
      events.stop();
    }
  });

  it("is atomic as one item of a batch", async () => {
    const s = seed();
    const fresh = s.line("2026-09-30", 1.37, IN, "INTEREST CREDIT");
    const taken = s.line("2026-09-15", 12.5, OUT, "SOFTWARE CO");
    const existing = spend(s, "2026-09-15", 12.5);
    resultValue(
      setMovementMatches(s.ctx, bankSide(s, existing), [
        { lineId: taken, amount: 12.5 },
      ]),
    );
    const before = snapshot(s);
    const item = (
      lineId: number,
      kind: "income" | "expense",
      categoryAccountId: number,
    ) => ({
      action: "create_from_lines",
      run: (ctx: AppContext) =>
        createRecordFromLines(ctx, {
          lineIds: [lineId],
          kind,
          categoryAccountId,
        }),
    });

    const outcome = resultValue(
      await runBatch(s.ctx, {
        tool: "akaun_match_bank_lines",
        dryRun: false,
        items: [
          item(fresh, "income", s.interest),
          item(taken, "expense", s.charges),
        ],
      }),
    );

    expect(outcome.saved).toBe(false);
    expect(outcome.items.map((i) => i.ok)).toEqual([true, false]);
    expect(snapshot(s)).toEqual(before);

    const saved = resultValue(
      await runBatch(s.ctx, {
        tool: "akaun_match_bank_lines",
        dryRun: false,
        items: [item(fresh, "income", s.interest)],
      }),
    );
    expect(saved.saved).toBe(true);
    expect(allocationsOf(s, fresh)).toHaveLength(1);
  });
});

describe("a payment from bank lines settles the control account its contact's balance is on (review finding 2)", () => {
  const receivableOf = (s: Seeded) =>
    s.db
      .select()
      .from(schema.accountDefaults)
      .where(
        eq(schema.accountDefaults.purpose, DefaultAccountPurpose.Receivable),
      )
      .get()!.accountId;

  /** We paid the supplier 200.00 that nothing was owed for: Payable +200 for them. */
  function overpaid(s: Seeded, amount = 200) {
    return resultValue(
      createRecord(s.ctx, {
        kind: "payment",
        date: "2026-09-02",
        amount,
        currency: "MYR",
        exchangeRate: 1,
        description: "Paid twice by mistake",
        paidFromAccountId: s.bank,
        contactId: s.supplier,
        direction: "we-pay",
        settlements: [],
      }),
    ).record;
  }

  /** An employee paid 150.00 of supplies personally: ReimbursementsPayable −150 for them. */
  function personallyPaid(s: Seeded) {
    const reimbursements = resultValue(
      ensureReimbursementsPayableAccount(s.db, 1),
    );
    const employee = s.db
      .insert(schema.contacts)
      .values({ legalName: "Siti Employee", entityType: 1 })
      .returning()
      .get()!.id;
    resultValue(
      createRecord(s.ctx, {
        kind: "expense",
        date: "2026-09-03",
        amount: 150,
        currency: "MYR",
        exchangeRate: 1,
        description: "Supplies, paid personally",
        categoryAccountId: s.charges,
        paidFromAccountId: null,
        expensePaymentSource: "personal",
        paidByContactId: employee,
      }),
    );
    return { reimbursements, employee };
  }

  it("A: records a supplier's refund of an overpayment against Payable, not Receivable", () => {
    const s = seed();
    const payment = overpaid(s);
    const credit = payment.movements.find((m) => m.accountId === s.payable)!;
    expect(contactBalances(s.db, "we-owe", s.supplier)[0]).toMatchObject({
      creditsMinor: 20000,
    });
    const lineId = s.line("2026-09-25", 200, IN, "ACME REFUND");

    const made = resultValue(
      createRecordFromLines(s.ctx, {
        lineIds: [lineId],
        kind: "payment",
        contactId: s.supplier,
      }),
    );

    expect(sides(made.record)).toEqual({
      [s.bank]: 20000,
      [s.payable]: -20000,
    });
    expect(sides(made.record)[receivableOf(s)]).toBeUndefined();
    // The refund used up the overpayment, so the supplier is square.
    expect(contactBalances(s.db, "we-owe", s.supplier)).toEqual([]);
    expect(contactBalances(s.db, "owed-to-us", s.supplier)).toEqual([]);
    const settled = s.db
      .select()
      .from(schema.settlements)
      .where(eq(schema.settlements.owedMovementId, credit.id))
      .all();
    expect(settled.map((row) => row.amountMinor)).toEqual([20000]);
  });

  it("A: takes the direction when it is given, and refuses one that runs against the lines", () => {
    const s = seed();
    overpaid(s);
    const lineId = s.line("2026-09-25", 200, IN, "ACME REFUND");
    const before = snapshot(s);
    const wrongWay = createRecordFromLines(s.ctx, {
      lineIds: [lineId],
      kind: "payment",
      contactId: s.supplier,
      direction: "we-pay",
    });
    expect(wrongWay).toMatchObject({ ok: false, code: "REFUSED" });
    if (!wrongWay.ok) expect(wrongWay.reason).toMatch(/money in/);
    expect(snapshot(s)).toEqual(before);

    const made = resultValue(
      createRecordFromLines(s.ctx, {
        lineIds: [lineId],
        kind: "payment",
        contactId: s.supplier,
        direction: "refund-received",
      }),
    );
    expect(sides(made.record)).toEqual({
      [s.bank]: 20000,
      [s.payable]: -20000,
    });
  });

  it("A: refuses a refund larger than the overpayment, by createRecord's own rule", () => {
    const s = seed();
    overpaid(s);
    const lineId = s.line("2026-09-25", 250, IN, "ACME REFUND");
    const before = snapshot(s);
    const result = createRecordFromLines(s.ctx, {
      lineIds: [lineId],
      kind: "payment",
      contactId: s.supplier,
      direction: "refund-received",
    });
    expect(result).toMatchObject({
      ok: false,
      code: "REFUSED",
      reason:
        "A refund must name one contact and be fully applied to their overpayment.",
    });
    expect(snapshot(s)).toEqual(before);
  });

  it("B: pays an employee's reimbursement out of ReimbursementsPayable, not Payable", () => {
    const s = seed();
    const { reimbursements, employee } = personallyPaid(s);
    const lineId = s.line("2026-09-26", 150, OUT, "SITI CLAIM");

    const made = resultValue(
      createRecordFromLines(s.ctx, {
        lineIds: [lineId],
        kind: "payment",
        contactId: employee,
      }),
    );

    expect(sides(made.record)).toEqual({
      [reimbursements]: 15000,
      [s.bank]: -15000,
    });
    expect(sides(made.record)[s.payable]).toBeUndefined();
    expect(
      contactBalances(s.db, "we-owe", employee)[0]?.outstandingMinor ?? 0,
    ).toBe(0);
  });

  it("names the settlement account when it is given", () => {
    const s = seed();
    const { reimbursements, employee } = personallyPaid(s);
    const lineId = s.line("2026-09-26", 150, OUT, "SITI CLAIM");
    const made = resultValue(
      createRecordFromLines(s.ctx, {
        lineIds: [lineId],
        kind: "payment",
        contactId: employee,
        direction: "we-pay",
        settlementAccountId: reimbursements,
      }),
    );
    expect(sides(made.record)).toEqual({
      [reimbursements]: 15000,
      [s.bank]: -15000,
    });
  });

  it("keeps the defaults: money out to a supplier we owe settles Payable, money in from nobody owed is Receivable", () => {
    const s = seed();
    unpaidBill(s, 80);
    const out = s.line("2026-09-20", 80, OUT, "ACME");
    expect(
      sides(
        resultValue(
          createRecordFromLines(s.ctx, {
            lineIds: [out],
            kind: "payment",
            contactId: s.supplier,
          }),
        ).record,
      ),
    ).toEqual({ [s.payable]: 8000, [s.bank]: -8000 });

    const customer = s.db
      .insert(schema.contacts)
      .values({ legalName: "New Customer", entityType: 2 })
      .returning()
      .get()!.id;
    const into = s.line("2026-09-21", 60, IN, "DEPOSIT");
    expect(
      sides(
        resultValue(
          createRecordFromLines(s.ctx, {
            lineIds: [into],
            kind: "payment",
            contactId: customer,
          }),
        ).record,
      ),
    ).toEqual({ [s.bank]: 6000, [receivableOf(s)]: -6000 });
  });

  it("refuses rather than guess when the contact's balance is on the other control account", () => {
    const s = seed();
    unpaidBill(s, 120);
    const lineId = s.line("2026-09-25", 120, IN, "ACME");
    const before = snapshot(s);
    const result = createRecordFromLines(s.ctx, {
      lineIds: [lineId],
      kind: "payment",
      contactId: s.supplier,
    });
    expect(result).toMatchObject({
      ok: false,
      code: "REFUSED",
      paymentDirections: ["we-receive", "refund-received"],
    });
    if (!result.ok) expect(result.reason).toMatch(/direction/);
    expect(snapshot(s)).toEqual(before);
  });
});
