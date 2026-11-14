import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { AccountType, DefaultAccountPurpose } from "$lib/enums.js";
import * as schema from "../db/schema.js";
import type { RecordView } from "../ledger/types.js";
import { ensureReimbursementsPayableAccount } from "../services/account-defaults.js";
import { createAccount } from "../services/accounts.js";
import { releaseBook, resultValue } from "./__fixtures__/release-book.js";
import {
  inferPaymentDirection,
  settlesReceivable,
  type PaymentDirectionInput,
} from "./payment-direction.js";
import { createRecord } from "./records.js";

/**
 * G1: the one payment-direction rule, as both callers use it. The cases
 * without `moneyIn` are `record_payments`' (the direction its items point);
 * the cases with it are a payment from bank lines' (`createRecordFromLines`,
 * see "a payment from bank lines settles the control account its contact's
 * balance is on" in `reconciliation.spec.ts`). Each runs on its own in-memory
 * book; nothing imports `db/client.ts`.
 */

type Book = ReturnType<typeof releaseBook>;
let book: Book | undefined;
afterEach(() => {
  book?.raw.close();
  book = undefined;
});

function seed() {
  book = releaseBook();
  const { db, ctx, bank, expense } = book;
  const defaultFor = (purpose: number) =>
    db
      .select()
      .from(schema.accountDefaults)
      .where(eq(schema.accountDefaults.purpose, purpose))
      .get()!.accountId;
  const contact = (legalName: string) =>
    db
      .insert(schema.contacts)
      .values({ legalName, entityType: 2 })
      .returning()
      .get()!.id;
  const sales = resultValue(
    createAccount(db, 1, { name: "Sales", type: AccountType.Revenue }),
  ).id;
  const receivable = defaultFor(DefaultAccountPurpose.Receivable);
  const payable = defaultFor(DefaultAccountPurpose.Payable);
  const reimbursements = resultValue(ensureReimbursementsPayableAccount(db, 1));
  const supplier = contact("Supplier");
  const customer = contact("Customer");
  const employee = contact("Employee");
  const base = {
    date: "2026-09-01",
    currency: "MYR",
    exchangeRate: 1,
    description: "Fixture",
  };
  const written = (input: Record<string, unknown>) =>
    resultValue(
      createRecord(ctx, { ...base, ...input } as Parameters<
        typeof createRecord
      >[1]),
    ).record;
  /** The record's side on `accountId`. */
  const side = (record: RecordView, accountId: number) => ({
    owedMovementId: record.movements.find((m) => m.accountId === accountId)!.id,
  });
  return {
    ...book,
    receivable,
    payable,
    reimbursements,
    supplier,
    customer,
    employee,
    side,
    /** Payable −amount for the supplier: we owe them. */
    bill: (amount = 80) =>
      written({
        kind: "expense",
        amount,
        categoryAccountId: expense,
        paidFromAccountId: null,
        contactId: supplier,
        supplierContactId: supplier,
        expensePaymentSource: "unpaid",
      }),
    /** Payable +amount for the supplier: we paid them what nothing was owed for. */
    overpaid: (amount = 200) =>
      written({
        kind: "payment",
        amount,
        paidFromAccountId: bank,
        contactId: supplier,
        direction: "we-pay",
        settlements: [],
      }),
    /** Receivable +amount for the customer: they owe us. */
    invoice: (amount = 60) =>
      written({
        kind: "income",
        amount,
        categoryAccountId: sales,
        receivedIntoAccountId: receivable,
        contactId: customer,
      }),
    /** Receivable −amount for the customer: they paid what nothing was owed for. */
    prepaid: (amount = 30) =>
      written({
        kind: "payment",
        amount,
        paidFromAccountId: bank,
        contactId: customer,
        direction: "we-receive",
        settlements: [],
      }),
    /** ReimbursementsPayable −amount for the employee: they paid personally. */
    claim: (amount = 150) =>
      written({
        kind: "expense",
        amount,
        categoryAccountId: expense,
        paidFromAccountId: null,
        expensePaymentSource: "personal",
        paidByContactId: employee,
      }),
  };
}
type Seeded = ReturnType<typeof seed>;

