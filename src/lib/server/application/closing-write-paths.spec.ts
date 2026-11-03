import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  AccountSubType,
  AccountType,
  DefaultAccountPurpose,
  DocumentType,
  ImportState,
  type AccountTypeCode,
  type AccountSubTypeCode,
} from "$lib/enums.js";
import { LEAF_PERMISSIONS } from "$lib/permissions/catalog.js";
import * as schema from "../db/schema.js";
import type { LedgerDb, RecordView } from "../ledger/types.js";
import { localsFor } from "../permissions/test-locals.js";
import { createAccount } from "../services/accounts.js";
import { createInvoice, getInvoice } from "../queries/invoices.js";
import { balanceSheetReport, profitLossReport } from "../queries/reports.js";
import { confirmImportRow } from "../services/import.js";
import { accountEvents, ledgerEvents } from "../ledger/events.js";
import { invoiceEvents, contactEvents } from "../finance/events.js";
import { importEvents } from "../import/events.js";
import { SETTING_KEYS, setSetting } from "../settings.js";
import type { AppContext } from "./context.js";
import { createRecord, settlePayment } from "./records.js";
import { issueInvoice, voidInvoice } from "./sales.js";
import {
  correctRecordDate,
  prepareRecordDateCorrection,
} from "./record-date-correction.js";
import {
  correctExpenseContact,
  prepareExpenseContactCorrection,
} from "./expense-contact-correction.js";
import {
  correctPaymentRecipient,
  prepareRecipientCorrection,
} from "./payment-recipient.js";
import {
  correctReimbursementAmount,
  prepareReimbursementAmountCorrection,
} from "./reimbursement-amount-correction.js";
import { createReimbursement } from "./reimbursements.js";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createServer } from "../mcp/server.js";
import { LocalBlobStore } from "../storage/blob-store.js";

