import { Database } from "bun:sqlite";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AccountSubType,
  AccountType,
  DefaultAccountPurpose,
} from "$lib/enums.js";
import { LEAF_PERMISSIONS } from "$lib/permissions/catalog.js";
import * as schema from "../db/schema.js";
import {
  accountDefaults,
  auditLog,
  contacts,
  ledgerMovements,
  ledgerRecords,
  reimbursementEntries,
  reimbursementItems,
  reimbursements,
  settlements,
  users,
} from "../db/schema.js";
import type { LedgerDb } from "../ledger/types.js";
import { localsFor } from "../permissions/test-locals.js";
import { getRecord } from "../queries/ledger.js";
import { recordRelations } from "../queries/reimbursements.js";
import { createAccount } from "../services/accounts.js";
import { voidBlockedReason } from "../services/ledger.js";
import { setSetting, SETTING_KEYS } from "../settings.js";
import { createLegacyReimbursement } from "./__fixtures__/legacy-reimbursement.js";
import type { AppContext } from "./context.js";
import {
  correctPaymentAllocations,
  paymentAllocationSnapshot,
  preparePaymentCorrection,
} from "./payment-corrections.js";
import {
  correctPaymentRecipient,
  prepareRecipientCorrection,
} from "./payment-recipient.js";
import { createRecord, updateRecord } from "./records.js";
import {
  prepareReimbursementReversal,
  reverseReimbursement,
} from "./reimbursement-reversal.js";

let sqlite: Database;
let db: LedgerDb;
const userId = 1;
let bank: number;
let fuel: number;
let payable: number;
let supplierA: number;
let supplierB: number;
let recipient: number;

const reason = "Paid from the company account, not personally.";

function account(name: string, type: number, subType?: number) {
  const result = createAccount(db, userId, {
    name,
    type: type as never,
    subType: subType as never,
  });
  if (!result.ok) throw new Error(result.reason);
  return result.value.id;
}

function ctx(deny: string[] = []): AppContext {
  return {
    db,
    locals: localsFor(
      LEAF_PERMISSIONS.filter((leaf) => !deny.includes(leaf)),
      { userId },
    ),
  };
}

function contact(name: string) {
  return db
    .insert(contacts)
    .values({ entityType: 2, legalName: name })
    .returning({ id: contacts.id })
    .get().id;
}

function expense(amount: number, contactId: number) {
  const result = createRecord(ctx(), {
    date: "2026-08-10",
    description: `Expense ${amount}`,
    amount,
    currency: "MYR",
    exchangeRate: 1,
    kind: "expense",
    categoryAccountId: fuel,
    paidFromAccountId: null,
    contactId,
  });
  if (!result.ok) throw new Error(result.reason);
  return result.value.record;
}

function owed(record: { movements: { id: number; accountId: number }[] }) {
  return record.movements.find((m) => m.accountId === payable)!.id;
}

/** The active supplier-entry → expense allocation the payment shows. */
function activeItemSettlement(expenseId: number) {
  const movement = owed(getRecord(db, expenseId)!);
  return db
    .select()
    .from(settlements)
    .where(eq(settlements.owedMovementId, movement))
    .all()
    .find((s) => s.reversedAt === null)!;
}

function outstanding(id: number) {
  return getRecord(db, id)!.outstandingMinor;
}

function clearingTotal(groupId: number) {
  // The fixture creates the clearing account on first use.
  const clearing = Number(
    db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, "reimbursements.clearingAccountId"))
      .get()!.value,
  );
  const ids = db
    .select({ id: reimbursementEntries.recordId })
    .from(reimbursementEntries)
    .where(eq(reimbursementEntries.groupId, groupId))
    .all()
    .map((e) => e.id);
  return db
    .select()
    .from(ledgerMovements)
    .where(inArray(ledgerMovements.recordId, ids))
    .all()
    .filter((m) => m.accountId === clearing)
    .reduce((sum, m) => sum + m.amountMinor, 0);
}