const infer = (s: Seeded, input: PaymentDirectionInput) =>
  inferPaymentDirection(s.ctx, input);

describe("without moneyIn: the direction every item settled points (record_payments)", () => {
  it("reads each control account and side: we-pay, refund-received, we-receive, refund-paid", () => {
    const s = seed();
    const cases = [
      [s.side(s.bill(), s.payable), s.supplier, "we-pay"],
      [s.side(s.overpaid(), s.payable), s.supplier, "refund-received"],
      [s.side(s.invoice(), s.receivable), s.customer, "we-receive"],
      [s.side(s.prepaid(), s.receivable), s.customer, "refund-paid"],
    ] as const;
    for (const [item, contactId, direction] of cases)
      expect(infer(s, { contactId, allocateTo: [item] })).toEqual({
        ok: true,
        value: { direction },
      });
  });

  it("names Reimbursements payable as the settlement account of a claim", () => {
    const s = seed();
    expect(
      infer(s, {
        contactId: s.employee,
        allocateTo: [s.side(s.claim(), s.reimbursements)],
      }),
    ).toEqual({
      ok: true,
      value: { direction: "we-pay", settlementAccountId: s.reimbursements },
    });
  });

  it("refuses as undecided when nothing is settled, or the items point different ways", () => {
    const s = seed();
    expect(infer(s, { contactId: s.supplier, allocateTo: [] })).toMatchObject({
      ok: false,
      code: "INVALID_INPUT",
      reason:
        "The direction cannot be worked out: this payment settles no record.",
      undecided: "settles-nothing",
    });
    const mixed = infer(s, {
      contactId: s.supplier,
      allocateTo: [
        s.side(s.bill(), s.payable),
        s.side(s.overpaid(), s.payable),
      ],
    });
    expect(mixed).toMatchObject({
      ok: false,
      code: "INVALID_INPUT",
      reason: "The records it settles are owed in different directions.",
      undecided: "mixed",
    });
    expect(mixed).not.toHaveProperty("paymentDirections");
  });

  it("takes a sent direction as it is, unchecked: createRecord judges it", () => {
    const s = seed();
    expect(
      infer(s, {
        contactId: s.supplier,
        direction: "refund-paid",
        allocateTo: [],
      }),
    ).toEqual({ ok: true, value: { direction: "refund-paid" } });
    // Kept as record_payments always did: a payable-side direction names the
    // one account its items share whenever that is not Payable.
    expect(
      infer(s, {
        contactId: s.customer,
        direction: "we-pay",
        allocateTo: [s.side(s.invoice(), s.receivable)],
      }),
    ).toEqual({
      ok: true,
      value: { direction: "we-pay", settlementAccountId: s.receivable },
    });
  });

  it("keeps a bill and a claim together as one we-pay, naming no settlement account", () => {
    const s = seed();
    expect(
      infer(s, {
        contactId: s.supplier,
        allocateTo: [
          s.side(s.bill(), s.payable),
          s.side(s.claim(), s.reimbursements),
        ],
      }),
    ).toEqual({ ok: true, value: { direction: "we-pay" } });
  });
});

