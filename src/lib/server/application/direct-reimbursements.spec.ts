import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confirmImportRow } from "../services/import.js";
import { eq } from "drizzle-orm";
import { recordAudit } from "../audit.js";
import { ledgerEvents } from "../ledger/events.js";
import { recordRelations } from "../queries/reimbursements.js";
import {
  getSettlement,
  settlementsForRecord,
  listOutstanding,
} from "../queries/settlements.js";
import { removeRecord, patchRecord } from "../services/ledger.js";
import { undoSettlement } from "../services/settlements.js";
import {
  updateRecord,
  wouldRemoveAllocationHistory,
} from "../queries/ledger.js";
import { prepareRecordDateCorrection } from "./record-date-correction.js";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AccountSubType,
  AccountType,
  DefaultAccountPurpose,
  DocumentType,
  ImportState,
} from "$lib/enums.js";
import { LEAF_PERMISSIONS } from "$lib/permissions/catalog.js";
import * as schema from "../db/schema.js";
import type { LedgerDb, RecordView } from "../ledger/types.js";
import { localsFor } from "../permissions/test-locals.js";
import { createAccount } from "../services/accounts.js";
import {
  accountDefaultId,
  ensureReimbursementsPayableAccount,
} from "../services/account-defaults.js";
import { setSetting, SETTING_KEYS } from "../settings.js";
import { getRecord, integrityInputs, listRecords } from "../queries/ledger.js";
import { checkIntegrity } from "../ledger/integrity.js";
import { contactBalances } from "../queries/settlements.js";
import { createRecord } from "./records.js";
import {
  correctReimbursementAmount,
  prepareReimbursementAmountCorrection,
} from "./reimbursement-amount-correction.js";
import { updateRecord as updateLedgerRecord } from "../queries/ledger.js";
import {
  createReimbursement,
  reimbursementCandidates,
} from "./reimbursements.js";
import {
  correctPaymentAllocations,
  preparePaymentCorrection,
} from "./payment-corrections.js";
import {
  correctPaymentRecipient,
  prepareRecipientCorrection,
} from "./payment-recipient.js";
import type { AppContext } from "./context.js";

let sqlite: Database;
let db: LedgerDb;
let ctx: AppContext;
let bank: number;
let category: number;
let person: number;
let supplier: number;
const common = {
  date: "2026-03-01",
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
function expense(amount = 554.94, paidBy = person): RecordView {
  const r = createRecord(ctx, {
    ...common,
    kind: "expense",
    amount,
    categoryAccountId: category,
    paidFromAccountId: null,
    contactId: paidBy === person ? supplier : paidBy,
  });
  if (!r.ok) throw new Error(r.reason);
  return r.value.record;
}
function claim(bill: RecordView, cashMinor = 58294) {
  const payable = accountDefaultId(db, DefaultAccountPurpose.Payable)!;
  return {
    contactId: person,
    personallyPaid: true as const,
    date: common.date,
    description: common.description,
    reference: "",
    remark: "",
    items: [
      {
        owedMovementId: bill.movements.find((m) => m.accountId === payable)!.id,
        amountMinor: bill.amountMinor,
      },
    ],
    cashMinor,
    paidFromAccountId: bank,
    credits: [] as { paymentMovementId: number; amountMinor: number }[],
  };
}
beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema }) as unknown as LedgerDb;
  migrate(db as never, { migrationsFolder: "drizzle" });
  db.insert(schema.users)
    .values({ email: "direct@test", username: "direct", passwordHash: "x" })
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
    ])
    .run();
  const opening = account("Opening", AccountType.Equity);
  db.insert(schema.accountDefaults)
    .values({
      purpose: DefaultAccountPurpose.OpeningBalances,
      accountId: opening,
      updatedBy: 1,
    })
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

