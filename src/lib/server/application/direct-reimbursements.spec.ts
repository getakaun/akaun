import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confirmImportRow } from "../services/import.js";
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
