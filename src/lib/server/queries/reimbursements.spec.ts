import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AccountType,
  DefaultAccountPurpose,
  LedgerRecordKind,
} from "$lib/enums.js";
import * as schema from "../db/schema.js";
import type { LedgerDb } from "../ledger/types.js";
import { getRecord } from "./ledger.js";
import { recordRelations } from "./reimbursements.js";

let sqlite: Database;
let db: LedgerDb;
let supplier: number;
let recipient: number;
const bank = 1,
  payable = 2,
  clearing = 3,
  expense = 4;
function record(
  id: number,
  kind: number,
  amount: number,
  contactId: number,
  positiveAccount: number,
  negativeAccount: number,
) {
  db.insert(schema.ledgerRecords)
    .values({
      id,
      kind,
      amount: amount / 100,
      description: `Record ${id}`,
      recordNumber: `REC-${id}`,
      date: "2026-03-01",
      contactId,
      currency: "MYR",
    })
    .run();
  const movements = db
    .insert(schema.ledgerMovements)
    .values([
      { recordId: id, accountId: positiveAccount, amountMinor: amount },
      { recordId: id, accountId: negativeAccount, amountMinor: -amount },
    ])
    .returning()
    .all();
  return { id, positive: movements[0].id, negative: movements[1].id };
}
function allocate(
  paymentMovementId: number,
  owedMovementId: number,
  amountMinor: number,
) {
  return db
    .insert(schema.settlements)
    .values({ paymentMovementId, owedMovementId, amountMinor })
    .returning()
    .get();
}
function fixture(fundingAmounts = [55494], originalPayment = true) {
  const payment = record(
    219,
    LedgerRecordKind.Payment,
    58294,
    recipient,
    payable,
    bank,
  );
  const obligation = record(
    252,
    LedgerRecordKind.Transfer,
    55494,
    recipient,
    clearing,
    payable,
  );
  const transfer = record(
    253,
    LedgerRecordKind.Transfer,
    55494,
    supplier,
    payable,
    clearing,
  );
  db.insert(schema.reimbursements)
    .values({
      id: 1,
      payableRecordId: obligation.id,
      paymentRecordId: originalPayment ? payment.id : null,
    })
    .run();
  db.insert(schema.reimbursementEntries)
    .values([
      { recordId: obligation.id, groupId: 1, role: "recipient" },
      { recordId: transfer.id, groupId: 1, role: "supplier" },
    ])
    .run();
  const amounts = [5000, 6000, 7000, 8000, 9000, 10000, 5000, 5494];
  const expenses = amounts.map((amount, index) => {
    const item = record(
      100 + index,
      LedgerRecordKind.Expense,
      amount,
      supplier,
      expense,
      payable,
    );
    db.insert(schema.reimbursementItems)
      .values({
        groupId: 1,
        sourceMovementId: item.negative,
        amountMinor: amount,
      })
      .run();
    allocate(transfer.positive, item.negative, amount);
    return item;
  });
  const payments = [payment];
  const funding = fundingAmounts.map((amount, index) => {
    if (index)
      payments.push(
        record(
          220 + index,
          LedgerRecordKind.Payment,
          amount,
          recipient,
          payable,
          bank,
        ),
      );
    return allocate(payments[index].positive, obligation.negative, amount);
  });
  return { payment, obligation, transfer, expenses, payments, funding };
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema }) as unknown as LedgerDb;
  migrate(db as never, { migrationsFolder: "drizzle" });
  db.insert(schema.accounts)
    .values([
      { id: bank, name: "Bank", role: 1, type: AccountType.Asset, rank: "a" },
      {
        id: payable,
        name: "Accounts Payable",
        role: 1,
        type: AccountType.Liability,
        rank: "b",
      },
      {
        id: clearing,
        name: "Clearing",
        role: 1,
        type: AccountType.Asset,
        rank: "c",
      },
      {
        id: expense,
        name: "Expense",
        role: 1,
        type: AccountType.Expense,
        rank: "d",
      },
    ])
    .run();
  db.insert(schema.accountDefaults)
    .values({ purpose: DefaultAccountPurpose.Payable, accountId: payable })
    .run();
  supplier = db
    .insert(schema.contacts)
    .values({ entityType: 2, legalName: "Supplier" })
    .returning()
    .get().id;
  recipient = db
    .insert(schema.contacts)
    .values({ entityType: 2, legalName: "Recipient" })
    .returning()
    .get().id;
});
afterEach(() => sqlite.close());