describe("controlled reimbursement amount corrections", () => {
  const reason = "Correct the amount to the actual bank transfer.";
  function funded(amount = 5.5, cashMinor = 550) {
    const bill = expense(amount);
    const created = createReimbursement(ctx, claim(bill, cashMinor));
    if (!created.ok || !created.value.payment)
      throw new Error("Fixture payment failed");
    const payment = created.value.payment;
    const prepared = prepareReimbursementAmountCorrection(ctx, payment.id);
    if (!prepared.ok) throw new Error(prepared.reason);
    return { bill, payment, state: prepared.value };
  }
  function correct(
    f: ReturnType<typeof funded>,
    amountMinor: number,
    allocatedMinor = amountMinor,
  ) {
    return correctReimbursementAmount(ctx, f.payment.id, {
      amountMinor,
      allocations: [
        {
          owedMovementId: f.state.expenses[0].owedMovementId,
          amountMinor: allocatedMinor,
        },
      ],
      reason,
      expectedVersion: f.state.version,
    });
  }

  it("corrects 5.50 to 5.00, retains history and IDs, and reimburses the remaining 0.50", () => {
    const f = funded();
    const movementIds = f.payment.movements.map((m) => m.id);
    const events: unknown[] = [];
    const listen = (event: unknown) => events.push(event);
    ledgerEvents.on("record-update", listen);
    let result;
    try {
      result = correct(f, 500);
    } finally {
      ledgerEvents.off("record-update", listen);
    }
    expect(result.ok).toBe(true);
    expect(getRecord(db, f.payment.id)).toMatchObject({
      amountMinor: 500,
      outstandingMinor: 0,
    });
    expect(getRecord(db, f.payment.id)!.movements.map((m) => m.id)).toEqual(
      movementIds,
    );
    expect(
      getRecord(db, f.payment.id)!.movements.map((m) => m.amountMinor),
    ).toEqual([500, -500]);
    expect(getRecord(db, f.bill.id)).toMatchObject({
      amountMinor: 550,
      outstandingMinor: 50,
      paid: false,
    });
    expect(events.length).toBeGreaterThan(0);
    expect(
      db
        .select()
        .from(schema.settlements)
        .where(eq(schema.settlements.id, f.state.allocations[0].id))
        .get(),
    ).toMatchObject({
      amountMinor: 550,
      reversedBy: 1,
      reversalReason: reason,
    });
    expect(recordRelations(db, f.payment.id).historicalLinks).toHaveLength(1);
    const audit = db
      .select()
      .from(schema.auditLog)
      .all()
      .find((a) => a.changes?.includes("reimbursementAmountCorrectionReason"));
    expect(audit?.changes).toContain(reason);
    expect(audit?.changes).toContain('"before":5.5');
    const next = createReimbursement(ctx, {
      ...claim(getRecord(db, f.bill.id)!, 50),
      items: [
        { owedMovementId: f.state.expenses[0].owedMovementId, amountMinor: 50 },
      ],
    });
    expect(next.ok).toBe(true);
    expect(getRecord(db, f.bill.id)?.outstandingMinor).toBe(0);
    expect(getRecord(db, f.payment.id)?.amountMinor).toBe(500);
  });

  it("increases payment, settles only the available balance and retains excess payee credit", () => {
    const f = funded(5.5, 500);
    expect(correct(f, 700, 550).ok).toBe(true);
    expect(getRecord(db, f.bill.id)?.outstandingMinor).toBe(0);
    const current = prepareReimbursementAmountCorrection(ctx, f.payment.id);
    expect(current.ok && current.value.availableCreditMinor).toBe(150);
    const balances = contactBalances(db, "we-owe", person);
    expect(balances[0]).toMatchObject({
      obligationsMinor: 0,
      creditsMinor: 150,
    });
  });

  it("preserves unchanged allocation rows when only available credit changes", () => {
    const f = funded(5.5, 700);
    expect(correct(f, 600, 550).ok).toBe(true);
    expect(getSettlement(db, f.state.allocations[0].id)?.amountMinor).toBe(550);
    expect(recordRelations(db, f.payment.id).historicalLinks).toHaveLength(0);
  });

  it("can reopen an expense fully and correct a credit-only remainder again", () => {
    const f = funded();
    expect(correct(f, 500, 0).ok).toBe(true);
    expect(getRecord(db, f.bill.id)?.outstandingMinor).toBe(550);
    const prepared = prepareReimbursementAmountCorrection(ctx, f.payment.id);
    if (!prepared.ok) throw new Error(prepared.reason);
    expect(prepared.value.expenses).toEqual([]);
    expect(
      correctReimbursementAmount(ctx, f.payment.id, {
        amountMinor: 450,
        allocations: [],
        expectedVersion: prepared.value.version,
        reason,
      }).ok,
    ).toBe(true);
    expect(getRecord(db, f.payment.id)?.amountMinor).toBe(450);
    expect(recordRelations(db, f.payment.id).historicalLinks).toHaveLength(1);
  });

  it("corrects selected expenses across suppliers and preserves unaffected allocations", () => {
    const first = expense(5.5);
    const second = expense(8, person);
    const items = [first, second].map((bill) => ({
      owedMovementId: bill.movements.find((m) => m.amountMinor < 0)!.id,
      amountMinor: bill.amountMinor,
    }));
    const created = createReimbursement(ctx, { ...claim(first, 1350), items });
    if (!created.ok || !created.value.payment)
      throw new Error("Fixture payment failed");
    const prepared = prepareReimbursementAmountCorrection(
      ctx,
      created.value.payment.id,
    );
    if (!prepared.ok) throw new Error(prepared.reason);
    const state = prepared.value;
    const result = correctReimbursementAmount(ctx, created.value.payment.id, {
      amountMinor: 1300,
      reason,
      expectedVersion: state.version,
      allocations: [{ ...items[0], amountMinor: 500 }, items[1]],
    });
    expect(result.ok).toBe(true);
    expect(getRecord(db, first.id)?.outstandingMinor).toBe(50);
    expect(getRecord(db, second.id)?.outstandingMinor).toBe(0);
    expect(getSettlement(db, state.allocations[1].id)?.amountMinor).toBe(800);
  });

  it("caps correction against other payments and detects their concurrent allocations", () => {
    const f = funded(10, 500);
    const another = createReimbursement(ctx, {
      ...claim(f.bill, 200),
      items: [
        {
          owedMovementId: f.state.expenses[0].owedMovementId,
          amountMinor: 200,
        },
      ],
    });
    expect(another.ok).toBe(true);
    expect(correct(f, 700)).toMatchObject({ ok: false, code: "CONFLICT" });
    const fresh = prepareReimbursementAmountCorrection(ctx, f.payment.id);
    if (!fresh.ok) throw new Error(fresh.reason);
    expect(fresh.value.expenses[0].availableMinor).toBe(800);
    expect(
      correctReimbursementAmount(ctx, f.payment.id, {
        amountMinor: 900,
        allocations: [
          {
            owedMovementId: f.state.expenses[0].owedMovementId,
            amountMinor: 900,
          },
        ],
        expectedVersion: fresh.value.version,
        reason,
      }),
    ).toMatchObject({ ok: false, code: "INVALID_INPUT" });
  });

  it("refuses duplicate, unrelated and overallocated targets and invalid amounts without changes", () => {
    const f = funded();
    const allocation = {
      owedMovementId: f.state.expenses[0].owedMovementId,
      amountMinor: 500,
    };
    const base = {
      amountMinor: 500,
      allocations: [allocation],
      reason,
      expectedVersion: f.state.version,
    };
    for (const patch of [
      { allocations: [allocation, allocation] },
      { allocations: [{ owedMovementId: 99999, amountMinor: 500 }] },
      { allocations: [{ ...allocation, amountMinor: 551 }], amountMinor: 600 },
      { allocations: [{ ...allocation, amountMinor: 501 }] },
      { amountMinor: 0 },
      { amountMinor: -1 },
      { amountMinor: 500.1 },
      { amountMinor: Number.MAX_SAFE_INTEGER + 1 },
      { amountMinor: 550 },
      { reason: "short" },
    ]) {
      expect(
        correctReimbursementAmount(ctx, f.payment.id, { ...base, ...patch }).ok,
      ).toBe(false);
      expect(getRecord(db, f.payment.id)?.amountMinor).toBe(550);
      expect(getSettlement(db, f.state.allocations[0].id)?.amountMinor).toBe(
        550,
      );
    }
  });

  it("requires all permissions", () => {
    const f = funded();
    for (const permission of [
      "records.read",
      "records.update",
      "records.correctReimbursementAmount",
    ]) {
      const limited = {
        ...ctx,
        locals: localsFor(LEAF_PERMISSIONS.filter((p) => p !== permission)),
      };
      expect(
        prepareReimbursementAmountCorrection(limited, f.payment.id),
      ).toMatchObject({ ok: false, code: "FORBIDDEN" });
      expect(
        correctReimbursementAmount(limited, f.payment.id, {}),
      ).toMatchObject({ ok: false, code: "FORBIDDEN" });
    }
  });

  it.each(["pat", "oauth"] as const)(
    "allows authorized %s reimbursement amount corrections",
    (kind) => {
      const f = funded();
      const api = {
        ...ctx,
        locals: {
          ...ctx.locals,
          credential:
            kind === "pat"
              ? { kind, tokenId: 1 }
              : { kind, grantId: "g", clientId: "c" },
        },
      };
      expect(prepareReimbursementAmountCorrection(api, f.payment.id).ok).toBe(
        true,
      );
      expect(
        correctReimbursementAmount(api, f.payment.id, {
          amountMinor: 500,
          allocations: [
            {
              owedMovementId: f.state.expenses[0].owedMovementId,
              amountMinor: 500,
            },
          ],
          reason,
          expectedVersion: f.state.version,
        }).ok,
      ).toBe(true);
      expect(getRecord(db, f.payment.id)?.amountMinor).toBe(500);
    },
  );

  it("rejects stale payment and expense edits, and repeat confirmation", () => {
    const f = funded();
    updateLedgerRecord(db, f.bill.id, 1, { reference: "Changed expense" });
    expect(correct(f, 500)).toMatchObject({ ok: false, code: "CONFLICT" });
    const prepared = prepareReimbursementAmountCorrection(ctx, f.payment.id);
    if (!prepared.ok) throw new Error(prepared.reason);
    f.state = prepared.value;
    expect(correct(f, 500).ok).toBe(true);
    expect(correct(f, 500)).toMatchObject({ ok: false, code: "CONFLICT" });
  });

  it("rolls back payment, allocations and audit rows and emits nothing when auditing fails", () => {
    const f = funded();
    const beforeAudit = db.select().from(schema.auditLog).all().length;
    const events: unknown[] = [];
    const listen = (event: unknown) => events.push(event);
    sqlite.exec(`CREATE TRIGGER fail_amount_audit BEFORE INSERT ON audit_log
      WHEN NEW.changes LIKE '%reimbursementAmountCorrectionReason%'
      BEGIN SELECT RAISE(ABORT, 'test audit failure'); END;`);
    ledgerEvents.on("record-update", listen);
    try {
      expect(() => correct(f, 500)).toThrow();
    } finally {
      ledgerEvents.off("record-update", listen);
    }
    expect(getRecord(db, f.payment.id)?.amountMinor).toBe(550);
    expect(getRecord(db, f.bill.id)?.outstandingMinor).toBe(0);
    expect(db.select().from(schema.settlements).all()).toHaveLength(1);
    expect(getSettlement(db, f.state.allocations[0].id)?.amountMinor).toBe(550);
    expect(db.select().from(schema.auditLog).all()).toHaveLength(beforeAudit);
    expect(events).toEqual([]);
  });

  it("blocks bank matches and detects a match added after preview", () => {
    const f = funded();
    const statement = db
      .insert(schema.bankStatements)
      .values({
        originalFilename: "fixture.pdf",
        storedFilePath: "fixture.pdf",
        accountId: bank,
      })
      .returning()
      .get()!;
    const line = db
      .insert(schema.bankStatementLines)
      .values({
        statementId: statement.id,
        date: common.date,
        amount: 5,
        direction: 2,
      })
      .returning()
      .get()!;
    db.insert(schema.reconciliationAllocations)
      .values({
        lineId: line.id,
        movementId: f.payment.movements.find((m) => m.accountId === bank)!.id,
        amount: 5,
        itemAmountSnapshot: 5.5,
      })
      .run();
    expect(
      prepareReimbursementAmountCorrection(ctx, f.payment.id),
    ).toMatchObject({ ok: false, code: "REFUSED" });
    expect(correct(f, 500)).toMatchObject({ ok: false, code: "CONFLICT" });
    expect(getRecord(db, f.payment.id)?.amountMinor).toBe(550);
  });

  it("blocks a payment whose available credit was refunded", () => {
    const f = funded(5.5, 700);
    const refund = createRecord(ctx, {
      ...common,
      kind: "payment",
      direction: "refund-received",
      amount: 1,
      contactId: person,
      paidFromAccountId: bank,
      settlementAccountId: f.state.payment.accountId,
      settlements: [{ owedMovementId: f.state.payment.id, amountMinor: 100 }],
    });
    expect(refund.ok).toBe(true);
    const prepared = prepareReimbursementAmountCorrection(ctx, f.payment.id);
    expect(prepared).toMatchObject({ ok: false, code: "REFUSED" });
    if (!prepared.ok) expect(prepared.reason).toContain("refund or offset");
    expect(correct(f, 600, 550)).toMatchObject({ ok: false, code: "CONFLICT" });
  });

  it("excludes legacy helper groups and generated entries", () => {
    const f = funded();
    const group = db
      .insert(schema.reimbursements)
      .values({
        paymentRecordId: f.payment.id,
        payableRecordId: f.bill.id,
      })
      .returning()
      .get()!;
    db.insert(schema.reimbursementEntries)
      .values({
        recordId: f.bill.id,
        groupId: group.id,
        role: "recipient",
      })
      .run();
    const prepared = prepareReimbursementAmountCorrection(ctx, f.payment.id);
    expect(prepared).toMatchObject({ ok: false, code: "REFUSED" });
    if (!prepared.ok) expect(prepared.reason).toContain("older reimbursement");
    expect(prepareReimbursementAmountCorrection(ctx, f.bill.id).ok).toBe(false);
    expect(correct(f, 500)).toMatchObject({ ok: false, code: "CONFLICT" });
  });

  it("rejects split and contactless payments without changing their postings", () => {
    const f = funded();
    db.insert(schema.ledgerMovements)
      .values({
        recordId: f.payment.id,
        accountId: category,
        amountMinor: 0,
        sortOrder: 2,
      })
      .run();
    expect(prepareReimbursementAmountCorrection(ctx, f.payment.id).ok).toBe(
      false,
    );
    db.delete(schema.ledgerMovements)
      .where(eq(schema.ledgerMovements.sortOrder, 2))
      .run();
    updateLedgerRecord(db, f.payment.id, 1, { contactId: null });
    expect(prepareReimbursementAmountCorrection(ctx, f.payment.id).ok).toBe(
      false,
    );
    expect(getRecord(db, f.payment.id)?.amountMinor).toBe(550);
  });
});