let sqlite: Database;
let db: LedgerDb;
let ctx: AppContext;
let bank: number;
let category: number;
let sales: number;
let receivable: number;
let payable: number;
let supplier: number;
let person: number;
let other: number;
let customer: number;
const roots: string[] = [];
const common = {
  date: "2026-10-15",
  description: "October supplies",
  currency: "MYR",
  exchangeRate: 1,
};
function account(
  name: string,
  type: AccountTypeCode,
  subType?: AccountSubTypeCode,
) {
  const result = createAccount(db, 1, { name, type, subType });
  if (!result.ok) throw new Error(result.reason);
  return result.value.id;
}
function contact(name: string) {
  return db
    .insert(schema.contacts)
    .values({ entityType: 2, legalName: name })
    .returning()
    .get()!.id;
}
function close() {
  setSetting(db, SETTING_KEYS.accountingClosedThrough, "2026-10-31");
}
function bill(date = common.date): RecordView {
  const result = createRecord(ctx, {
    ...common,
    date,
    kind: "expense",
    amount: 50,
    categoryAccountId: category,
    paidFromAccountId: null,
    contactId: supplier,
    supplierContactId: supplier,
    expensePaymentSource: "unpaid",
  });
  if (!result.ok) throw new Error(result.reason);
  return result.value.record;
}
function payment(record: RecordView, date = common.date, amount = 50) {
  const result = createRecord(ctx, {
    ...common,
    date,
    kind: "payment",
    direction: "we-pay",
    amount,
    contactId: supplier,
    paidFromAccountId: bank,
    settlements: [
      {
        owedMovementId: record.movements.find((m) => m.accountId === payable)!
          .id,
        amountMinor: amount * 100,
      },
    ],
  });
  if (!result.ok) throw new Error(result.reason);
  return result.value.record;
}
function invoice(posted = false) {
  const draft = createInvoice(db, 1, {
    contactId: customer,
    issueDate: common.date,
    currency: "MYR",
    exchangeRate: 1,
    lines: [{ description: "October consulting", quantity: 1, unitPrice: 100 }],
  });
  if (!posted) return getInvoice(db, draft.id)!;
  const result = issueInvoice(ctx, draft.id, { incomeAccountId: sales });
  if (!result.ok) throw new Error(result.reason);
  return getInvoice(db, draft.id)!;
}
function snapshot() {
  return {
    records: db.select().from(schema.ledgerRecords).all(),
    movements: db.select().from(schema.ledgerMovements).all(),
    invoices: db.select().from(schema.invoices).all(),
    invoiceLines: db.select().from(schema.invoiceLines).all(),
    sequences: db.select().from(schema.appSequences).all(),
    settlements: db.select().from(schema.settlements).all(),
    reimbursements: db.select().from(schema.reimbursements).all(),
    reimbursementItems: db.select().from(schema.reimbursementItems).all(),
    reimbursementEntries: db.select().from(schema.reimbursementEntries).all(),
    audit: db.select().from(schema.auditLog).all(),
    contacts: db.select().from(schema.contacts).all(),
    queue: db.select().from(schema.importQueue).all(),
    attachments: db.select().from(schema.recordAttachments).all(),
    settings: db.select().from(schema.settings).all(),
  };
}
function expectRefusedWithoutChanges(
  action: () => { ok: boolean; reason?: string },
) {
  const before = snapshot();
  const seen: string[] = [];
  const emitters = [
    [ledgerEvents, "record-update"],
    [ledgerEvents, "record-deleted"],
    [ledgerEvents, "settlement-changed"],
    [accountEvents, "account-update"],
    [invoiceEvents, "invoice-update"],
    [importEvents, "job-update"],
    [contactEvents, "contact-update"],
  ] as const;
  const listeners = emitters.map(([emitter, name]) => {
    const listener = () => seen.push(name);
    emitter.on(name, listener);
    return () => emitter.off(name, listener);
  });
  try {
    const result = action();
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/closed through 2026-10-31/i);
    expect(snapshot()).toEqual(before);
    expect(seen).toEqual([]);
  } finally {
    listeners.forEach((stop) => stop());
  }
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "drizzle" });
  sqlite.exec("PRAGMA foreign_keys = ON");
  db.insert(schema.users)
    .values({
      id: 1,
      email: "closing-paths@test",
      username: "closing-paths",
      passwordHash: "x",
    })
    .run();
  ctx = { db, locals: localsFor(LEAF_PERMISSIONS, { userId: 1 }) };
  setSetting(db, SETTING_KEYS.currencyCode, "MYR");
  bank = account("Bank", AccountType.Asset, AccountSubType.Bank);
  category = account("Supplies", AccountType.Expense);
  sales = account("Sales", AccountType.Revenue);
  receivable = account(
    "Receivable",
    AccountType.Asset,
    AccountSubType.Receivable,
  );
  payable = account(
    "Payable",
    AccountType.Liability,
    AccountSubType.AccountsPayable,
  );
  const opening = account("Opening balance", AccountType.Equity);
  db.insert(schema.accountDefaults)
    .values([
      {
        purpose: DefaultAccountPurpose.Receivable,
        accountId: receivable,
        updatedBy: 1,
      },
      {
        purpose: DefaultAccountPurpose.Payable,
        accountId: payable,
        updatedBy: 1,
      },
      {
        purpose: DefaultAccountPurpose.OpeningBalances,
        accountId: opening,
        updatedBy: 1,
      },
      {
        purpose: DefaultAccountPurpose.SalesRevenue,
        accountId: sales,
        updatedBy: 1,
      },
    ])
    .run();
  supplier = contact("Supplier");
  person = contact("Employee");
  other = contact("Corrected employee");
  customer = contact("Customer");
});
afterEach(() => {
  sqlite.close();
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true }));
});

