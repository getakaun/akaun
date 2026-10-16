import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AccountSubType,
  AccountType,
  DefaultAccountPurpose,
  EntityType,
  InvoiceStatus,
  QuotationStatus,
} from "$lib/enums.js";
import * as schema from "../db/schema.js";
import {
  accountDefaults,
  auditLog,
  bankStatementLines,
  bankStatements,
  contacts,
  invoices,
  ledgerMovements,
  ledgerRecords,
  quotations,
  reconciliationAllocations,
  users,
} from "../db/schema.js";
import { createAccount } from "./accounts.js";
import { createRecord } from "./ledger.js";
import { createSettlements } from "./settlements.js";
import {
  cancelInvoice,
  issueInvoice,
  removeInvoice,
  voidAndReissueInvoice,
} from "./invoices.js";
import { createQuotation, getQuotation } from "../queries/quotations.js";
import * as invoiceQueries from "../queries/invoices.js";
import { createInvoice, getInvoice } from "../queries/invoices.js";
import { getRecord } from "../queries/ledger.js";
import { invoiceEvents } from "../finance/events.js";
import { ledgerEvents } from "../ledger/events.js";
import type { AccountCreate, LedgerDb } from "../ledger/types.js";

/**
 * Voiding a sent invoice, and sending one in a single transaction. Run against
 * a real in-memory database, so nothing here can touch `data/`.
 */

let sqlite: Database;
let db: LedgerDb;
const userId = 1;

beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema }) as unknown as LedgerDb;
  migrate(db as never, { migrationsFolder: "drizzle" });
  // On, as `db/client.ts` has it: a record's movements go with it by cascade,
  // and an invoice's link to it is a foreign key too.
  sqlite.exec("PRAGMA foreign_keys = ON");
  db.insert(users)
    .values({ email: "u@test", username: "u", passwordHash: "x" })
    .run();
});
afterEach(() => {
  vi.restoreAllMocks();
  sqlite.close();
});

function account(
  name: string,
  type: AccountCreate["type"],
  subType?: AccountCreate["subType"],
): number {
  const result = createAccount(db, userId, { name, type, subType });
  if (!result.ok) throw new Error(result.reason);
  return result.value.id;
}

function setDefault(purpose: number, accountId: number) {
  db.delete(accountDefaults).where(eq(accountDefaults.purpose, purpose)).run();
  db.insert(accountDefaults)
    .values({ purpose, accountId, updatedBy: userId })
    .run();
}

/** A book with the saved defaults issuing and paying an invoice needs. */
function book() {
  const receivable = account(
    "Accounts Receivable",
    AccountType.Asset,
    AccountSubType.Receivable,
  );
  setDefault(DefaultAccountPurpose.Receivable, receivable);
  const payable = account(
    "Accounts Payable",
    AccountType.Liability,
    AccountSubType.AccountsPayable,
  );
  setDefault(DefaultAccountPurpose.Payable, payable);
  const sales = account("Sales", AccountType.Revenue);
  const bank = account("Main Bank", AccountType.Asset, AccountSubType.Bank);
  const customer = db
    .insert(contacts)
    .values({ entityType: EntityType.Business, legalName: "Acme Sdn Bhd" })
    .returning({ id: contacts.id })
    .get().id;
  return { receivable, sales, bank, customer };
}

function draftInvoice(b: ReturnType<typeof book>) {
  return createInvoice(db, userId, {
    contactId: b.customer,
    issueDate: "2026-08-01",
    currency: "MYR",
    exchangeRate: 1,
    lines: [{ description: "Consulting", quantity: 1, unitPrice: 100 }],
  });
}

function sentInvoice(b: ReturnType<typeof book>) {
  const issued = issueInvoice(db, draftInvoice(b).id, userId, {
    incomeAccountId: b.sales,
  });
  if (!issued.ok) throw new Error(issued.reason);
  return issued.value;
}

/** A customer's payment into the bank, settling `amountMinor` of the invoice. */
function pay(
  b: ReturnType<typeof book>,
  invoice: ReturnType<typeof sentInvoice>,
  amountMinor: number,
) {
  const payment = createRecord(db, userId, {
    kind: "payment",
    date: "2026-08-10",
    description: "Payment from Acme",
    amount: amountMinor / 100,
    currency: "MYR",
    exchangeRate: 1,
    contactId: b.customer,
    paidFromAccountId: b.bank,
    direction: "we-receive",
  });
  if (!payment.ok) throw new Error(payment.reason);
  const paymentMovement = payment.value.movements.find(
    (m) => m.amountMinor < 0,
  )!;
  const settled = createSettlements(db, userId, paymentMovement.id, [
    { owedMovementId: invoice.owedMovementId!, amountMinor },
  ]);
  if (!settled.ok) throw new Error(settled.reason);
}

