import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AccountSubType,
  AccountType,
  DefaultAccountPurpose,
  EntityType,
} from "$lib/enums.js";
import * as schema from "../db/schema.js";
import { accountDefaults, contacts, users } from "../db/schema.js";
import { createAccount } from "./accounts.js";
import { createRecord } from "./ledger.js";
import { createSettlements, undoSettlement } from "./settlements.js";
import { settlementIdsForPayment } from "../queries/settlements.js";
import type { LedgerDb } from "../ledger/types.js";

/**
 * A payment naming one contact may only settle that contact's own items — the
 * existing rule. A payment naming none (a batch across several contacts, one
 * real bank transfer) is the new exception: it may settle items across
 * several contacts at once, provided every item still belongs to somebody and
 * the payment is spent in full.
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

function bankAccount(name: string) {
  const result = createAccount(db, userId, {
    name,
    type: AccountType.Asset,
    subType: AccountSubType.Bank,
  });
  if (!result.ok) throw new Error(result.reason);
  return result.value.id;
}

function categoryAccount(name: string) {
  const result = createAccount(db, userId, { name, type: AccountType.Expense });
  if (!result.ok) throw new Error(result.reason);
  return result.value.id;
}

function payableAccount() {
  const result = createAccount(db, userId, {
    name: "Accounts Payable",
    type: AccountType.Liability,
    subType: AccountSubType.AccountsPayable,
  });
  if (!result.ok) throw new Error(result.reason);
  db.insert(accountDefaults)
    .values({
      purpose: DefaultAccountPurpose.Payable,
      accountId: result.value.id,
      updatedBy: userId,
    })
    .run();
  return result.value.id;
}

/** `createSettlements` checks both saved defaults regardless of direction. */
function receivableAccount() {
  const result = createAccount(db, userId, {
    name: "Accounts Receivable",
    type: AccountType.Asset,
    subType: AccountSubType.Receivable,
  });
  if (!result.ok) throw new Error(result.reason);
  db.insert(accountDefaults)
    .values({
      purpose: DefaultAccountPurpose.Receivable,
      accountId: result.value.id,
      updatedBy: userId,
    })
    .run();
  return result.value.id;
}

function contact(name: string): number {
  return db
    .insert(contacts)
    .values({ entityType: EntityType.Business, legalName: name })
    .returning({ id: contacts.id })
    .get().id;
}

/** An expense someone else paid — owed to `contactId` (FR-008). */
function makeExpenseOwed(categoryId: number, contactId: number, amount = 50) {
  const result = createRecord(db, userId, {
    kind: "expense",
    date: "2026-08-01",
    description: "Owed expense",
    amount,
    currency: "USD",
    exchangeRate: 1,
    categoryAccountId: categoryId,
    paidFromAccountId: null,
    contactId,
  });
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}

function owedMovementOf(record: ReturnType<typeof makeExpenseOwed>) {
  return record.movements.find((m) => m.amountMinor < 0)!;
}