let a1: ReturnType<typeof expense>;
let b1: ReturnType<typeof expense>;
let b2: ReturnType<typeof expense>;

/** A legacy group: supplier A (one expense) and B (two), paid by one payment. */
function group(cashMinor = 4500) {
  a1 = expense(30, supplierA);
  b1 = expense(10, supplierB);
  b2 = expense(5, supplierB);
  const result = createLegacyReimbursement(ctx(), {
    contactId: recipient,
    personallyPaid: true,
    date: "2026-08-25",
    description: "Settlement",
    reference: "",
    remark: "",
    items: [
      { owedMovementId: owed(a1), amountMinor: 3000 },
      { owedMovementId: owed(b1), amountMinor: 1000 },
      { owedMovementId: owed(b2), amountMinor: 500 },
    ],
    cashMinor,
    paidFromAccountId: bank,
    credits: [],
  });
  if (!result.ok) throw new Error(result.reason);
  const payment = result.value.payment!;
  return {
    groupId: result.value.groupId,
    payment,
    paymentMovementId: owed(payment),
    recipientEntryId: result.value.payable.id,
  };
}

function remove(
  paymentMovementId: number,
  ids: number[],
  extra: Partial<Parameters<typeof correctPaymentAllocations>[1]> = {},
  context = ctx(),
) {
  const prepared = preparePaymentCorrection(ctx(), paymentMovementId);
  if (!prepared.ok) return prepared;
  return correctPaymentAllocations(context, {
    paymentMovementId,
    removeSettlementIds: ids,
    allocations: [],
    reason,
    expectedVersion: prepared.value.version,
    ...extra,
  });
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema }) as unknown as LedgerDb;
  migrate(db as never, { migrationsFolder: "drizzle" });
  setSetting(db, SETTING_KEYS.currencyCode, "MYR");
  db.insert(users)
    .values({ email: "u@test", username: "u", passwordHash: "x" })
    .run();
  bank = account("Bank", AccountType.Asset, AccountSubType.Bank);
  fuel = account("Fuel", AccountType.Expense);
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
  supplierA = contact("Supplier A");
  supplierB = contact("Supplier B");
  recipient = contact("Owner");
});
afterEach(() => sqlite.close());

