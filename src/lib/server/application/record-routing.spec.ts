import { createHash } from "node:crypto";
import type { EventEmitter } from "node:events";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import {
  AccountType,
  DefaultAccountPurpose,
  LedgerRecordKind,
  StatementDirection,
  StatementExtractionState,
} from "$lib/enums.js";
import * as schema from "../db/schema.js";
import { auditEvents } from "../audit-events.js";
import { ledgerEvents } from "../ledger/events.js";
import { reconciliationEvents } from "../reconciliation/events.js";
import type { RecordView } from "../ledger/types.js";
import { getRecord } from "../queries/ledger.js";
import { contactBalances } from "../queries/settlements.js";
import { accountDefaultId } from "../services/account-defaults.js";
import { createAccount } from "../services/accounts.js";
import { releaseBook, resultValue } from "./__fixtures__/release-book.js";
import {
  postDepreciationMonth,
  previewDepreciationMonth,
} from "./depreciation.js";
import { setMovementMatches } from "./reconciliation.js";
import {
  changeRecord,
  recordEditability,
  routeRecordChange,
  RECORD_CHANGE_FIELDS,
  type RecordChange,
  type RecordChangeField,
} from "./record-routing.js";
import { createRecord, prepareVoidRecord, voidRecord } from "./records.js";
import { createReimbursement } from "./reimbursements.js";
import { recordVersion } from "./version.js";

type Book = ReturnType<typeof releaseBook>;
let book: Book | undefined;
afterEach(() => {
  book?.raw.close();
  book = undefined;
});

const REASON = "Freight was left off the supplier invoice.";
const DAY = "2026-09-02";

function seed() {
  book = releaseBook();
  const { db, ctx, bank, expense } = book;
  const freight = resultValue(
    createAccount(db, 1, { name: "Freight", type: AccountType.Expense }),
  ).id;
  const contact = (legalName: string) =>
    db
      .insert(schema.contacts)
      .values({ legalName, entityType: 2 })
      .returning()
      .get()!.id;
  const acme = contact("Acme Sdn Bhd");
  const other = contact("Other Sdn Bhd");
  const person = contact("Employee");
  const payable = accountDefaultId(db, DefaultAccountPurpose.Payable)!;
  const owedSide = (record: RecordView) =>
    record.movements.find((m) => m.accountId === payable)!;

  function bill(amount: number, contactId = acme, date = DAY) {
    return resultValue(
      createRecord(ctx, {
        kind: "expense",
        date,
        amount,
        currency: "MYR",
        exchangeRate: 1,
        description: "Acme goods",
        categoryAccountId: expense,
        paidFromAccountId: null,
        contactId,
      }),
    ).record;
  }
  function pay(amount: number, owed: RecordView, minor: number) {
    return resultValue(
      createRecord(ctx, {
        kind: "payment",
        date: DAY,
        amount,
        currency: "MYR",
        exchangeRate: 1,
        description: "Acme payment",
        paidFromAccountId: bank,
        contactId: acme,
        direction: "we-pay",
        settlements: [
          { owedMovementId: owedSide(owed).id, amountMinor: minor },
        ],
      }),
    ).record;
  }
  function bankExpense(amount = 40) {
    return resultValue(
      createRecord(ctx, {
        kind: "expense",
        date: DAY,
        amount,
        currency: "MYR",
        exchangeRate: 1,
        description: "Paid from the bank",
        categoryAccountId: expense,
        paidFromAccountId: bank,
      }),
    ).record;
  }
  function statementLine(amount: number) {
    const statementId = db
      .insert(schema.bankStatements)
      .values({
        originalFilename: "sept.pdf",
        storedFilePath: "reconciliation/sept.pdf",
        extractionState: StatementExtractionState.Ready,
        uploadedBy: 1,
        accountId: bank,
      })
      .returning()
      .get()!.id;
    return db
      .insert(schema.bankStatementLines)
      .values({
        statementId,
        date: DAY,
        amount,
        direction: StatementDirection.Out,
      })
      .returning()
      .get()!.id;
  }
  function matched(amount = 40) {
    const record = bankExpense(amount);
    const lineId = statementLine(amount);
    const bankSide = record.movements.find((m) => m.accountId === bank)!;
    resultValue(setMovementMatches(ctx, bankSide.id, [{ lineId, amount }]));
    return { record: getRecord(db, record.id)!, lineId, bankSide };
  }
  /** The freight case: 1,200.00 owed, a 1,285.00 payment allocated 1,200.00. */
  function freightCase() {
    const expense = bill(1200);
    const payment = pay(1285, expense, 120_000);
    return { expense: getRecord(db, expense.id)!, payment };
  }
  function reimbursementPayment() {
    const owed = bill(5.5, acme);
    const created = resultValue(
      createReimbursement(ctx, {
        contactId: person,
        personallyPaid: true,
        date: DAY,
        description: "Personally paid supplies",
        reference: "",
        remark: "",
        items: [
          { owedMovementId: owedSide(owed).id, amountMinor: owed.amountMinor },
        ],
        cashMinor: 550,
        paidFromAccountId: bank,
        credits: [],
      }),
    );
    return created.payment!;
  }
  function invoicePosting() {
    const record = bankExpense(12);
    db.update(schema.ledgerRecords)
      .set({ kind: LedgerRecordKind.InvoiceIssue })
      .where(eq(schema.ledgerRecords.id, record.id))
      .run();
    return getRecord(db, record.id)!;
  }
  function voidPair() {
    const record = bankExpense(15);
    resultValue(
      voidRecord(ctx, record.id, {
        reason: "Entered twice by mistake.",
        expectedVersion: resultValue(prepareVoidRecord(ctx, record.id)).version,
      }),
    );
    const voided = getRecord(db, record.id)!;
    return { voided, reversal: getRecord(db, voided.voidedByRecordId!)! };
  }
  function depreciationJournal() {
    book!.asset("review");
    const preview = resultValue(previewDepreciationMonth(ctx, "2025-01"));
    resultValue(
      postDepreciationMonth(ctx, {
        month: "2025-01",
        expectedVersion: preview.version,
      }),
    );
    const row = book!.raw
      .query(
        "SELECT id FROM ledger_records WHERE legacy_kind LIKE 'asset-depreciation%' ORDER BY id DESC",
      )
      .get() as { id: number };
    return getRecord(db, row.id)!;
  }
  return {
    ...book,
    freight,
    acme,
    other,
    person,
    bill,
    pay,
    bankExpense,
    matched,
    freightCase,
    reimbursementPayment,
    invoicePosting,
    voidPair,
    depreciationJournal,
  };
}