describe("month closing across alternate accounting write paths", () => {
  it("refuses issue of a closed-date draft without posting, numbering or success events", () => {
    const draft = invoice();
    close();
    expectRefusedWithoutChanges(() =>
      issueInvoice(ctx, draft.id, { incomeAccountId: sales }),
    );
  });
  it.each([false, true])(
    "refuses void of a closed invoice (reissue=%s) and retains its number, link and postings",
    (reissue) => {
      const sent = invoice(true);
      expect(sent.ledgerRecordId).not.toBeNull();
      close();
      expectRefusedWithoutChanges(() => voidInvoice(ctx, sent.id, { reissue }));
      expect(getInvoice(db, sent.id)?.ledgerRecordId).toBe(sent.ledgerRecordId);
    },
  );
  it("refuses closed-date import and rolls back queue claim and new contact without moving its receipt", () => {
    const root = mkdtempSync(join(tmpdir(), "akaun-close-import-"));
    roots.push(root);
    const jobId = "c4138ca8-018a-4c69-8b97-9d4d34b5d6c6";
    const tempFilePath = `import/temp/${jobId}_receipt.pdf`;
    const source = join(root, tempFilePath);
    mkdirSync(dirname(source), { recursive: true });
    writeFileSync(source, "%PDF-1.4 closed-month receipt");
    db.insert(schema.importQueue)
      .values({
        id: jobId,
        createdBy: 1,
        state: ImportState.PendingReview,
        tempFilePath,
        originalFilename: "receipt.pdf",
        documentType: DocumentType.Expense,
        extractedText: "Printer paper",
      })
      .run();
    close();
    expectRefusedWithoutChanges(() =>
      confirmImportRow(
        db,
        {
          jobId,
          uploadedBy: 1,
          tempFilePath,
          extractedText: "Printer paper",
        },
        {
          documentType: DocumentType.Expense,
          description: "Printer paper",
          partyName: "New receipt supplier",
          partyEdited: true,
          date: common.date,
          amount: 12.5,
          currency: "MYR",
          exchangeRate: 1,
          reference: "REC-12",
          category: "",
          categoryAccountId: null,
          remark: "",
          accountId: null,
          sides: { fromAccountId: bank, toAccountId: category },
          matchedContact: null,
        },
        { actingUserId: 1, storageRoot: root },
      ),
    );
    expect(readFileSync(source, "utf8")).toBe("%PDF-1.4 closed-month receipt");
  });
  it.each([
    ["2026-10-15", "2026-11-01"],
    ["2026-11-01", "2026-10-31"],
  ])(
    "refuses a settled-date correction across the closing boundary (%s to %s)",
    (original, corrected) => {
      const expense = bill(original);
      payment(expense, "2026-11-02");
      const preview = prepareRecordDateCorrection(ctx, expense.id);
      if (!preview.ok) throw new Error(preview.reason);
      close();
      expectRefusedWithoutChanges(() =>
        correctRecordDate(ctx, expense.id, {
          date: corrected,
          reason: "Corrected against the original receipt",
          expectedVersion: preview.value.version,
          acknowledgePeriodChange: true,
        }),
      );
    },
  );
  it("refuses closed expense supplier correction with existing payment history intact", () => {
    const expense = bill();
    payment(expense);
    const preview = prepareExpenseContactCorrection(ctx, expense.id);
    if (!preview.ok) throw new Error(preview.reason);
    close();
    expectRefusedWithoutChanges(() =>
      correctExpenseContact(ctx, expense.id, {
        field: "supplier",
        contactId: other,
        reason: "Correct the supplier shown on the receipt",
        expectedVersion: preview.value.version,
      }),
    );
  });
  it("rolls back allocation reversals when a closed reimbursement amount correction is refused", () => {
    const expense = bill();
    const reimbursed = createReimbursement(ctx, {
      contactId: person,
      personallyPaid: true,
      date: common.date,
      description: "Employee reimbursement",
      reference: "",
      remark: "",
      cashMinor: 5000,
      paidFromAccountId: bank,
      credits: [],
      items: [
        {
          owedMovementId: expense.movements.find(
            (m) => m.accountId === payable,
          )!.id,
          amountMinor: 5000,
        },
      ],
    });
    if (!reimbursed.ok || !reimbursed.value.payment)
      throw new Error("Reimbursement fixture failed");
    const id = reimbursed.value.payment.id;
    const preview = prepareReimbursementAmountCorrection(ctx, id);
    if (!preview.ok) throw new Error(preview.reason);
    expect(preview.value.blockedReason).toBeNull();
    close();
    expectRefusedWithoutChanges(() =>
      correctReimbursementAmount(ctx, id, {
        amountMinor: 4500,
        allocations: [
          {
            owedMovementId: preview.value.expenses[0].owedMovementId,
            amountMinor: 4500,
          },
        ],
        reason: "Correct payment to the amount actually transferred",
        expectedVersion: preview.value.version,
      }),
    );
  });
  it("refuses closed outgoing payment recipient correction without changing its allocations", () => {
    const expense = bill();
    const paid = payment(expense);
    const preview = prepareRecipientCorrection(ctx, paid.id);
    if (!preview.ok) throw new Error(preview.reason);
    close();
    expectRefusedWithoutChanges(() =>
      correctPaymentRecipient(ctx, {
        recordId: paid.id,
        contactId: other,
        reason: "Correct the recipient of this outgoing transfer",
        expectedVersion: preview.value.version,
      }),
    );
  });
  it("allows a November payment against an October invoice without changing October financial statements", () => {
    const sent = invoice(true);
    close();
    const reports = {
      pnl: profitLossReport(db, "2026-10-01", "2026-10-31"),
      balance: balanceSheetReport(db, "2026-10-31"),
    };
    const result = createRecord(ctx, {
      ...common,
      date: "2026-11-01",
      description: "November receipt",
      kind: "payment",
      direction: "we-receive",
      amount: 100,
      paidFromAccountId: bank,
      contactId: customer,
      settlements: [
        { owedMovementId: sent.owedMovementId!, amountMinor: 10000 },
      ],
    });
    expect(result.ok).toBe(true);
    expect(getInvoice(db, sent.id)?.paidMinor).toBe(10000);
    expect(profitLossReport(db, "2026-10-01", "2026-10-31")).toEqual(
      reports.pnl,
    );
    expect(balanceSheetReport(db, "2026-10-31")).toEqual(reports.balance);
  });
  it("allows pure allocation of an existing closed payment while preserving every posting", () => {
    const sent = invoice(true);
    const received = createRecord(ctx, {
      ...common,
      kind: "payment",
      direction: "we-receive",
      amount: 100,
      paidFromAccountId: bank,
      contactId: customer,
    });
    if (!received.ok) throw new Error(received.reason);
    const movement = received.value.record.movements.find(
      (m) => m.accountId === receivable,
    )!;
    close();
    const before = {
      records: db.select().from(schema.ledgerRecords).all(),
      movements: db.select().from(schema.ledgerMovements).all(),
    };
    const allocated = settlePayment(ctx, {
      paymentMovementId: movement.id,
      allocations: [
        { owedMovementId: sent.owedMovementId!, amountMinor: 10000 },
      ],
    });
    expect(allocated.ok).toBe(true);
    expect(getInvoice(db, sent.id)?.paidMinor).toBe(10000);
    expect(db.select().from(schema.ledgerRecords).all()).toEqual(
      before.records,
    );
    expect(db.select().from(schema.ledgerMovements).all()).toEqual(
      before.movements,
    );
  });
  it("returns actionable REFUSED errors through MCP create and correction tools without partial writes", async () => {
    const expense = bill();
    payment(expense);
    const preview = prepareRecordDateCorrection(ctx, expense.id);
    if (!preview.ok) throw new Error(preview.reason);
    close();
    const root = mkdtempSync(join(tmpdir(), "akaun-close-mcp-"));
    roots.push(root);
    const server = createServer({
      ...ctx,
      storageRoot: root,
      store: new LocalBlobStore(root),
    });
    const client = new Client({ name: "closing-test", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const before = snapshot();
    const seen: unknown[] = [];
    const listener = (event: unknown) => seen.push(event);
    ledgerEvents.on("record-update", listener);
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      for (const [name, input] of [
        [
          "create_record",
          { ...common, amount: 25, fromAccountId: bank, toAccountId: category },
        ],
        [
          "correct_record_date",
          {
            recordId: expense.id,
            date: "2026-11-01",
            reason: "Corrected against the original receipt",
            expectedVersion: preview.value.version,
            acknowledgePeriodChange: true,
          },
        ],
      ] as const) {
        const response = (await client.callTool({
          name,
          arguments: input,
        })) as {
          isError?: boolean;
          content: { type: string; text?: string }[];
        };
        expect(response.isError).toBe(true);
        const error = JSON.parse(response.content[0].text!).error;
        expect(error.code).toBe("REFUSED");
        expect(error.message).toMatch(/closed through 2026-10-31/i);
      }
      expect(snapshot()).toEqual(before);
      expect(seen).toEqual([]);
    } finally {
      ledgerEvents.off("record-update", listener);
      await client.close();
      await server.close();
    }
  });
});