describe("Correct allocation on a group reimbursement", () => {
  const fresh = () => group();

  it("presents the group's expenses as the payment's own allocations", () => {
    const g = fresh();
    const raw = paymentAllocationSnapshot(ctx(), g.paymentMovementId)!;
    expect(raw.allocations).toHaveLength(1);
    const view = preparePaymentCorrection(ctx(), g.paymentMovementId);
    if (!view.ok) throw new Error(view.reason);
    expect(view.value.allocations.map((a) => a.amountMinor)).toEqual([
      3000, 1000, 500,
    ]);
    expect(view.value.allocations.map((a) => a.id)).toEqual(
      [a1, b1, b2].map((e) => activeItemSettlement(e.id).id),
    );
    expect(view.value.version).toBe(raw.version);
    // A generated supplier entry's movement stands for the payment.
    const helperMovement = activeItemSettlement(a1.id).paymentMovementId;
    const viaHelper = preparePaymentCorrection(ctx(), helperMovement);
    if (!viaHelper.ok) throw new Error(viaHelper.reason);
    expect(viaHelper.value.record.id).toBe(g.payment.id);
    expect(viaHelper.value.allocations).toEqual(view.value.allocations);
    expect(viaHelper.value.version).toBe(view.value.version);
  });

  it("takes one expense out and leaves its amount as the payment's credit", () => {
    const g = fresh();
    const before = getRecord(db, g.payment.id)!;
    const result = remove(g.paymentMovementId, [
      activeItemSettlement(a1.id).id,
    ]);
    expect(result.ok).toBe(true);
    expect(outstanding(a1.id)).toBe(3000);
    expect(outstanding(b1.id)).toBe(0);
    expect(outstanding(b2.id)).toBe(0);
    const after = getRecord(db, g.payment.id)!;
    expect(after.movements).toEqual(before.movements);
    expect(after.outstandingMinor).toBe(3000);
    expect(outstanding(g.recipientEntryId)).toBe(0);
    expect(clearingTotal(g.groupId)).toBe(0);
    const items = db
      .select()
      .from(reimbursementItems)
      .where(eq(reimbursementItems.groupId, g.groupId))
      .all();
    expect(items.filter((i) => i.removedAt).length).toBe(1);
    expect(
      db
        .select()
        .from(reimbursements)
        .where(eq(reimbursements.id, g.groupId))
        .get()!.reversedAt,
    ).toBeNull();
    // History is kept, and the expense's own Activity says why.
    expect(
      db
        .select()
        .from(settlements)
        .where(
          and(
            eq(settlements.owedMovementId, owed(a1)),
            isNotNull(settlements.reversedAt),
          ),
        )
        .all().length,
    ).toBeGreaterThan(0);
    const expenseAudit = db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.recordType, "record"),
          eq(auditLog.recordId, String(a1.id)),
        ),
      )
      .all()
      .map((row) => row.changes ?? "");
    expect(expenseAudit.some((c) => c.includes("reimbursementRemoval"))).toBe(
      true,
    );
    // The payment now shows only the expenses still in it.
    const view = preparePaymentCorrection(ctx(), g.paymentMovementId);
    if (!view.ok) throw new Error(view.reason);
    expect(view.value.allocations.map((a) => a.amountMinor)).toEqual([
      1000, 500,
    ]);
  });

  it("takes out one expense of a supplier entry that covers several, through the undo_settlement shape", () => {
    const g = fresh();
    const row = activeItemSettlement(b1.id);
    // undo_settlement passes the settlement's own payment movement: the entry.
    const prepared = preparePaymentCorrection(ctx(), row.paymentMovementId);
    if (!prepared.ok) throw new Error(prepared.reason);
    const result = correctPaymentAllocations(ctx(), {
      paymentMovementId: row.paymentMovementId,
      removeSettlementIds: [row.id],
      allocations: [],
      reason,
      expectedVersion: prepared.value.version,
    });
    expect(result.ok).toBe(true);
    expect(outstanding(b1.id)).toBe(1000);
    expect(outstanding(b2.id)).toBe(0);
    expect(outstanding(a1.id)).toBe(0);
    expect(outstanding(g.payment.id)).toBe(1000);
    expect(clearingTotal(g.groupId)).toBe(0);
  });

  it("takes an expense out and re-applies the released credit in one call", () => {
    const g = fresh();
    const other = expense(20, supplierA);
    const result = remove(
      g.paymentMovementId,
      [activeItemSettlement(a1.id).id],
      {
        allocations: [{ owedMovementId: owed(other), amountMinor: 2000 }],
      },
    );
    expect(result.ok).toBe(true);
    expect(outstanding(other.id)).toBe(0);
    expect(outstanding(a1.id)).toBe(3000);
    expect(outstanding(g.payment.id)).toBe(1000);
  });

  it("taking out every expense reverses the whole reimbursement", () => {
    const g = fresh();
    const ids = [a1, b1, b2].map((e) => activeItemSettlement(e.id).id);
    // That is a reversal, so it also needs the delete permission.
    expect(
      remove(g.paymentMovementId, ids, {}, ctx(["records.delete"])).ok,
    ).toBe(false);
    const result = remove(g.paymentMovementId, ids);
    expect(result.ok).toBe(true);
    expect(
      db
        .select()
        .from(reimbursements)
        .where(eq(reimbursements.id, g.groupId))
        .get()!.reversedAt,
    ).not.toBeNull();
    expect(outstanding(a1.id)).toBe(3000);
    expect(outstanding(b1.id)).toBe(1000);
    expect(outstanding(b2.id)).toBe(500);
    expect(outstanding(g.payment.id)).toBe(4500);
    expect(clearingTotal(g.groupId)).toBe(0);
  });

  it("needs records.create to take an expense out", () => {
    const g = fresh();
    const result = remove(
      g.paymentMovementId,
      [activeItemSettlement(a1.id).id],
      {},
      ctx(["records.create"]),
    );
    expect(result.ok).toBe(false);
    expect(outstanding(a1.id)).toBe(0);
  });

  it("refuses in a closed month and changes nothing", () => {
    const g = fresh();
    const prepared = preparePaymentCorrection(ctx(), g.paymentMovementId);
    if (!prepared.ok) throw new Error(prepared.reason);
    setSetting(db, SETTING_KEYS.accountingClosedThrough, "2026-08-31");
    const result = correctPaymentAllocations(ctx(), {
      paymentMovementId: g.paymentMovementId,
      removeSettlementIds: [activeItemSettlement(a1.id).id],
      allocations: [],
      reason,
      expectedVersion: prepared.value.version,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/closed period/);
    expect(outstanding(a1.id)).toBe(0);
    expect(
      db
        .select()
        .from(reimbursementItems)
        .where(isNotNull(reimbursementItems.removedAt))
        .all(),
    ).toEqual([]);
  });

  it("refuses a group that one payment does not fund in full", () => {
    const g = fresh();
    // Part-paid: the payment covers less than the expenses.
    const partial = group(4000);
    const row = activeItemSettlement(a1.id);
    const prepared = preparePaymentCorrection(ctx(), row.paymentMovementId);
    expect(prepared.ok).toBe(false);
    if (!prepared.ok)
      expect(prepared.reason).toMatch(/several payments or is not fully paid/);
    // The part-paid payment keeps showing its one raw funding row.
    const view = preparePaymentCorrection(ctx(), partial.paymentMovementId);
    if (!view.ok) throw new Error(view.reason);
    expect(view.value.allocations).toHaveLength(1);
    expect(g.groupId).not.toBe(partial.groupId);
  });

  it("refuses when the funding payment is to someone else than the reimbursement", () => {
    const g = fresh();
    const other = contact("Someone else");
    db.update(ledgerRecords)
      .set({ contactId: other })
      .where(eq(ledgerRecords.id, g.payment.id))
      .run();
    const row = activeItemSettlement(a1.id);
    const prepared = preparePaymentCorrection(ctx(), row.paymentMovementId);
    expect(prepared.ok).toBe(false);
    if (!prepared.ok) expect(prepared.reason).toMatch(/different person/);
  });

  it("refuses a stale version", () => {
    const g = fresh();
    const prepared = preparePaymentCorrection(ctx(), g.paymentMovementId);
    if (!prepared.ok) throw new Error(prepared.reason);
    expect(
      remove(g.paymentMovementId, [activeItemSettlement(b1.id).id]).ok,
    ).toBe(true);
    const stale = correctPaymentAllocations(ctx(), {
      paymentMovementId: g.paymentMovementId,
      removeSettlementIds: [activeItemSettlement(a1.id).id],
      allocations: [],
      reason,
      expectedVersion: prepared.value.version,
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe("CONFLICT");
  });

  it("refuses a replacement onto an item the payment already covers", () => {
    const g = fresh();
    const result = remove(
      g.paymentMovementId,
      [activeItemSettlement(b1.id).id],
      {
        allocations: [
          {
            owedMovementId: owed(getRecord(db, g.recipientEntryId)!),
            amountMinor: 100,
          },
        ],
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/already covers/);
    expect(outstanding(b1.id)).toBe(0);
  });

  it("keeps the full reversal, the payee correction and the expense's own edits working after a removal", () => {
    const g = fresh();
    expect(
      remove(g.paymentMovementId, [activeItemSettlement(a1.id).id]).ok,
    ).toBe(true);

    // The removed expense is free: it can be booked as paid from the bank,
    // keeping its movement, and nothing blocks a void.
    expect(voidBlockedReason(db, a1.id)).toBeNull();
    const ownSide = owed(a1);
    const edited = updateRecord(ctx(), a1.id, { paidFromAccountId: bank });
    if (!edited.ok) throw new Error(edited.reason);
    const bankSide = getRecord(db, a1.id)!.movements.find(
      (m) => m.accountId === bank,
    )!;
    expect(bankSide.id).toBe(ownSide);

    // A payee correction still sees no dependency, and moves the removal entry.
    const preview = prepareRecipientCorrection(ctx(), g.payment.id);
    if (!preview.ok) throw new Error(preview.reason);
    expect(preview.value.dependencies).toEqual([]);
    const newPayee = contact("New payee");
    const corrected = correctPaymentRecipient(ctx(), {
      recordId: g.payment.id,
      contactId: newPayee,
      reason: "The reimbursement went to the new payee.",
      expectedVersion: preview.value.version,
    });
    if (!corrected.ok) throw new Error(corrected.reason);
    const removalEntries = db
      .select()
      .from(reimbursementEntries)
      .where(
        and(
          eq(reimbursementEntries.groupId, g.groupId),
          eq(reimbursementEntries.role, "recipient-removal"),
        ),
      )
      .all();
    expect(removalEntries).toHaveLength(1);
    expect(getRecord(db, removalEntries[0].recordId)!.contactId).toBe(newPayee);

    // The whole reversal only reverses what is still in the group.
    const reversal = prepareReimbursementReversal(ctx(), g.groupId);
    if (!reversal.ok) throw new Error(reversal.reason);
    expect(reversal.value.summary.amountMinor).toBe(1500);
    const reversed = reverseReimbursement(ctx(), {
      groupId: g.groupId,
      date: "2026-08-25",
      reason: "Reverse the rest of the reimbursement.",
      expectedVersion: reversal.value.version,
    });
    if (!reversed.ok) throw new Error(reversed.reason);
    expect(outstanding(b1.id)).toBe(1000);
    expect(outstanding(b2.id)).toBe(500);
    expect(outstanding(g.payment.id)).toBe(4500);
    expect(outstanding(g.recipientEntryId)).toBe(0);
    expect(clearingTotal(g.groupId)).toBe(0);
  });

  it("shows each expense with its own reversible link, and a removed one as taken out", () => {
    const g = fresh();
    const link = recordRelations(db, a1.id).displayLinks.find(
      (l) => l.otherRecordId === g.payment.id,
    )!;
    expect(link.settlementId).toBe(activeItemSettlement(a1.id).id);
    expect(link.canUndo).toBe(true);
    expect(
      recordRelations(db, g.payment.id).displayLinks.map(
        (l) => l.otherRecordId,
      ),
    ).toEqual(expect.arrayContaining([a1.id, b1.id, b2.id]));

    expect(
      remove(g.paymentMovementId, [activeItemSettlement(a1.id).id]).ok,
    ).toBe(true);
    const removed = recordRelations(db, a1.id);
    expect(
      removed.displayLinks.some((l) => l.otherRecordId === g.payment.id),
    ).toBe(false);
    const card = removed.reimbursement.groups.find((x) => x.id === g.groupId)!;
    expect(card.removedForRecord?.amountMinor).toBe(3000);
    expect(card.removedForRecord?.reason).toBe(reason);
    // The history names the payment, not the generated entry.
    expect(
      removed.historicalLinks.some((l) => l.otherRecordId === g.payment.id),
    ).toBe(true);

    const payment = recordRelations(db, g.payment.id);
    expect(payment.displayLinks.map((l) => l.otherRecordId).sort()).toEqual(
      [b1.id, b2.id].sort(),
    );
    // The reduced funding is bookkeeping; the history lists the expense.
    expect(
      payment.historicalLinks.some(
        (l) => l.otherRecordId === g.recipientEntryId,
      ),
    ).toBe(false);
    expect(payment.historicalLinks.some((l) => l.otherRecordId === a1.id)).toBe(
      true,
    );
    const group = payment.reimbursement.groups.find((x) => x.id === g.groupId)!;
    expect(group.totalMinor).toBe(1500);
    expect(group.fundedMinor).toBe(1500);
  });
});