function movementsOf(recordId: number) {
  return db
    .select()
    .from(ledgerMovements)
    .where(eq(ledgerMovements.recordId, recordId))
    .all();
}

function auditFor(recordType: string, recordId: number) {
  return db
    .select()
    .from(auditLog)
    .where(
      and(eq(auditLog.recordType, recordType), eq(auditLog.recordId, String(recordId))),
    )
    .all();
}

/** Sets the stored status directly, the way the old PATCH did. */
function forceStatus(invoiceId: number, status: number) {
  db.update(invoices).set({ status }).where(eq(invoices.id, invoiceId)).run();
}

describe("voiding a sent invoice", () => {
  it("removes the posting and its movements, keeps the number, and cannot be deleted afterwards", () => {
    const b = book();
    const invoice = sentInvoice(b);
    const recordId = invoice.ledgerRecordId!;
    expect(movementsOf(recordId)).toHaveLength(2);

    const order: string[] = [];
    const onInvoice = (e: { item: { status: number } }) =>
      order.push(`invoice:${e.item.status}`);
    const onDeleted = (e: { id: number }) => order.push(`record:${e.id}`);
    invoiceEvents.on("invoice-update", onInvoice);
    ledgerEvents.on("record-deleted", onDeleted);
    let result!: ReturnType<typeof cancelInvoice>;
    try {
      result = cancelInvoice(db as never, invoice.id, userId);
    } finally {
      invoiceEvents.off("invoice-update", onInvoice);
      ledgerEvents.off("record-deleted", onDeleted);
    }

    if (!result.ok) throw new Error(result.reason);
    expect(result.value.status).toBe(InvoiceStatus.Cancelled);
    expect(result.value.invoiceNumber).toBe(invoice.invoiceNumber);
    expect(result.value.ledgerRecordId).toBeNull();
    expect(result.value.outstandingMinor).toBe(0);

    // Out of the books entirely: the record, both its sides.
    expect(getRecord(db, recordId)).toBeNull();
    expect(movementsOf(recordId)).toHaveLength(0);

    // Told after the commit, the record's removal first.
    expect(order).toEqual([
      `record:${recordId}`,
      `invoice:${InvoiceStatus.Cancelled}`,
    ]);

    // Audited on both sides: the invoice's change, and a snapshot of the
    // record that went.
    const invoiceChange = auditFor("invoice", invoice.id).at(-1)!;
    expect(JSON.parse(invoiceChange.changes!)).toEqual(
      expect.arrayContaining([
        {
          field: "status",
          before: InvoiceStatus.Sent,
          after: InvoiceStatus.Cancelled,
        },
        { field: "ledgerRecordId", before: recordId, after: null },
      ]),
    );
    expect(auditFor("record", recordId).at(-1)!.action).toBe("delete");

    // A cancelled invoice keeps its number.
    expect(removeInvoice(db as never, invoice.id, userId)).toEqual({
      ok: false,
      reason: "cancelled",
    });
    expect(getInvoice(db, invoice.id)).not.toBeNull();

    // And cancelling it again has nothing left to do.
    const again = cancelInvoice(db as never, invoice.id, userId);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toMatch(/already cancelled/);
  });

  it("is refused once a payment has been recorded against it", () => {
    const b = book();
    const invoice = sentInvoice(b);
    pay(b, invoice, 1000);

    const result = cancelInvoice(db as never, invoice.id, userId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/payment/);

    const after = getInvoice(db, invoice.id)!;
    expect(after.status).toBe(InvoiceStatus.Sent);
    expect(after.ledgerRecordId).toBe(invoice.ledgerRecordId);
    expect(getRecord(db, invoice.ledgerRecordId!)).not.toBeNull();
  });

  it("is refused on a draft, which is deleted instead", () => {
    const b = book();
    const draft = draftInvoice(b);

    const result = cancelInvoice(db as never, draft.id, userId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/Delete it instead/);
    expect(getInvoice(db, draft.id)!.status).toBe(InvoiceStatus.Draft);
  });

  it("passes the record's own refusal through, and writes nothing", () => {
    const b = book();
    const invoice = sentInvoice(b);
    // The owed side matched to a bank line, the way reconciling records it.
    const statementId = db
      .insert(bankStatements)
      .values({
        originalFilename: "s.csv",
        storedFilePath: "s.csv",
        accountId: b.bank,
      })
      .returning({ id: bankStatements.id })
      .get().id;
    const lineId = db
      .insert(bankStatementLines)
      .values({ statementId, date: "2026-08-02", amount: 100, direction: 1 })
      .returning({ id: bankStatementLines.id })
      .get().id;
    db.insert(reconciliationAllocations)
      .values({
        lineId,
        movementId: invoice.owedMovementId!,
        amount: 100,
        itemAmountSnapshot: 100,
      })
      .run();
    const auditBefore = auditFor("invoice", invoice.id).length;

    const result = cancelInvoice(db as never, invoice.id, userId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/bank line/);

    expect(getInvoice(db, invoice.id)!.status).toBe(InvoiceStatus.Sent);
    expect(getRecord(db, invoice.ledgerRecordId!)).not.toBeNull();
    expect(auditFor("invoice", invoice.id)).toHaveLength(auditBefore);
  });

  it("finishes an invoice cancelled before cancelling removed its posting", () => {
    const b = book();
    const invoice = sentInvoice(b);
    const recordId = invoice.ledgerRecordId!;
    forceStatus(invoice.id, InvoiceStatus.Cancelled);

    const result = cancelInvoice(db as never, invoice.id, userId);
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.status).toBe(InvoiceStatus.Cancelled);
    expect(result.value.ledgerRecordId).toBeNull();
    expect(getRecord(db, recordId)).toBeNull();

    // The status did not change, but the link did, and the log says so.
    expect(
      JSON.parse(auditFor("invoice", invoice.id).at(-1)!.changes!),
    ).toEqual([
      expect.objectContaining({
        field: "ledgerRecordId",
        before: recordId,
        after: null,
      }),
    ]);
  });

  it("cancels an invoice sent before the upgrade, which has no posting", () => {
    const b = book();
    const draft = draftInvoice(b);
    forceStatus(draft.id, InvoiceStatus.Sent);

    const result = cancelInvoice(db as never, draft.id, userId);
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.status).toBe(InvoiceStatus.Cancelled);
    // Sent, so it still cannot be deleted — and now it is cancelled anyway.
    expect(removeInvoice(db as never, draft.id, userId).ok).toBe(false);
  });
});

