import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AccountSubType,
  AccountType,
  DefaultAccountPurpose,
  EntityType,
  InvoiceStatus,
  QuotationStatus,
} from "$lib/enums.js";
import * as schema from "../db/schema.js";
import { accountDefaults, contacts, users } from "../db/schema.js";
import { createAccount } from "./accounts.js";
import { createRecord, removeRecord, type DeferredEmits } from "./ledger.js";
import { createSettlements } from "./settlements.js";
import { issueInvoice } from "./invoices.js";
import {
  createInvoice,
  deriveOverdue,
  getInvoice,
} from "../queries/invoices.js";
import { deriveExpired } from "../queries/quotations.js";
import { getRecord } from "../queries/ledger.js";
import { toMinor } from "../ledger/money.js";
import { invoiceEvents } from "../finance/events.js";
import { ledgerEvents } from "../ledger/events.js";
import type { AccountCreate, LedgerDb } from "../ledger/types.js";

/**
 * An invoice once it is in the books: what its issue posting says, who may
 * remove it, how its paid state is found, and who hears when it changes. Run
 * against a real in-memory database, so nothing here can touch `data/`.
 */

let sqlite: Database;
let db: LedgerDb;
const userId = 1;

beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema }) as unknown as LedgerDb;
  migrate(db as never, { migrationsFolder: "drizzle" });
  db.insert(users)
    .values({ email: "u@test", username: "u", passwordHash: "x" })
    .run();
});
afterEach(() => sqlite.close());

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

function sentInvoice(
  b: ReturnType<typeof book>,
  opts: { currency?: string; exchangeRate?: number; unitPrice?: number } = {},
) {
  const invoice = createInvoice(db, userId, {
    contactId: b.customer,
    issueDate: "2026-08-01",
    currency: opts.currency ?? "MYR",
    exchangeRate: opts.exchangeRate ?? 1,
    lines: [
      {
        description: "Consulting",
        quantity: 1,
        unitPrice: opts.unitPrice ?? 100,
      },
    ],
  });
  const issued = issueInvoice(db, invoice.id, userId, {
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

describe("an invoice in another currency", () => {
  it("can be sent, and owes toMinor(total, rate) in the main currency", () => {
    const b = book();
    const invoice = sentInvoice(b, {
      currency: "USD",
      exchangeRate: 4.4567,
      unitPrice: 123.45,
    });

    const record = getRecord(db, invoice.ledgerRecordId!)!;
    const expected = toMinor(123.45, 4.4567);
    const owed = record.movements.find((m) => m.accountId === b.receivable)!;
    expect(owed.amountMinor).toBe(expected);
    expect(record.movements.reduce((s, m) => s + m.amountMinor, 0)).toBe(0);
    expect(record.currency).toBe("USD");
    expect(record.exchangeRate).toBe(4.4567);
    expect(invoice.outstandingMinor).toBe(expected);
  });

  it("does not open other kinds to a foreign rate", () => {
    const b = book();
    const result = createRecord(db, userId, {
      kind: "transfer",
      date: "2026-08-01",
      description: "Move",
      amount: 10,
      currency: "USD",
      exchangeRate: 4,
      fromAccountId: b.bank,
      toAccountId: account("Savings", AccountType.Asset, AccountSubType.Bank),
    });
    expect(result.ok).toBe(false);
  });
});

describe("the paid state of a sent invoice", () => {
  it("exposes the movement a payment settles", () => {
    const b = book();
    const invoice = sentInvoice(b);
    const record = getRecord(db, invoice.ledgerRecordId!)!;
    expect(invoice.owedMovementId).toBe(
      record.movements.find((m) => m.accountId === b.receivable)!.id,
    );
  });

  it("survives a change of the Receivable default", () => {
    const b = book();
    const invoice = sentInvoice(b);
    pay(b, invoice, 4000);

    const before = getInvoice(db, invoice.id)!;
    expect(before.paidMinor).toBe(4000);
    expect(before.outstandingMinor).toBe(6000);

    const another = account(
      "Trade Debtors",
      AccountType.Asset,
      AccountSubType.Receivable,
    );
    setDefault(DefaultAccountPurpose.Receivable, another);

    const after = getInvoice(db, invoice.id)!;
    expect(after.paidMinor).toBe(4000);
    expect(after.outstandingMinor).toBe(6000);
    expect(after.paid).toBe(false);
    expect(after.owedMovementId).toBe(invoice.owedMovementId);
  });
});

describe("removing an invoice's issue posting", () => {
  it("is refused from the records side", () => {
    const b = book();
    const invoice = sentInvoice(b);

    const result = removeRecord(db, invoice.ledgerRecordId!, userId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/Cancel the invoice/);
    expect(getRecord(db, invoice.ledgerRecordId!)).not.toBeNull();
  });

  it("is allowed for the invoice itself, with its emits held back", () => {
    const b = book();
    const invoice = sentInvoice(b);
    const deleted: number[] = [];
    const onDeleted = (e: { id: number }) => deleted.push(e.id);
    ledgerEvents.on("record-deleted", onDeleted);
    try {
      const deferredEmits: DeferredEmits = [];
      const result = removeRecord(db, invoice.ledgerRecordId!, userId, {
        allowReadOnlyKind: true,
        deferredEmits,
      });
      expect(result.ok).toBe(true);
      expect(getRecord(db, invoice.ledgerRecordId!)).toBeNull();
      expect(deleted).toEqual([]);

      for (const emit of deferredEmits) emit();
      expect(deleted).toEqual([invoice.ledgerRecordId]);
    } finally {
      ledgerEvents.off("record-deleted", onDeleted);
    }
  });
});

describe("recording a payment against an invoice", () => {
  it("tells the invoices list, with the new paid state", () => {
    const b = book();
    const invoice = sentInvoice(b);
    const updates: { id: number; paidMinor: number }[] = [];
    const onUpdate = (e: { item: { id: number; paidMinor: number } }) =>
      updates.push({ id: e.item.id, paidMinor: e.item.paidMinor });
    invoiceEvents.on("invoice-update", onUpdate);
    try {
      pay(b, invoice, 2500);
    } finally {
      invoiceEvents.off("invoice-update", onUpdate);
    }
    expect(updates).toEqual([{ id: invoice.id, paidMinor: 2500 }]);
  });
});

describe("overdue and expired", () => {
  const today = "2026-10-09";

  it("only a sent invoice can be overdue", () => {
    const due = { dueDate: "2026-10-08" };
    expect(
      deriveOverdue({ ...due, status: InvoiceStatus.Sent }, false, today),
    ).toBe(true);
    expect(
      deriveOverdue({ ...due, status: InvoiceStatus.Draft }, false, today),
    ).toBe(false);
    expect(
      deriveOverdue({ ...due, status: InvoiceStatus.Cancelled }, false, today),
    ).toBe(false);
    expect(
      deriveOverdue({ ...due, status: InvoiceStatus.Sent }, true, today),
    ).toBe(false);
  });

  it("is not overdue on the due date itself", () => {
    expect(
      deriveOverdue(
        { dueDate: today, status: InvoiceStatus.Sent },
        false,
        today,
      ),
    ).toBe(false);
  });

  it("only an open quote expires", () => {
    const past = { expiryDate: "2026-10-08" };
    expect(
      deriveExpired({ ...past, status: QuotationStatus.Sent }, today),
    ).toBe(true);
    expect(
      deriveExpired({ ...past, status: QuotationStatus.Accepted }, today),
    ).toBe(false);
    expect(
      deriveExpired(
        { expiryDate: today, status: QuotationStatus.Draft },
        today,
      ),
    ).toBe(false);
  });
});