describe("with moneyIn: the account its items are on, else the contact's open balance (bank lines)", () => {
  it("reads the money's way on the items' account", () => {
    const s = seed();
    const bill = s.side(s.bill(), s.payable);
    expect(
      infer(s, { contactId: s.supplier, moneyIn: false, allocateTo: [bill] }),
    ).toEqual({ ok: true, value: { direction: "we-pay" } });
    // Money in against a bill is a refund on Payable; createRecord then
    // refuses it, since a refund must use up an overpayment.
    expect(
      infer(s, { contactId: s.supplier, moneyIn: true, allocateTo: [bill] }),
    ).toEqual({ ok: true, value: { direction: "refund-received" } });
    expect(
      infer(s, {
        contactId: s.customer,
        moneyIn: true,
        allocateTo: [s.side(s.invoice(), s.receivable)],
      }),
    ).toEqual({ ok: true, value: { direction: "we-receive" } });
    expect(
      infer(s, {
        contactId: s.employee,
        moneyIn: false,
        allocateTo: [s.side(s.claim(), s.reimbursements)],
      }),
    ).toEqual({
      ok: true,
      value: { direction: "we-pay", settlementAccountId: s.reimbursements },
    });
  });

  it("refuses a direction the money cannot take, with the ones it can", () => {
    const s = seed();
    expect(
      infer(s, { contactId: s.supplier, moneyIn: true, direction: "we-pay" }),
    ).toMatchObject({
      ok: false,
      code: "REFUSED",
      reason:
        "These lines are money in, so a payment from them is we-receive or refund-received, not we-pay.",
      paymentDirections: ["we-receive", "refund-received"],
    });
  });

  it("refuses items on two control accounts, and a settlement account that is not one", () => {
    const s = seed();
    expect(
      infer(s, {
        contactId: s.supplier,
        moneyIn: false,
        allocateTo: [
          s.side(s.bill(), s.payable),
          s.side(s.claim(), s.reimbursements),
        ],
      }),
    ).toMatchObject({
      ok: false,
      code: "REFUSED",
      reason:
        "The allocations are on more than one control account. Record one payment for each.",
    });
    expect(
      infer(s, {
        contactId: s.supplier,
        moneyIn: false,
        settlementAccountId: s.bank,
      }),
    ).toMatchObject({
      ok: false,
      code: "REFUSED",
      reason:
        "The settlement account must be the saved Receivable, Payable or Reimbursements payable account.",
    });
  });

  it("takes a named settlement account, and the direction it implies", () => {
    const s = seed();
    expect(
      infer(s, {
        contactId: s.employee,
        moneyIn: false,
        settlementAccountId: s.reimbursements,
      }),
    ).toEqual({
      ok: true,
      value: { direction: "we-pay", settlementAccountId: s.reimbursements },
    });
    // Unlike record_payments, a payable-side direction against Receivable
    // items names no settlement account.
    expect(
      infer(s, {
        contactId: s.customer,
        moneyIn: false,
        direction: "we-pay",
        allocateTo: [s.side(s.invoice(), s.receivable)],
      }),
    ).toEqual({ ok: true, value: { direction: "we-pay" } });
  });

  it("with no items, follows the contact's open balance", () => {
    const s = seed();
    s.overpaid();
    expect(infer(s, { contactId: s.supplier, moneyIn: true })).toEqual({
      ok: true,
      value: { direction: "refund-received" },
    });
    s.claim();
    expect(infer(s, { contactId: s.employee, moneyIn: false })).toEqual({
      ok: true,
      value: { direction: "we-pay", settlementAccountId: s.reimbursements },
    });
    const nobody = s.db
      .insert(schema.contacts)
      .values({ legalName: "Nobody", entityType: 2 })
      .returning()
      .get()!.id;
    expect(infer(s, { contactId: nobody, moneyIn: true })).toEqual({
      ok: true,
      value: { direction: "we-receive" },
    });
    expect(infer(s, { contactId: nobody, moneyIn: false })).toEqual({
      ok: true,
      value: { direction: "we-pay" },
    });
  });

  it("refuses rather than guess when the balance is on the other control account", () => {
    const s = seed();
    s.invoice();
    expect(infer(s, { contactId: s.customer, moneyIn: false })).toMatchObject({
      ok: false,
      code: "REFUSED",
      paymentDirections: ["we-pay", "refund-paid"],
    });
  });
});

it("settlesReceivable splits the directions by control account", () => {
  expect(
    (["we-receive", "refund-paid", "we-pay", "refund-received"] as const).map(
      settlesReceivable,
    ),
  ).toEqual([true, true, false, false]);
});