describe("deleting an invoice", () => {
  it("is refused once it has been sent", () => {
    const b = book();
    const invoice = sentInvoice(b);
    expect(removeInvoice(db as never, invoice.id, userId)).toEqual({
      ok: false,
      reason: "issued",
    });
  });
});

describe("sending an invoice", () => {
  it("rolls back with no stray record when linking the invoice fails", () => {
    const b = book();
    const draft = draftInvoice(b);
    vi.spyOn(invoiceQueries, "markInvoiceIssued").mockImplementation(() => {
      throw new Error("disk full");
    });

    const updates: number[] = [];
    const onUpdate = (e: { record: { id: number } }) =>
      updates.push(e.record.id);
    ledgerEvents.on("record-update", onUpdate);
    try {
      expect(() =>
        issueInvoice(db as never, draft.id, userId, {
          incomeAccountId: b.sales,
        }),
      ).toThrow("disk full");
    } finally {
      ledgerEvents.off("record-update", onUpdate);
    }

    // Nothing in the books, nothing announced, and still a draft.
    expect(db.select().from(ledgerRecords).all()).toHaveLength(0);
    expect(db.select().from(ledgerMovements).all()).toHaveLength(0);
    expect(updates).toEqual([]);
    const after = getInvoice(db, draft.id)!;
    expect(after.status).toBe(InvoiceStatus.Draft);
    expect(after.ledgerRecordId).toBeNull();

    // And it can still be sent, once.
    vi.restoreAllMocks();
    const issued = issueInvoice(db as never, draft.id, userId, {
      incomeAccountId: b.sales,
    });
    expect(issued.ok).toBe(true);
    expect(db.select().from(ledgerRecords).all()).toHaveLength(1);
  });
});