describe("a single-contact payment", () => {
  it("settles that contact's own item", () => {
    const category = categoryAccount("Office Supplies");
    payableAccount();
    receivableAccount();
    const bank = bankAccount("Main Bank");
    const alice = contact("Alice");
    const owed = makeExpenseOwed(category, alice);
    const owedMovement = owedMovementOf(owed);

    const payment = createRecord(db, userId, {
      kind: "payment",
      date: "2026-08-02",
      description: "Reimburse Alice",
      amount: 50,
      currency: "USD",
      exchangeRate: 1,
      contactId: alice,
      paidFromAccountId: bank,
      direction: "we-pay",
    });
    if (!payment.ok) throw new Error(payment.reason);
    const paymentMovement = payment.value.movements.find(
      (m) => m.amountMinor > 0,
    )!;

    const result = createSettlements(db, userId, paymentMovement.id, [
      { owedMovementId: owedMovement.id, amountMinor: 5000 },
    ]);
    expect(result.ok, result.ok ? "" : result.reason).toBe(true);
  });

  it("refuses to settle a different contact's item", () => {
    const category = categoryAccount("Office Supplies");
    payableAccount();
    receivableAccount();
    const bank = bankAccount("Main Bank");
    const alice = contact("Alice");
    const bob = contact("Bob");
    const bobsExpense = makeExpenseOwed(category, bob);
    const bobsMovement = owedMovementOf(bobsExpense);

    const payment = createRecord(db, userId, {
      kind: "payment",
      date: "2026-08-02",
      description: "Reimburse Alice",
      amount: 50,
      currency: "USD",
      exchangeRate: 1,
      contactId: alice,
      paidFromAccountId: bank,
      direction: "we-pay",
    });
    if (!payment.ok) throw new Error(payment.reason);
    const paymentMovement = payment.value.movements.find(
      (m) => m.amountMinor > 0,
    )!;

    const result = createSettlements(db, userId, paymentMovement.id, [
      { owedMovementId: bobsMovement.id, amountMinor: 5000 },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/different people/i);
  });
});

describe("a batch payment naming no single contact", () => {
  it("settles items across several contacts at once, fully allocated", () => {
    const category = categoryAccount("Office Supplies");
    payableAccount();
    receivableAccount();
    const bank = bankAccount("Main Bank");
    const alice = contact("Alice");
    const bob = contact("Bob");
    const alicesExpense = makeExpenseOwed(category, alice, 30);
    const bobsExpense = makeExpenseOwed(category, bob, 20);
    const alicesMovement = owedMovementOf(alicesExpense);
    const bobsMovement = owedMovementOf(bobsExpense);
    const allocations = [
      { owedMovementId: alicesMovement.id, amountMinor: 3000 },
      { owedMovementId: bobsMovement.id, amountMinor: 2000 },
    ];

    const payment = createRecord(db, userId, {
      kind: "payment",
      date: "2026-08-02",
      description: "Batch reimbursement",
      amount: 50,
      currency: "USD",
      exchangeRate: 1,
      contactId: null,
      paidFromAccountId: bank,
      direction: "we-pay",
      settlements: allocations,
    });
    if (!payment.ok) throw new Error(payment.reason);
    const paymentMovement = payment.value.movements.find(
      (m) => m.amountMinor > 0,
    )!;

    const result = createSettlements(
      db,
      userId,
      paymentMovement.id,
      allocations,
    );
    expect(result.ok, result.ok ? "" : result.reason).toBe(true);
  });

  it("refuses to leave part of itself unallocated", () => {
    const category = categoryAccount("Office Supplies");
    payableAccount();
    receivableAccount();
    const bank = bankAccount("Main Bank");
    const alice = contact("Alice");
    const bob = contact("Bob");
    const alicesExpense = makeExpenseOwed(category, alice, 30);
    const bobsExpense = makeExpenseOwed(category, bob, 20);
    const alicesMovement = owedMovementOf(alicesExpense);
    const bobsMovement = owedMovementOf(bobsExpense);
    // Only part of the 50 is put against anything — nobody is left to carry
    // the rest of a payment naming no single contact.
    const partial = [{ owedMovementId: alicesMovement.id, amountMinor: 3000 }];

    const payment = createRecord(db, userId, {
      kind: "payment",
      date: "2026-08-02",
      description: "Batch reimbursement",
      amount: 50,
      currency: "USD",
      exchangeRate: 1,
      contactId: null,
      paidFromAccountId: bank,
      direction: "we-pay",
      settlements: [
        ...partial,
        { owedMovementId: bobsMovement.id, amountMinor: 2000 },
      ],
    });
    if (!payment.ok) throw new Error(payment.reason);
    const paymentMovement = payment.value.movements.find(
      (m) => m.amountMinor > 0,
    )!;

    const result = createSettlements(db, userId, paymentMovement.id, partial);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/fully allocated/i);
  });

  it("refuses an item that belongs to nobody in particular", () => {
    const payableAccountId = payableAccount();
    receivableAccount();
    const bank = bankAccount("Main Bank");

    // A movement on the shared payable account with no contact — not
    // reachable through the normal record forms (FR-008 already refuses it),
    // but a stray one is exactly what a batch payment must still not settle.
    const orphanRecord = db
      .insert(schema.ledgerRecords)
      .values({
        kind: 1,
        date: "2026-08-01",
        description: "Orphaned",
        amount: 10,
        currency: "USD",
        exchangeRate: 1,
        contactId: null,
      })
      .returning({ id: schema.ledgerRecords.id })
      .get();
    const orphanMovement = db
      .insert(schema.ledgerMovements)
      .values({
        recordId: orphanRecord.id,
        accountId: payableAccountId,
        amountMinor: -1000,
        sortOrder: 0,
      })
      .returning({ id: schema.ledgerMovements.id })
      .get();

    const payment = createRecord(db, userId, {
      kind: "payment",
      date: "2026-08-02",
      description: "Batch reimbursement",
      amount: 10,
      currency: "USD",
      exchangeRate: 1,
      contactId: null,
      paidFromAccountId: bank,
      direction: "we-pay",
      settlements: [{ owedMovementId: orphanMovement.id, amountMinor: 1000 }],
    });
    if (!payment.ok) throw new Error(payment.reason);
    const paymentMovement = payment.value.movements.find(
      (m) => m.amountMinor > 0,
    )!;

    const result = createSettlements(db, userId, paymentMovement.id, [
      { owedMovementId: orphanMovement.id, amountMinor: 1000 },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/nobody in particular/i);
  });
});

describe("what a payment has left", () => {
  it("refuses to spread a payment over more than it is, across several calls", () => {
    const category = categoryAccount("Office Supplies");
    payableAccount();
    receivableAccount();
    const bank = bankAccount("Main Bank");
    const alice = contact("Alice");
    const first = owedMovementOf(makeExpenseOwed(category, alice, 30));
    const second = owedMovementOf(makeExpenseOwed(category, alice, 30));

    const payment = createRecord(db, userId, {
      kind: "payment",
      date: "2026-08-02",
      description: "Reimburse Alice",
      amount: 50,
      currency: "USD",
      exchangeRate: 1,
      contactId: alice,
      paidFromAccountId: bank,
      direction: "we-pay",
    });
    if (!payment.ok) throw new Error(payment.reason);
    const paymentMovement = payment.value.movements.find(
      (m) => m.amountMinor > 0,
    )!;

    expect(
      createSettlements(db, userId, paymentMovement.id, [
        { owedMovementId: first.id, amountMinor: 3000 },
      ]).ok,
    ).toBe(true);
    // 20.00 is left; 30.00 more would make the payment cover 60.00 of 50.00.
    const over = createSettlements(db, userId, paymentMovement.id, [
      { owedMovementId: second.id, amountMinor: 3000 },
    ]);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toMatch(/20\.00/);
    expect(
      createSettlements(db, userId, paymentMovement.id, [
        { owedMovementId: second.id, amountMinor: 2000 },
      ]).ok,
    ).toBe(true);
  });
});

describe("taking back part of a batch payment", () => {
  it("takes back every allocation together, so none is left owed to nobody", () => {
    const category = categoryAccount("Office Supplies");
    payableAccount();
    receivableAccount();
    const bank = bankAccount("Main Bank");
    const alice = owedMovementOf(
      makeExpenseOwed(category, contact("Alice"), 30),
    );
    const bob = owedMovementOf(makeExpenseOwed(category, contact("Bob"), 20));
    const payment = createRecord(db, userId, {
      kind: "payment",
      date: "2026-08-02",
      description: "Batch reimbursement",
      amount: 50,
      currency: "USD",
      exchangeRate: 1,
      contactId: null,
      paidFromAccountId: bank,
      direction: "we-pay",
      settlements: [
        { owedMovementId: alice.id, amountMinor: 3000 },
        { owedMovementId: bob.id, amountMinor: 2000 },
      ],
    });
    if (!payment.ok) throw new Error(payment.reason);
    const paymentMovement = payment.value.movements.find(
      (m) => m.amountMinor > 0,
    )!;
    const settled = createSettlements(db, userId, paymentMovement.id, [
      { owedMovementId: alice.id, amountMinor: 3000 },
      { owedMovementId: bob.id, amountMinor: 2000 },
    ]);
    if (!settled.ok) throw new Error(settled.reason);

    const undone = undoSettlement(db, settled.value[0], userId);
    expect(undone.ok).toBe(true);
    if (undone.ok)
      expect([...undone.value].sort()).toEqual([...settled.value].sort());
    expect(settlementIdsForPayment(db, paymentMovement.id)).toEqual([]);

    // And it can be allocated again from scratch.
    expect(
      createSettlements(db, userId, paymentMovement.id, [
        { owedMovementId: alice.id, amountMinor: 3000 },
        { owedMovementId: bob.id, amountMinor: 2000 },
      ]).ok,
    ).toBe(true);
  });
});
