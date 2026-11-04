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
} from "$lib/enums.js";
import { LEAF_PERMISSIONS } from "$lib/permissions/catalog.js";
import * as schema from "../db/schema.js";
import type { LedgerDb, RecordView } from "../ledger/types.js";
import { localsFor } from "../permissions/test-locals.js";
import { createAccount } from "../services/accounts.js";
import { accountDefaultId } from "../services/account-defaults.js";
import { setSetting, SETTING_KEYS } from "../settings.js";
import { getRecord, integrityInputs, listRecords } from "../queries/ledger.js";
import { checkIntegrity } from "../ledger/integrity.js";
import { contactBalances, listOutstanding } from "../queries/settlements.js";
import { accountBalanceMinor } from "../queries/accounts.js";
import { balanceSheetReport, profitLossReport } from "../queries/reports.js";
import { ledgerEvents } from "../ledger/events.js";
import {
  createRecord,
  deleteRecord,
  prepareVoidRecord,
  updateRecord,
  voidRecord,
} from "./records.js";
import { createReimbursement } from "./reimbursements.js";
import {
  correctPaymentAllocations,
  preparePaymentCorrection,
} from "./payment-corrections.js";
import type { AppContext } from "./context.js";

let sqlite: Database;
let db: LedgerDb;
let ctx: AppContext;
let bank: number;
let category: number;
let person: number;
let supplier: number;
const reason = "Entered by mistake; not a company expense.";
const common = {
  date: "2025-06-10",
  description: "Personally paid supplies",
  currency: "MYR",
  exchangeRate: 1,
};

function account(name: string, type: number, subType?: number) {
  const r = createAccount(db, 1, {
    name,
    type: type as never,
    subType: subType as never,
  });
  if (!r.ok) throw new Error(r.reason);
  return r.value.id;
}
function payableId() {
  return accountDefaultId(db, DefaultAccountPurpose.Payable)!;
}
function expense(amount: number): RecordView {
  const r = createRecord(ctx, {
    ...common,
    kind: "expense",
    amount,
    categoryAccountId: category,
    paidFromAccountId: null,
    contactId: supplier,
  });
  if (!r.ok) throw new Error(r.reason);
  return r.value.record;
}
function owedSide(bill: RecordView) {
  return bill.movements.find((m) => m.accountId === payableId())!;
}
/** Two personally paid expenses, reimbursed together by one bank payment. */
function reimbursed() {
  const first = expense(30);
  const second = expense(20);
  const paid = createReimbursement(ctx, {
    contactId: person,
    personallyPaid: true as const,
    date: "2025-06-20",
    description: "Reimbursement",
    reference: "",
    remark: "",
    items: [first, second].map((bill) => ({
      owedMovementId: owedSide(bill).id,
      amountMinor: bill.amountMinor,
    })),
    cashMinor: 5000,
    paidFromAccountId: bank,
    credits: [],
  });
  if (!paid.ok || !paid.value.payment) throw new Error("Fixture failed");
  return { first, second, payment: paid.value.payment };
}
function reverseAllocations(payment: RecordView) {
  const side = payment.movements.find((m) => m.amountMinor > 0)!;
  const before = preparePaymentCorrection(ctx, side.id);
  if (!before.ok) throw new Error(before.reason);
  const result = correctPaymentAllocations(ctx, {
    paymentMovementId: side.id,
    removeSettlementIds: before.value.allocations.map((a) => a.id),
    allocations: [],
    reason: "These expenses should never have been claimed.",
    expectedVersion: before.value.version,
  });
  if (!result.ok) throw new Error(result.reason);
}
function voidIt(id: number, why = reason) {
  const preview = prepareVoidRecord(ctx, id);
  if (!preview.ok) throw new Error(preview.reason);
  return voidRecord(ctx, id, {
    reason: why,
    expectedVersion: preview.value.version,
  });
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema }) as unknown as LedgerDb;
  migrate(db as never, { migrationsFolder: "drizzle" });
  sqlite.exec("PRAGMA foreign_keys = ON");
  db.insert(schema.users)
    .values({ email: "void@test", username: "void", passwordHash: "x" })
    .run();
  ctx = { db, locals: localsFor(LEAF_PERMISSIONS, { userId: 1 }) };
  setSetting(db, SETTING_KEYS.currencyCode, "MYR");
  bank = account("Bank", AccountType.Asset, AccountSubType.Bank);
  category = account("Supplies", AccountType.Expense);
  const payable = account(
    "Supplier payable",
    AccountType.Liability,
    AccountSubType.AccountsPayable,
  );
  const receivable = account(
    "Receivable",
    AccountType.Asset,
    AccountSubType.Receivable,
  );
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
  person = db
    .insert(schema.contacts)
    .values({ legalName: "Employee", entityType: 2 })
    .returning()
    .get()!.id;
  supplier = db
    .insert(schema.contacts)
    .values({ legalName: "Shop", entityType: 2 })
    .returning()
    .get()!.id;
});
afterEach(() => sqlite.close());