describe("cancelling and reissuing a sent invoice", () => {
  /** A sent invoice that a converted quotation points at. */
  function convertedSentInvoice(b: ReturnType<typeof book>) {
    const invoice = sentInvoice(b);
    const quote = createQuotation(db as never, userId, {
      contactId: b.customer,
      issueDate: "2026-07-20",
      lines: [{ description: "Consulting", quantity: 1, unitPrice: 100 }],
    });
    db.update(quotations)
      .set({
        status: QuotationStatus.Converted,
        convertedInvoiceId: invoice.id,
      })
      .where(eq(quotations.id, quote.id))
      .run();
    db.update(invoices)
      .set({ sourceQuotationId: quote.id })
      .where(eq(invoices.id, invoice.id))
      .run();
    return { invoice: getInvoice(db, invoice.id)!, quoteId: quote.id };
  }

  it("voids the old one and opens a linked draft copy with a new number, dated today on the same term", () => {
    const b = book();
    const sent = sentInvoice(b);
    db.update(invoices)
      .set({ dueDate: "2026-08-31", notes: "Thanks" })
      .where(eq(invoices.id, sent.id))
      .run();

    const result = voidAndReissueInvoice(db as never, sent.id, userId, {
      today: "2026-09-10",
    });
    if (!result.ok) throw new Error(result.reason);
    const { voided, invoice } = result.value;

    expect(voided.status).toBe(InvoiceStatus.Cancelled);
    expect(voided.ledgerRecordId).toBeNull();
    expect(getRecord(db, sent.ledgerRecordId!)).toBeNull();

    expect(invoice.status).toBe(InvoiceStatus.Draft);
    expect(invoice.ledgerRecordId).toBeNull();
    expect(invoice.invoiceNumber).not.toBe(sent.invoiceNumber);
    expect(invoice.issueDate).toBe("2026-09-10");
    expect(invoice.dueDate).toBe("2026-10-10"); // 30 days, as before
    expect(invoice.notes).toBe("Thanks");
    expect(invoice.total).toBe(sent.total);
    expect(invoice.lines.map((l) => l.description)).toEqual(["Consulting"]);
    expect(invoice.replaces).toEqual({
      id: sent.id,
      invoiceNumber: sent.invoiceNumber,
    });
    expect(getInvoice(db, sent.id)!.replacedBy).toEqual({
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
    });
  });

  it("moves the quotation it came from onto the new invoice", () => {
    const b = book();
    const { invoice: sent, quoteId } = convertedSentInvoice(b);

    const result = voidAndReissueInvoice(db as never, sent.id, userId);
    if (!result.ok) throw new Error(result.reason);

    const quote = getQuotation(db as never, quoteId)!;
    expect(quote.status).toBe(QuotationStatus.Converted);
    expect(quote.convertedInvoiceId).toBe(result.value.invoice.id);
    expect(result.value.invoice.sourceQuotationId).toBe(quoteId);
  });

  it("is refused on the same terms as a cancel, and writes nothing", () => {
    const b = book();
    const invoice = sentInvoice(b);
    pay(b, invoice, 1000);
    const before = db.select().from(invoices).all().length;

    const result = voidAndReissueInvoice(db as never, invoice.id, userId);
    expect(result.ok).toBe(false);
    expect(db.select().from(invoices).all()).toHaveLength(before);
    expect(getInvoice(db, invoice.id)!.status).toBe(InvoiceStatus.Sent);
  });
});

describe("cancelling an invoice a quotation was converted into", () => {
  it("puts the quotation back to Accepted, so it can be converted again", () => {
    const b = book();
    const invoice = sentInvoice(b);
    const quote = createQuotation(db as never, userId, {
      contactId: b.customer,
      issueDate: "2026-07-20",
      lines: [{ description: "Consulting", quantity: 1, unitPrice: 100 }],
    });
    db.update(quotations)
      .set({
        status: QuotationStatus.Converted,
        convertedInvoiceId: invoice.id,
      })
      .where(eq(quotations.id, quote.id))
      .run();
    db.update(invoices)
      .set({ sourceQuotationId: quote.id })
      .where(eq(invoices.id, invoice.id))
      .run();

    const result = cancelInvoice(db as never, invoice.id, userId);
    if (!result.ok) throw new Error(result.reason);

    const back = getQuotation(db as never, quote.id)!;
    expect(back.status).toBe(QuotationStatus.Accepted);
    expect(back.convertedInvoiceId).toBeNull();
  });
});