/** Row count and an order-independent digest of every row, per table. */
function snapshot(b: Book): Record<string, { count: number; digest: string }> {
  const names = (
    b.raw
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[]
  ).map((r) => r.name);
  const out: Record<string, { count: number; digest: string }> = {};
  for (const name of names) {
    const rows = b.raw
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

function route(
  s: ReturnType<typeof seed>,
  id: number,
  change: RecordChange,
  release = false,
) {
  return resultValue(
    routeRecordChange(s.ctx, id, change, { releaseBankMatches: release }),
  );
}

/** One different value for each field, as an agent would send it. */
function sample(
  s: ReturnType<typeof seed>,
  record: RecordView,
  field: RecordChangeField,
): RecordChange {
  switch (field) {
    case "description":
      return { description: "Changed by the router spec" };
    case "reference":
      return { reference: "REF-ROUTER" };
    case "remark":
      return { remark: "Checked against the receipt" };
    case "contactId":
      return { contactId: s.other };
    case "date":
      return { date: record.date.slice(0, 8) + "20" };
    case "categoryAccountId":
      return { categoryAccountId: s.freight };
    case "lines":
      return {
        lines: [{ accountId: s.freight, amountMinor: record.amountMinor }],
      };
    case "amount":
      return { amount: (record.amount + 1).toFixed(2) };
    case "currency":
      return { currency: "USD" };
    case "exchangeRate":
      return { exchangeRate: 2 };
    case "tax":
      return {
        tax: [{ treatment: "non_deductible", reason: "Private use" }],
      };
  }
}

const pathsOf = (r: { steps: { path: string }[] }) =>
  r.steps.map((s) => s.path);

describe("routeRecordChange", () => {
  it("sends every field of an unsettled expense to update", () => {
    const s = seed();
    const record = s.bankExpense();
    for (const field of RECORD_CHANGE_FIELDS) {
      const r = route(s, record.id, sample(s, record, field));
      expect(r.blocked, field).toEqual([]);
      expect(r.steps, field).toEqual([
        expect.objectContaining({ path: "update", fields: [field] }),
      ]);
    }
    const all = route(s, record.id, {
      description: "All at once",
      reference: "R-1",
      remark: "Note",
      contactId: s.other,
      date: "2026-09-20",
      amount: "50.00",
      lines: [
        { accountId: s.expense, amountMinor: 3000 },
        { accountId: s.freight, amountMinor: 2000 },
      ],
      tax: [{ line: 0, treatment: "ordinary_deductible", reason: "Business" }],
    });
    expect(all.blocked).toEqual([]);
    // The new lines first, then tax against them.
    expect(pathsOf(all)).toEqual(["update", "update"]);
    expect(all.steps[1].fields).toEqual(["tax"]);
    expect(all.steps[0].needs).toEqual({ reason: false });
  });

  it("routes each field of a settled expense to its own path", () => {
    const s = seed();
    const { expense } = s.freightCase();
    const id = expense.id;
    expect(pathsOf(route(s, id, { description: "Goods" }))).toEqual(["update"]);
    expect(pathsOf(route(s, id, { categoryAccountId: s.freight }))).toEqual([
      "update",
    ]);
    // A re-split at the same total keeps the money side, so it stays an edit.
    expect(
      pathsOf(
        route(s, id, {
          lines: [
            { accountId: s.expense, amountMinor: 100_000 },
            { accountId: s.freight, amountMinor: 20_000 },
          ],
        }),
      ),
    ).toEqual(["update"]);

    const sameMonth = route(s, id, { date: "2026-09-20" });
    expect(sameMonth.steps).toEqual([
      expect.objectContaining({
        path: "correct_date",
        needs: { reason: true, acknowledgePeriodChange: false },
        permissions: expect.arrayContaining(["records.correctDate"]),
      }),
    ]);
    const otherMonth = route(s, id, { date: "2026-10-01" });
    expect(otherMonth.steps[0].needs.acknowledgePeriodChange).toBe(true);

    expect(route(s, id, { contactId: s.other }).steps).toEqual([
      expect.objectContaining({
        path: "correct_expense_contact",
        fields: ["contactId"],
      }),
    ]);
    const freight = route(s, id, {
      amount: "1285.00",
      lines: [
        { accountId: s.expense, amountMinor: 120_000 },
        { accountId: s.freight, amountMinor: 8_500 },
      ],
    });
    expect(freight.blocked).toEqual([]);
    expect(freight.steps).toEqual([
      expect.objectContaining({
        path: "correct_settled_amount",
        fields: ["lines", "amount"],
        needs: { reason: true },
      }),
    ]);
    // Asking for what it already says routes nothing.
    expect(route(s, id, { date: expense.date, amount: "1200" })).toEqual({
      steps: [],
      blocked: [],
    });
  });

  it("orders a mixed change: update, corrections, then tax", () => {
    const s = seed();
    const { expense } = s.freightCase();
    const r = route(s, expense.id, {
      description: "Goods and freight",
      date: "2026-09-03",
      amount: "1285",
      lines: [
        { accountId: s.expense, amountMinor: 120_000 },
        { accountId: s.freight, amountMinor: 8_500 },
      ],
      tax: [{ line: 1, treatment: "ordinary_deductible" }],
    });
    expect(pathsOf(r)).toEqual([
      "update",
      "correct_date",
      "correct_settled_amount",
      "update",
    ]);
    expect(r.steps[3]).toMatchObject({
      fields: ["tax"],
      needs: { reason: true },
    });
  });

  it("routes a payment's contact to the recipient correction", () => {
    const s = seed();
    const { payment } = s.freightCase();
    expect(route(s, payment.id, { contactId: s.other }).steps).toEqual([
      expect.objectContaining({
        path: "correct_payment_recipient",
        needs: { reason: true },
      }),
    ]);
  });

  it("routes a reimbursement payment's amount to its correction", () => {
    const s = seed();
    const payment = s.reimbursementPayment();
    const r = route(s, payment.id, { amount: "6.00" });
    expect(r.blocked).toEqual([]);
    expect(pathsOf(r)).toEqual(["correct_reimbursement_amount"]);
    const value = resultValue(
      changeRecord(s.ctx, {
        recordId: payment.id,
        expectedVersion: recordVersion(s.db, payment.id),
        change: { amount: "5.00" },
        reason: "The transfer to the employee was 5.00.",
      }),
    );
    expect(value.steps.map((step) => step.path)).toEqual([
      "correct_reimbursement_amount",
    ]);
    expect(value.record.amountMinor).toBe(500);
    const currency = route(s, payment.id, { amount: "6.00", currency: "USD" });
    expect(currency.blocked.map((b) => b.field)).toEqual(["currency"]);
  });

  it("blocks an invoice posting, a void pair and a depreciation journal", () => {
    const s = seed();
    const { voided, reversal } = s.voidPair();
    for (const record of [
      s.invoicePosting(),
      voided,
      reversal,
      s.depreciationJournal(),
    ]) {
      const r = route(s, record.id, {
        description: "Try anyway",
        date: "2026-09-21",
      });
      expect(r.steps, record.description).toEqual([]);
      expect(r.blocked.map((b) => b.field)).toEqual(["description", "date"]);
      for (const block of r.blocked) {
        expect(block.why.length).toBeGreaterThan(10);
        expect(block.fix.length).toBeGreaterThan(10);
      }
    }
  });

  it("blocks the date of a bank-matched record unless its matches are released", () => {
    const s = seed();
    const { record } = s.matched();
    const blocked = route(s, record.id, { date: "2026-09-05" });
    expect(blocked.steps).toEqual([]);
    expect(blocked.blocked).toEqual([
      expect.objectContaining({
        field: "date",
        fix: expect.stringContaining("releaseBankMatches"),
      }),
    ]);
    const released = route(s, record.id, { date: "2026-09-05" }, true);
    expect(released.steps).toEqual([
      expect.objectContaining({
        path: "update",
        needs: { reason: false, releaseBankMatches: true },
        permissions: ["records.update", "reconciliation.match"],
      }),
    ]);
    // The amount of a matched, unsettled record stays locked either way.
    expect(
      route(s, record.id, { amount: "41" }, true).blocked.map((b) => b.field),
    ).toEqual(["amount"]);
  });
});

describe("changeRecord", () => {
  it("corrects the freight case end to end", () => {
    const s = seed();
    const { expense, payment } = s.freightCase();
    const result = changeRecord(s.ctx, {
      recordId: expense.id,
      expectedVersion: recordVersion(s.db, expense.id),
      change: {
        amount: "1285.00",
        lines: [
          { accountId: s.expense, amountMinor: 120_000 },
          { accountId: s.freight, amountMinor: 8_500 },
        ],
      },
      reason: REASON,
    });
    const value = resultValue(result);
    expect(value.steps.map((step) => step.path)).toEqual([
      "correct_settled_amount",
    ]);
    expect(value.record.amountMinor).toBe(128_500);
    expect(value.record.paid).toBe(true);
    expect(value.version).toBe(recordVersion(s.db, expense.id));
    const reapplied = s.db
      .select()
      .from(schema.settlements)
      .all()
      .filter((row) => row.reversedAt === null);
    expect(reapplied.map((row) => row.amountMinor)).toEqual([128_500]);
    expect(getRecord(s.db, payment.id)!.amountMinor).toBe(128_500);
    expect(
      contactBalances(s.db, "we-owe", s.acme)[0]?.outstandingMinor ?? 0,
    ).toBe(0);
    expect(contactBalances(s.db, "we-owe", s.acme)[0]?.creditsMinor ?? 0).toBe(
      0,
    );
  });

  it("runs a description and a date as two steps in one transaction", () => {
    const s = seed();
    const { expense } = s.freightCase();
    const first = recordVersion(s.db, expense.id);
    const value = resultValue(
      changeRecord(s.ctx, {
        recordId: expense.id,
        expectedVersion: first,
        change: { description: "Goods, per receipt", date: "2026-09-05" },
        reason: "The receipt is dated the fifth.",
      }),
    );
    expect(value.steps.map((step) => step.path)).toEqual([
      "update",
      "correct_date",
    ]);
    expect(value.record).toMatchObject({
      description: "Goods, per receipt",
      date: "2026-09-05",
    });
    expect(value.version).toBe(recordVersion(s.db, expense.id));
    expect(value.version).not.toBe(first);
    // The old version is stale now; the returned one chains on.
    expect(
      changeRecord(s.ctx, {
        recordId: expense.id,
        expectedVersion: first,
        change: { remark: "late" },
      }),
    ).toMatchObject({ ok: false, code: "CONFLICT" });
    expect(
      changeRecord(s.ctx, {
        recordId: expense.id,
        expectedVersion: value.version,
        change: { remark: "late" },
      }).ok,
    ).toBe(true);
  });

  it("refuses a correction without a reason before writing anything", () => {
    const s = seed();
    const { expense } = s.freightCase();
    const before = snapshot(s);
    const result = changeRecord(s.ctx, {
      recordId: expense.id,
      expectedVersion: recordVersion(s.db, expense.id),
      change: { description: "Goods", date: "2026-09-05" },
    });
    expect(result).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    if (!result.ok) expect(result.reason).toContain("correct_date");
    expect(snapshot(s)).toEqual(before);
  });

  it("refuses the whole change when one field is blocked", () => {
    const s = seed();
    const { payment } = s.freightCase();
    const before = snapshot(s);
    const result = changeRecord(s.ctx, {
      recordId: payment.id,
      expectedVersion: recordVersion(s.db, payment.id),
      change: { description: "Renamed", date: "2026-09-05" },
      reason: "The payment left the bank on the fifth.",
    });
    // A payment's date has no correction while it settles a bill.
    expect(result).toMatchObject({
      ok: false,
      code: "REFUSED",
      blocked: [expect.objectContaining({ field: "date" })],
    });
    expect(snapshot(s)).toEqual(before);
  });

  it("rolls a dry run back and still reports every step", () => {
    const s = seed();
    const { expense } = s.freightCase();
    const before = snapshot(s);
    const value = resultValue(
      changeRecord(
        s.ctx,
        {
          recordId: expense.id,
          expectedVersion: recordVersion(s.db, expense.id),
          change: {
            description: "Goods and freight",
            amount: "1285.00",
            lines: [
              { accountId: s.expense, amountMinor: 120_000 },
              { accountId: s.freight, amountMinor: 8_500 },
            ],
          },
          reason: REASON,
        },
        { dryRun: true },
      ),
    );
    expect(value.steps.map((step) => step.path)).toEqual([
      "update",
      "correct_settled_amount",
    ]);
    expect(value.record.amountMinor).toBe(128_500);
    expect(snapshot(s)).toEqual(before);
  });

  it("persists nothing inside an outer transaction that throws", () => {
    const s = seed();
    const { expense } = s.freightCase();
    const before = snapshot(s);
    class Sentinel extends Error {}
    expect(() =>
      s.db.transaction(() => {
        resultValue(
          changeRecord(s.ctx, {
            recordId: expense.id,
            expectedVersion: recordVersion(s.db, expense.id),
            change: { description: "Inside", date: "2026-09-05" },
            reason: "The receipt is dated the fifth.",
          }),
        );
        throw new Sentinel("roll back");
      }),
    ).toThrow(Sentinel);
    expect(s.raw.inTransaction).toBe(false);
    expect(snapshot(s)).toEqual(before);
  });

  it("unmatches, changes and rematches the date of a bank-matched record", () => {
    const s = seed();
    const { record, lineId, bankSide } = s.matched();
    const value = resultValue(
      changeRecord(s.ctx, {
        recordId: record.id,
        expectedVersion: recordVersion(s.db, record.id),
        change: { date: "2026-09-05" },
        releaseBankMatches: true,
      }),
    );
    expect(value.record.date).toBe("2026-09-05");
    expect(value.record.reconciled).toBe(true);
    const matches = s.db.select().from(schema.reconciliationAllocations).all();
    expect(
      matches.map((m) => ({
        movementId: m.movementId,
        lineId: m.lineId,
        amount: m.amount,
      })),
    ).toEqual([{ movementId: bankSide.id, lineId, amount: 40 }]);
  });
});

describe("recordEditability", () => {
  it("tells no listener anything while it probes a bank-matched record", async () => {
    // Deciding a matched record's date runs the correction's own rules in a
    // savepoint that is always rolled back; a read must not announce that.
    const s = seed();
    const { record } = s.matched();
    // A settled expense whose owed side is itself matched (a statement on
    // the payable account, built directly as record-amount-correction.spec
    // does): deciding its date runs the probe in `afterReleasing`.
    const { expense } = s.freightCase();
    const payable = accountDefaultId(s.db, DefaultAccountPurpose.Payable)!;
    const owed = getRecord(s.db, expense.id)!.movements.find(
      (m) => m.accountId === payable,
    )!;
    const statementId = s.db
      .insert(schema.bankStatements)
      .values({
        originalFilename: "payable.pdf",
        storedFilePath: "reconciliation/payable.pdf",
        extractionState: StatementExtractionState.Ready,
        uploadedBy: 1,
        accountId: payable,
      })
      .returning()
      .get()!.id;
    const lineId = s.db
      .insert(schema.bankStatementLines)
      .values({
        statementId,
        date: expense.date,
        amount: 1200,
        direction: StatementDirection.Out,
      })
      .returning()
      .get()!.id;
    s.db
      .insert(schema.reconciliationAllocations)
      .values({
        lineId,
        movementId: owed.id,
        amount: 1200,
        itemAmountSnapshot: 1200,
        createdBy: 1,
      })
      .run();
    // Let the fixture's own audit announcements (queued as microtasks while
    // it was built outside any unit of work) go out before we listen.
    await new Promise((settle) => setTimeout(settle, 0));
    const heard: string[] = [];
    const subscriptions: [EventEmitter, string, () => void][] = [
      [auditEvents, "entry-added", () => heard.push("audit entry-added")],
      [
        reconciliationEvents,
        "allocation-update",
        () => heard.push("allocation-update"),
      ],
      [ledgerEvents, "record-update", () => heard.push("record-update")],
    ];
    for (const [emitter, name, listener] of subscriptions)
      emitter.on(name, listener);
    try {
      resultValue(recordEditability(s.ctx, record.id));
      route(s, record.id, { date: "2026-09-05" }, true);
      const settled = resultValue(recordEditability(s.ctx, expense.id));
      // The probe really ran: the date is a correction once matches are released.
      expect(settled.fields.date).toMatchObject({ mode: "correction" });
      route(s, expense.id, { date: "2026-09-05" }, true);
      await new Promise((settle) => setTimeout(settle, 0));
    } finally {
      for (const [emitter, name, listener] of subscriptions)
        emitter.off(name, listener);
    }
    expect(heard).toEqual([]);
  });

  it("agrees with routeRecordChange for every field of every fixture record", () => {
    const s = seed();
    const { expense, payment } = s.freightCase();
    const { voided, reversal } = s.voidPair();
    const records = [
      s.bankExpense(),
      expense,
      payment,
      s.reimbursementPayment(),
      s.matched().record,
      s.invoicePosting(),
      voided,
      reversal,
      s.depreciationJournal(),
    ].map((r) => getRecord(s.db, r.id)!);
    for (const record of records) {
      const map = resultValue(recordEditability(s.ctx, record.id));
      expect(map.version).toBe(recordVersion(s.db, record.id));
      for (const field of RECORD_CHANGE_FIELDS) {
        const r = route(s, record.id, sample(s, record, field), true);
        const entry = map.fields[field];
        const label = `${record.id}/${field}`;
        if (r.blocked.length) {
          expect(entry.mode, label).toBe("blocked");
          if (entry.mode === "blocked")
            expect(entry.why, label).toBe(r.blocked[0].why);
        } else if (r.steps[0].path === "update") {
          expect(entry.mode, label).toBe("edit");
        } else {
          expect(entry, label).toMatchObject({
            mode: "correction",
            path: r.steps[0].path,
          });
        }
      }
    }
    // Spot checks on the map itself.
    const settled = resultValue(recordEditability(s.ctx, expense.id)).fields;
    expect(settled.description).toEqual({ mode: "edit" });
    expect(settled.date).toEqual({
      mode: "correction",
      path: "correct_date",
      needs: { reason: true, acknowledgePeriodChange: true },
    });
    expect(settled.amount).toMatchObject({
      mode: "correction",
      path: "correct_settled_amount",
    });
    const frozen = resultValue(recordEditability(s.ctx, voided.id)).fields;
    for (const field of RECORD_CHANGE_FIELDS)
      expect(frozen[field].mode).toBe("blocked");
  });
});

describe("tax with a new split (review finding 1)", () => {
  /** An expense of 100.00 split [Office 60, Meals 40], paid from the bank. */
  function officeAndMeals() {
    const s = seed();
    const office = resultValue(
      createAccount(s.db, 1, { name: "Office", type: AccountType.Expense }),
    ).id;
    const meals = resultValue(
      createAccount(s.db, 1, { name: "Meals", type: AccountType.Expense }),
    ).id;
    const record = s.bankExpense(100);
    resultValue(
      changeRecord(s.ctx, {
        recordId: record.id,
        expectedVersion: recordVersion(s.db, record.id),
        change: {
          lines: [
            { accountId: office, amountMinor: 6_000 },
            { accountId: meals, amountMinor: 4_000 },
          ],
        },
      }),
    );
    return { s, office, meals, id: record.id };
  }

  /** Each category line in movement order, with its tax treatment. */
  function taxByLine(s: ReturnType<typeof seed>, id: number) {
    return getRecord(s.db, id)!
      .movements.filter((m) => m.amountMinor > 0 && m.accountId !== s.bank)
      .map((m) => ({
        accountId: m.accountId,
        amountMinor: m.amountMinor,
        treatment: m.taxClassification?.treatment ?? null,
      }));
  }

  it("classifies the line at the index after the change, not before", () => {
    const { s, office, meals, id } = officeAndMeals();
    const value = resultValue(
      changeRecord(s.ctx, {
        recordId: id,
        expectedVersion: recordVersion(s.db, id),
        change: {
          lines: [
            { accountId: meals, amountMinor: 7_000 },
            { accountId: office, amountMinor: 3_000 },
          ],
          tax: [{ line: 0, treatment: "non_deductible" }],
        },
        reason: "Client lunch, not deductible.",
      }),
    );
    const lines = taxByLine(s, id);
    expect(lines[1]).toMatchObject({ accountId: office, amountMinor: 3_000 });
    expect(lines[1].treatment).not.toBe("non_deductible");
    expect(lines[0]).toMatchObject({
      accountId: meals,
      amountMinor: 7_000,
      treatment: "non_deductible",
    });
    expect(value.steps.map((step) => step.fields)).toEqual([
      ["lines"],
      ["tax"],
    ]);
  });

  it("classifies a line the change adds", () => {
    const s = seed();
    const meals = resultValue(
      createAccount(s.db, 1, { name: "Meals", type: AccountType.Expense }),
    ).id;
    const record = s.bankExpense(100);
    const value = resultValue(
      changeRecord(s.ctx, {
        recordId: record.id,
        expectedVersion: recordVersion(s.db, record.id),
        change: {
          lines: [
            { accountId: s.expense, amountMinor: 6_000 },
            { accountId: meals, amountMinor: 4_000 },
          ],
          tax: [{ line: 1, treatment: "non_deductible" }],
        },
        reason: "Client lunch, not deductible.",
      }),
    );
    expect(value.steps).toHaveLength(2);
    expect(taxByLine(s, record.id)[1]).toMatchObject({
      accountId: meals,
      treatment: "non_deductible",
    });
  });

  it("classifies the new category when the category changes", () => {
    const s = seed();
    const record = s.bankExpense(100);
    const value = resultValue(
      changeRecord(s.ctx, {
        recordId: record.id,
        expectedVersion: recordVersion(s.db, record.id),
        change: {
          categoryAccountId: s.freight,
          tax: [{ treatment: "non_deductible" }],
        },
        reason: "Freight for a private parcel.",
      }),
    );
    expect(value.steps.map((step) => step.fields)).toEqual([
      ["categoryAccountId"],
      ["tax"],
    ]);
    expect(taxByLine(s, record.id)).toEqual([
      {
        accountId: s.freight,
        amountMinor: 10_000,
        treatment: "non_deductible",
      },
    ]);
  });

  it("still folds tax into a plain update that leaves the lines alone", () => {
    const s = seed();
    const record = s.bankExpense(100);
    const r = route(s, record.id, {
      description: "Stationery",
      tax: [{ treatment: "non_deductible", reason: "Private use" }],
    });
    expect(r.steps).toEqual([
      expect.objectContaining({
        path: "update",
        fields: ["description", "tax"],
      }),
    ]);
  });
});