describe("reimbursement record presentation", () => {
  it("projects eight expenses without changing payment or obligation amounts and exposes payment from each expense", () => {
    const f = fixture();
    const result = recordRelations(db, 219);
    expect(getRecord(db, 219)?.amountMinor).toBe(58294);
    expect(getRecord(db, 219)?.outstandingMinor).toBe(2800);
    expect(result.links.map((l) => l.otherRecordId)).toEqual([252]);
    expect(result.displayLinks.map((l) => l.otherRecordId)).toEqual(
      f.expenses.map((e) => e.id),
    );
    expect(result.displayLinks.reduce((sum, l) => sum + l.amountMinor, 0)).toBe(
      55494,
    );
    expect(result.displayLinks.every((l) => l.canUndo === false)).toBe(true);
    expect(result.reimbursement.groups[0].fundingForRecordMinor).toBe(55494);
    const helperEntries = recordRelations(db, 252).reimbursement.groups[0]
      .entries;
    expect(
      helperEntries.find((entry) => entry.recordId === 252)?.description,
    ).toBe("Reimbursement summary: Record 219");
    expect(
      helperEntries.find((entry) => entry.recordId === 253)?.description,
    ).toBe("Included expenses: Record 219");
    // Existing historical descriptions are displayed clearly without rewriting stored records.
    expect(getRecord(db, 252)?.description).toBe("Record 252");
    expect(recordRelations(db, 252).reimbursement).toMatchObject({
      generated: true,
      generatedRole: "recipient",
    });
    expect(
      recordRelations(db, 252).reimbursement.groups[0].entries.find(
        (e) => e.recordId === 252,
      )?.amountMinor,
    ).toBe(55494);
    expect(recordRelations(db, 100).displayLinks).toMatchObject([
      { otherRecordId: 219, amountMinor: 5000, canUndo: false },
    ]);
  });

  it.each([[30000], [30000, 25494]])(
    "keeps partial and mixed funding as summaries without assigning expenses to funding sources: %j",
    (...amounts) => {
      fixture(amounts);
      const result = recordRelations(db, 219);
      expect(result.displayLinks.map((l) => l.otherRecordId)).toEqual([252]);
      expect(result.reimbursement.groups[0].fundingForRecordMinor).toBe(30000);
      expect(result.reimbursement.groups[0].items).toHaveLength(8);
      expect(recordRelations(db, 100).displayLinks).toMatchObject([
        {
          otherRecordId: 252,
          otherDescription: "Reimbursement summary: Record 219",
          canUndo: false,
        },
      ]);
      if (amounts.length > 1)
        expect(
          recordRelations(db, 221).reimbursement.groups[0]
            .fundingForRecordMinor,
        ).toBe(25494);
    },
  );

  it("discovers credit-only funding without an original payment link", () => {
    fixture([55494], false);
    const result = recordRelations(db, 219);
    expect(result.reimbursement.groups).toHaveLength(1);
    expect(result.displayLinks).toHaveLength(8);
    expect(result.reimbursement.relatedRecordIds).toContain(219);
  });

  it("preserves reversed credit-only group history after credit is reused and uses the effective reversal date", () => {
    const f = fixture([55494], false);
    for (const allocation of db.select().from(schema.settlements).all()) {
      db.insert(schema.auditLog)
        .values({
          recordType: "settlement",
          recordId: String(allocation.id),
          via: "system",
          action: "delete",
          changes: JSON.stringify([
            { field: "allocation", before: allocation, after: null },
          ]),
        })
        .run();
      db.delete(schema.settlements)
        .where(eq(schema.settlements.id, allocation.id))
        .run();
    }
    const recipientReversal = record(
      260,
      LedgerRecordKind.Transfer,
      55494,
      recipient,
      payable,
      clearing,
    );
    const supplierReversal = record(
      261,
      LedgerRecordKind.Transfer,
      55494,
      supplier,
      clearing,
      payable,
    );
    db.insert(schema.reimbursementEntries)
      .values([
        { groupId: 1, recordId: 260, role: "recipient-reversal" },
        { groupId: 1, recordId: 261, role: "supplier-reversal" },
      ])
      .run();
    allocate(recipientReversal.positive, f.obligation.negative, 55494);
    allocate(f.transfer.positive, supplierReversal.negative, 55494);
    db.update(schema.reimbursements)
      .set({ reversedAt: "2026-04-10T12:00:00Z" })
      .where(eq(schema.reimbursements.id, 1))
      .run();
    db.insert(schema.auditLog)
      .values({
        recordType: "record",
        recordId: "252",
        via: "system",
        action: "update",
        changes: JSON.stringify([
          {
            field: "reimbursementReversal",
            before: {},
            after: { date: "2026-04-01", reversalIds: [] },
          },
          {
            field: "correctionReason",
            before: null,
            after: "Remove incorrect claims",
          },
        ]),
      })
      .run();
    const later = record(
      300,
      LedgerRecordKind.Expense,
      58294,
      recipient,
      expense,
      payable,
    );
    allocate(f.payment.positive, later.negative, 58294);
    const result = recordRelations(db, 219);
    expect(result.displayLinks.map((l) => l.otherRecordId)).toEqual([300]);
    expect(result.reimbursement.groups[0]).toMatchObject({
      fundedMinor: 0,
      fundingForRecordMinor: 0,
      reversedAmountMinor: 55494,
      reversalDate: "2026-04-01",
      reversalReason: "Remove incorrect claims",
    });
    expect(result.reimbursement.groups[0].historicalFunding).toMatchObject([
      { otherRecordId: 219, amountMinor: 55494 },
    ]);
    expect(getRecord(db, 219)?.outstandingMinor).toBe(0);
    expect(recordRelations(db, 100).displayLinks).toEqual([]);
    expect(recordRelations(db, 252).displayLinks).toEqual([]);
    expect(result.reimbursement.groups[0].funding).toEqual([]);
  });

  it("combines multiple claim movements of one expense into one projected row", () => {
    fixture();
    const extra = db
      .insert(schema.ledgerMovements)
      .values({ recordId: 100, accountId: payable, amountMinor: -100 })
      .returning()
      .get();
    db.insert(schema.ledgerMovements)
      .values({ recordId: 100, accountId: expense, amountMinor: 100 })
      .run();
    db.update(schema.reimbursementItems)
      .set({ amountMinor: 4900 })
      .where(
        eq(
          schema.reimbursementItems.sourceMovementId,
          getRecord(db, 100)!.movements.find((m) => m.accountId === payable)!
            .id,
        ),
      )
      .run();
    db.insert(schema.reimbursementItems)
      .values({ groupId: 1, sourceMovementId: extra.id, amountMinor: 100 })
      .run();
    const rows = recordRelations(db, 219).displayLinks;
    expect(rows).toHaveLength(8);
    expect(rows.filter((row) => row.otherRecordId === 100)).toMatchObject([
      { amountMinor: 5000 },
    ]);
  });

  it("keeps allocation correction history separate from credit and ignores overlapping settlement and recipient audit entries", () => {
    fixture();
    const unchanged = {
      id: 10,
      paymentMovementId: 1,
      owedMovementId: 2,
      amountMinor: 55494,
    };
    const removed = {
      id: 32,
      paymentMovementId: 1,
      owedMovementId: 3,
      amountMinor: 2800,
    };
    for (const [recordType, recordId, fields] of [
      [
        "record",
        "219",
        [
          {
            field: "allocations",
            before: [unchanged, removed],
            after: [unchanged],
          },
          { field: "correctionReason", after: "Already paid by company" },
        ],
      ],
      [
        "settlement",
        "32",
        [{ field: "allocation", before: removed, after: null }],
      ],
      [
        "record",
        "219",
        [{ field: "reimbursementAllocations", before: [removed], after: [] }],
      ],
    ] as const) {
      db.insert(schema.auditLog)
        .values({
          recordType,
          recordId,
          via: "system",
          action: "update",
          changes: JSON.stringify(fields),
          createdAt: "2026-04-01 09:00:00",
        })
        .run();
    }
    const history = recordRelations(db, 219).reimbursement.allocationHistory;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      date: "2026-04-01 09:00:00",
      reason: "Already paid by company",
      removedMinor: 2800,
      addedMinor: 0,
    });
  });

  it("leaves ordinary allocations and refunds visible without inventing reimbursement groups", () => {
    const payment = record(
      1,
      LedgerRecordKind.Payment,
      10000,
      recipient,
      payable,
      bank,
    );
    const bill = record(
      2,
      LedgerRecordKind.Expense,
      7000,
      recipient,
      expense,
      payable,
    );
    const refund = record(
      3,
      LedgerRecordKind.Payment,
      1000,
      recipient,
      bank,
      payable,
    );
    allocate(payment.positive, bill.negative, 7000);
    allocate(payment.positive, refund.negative, 1000);
    const result = recordRelations(db, 1);
    expect(result.displayLinks).toEqual(result.links);
    expect(result.displayLinks.reduce((n, l) => n + l.amountMinor, 0)).toBe(
      8000,
    );
    expect(result.reimbursement.groups).toEqual([]);
    expect(getRecord(db, 1)?.outstandingMinor).toBe(2000);
  });
});