describe("voiding a reimbursed expense", () => {
  it("refuses while the reimbursement still covers it, and says what to do", () => {
    const { first } = reimbursed();
    const preview = prepareVoidRecord(ctx, first.id);
    expect(preview.ok && preview.value.blockedReason).toMatch(
      /Reverse the allocation/,
    );
    const result = voidIt(first.id);
    expect(result.ok).toBe(false);
    expect(db.select().from(schema.ledgerRecords).all()).toHaveLength(3);
  });

  it("after the allocations are reversed, voids both so the period reads as if they never happened", () => {
    const { first, second, payment } = reimbursed();
    const bankBefore = accountBalanceMinor(db, bank);
    reverseAllocations(payment);
    const emitted: number[] = [];
    const listener = ({ record }: { record: RecordView }) =>
      emitted.push(record.id);
    ledgerEvents.on("record-update", listener);
    let firstVoid, secondVoid;
    try {
      firstVoid = voidIt(first.id);
      secondVoid = voidIt(second.id);
    } finally {
      ledgerEvents.off("record-update", listener);
    }
    if (!firstVoid.ok || !secondVoid.ok) throw new Error("void failed");

    // The reversal negates the original on the same date.
    const reversal = firstVoid.value.reversal;
    expect(reversal.kind).toBe(LedgerRecordKind.Reversal);
    expect(reversal.date).toBe(first.date);
    expect(reversal.reversesRecordId).toBe(first.id);
    expect(reversal.remark).toBe(reason);
    expect(reversal.movements.map((m) => [m.accountId, m.amountMinor])).toEqual(
      first.movements.map((m) => [m.accountId, -m.amountMinor]),
    );
    expect(getRecord(db, first.id)?.voidedByRecordId).toBe(reversal.id);
    expect(emitted).toEqual(
      expect.arrayContaining([reversal.id, first.id, second.id]),
    );

    // Reports: no expense left in June 2025; the bank payment is untouched.
    const pnl = profitLossReport(db, "2025-06-01", "2025-06-30");
    expect(pnl.totalExpensesMinor).toBe(0);
    expect(accountBalanceMinor(db, category)).toBe(0);
    expect(accountBalanceMinor(db, bank)).toBe(bankBefore);
    expect(balanceSheetReport(db, "2025-06-30")).toBeTruthy();

    // Nothing owed on either expense; the payment is the person's credit.
    const owed = listOutstanding(db, { direction: "we-owe", openOnly: false });
    expect(
      owed.items.some((i) =>
        [first.id, second.id, reversal.id].includes(i.recordId),
      ),
    ).toBe(false);
    expect(contactBalances(db, "we-owe", supplier)).toEqual([]);
    expect(contactBalances(db, "we-owe", person)[0]?.creditsMinor).toBe(5000);

    // Lists hide the pair unless asked.
    const ids = (voided?: "include" | "only") =>
      listRecords(db, { voided })
        .records.map((r) => r.id)
        .sort();
    expect(ids()).toEqual([payment.id]);
    expect(ids("only")).toHaveLength(4);
    expect(ids("include")).toHaveLength(5);
    // Only the payment is still open (as unapplied credit); the voided pair is not.
    expect(listRecords(db, { paid: false }).records.map((r) => r.id)).toEqual([
      payment.id,
    ]);

    expect(checkIntegrity(integrityInputs(db)).ok).toBe(true);
    const audit = db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.recordId, String(first.id)))
      .all()
      .map((a) => a.changes ?? "");
    expect(audit.some((c) => c.includes("voidReason"))).toBe(true);
  });
});

describe("void refusals", () => {
  it("is final: no second void, no void of the reversal, no edit or delete of either", () => {
    const bill = expense(10);
    const done = voidIt(bill.id);
    if (!done.ok) throw new Error(done.reason);
    const reversal = done.value.reversal;
    expect(voidIt(bill.id).ok).toBe(false);
    expect(voidIt(reversal.id).ok).toBe(false);
    for (const id of [bill.id, reversal.id]) {
      expect(deleteRecord(ctx, id).ok).toBe(false);
      expect(updateRecord(ctx, id, { description: "Changed" }).ok).toBe(false);
    }
  });

  it("needs the explicit records.void leaf", () => {
    const bill = expense(10);
    const preview = prepareVoidRecord(ctx, bill.id);
    if (!preview.ok) throw new Error(preview.reason);
    const narrow = { db, locals: localsFor(["records"], { userId: 1 }) };
    const result = voidRecord(narrow, bill.id, {
      reason,
      expectedVersion: preview.value.version,
    });
    expect(result.ok).toBe(false);
    expect(db.select().from(schema.ledgerRecords).all()).toHaveLength(1);
  });

  it("refuses a short reason and a stale version", () => {
    const bill = expense(10);
    const preview = prepareVoidRecord(ctx, bill.id);
    if (!preview.ok) throw new Error(preview.reason);
    expect(
      voidRecord(ctx, bill.id, {
        reason: "short",
        expectedVersion: preview.value.version,
      }).ok,
    ).toBe(false);
    expect(
      voidRecord(ctx, bill.id, { reason, expectedVersion: "stale" }).ok,
    ).toBe(false);
  });

  it("refuses in a closed month until the month is reopened", () => {
    const bill = expense(10);
    setSetting(db, SETTING_KEYS.accountingClosedThrough, "2025-12-31");
    const result = voidIt(bill.id);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/closed through 2025-12-31/i);
    expect(db.select().from(schema.ledgerRecords).all()).toHaveLength(1);
  });

  it("refuses a record settled by a payment until its allocation is reversed", () => {
    const { payment } = reimbursed();
    expect(voidIt(payment.id).ok).toBe(false);
  });
});