describe("direct reimbursements", () => {
  it("creates only the expense and actual bank payment, retaining excess credit", () => {
    const bill = expense();
    const result = createReimbursement(ctx, claim(bill));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(db.select().from(schema.ledgerRecords).all()).toHaveLength(2);
    expect(db.select().from(schema.reimbursementEntries).all()).toHaveLength(0);
    expect(result.value.payment?.amountMinor).toBe(58294);
    expect(getRecord(db, bill.id)?.outstandingMinor).toBe(0);
    expect(contactBalances(db, "we-owe", person)[0]).toMatchObject({
      obligationsMinor: 0,
      creditsMinor: 2800,
      outstandingMinor: -2800,
    });
  });
  it("reimburses several suppliers and reverses only the selected allocation", () => {
    const otherSupplier = db
      .insert(schema.contacts)
      .values({ legalName: "Other shop", entityType: 2 })
      .returning()
      .get()!.id;
    const first = expense(10);
    const second = expense(20, otherSupplier);
    const request = claim(first, 3000);
    const secondSide = second.movements.find((m) => m.amountMinor < 0)!;
    const paid = createReimbursement(ctx, {
      ...request,
      items: [
        ...request.items,
        { owedMovementId: secondSide.id, amountMinor: 2000 },
      ],
    });
    if (!paid.ok) throw new Error(paid.reason);
    const payment = paid.value.payment!;
    const side = payment.movements.find((m) => m.amountMinor > 0)!;
    const before = preparePaymentCorrection(ctx, side.id);
    if (!before.ok) throw new Error(before.reason);
    const removed = before.value.allocations.find(
      (a) => a.owedMovementId === request.items[0].owedMovementId,
    )!;
    const result = correctPaymentAllocations(ctx, {
      paymentMovementId: side.id,
      removeSettlementIds: [removed.id],
      allocations: [],
      reason: "This purchase was actually paid by the company",
      expectedVersion: before.value.version,
    });
    if (!result.ok) throw new Error(result.reason);
    expect(getRecord(db, first.id)?.outstandingMinor).toBe(1000);
    expect(getRecord(db, second.id)?.paid).toBe(true);
    expect(getRecord(db, first.id)?.contactId).toBe(supplier);
    expect(getRecord(db, second.id)?.contactId).toBe(otherSupplier);
    expect(getRecord(db, payment.id)?.amountMinor).toBe(3000);
    expect(contactBalances(db, "we-owe", person)[0]?.creditsMinor).toBe(1000);
    expect(db.select().from(schema.ledgerRecords).all()).toHaveLength(3);
    expect(checkIntegrity(integrityInputs(db)).ok).toBe(true);
  });
  it("can spend recipient opening credit across suppliers without creating a cash record", () => {
    const payable = accountDefaultId(db, DefaultAccountPurpose.Payable)!;
    const credit = createRecord(ctx, {
      ...common,
      kind: "journal",
      amount: 10,
      contactId: person,
      movements: [
        { accountId: payable, amountMinor: 1000 },
        { accountId: bank, amountMinor: -1000 },
      ],
    });
    if (!credit.ok) throw new Error(credit.reason);
    const creditSide = credit.value.record.movements.find(
      (m) => m.accountId === payable,
    )!;
    const bill = expense(10);
    const candidates = reimbursementCandidates(ctx, person);
    expect(
      candidates.ok &&
        candidates.value.items.some((i) => i.movementId === creditSide.id),
    ).toBe(true);
    const paid = createReimbursement(ctx, {
      ...claim(bill, 0),
      credits: [{ paymentMovementId: creditSide.id, amountMinor: 1000 }],
    });
    if (!paid.ok) throw new Error(paid.reason);
    expect(paid.value.payment).toBeNull();
    expect(getRecord(db, bill.id)?.paid).toBe(true);
    expect(db.select().from(schema.ledgerRecords).all()).toHaveLength(2);
  });
  it("keeps earlier separate-payable expenses usable without mixing control accounts", () => {
    const configured = ensureReimbursementsPayableAccount(db, 1);
    if (!configured.ok) throw new Error(configured.reason);
    const old = createRecord(ctx, {
      ...common,
      kind: "expense",
      amount: 10,
      paidFromAccountId: null,
      categoryAccountId: category,
      contactId: person,
      supplierContactId: supplier,
      expensePaymentSource: "personal",
    });
    if (!old.ok) throw new Error(old.reason);
    const candidates = reimbursementCandidates(ctx, person, configured.value);
    expect(
      candidates.ok && candidates.value.items.map((i) => i.recordId),
    ).toEqual([old.value.record.id]);
    const item = old.value.record.movements.find(
      (m) => m.accountId === configured.value,
    )!;
    const paid = createReimbursement(ctx, {
      ...claim(expense(10), 1000),
      items: [{ owedMovementId: item.id, amountMinor: 1000 }],
    });
    if (!paid.ok) throw new Error(paid.reason);
    expect(
      paid.value.payment?.movements.some(
        (m) => m.accountId === configured.value,
      ),
    ).toBe(true);
    expect(getRecord(db, old.value.record.id)?.paid).toBe(true);
  });
  it("applies prior credit before cash to the next expense", () => {
    const first = createReimbursement(ctx, claim(expense()));
    if (!first.ok) throw new Error(first.reason);
    const payable = accountDefaultId(db, DefaultAccountPurpose.Payable)!;
    const credit = first.value.payment!.movements.find(
      (m) => m.accountId === payable,
    )!;
    const next = expense(100);
    const result = createReimbursement(ctx, {
      ...claim(next, 7200),
      credits: [{ paymentMovementId: credit.id, amountMinor: 2800 }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.payment?.amountMinor).toBe(7200);
    expect(result.value.remainingMinor).toBe(0);
    expect(contactBalances(db, "we-owe", person)).toEqual([]);
  });
  it("credit-only settlement creates no record and partial cash leaves debt", () => {
    const first = createReimbursement(ctx, claim(expense()));
    if (!first.ok) throw new Error(first.reason);
    const payable = accountDefaultId(db, DefaultAccountPurpose.Payable)!;
    const credit = first.value.payment!.movements.find(
      (m) => m.accountId === payable,
    )!;
    const next = expense(28);
    const before = db.select().from(schema.ledgerRecords).all().length;
    const result = createReimbursement(ctx, {
      ...claim(next, 0),
      credits: [{ paymentMovementId: credit.id, amountMinor: 2800 }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.payment).toBeNull();
    expect(result.value.record.id).toBe(next.id);
    expect(db.select().from(schema.ledgerRecords).all()).toHaveLength(before);
    const partial = createReimbursement(ctx, claim(expense(100), 5000));
    expect(partial.ok && partial.value.remainingMinor).toBe(5000);
  });
  it("rejects wrong ownership, zero funding and stale amounts atomically", () => {
    const bill = expense();
    const input = claim(bill);
    const count = db.select().from(schema.ledgerRecords).all().length;
    expect(createReimbursement(ctx, { ...input, cashMinor: 0 }).ok).toBe(false);
    expect(createReimbursement(ctx, { ...input, contactId: 999999 }).ok).toBe(
      false,
    );
    expect(
      createReimbursement(ctx, {
        ...input,
        items: [{ ...input.items[0], amountMinor: 999999 }],
      }).ok,
    ).toBe(false);
    expect(db.select().from(schema.ledgerRecords).all()).toHaveLength(count);
    expect(db.select().from(schema.settlements).all()).toHaveLength(0);
  });
  it("offers Accounts payable expenses across suppliers without a payment-source field", () => {
    const bill = expense();
    const other = expense(40, person);
    const result = reimbursementCandidates(ctx, person);
    expect(result.ok && result.value.items.map((i) => i.recordId)).toEqual([
      bill.id,
      other.id,
    ]);
  });
  it("corrects the recipient and selected allocations while preserving suppliers", () => {
    const bill = expense();
    const result = createReimbursement(ctx, claim(bill));
    if (!result.ok) throw new Error(result.reason);
    const payment = result.value.payment!;
    const recipient = prepareRecipientCorrection(ctx, payment.id);
    if (!recipient.ok) throw new Error(recipient.reason);
    expect(
      correctPaymentRecipient(ctx, {
        recordId: payment.id,
        contactId: supplier,
        reason: "Correct recipient after reviewing",
        expectedVersion: recipient.value.version,
      }).ok,
    ).toBe(true);
    const payable = accountDefaultId(db, DefaultAccountPurpose.Payable)!;
    const side = payment.movements.find((m) => m.accountId === payable)!;
    const preview = preparePaymentCorrection(ctx, side.id);
    if (!preview.ok) throw new Error(preview.reason);
    const corrected = correctPaymentAllocations(ctx, {
      paymentMovementId: side.id,
      removeSettlementIds: preview.value.allocations.map((a) => a.id),
      allocations: [],
      reason: "Remove the mistaken allocation",
      expectedVersion: preview.value.version,
    });
    expect(corrected.ok).toBe(true);
    expect(getRecord(db, bill.id)?.contactId).toBe(supplier);
    expect(getRecord(db, bill.id)?.outstandingMinor).toBe(55494);
  });
  it("accepts the original manual two-account form without payment metadata", () => {
    const payable = accountDefaultId(db, DefaultAccountPurpose.Payable)!;
    const saved = createRecord(ctx, {
      ...common,
      amount: 12,
      fromAccountId: payable,
      toAccountId: category,
      contactId: supplier,
    });
    if (!saved.ok) throw new Error(saved.reason);
    expect(saved.value.record.expensePaymentSource).toBeNull();
    expect(reimbursementCandidates(ctx, person).ok).toBe(true);
    const paid = createReimbursement(ctx, claim(saved.value.record, 1200));
    if (!paid.ok) throw new Error(paid.reason);
    expect(getRecord(db, saved.value.record.id)?.paid).toBe(true);
    expect(getRecord(db, saved.value.record.id)?.contactId).toBe(supplier);
    expect(
      accountDefaultId(db, DefaultAccountPurpose.ReimbursementsPayable),
    ).toBeNull();
  });
  it("refunds reimbursement credit through its original payable account", () => {
    const paid = createReimbursement(ctx, claim(expense()));
    if (!paid.ok) throw new Error(paid.reason);
    const payable = accountDefaultId(db, DefaultAccountPurpose.Payable)!;
    const refund = createRecord(ctx, {
      ...common,
      kind: "payment",
      direction: "refund-received",
      amount: 10,
      contactId: person,
      paidFromAccountId: bank,
      settlementAccountId: payable,
      settlements: [
        {
          owedMovementId: paid.value.payment!.movements.find(
            (m) => m.accountId === payable,
          )!.id,
          amountMinor: 1000,
        },
      ],
    });
    if (!refund.ok) throw new Error(refund.reason);
    expect(getRecord(db, paid.value.payment!.id)!.outstandingMinor).toBe(1800);
    expect(
      refund.value.record.movements.some(
        (m) => m.accountId === payable && m.amountMinor === -1000,
      ),
    ).toBe(true);
  });

  for (const payer of ["personal", "company"] as const) {
    it(`confirms a ${payer} import using its source account without extra payment fields`, () => {
      const root = mkdtempSync(join(tmpdir(), "akaun-personal-import-"));
      try {
        const jobId = "test-personal-import";
        const temp = "import/temp/personal.pdf";
        mkdirSync(join(root, "import/temp"), { recursive: true });
        writeFileSync(join(root, temp), "%PDF-1.4 fixture");
        db.insert(schema.importQueue)
          .values({
            id: jobId,
            createdBy: 1,
            state: ImportState.PendingReview,
            tempFilePath: temp,
            originalFilename: "personal.pdf",
            documentType: DocumentType.Expense,
          })
          .run();
        const input = {
          documentType: DocumentType.Expense,
          description: "Imported paper",
          partyName: "Shop",
          partyEdited: false,
          date: common.date,
          amount: 12,
          currency: "MYR",
          exchangeRate: 1,
          reference: "",
          category: "",
          categoryAccountId: category,
          remark: "",
          accountId:
            payer === "personal"
              ? accountDefaultId(db, DefaultAccountPurpose.Payable)!
              : bank,
          sides: {
            fromAccountId:
              payer === "personal"
                ? accountDefaultId(db, DefaultAccountPurpose.Payable)!
                : bank,
            toAccountId: category,
          },
          matchedContact: { id: supplier, documentType: DocumentType.Expense },
        };
        const result = confirmImportRow(
          db,
          { jobId, uploadedBy: 1, tempFilePath: temp, extractedText: null },
          input,
          { actingUserId: 1, storageRoot: root },
        );
        if (!result.ok) throw new Error(result.reason);
        expect(result.value.record.contactId).toBe(supplier);
        expect(result.value.record.expensePaymentSource).toBeNull();
        expect(
          result.value.record.movements.some(
            (m) =>
              m.accountId ===
                (payer === "personal"
                  ? accountDefaultId(db, DefaultAccountPurpose.Payable)
                  : bank) && m.amountMinor === -1200,
          ),
        ).toBe(true);
        expect(result.value.record.paid).toBe(payer === "company");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
  it("keeps supplier bills and company-paid expenses separate and searchable without changing old records", () => {
    const personallyPaid = expense(10);
    const legacy = createRecord(ctx, {
      ...common,
      kind: "expense",
      amount: 20,
      categoryAccountId: category,
      paidFromAccountId: null,
      contactId: supplier,
    });
    if (!legacy.ok) throw new Error(legacy.reason);
    const oldBefore = getRecord(db, legacy.value.record.id)!;
    const company = createRecord(ctx, {
      ...common,
      kind: "expense",
      amount: 30,
      categoryAccountId: category,
      paidFromAccountId: bank,
      expensePaymentSource: "company",
      supplierContactId: supplier,
    });
    const unpaid = createRecord(ctx, {
      ...common,
      kind: "expense",
      amount: 40,
      categoryAccountId: category,
      paidFromAccountId: null,
      expensePaymentSource: "unpaid",
      supplierContactId: supplier,
      contactId: supplier,
    });
    if (!company.ok) throw new Error(company.reason);
    if (!unpaid.ok) throw new Error(unpaid.reason);
    const supplierPayable = accountDefaultId(
      db,
      DefaultAccountPurpose.Payable,
    )!;
    expect(
      unpaid.value.record.movements.some(
        (m) => m.accountId === supplierPayable && m.amountMinor === -4000,
      ),
    ).toBe(true);
    expect(company.value.record.paid).toBe(true);
    expect(
      company.value.record.movements.some(
        (m) => m.accountId === bank && m.amountMinor === -3000,
      ),
    ).toBe(true);
    expect(getRecord(db, legacy.value.record.id)).toEqual(oldBefore);
    expect(
      listRecords(db, { contactId: supplier }).records.map((r) => r.id),
    ).toContain(personallyPaid.id);
    expect(
      listRecords(db, { search: "Shop" }).records.map((r) => r.id),
    ).toContain(personallyPaid.id);
    expect(checkIntegrity(integrityInputs(db)).ok).toBe(true);
  });
});

describe("retained allocation reversals", () => {
  function funded() {
    const bill = expense(100);
    const request = claim(bill, 10000);
    const paid = createReimbursement(ctx, request);
    if (!paid.ok) throw new Error(paid.reason);
    const payment = paid.value.payment!;
    const movementId = payment.movements.find((m) => m.amountMinor > 0)!.id;
    const prepared = preparePaymentCorrection(ctx, movementId);
    if (!prepared.ok) throw new Error(prepared.reason);
    return {
      bill,
      payment,
      movementId,
      prepared: prepared.value,
      allocation: prepared.value.allocations[0],
      owedId: request.items[0].owedMovementId,
    };
  }
  const reason = "This allocation covered the wrong purchase";
  function reverse(f: ReturnType<typeof funded>) {
    const result = correctPaymentAllocations(ctx, {
      paymentMovementId: f.movementId,
      removeSettlementIds: [f.allocation.id],
      allocations: [],
      reason,
      expectedVersion: f.prepared.version,
    });
    if (!result.ok) throw new Error(result.reason);
    return result.value;
  }

  it("retains immutable data and metadata while releasing credit and allowing a new pair", () => {
    const f = funded();
    const records = db.select().from(schema.ledgerRecords).all();
    const movements = db.select().from(schema.ledgerMovements).all();
    expect(getRecord(db, f.bill.id)?.outstandingMinor).toBe(0);
    expect(getRecord(db, f.payment.id)?.outstandingMinor).toBe(0);
    const result = reverse(f);
    const retained = db.select().from(schema.settlements).get()!;
    expect(retained).toMatchObject({
      ...f.allocation,
      reversedAt: expect.any(String),
      reversedBy: 1,
      reversalReason: reason,
    });
    expect(getRecord(db, f.bill.id)).toMatchObject({
      outstandingMinor: 10000,
      locked: false,
    });
    expect(getRecord(db, f.payment.id)?.outstandingMinor).toBe(10000);
    expect(getSettlement(db, retained.id)).toBeNull();
    expect(settlementsForRecord(db, f.bill.id)).toEqual([]);
    expect(
      listOutstanding(db, { direction: "we-owe", openOnly: true }).items.find(
        (i) => i.recordId === f.bill.id,
      )?.outstandingMinor,
    ).toBe(10000);
    expect(
      listRecords(db, { paid: false }).records.some((r) => r.id === f.bill.id),
    ).toBe(true);
    const replacement = correctPaymentAllocations(ctx, {
      paymentMovementId: f.movementId,
      removeSettlementIds: [],
      allocations: [{ owedMovementId: f.owedId, amountMinor: 6000 }],
      reason,
      expectedVersion: result.version,
    });
    expect(replacement.ok).toBe(true);
    expect(getRecord(db, f.bill.id)?.outstandingMinor).toBe(4000);
    expect(getRecord(db, f.payment.id)?.outstandingMinor).toBe(4000);
    expect(db.select().from(schema.settlements).all()).toHaveLength(2);
    expect(db.select().from(schema.ledgerRecords).all()).toEqual(records);
    expect(db.select().from(schema.ledgerMovements).all()).toEqual(movements);
    expect(() =>
      db
        .insert(schema.settlements)
        .values({
          paymentMovementId: f.movementId,
          owedMovementId: f.owedId,
          amountMinor: 1,
        })
        .run(),
    ).toThrow();
    const links = recordRelations(db, f.payment.id);
    expect(links.historicalLinks).toHaveLength(1);
    expect(links.historicalLinks[0]).toMatchObject({
      settlementId: retained.id,
      reversedBy: 1,
      reversedByName: "direct",
      reversalReason: reason,
      canUndo: false,
    });
    expect(
      recordRelations(db, f.bill.id).historicalLinks[0].otherRecordId,
    ).toBe(f.payment.id);
    expect(links.reimbursement.allocationHistory).toHaveLength(2);
  });

  it("rolls back reversals, audits and notifications when a replacement fails", () => {
    const f = funded();
    const rows = db.select().from(schema.settlements).all();
    const audits = db.select().from(schema.auditLog).all();
    let emitted = 0;
    const event = () => {
      emitted += 1;
    };
    ledgerEvents.on("settlement-changed", event);
    try {
      const result = correctPaymentAllocations(ctx, {
        paymentMovementId: f.movementId,
        removeSettlementIds: [f.allocation.id],
        allocations: [{ owedMovementId: f.owedId, amountMinor: 10001 }],
        reason,
        expectedVersion: f.prepared.version,
      });
      expect(result.ok).toBe(false);
      expect(db.select().from(schema.settlements).all()).toEqual(rows);
      expect(db.select().from(schema.auditLog).all()).toEqual(audits);
      expect(emitted).toBe(0);
    } finally {
      ledgerEvents.off("settlement-changed", event);
    }
  });

  it("rejects stale, invalid and already-reversed requests without changing history", () => {
    const f = funded();
    const input = {
      paymentMovementId: f.movementId,
      removeSettlementIds: [f.allocation.id],
      allocations: [],
      reason,
      expectedVersion: f.prepared.version,
    };
    expect(
      correctPaymentAllocations(ctx, { ...input, reason: "short" }).ok,
    ).toBe(false);
    expect(
      correctPaymentAllocations(ctx, { ...input, expectedVersion: "stale" }).ok,
    ).toBe(false);
    const result = reverse(f);
    const audits = db.select().from(schema.auditLog).all();
    expect(correctPaymentAllocations(ctx, input).ok).toBe(false);
    expect(
      correctPaymentAllocations(ctx, {
        ...input,
        expectedVersion: result.version,
      }).ok,
    ).toBe(false);
    expect(undoSettlement(db, f.allocation.id, 1, undefined, reason).ok).toBe(
      false,
    );
    expect(db.select().from(schema.auditLog).all()).toEqual(audits);
  });

  it("protects parent deletion separately from ordinary edits and recipient corrections", () => {
    const f = funded();
    reverse(f);
    sqlite.exec("PRAGMA foreign_keys = ON");
    for (const id of [f.bill.id, f.payment.id]) {
      expect(removeRecord(db, id, 1)).toMatchObject({
        ok: false,
        reason: expect.stringContaining("allocation history"),
      });
      expect(() =>
        db
          .delete(schema.ledgerRecords)
          .where(eq(schema.ledgerRecords.id, id))
          .run(),
      ).toThrow();
    }
    expect(() =>
      db
        .delete(schema.ledgerMovements)
        .where(eq(schema.ledgerMovements.id, f.owedId))
        .run(),
    ).toThrow();
    expect(
      patchRecord(db, f.bill.id, 1, { date: "2026-03-02", amount: 110 }).ok,
    ).toBe(true);
    expect(prepareRecordDateCorrection(ctx, f.bill.id)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("ordinary record form"),
    });
    expect(
      getRecord(db, f.bill.id)?.movements.some((m) => m.id === f.owedId),
    ).toBe(true);
    const before = db.select().from(schema.ledgerRecords).all();
    const next = db
      .select()
      .from(schema.ledgerMovements)
      .where(eq(schema.ledgerMovements.recordId, f.bill.id))
      .all()
      .filter((m) => m.id !== f.owedId);
    expect(wouldRemoveAllocationHistory(db, f.bill.id, next)).toBe(true);
    expect(() =>
      updateRecord(db, f.bill.id, 1, { description: "Must not persist" }, next),
    ).toThrow("allocation history");
    expect(db.select().from(schema.ledgerRecords).all()).toEqual(before);
    const another = db
      .insert(schema.contacts)
      .values({ legalName: "Correct recipient", entityType: 2 })
      .returning()
      .get()!.id;
    const prepared = prepareRecipientCorrection(ctx, f.payment.id);
    if (!prepared.ok) throw new Error(prepared.reason);
    expect(
      correctPaymentRecipient(ctx, {
        recordId: f.payment.id,
        contactId: another,
        reason,
        expectedVersion: prepared.value.version,
      }).ok,
    ).toBe(true);
    expect(contactBalances(db, "we-owe", another)[0]?.creditsMinor).toBe(10000);
    expect(recordRelations(db, f.bill.id).historicalLinks).toHaveLength(1);
  });

  it("prefers retained history over overlapping old delete audits and keeps audit-only history", () => {
    const f = funded();
    reverse(f);
    recordAudit(db, {
      recordType: "settlement",
      recordId: f.allocation.id,
      userId: 1,
      action: "delete",
      changes: [
        { field: "allocation", before: f.allocation, after: null },
        { field: "reason", before: null, after: "Old duplicate" },
      ],
    });
    expect(recordRelations(db, f.payment.id).historicalLinks).toHaveLength(1);
    expect(
      recordRelations(db, f.payment.id).historicalLinks[0].reversalReason,
    ).toBe(reason);
    // Simulate an allocation physically deleted before this migration.
    db.delete(schema.settlements)
      .where(eq(schema.settlements.id, f.allocation.id))
      .run();
    expect(recordRelations(db, f.bill.id).historicalLinks).toHaveLength(1);
    expect(recordRelations(db, f.bill.id).historicalLinks[0]).toMatchObject({
      reversalReason: "Old duplicate",
      reversedBy: 1,
      canUndo: false,
    });
  });
});
