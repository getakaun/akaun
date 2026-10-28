import { searchContactCorrectionContacts } from "./contact-correction-search.js";
import {
  listContacts,
  createContact as createDirectoryContact,
} from "../queries/contacts.js";
import {
  correctExpenseContact,
  prepareExpenseContactCorrection,
} from "./expense-contact-correction.js";
import { ensureReimbursementsPayableAccount } from "../services/account-defaults.js";
import { createSettlements } from "../services/settlements.js";
import { repairPaymentRecipients } from "./repair-payment-recipients.js";
import {
  prepareReimbursementReversal,
  reverseReimbursement,
} from "./reimbursement-reversal.js";
import { listRecords } from "../queries/ledger.js";
import { createLegacyReimbursement as createReimbursement } from "./__fixtures__/legacy-reimbursement.js";
import {
  prepareRecipientCorrection,
  correctPaymentRecipient,
} from "./payment-recipient.js";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { asc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AccountSubType,
  AccountType,
  DefaultAccountPurpose,
  LedgerRecordKind,
  StatementDirection,
} from "$lib/enums.js";
import * as schema from "../db/schema.js";
import {
  accountDefaults,
  auditLog,
  contacts,
  ledgerMovements,
  ledgerRecords,
  recordAttachments,
  settlements,
  users,
} from "../db/schema.js";
import { createAccount } from "../services/accounts.js";
import { ledgerEvents } from "../ledger/events.js";
import { LEAF_PERMISSIONS } from "$lib/permissions/catalog.js";
import { localsFor } from "../permissions/test-locals.js";
import type { LedgerDb } from "../ledger/types.js";
import type { AppContext } from "./context.js";
import {
  correctPaymentAllocations,
  preparePaymentCorrection,
  paymentAllocationSnapshot,
} from "./payment-corrections.js";
import {
  listOutstanding,
  listOutstandingPage,
  contactBalances,
  settledMinorFor,
} from "../queries/settlements.js";
import { createRecord, deleteRecord, updateRecord } from "./records.js";
import { recordVersion, recordVersions } from "./version.js";
import { setSetting, SETTING_KEYS } from "../settings.js";
import { setExtractedText } from "../queries/ledger.js";
import { getRecord } from "../queries/ledger.js";
import {
  correctRecordDate,
  prepareRecordDateCorrection,
} from "./record-date-correction.js";
import { accountTotalsBetween, accountTotalsUpTo } from "../queries/reports.js";
import { runInAuditScope, scopeFromLocals } from "../audit-context.js";

let sqlite: Database;
let db: LedgerDb;
const userId = 1;
let bank: number;
let savings: number;
let fuel: number;
let paper: number;
let payable: number;
let equity: number;
let supplier: number;

function account(name: string, type: number, subType?: number) {
  const result = createAccount(db, userId, {
    name,
    type: type as never,
    subType: subType as never,
  });
  if (!result.ok) throw new Error(result.reason);
  return result.value.id;
}

/** Every permission except the ones `deny` names. */
function ctx(deny: string[] = []): AppContext {
  return {
    db,
    locals: localsFor(
      LEAF_PERMISSIONS.filter((leaf) => !deny.includes(leaf)),
      {
        userId,
      },
    ),
  };
}

const base = {
  date: "2026-03-01",
  description: "Fuel",
  amount: 50,
  currency: "MYR",
  exchangeRate: 1,
};

beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema }) as unknown as LedgerDb;
  migrate(db as never, { migrationsFolder: "drizzle" });
  setSetting(db, SETTING_KEYS.currencyCode, "MYR");
  db.insert(users)
    .values({ email: "u@test", username: "u", passwordHash: "x" })
    .run();
  bank = account("Bank", AccountType.Asset, AccountSubType.Bank);
  savings = account("Savings", AccountType.Asset, AccountSubType.Bank);
  fuel = account("Fuel", AccountType.Expense);
  paper = account("Paper", AccountType.Expense);
  equity = account("Owner capital", AccountType.Equity);
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
  supplier = db
    .insert(contacts)
    .values({ entityType: 2, legalName: "Supplier" })
    .returning({ id: contacts.id })
    .get().id;
});
afterEach(() => sqlite.close());

describe("createRecord", () => {
  it("derives an everyday expense from two accounts", () => {
    const result = createRecord(ctx(), {
      ...base,
      fromAccountId: bank,
      toAccountId: fuel,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.record.movements).toHaveLength(2);
    expect(result.value.version).toBe(
      recordVersion(db, result.value.record.id),
    );
  });

  it("gates a journal sent with an explicit kind on adjustments", () => {
    const journal = {
      ...base,
      kind: "journal" as const,
      movements: [
        { accountId: bank, amountMinor: -5000 },
        { accountId: equity, amountMinor: 5000 },
      ],
    };
    const refused = createRecord(ctx(["records.adjust"]), journal);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("FORBIDDEN");
    expect(db.select().from(ledgerRecords).all()).toHaveLength(0);
    expect(createRecord(ctx(), journal).ok).toBe(true);
  });

  it("gates two money pots with a third side, but not a split bill", () => {
    const noAdjust = ctx(["records.adjust"]);
    const split = createRecord(noAdjust, {
      ...base,
      fromAccountId: bank,
      toAccountId: fuel,
      extraSides: [{ accountId: paper, amountMinor: 1000 }],
      categoryAmountMinor: 4000,
    });
    expect(split.ok).toBe(true);
    const rearrange = createRecord(noAdjust, {
      ...base,
      fromAccountId: bank,
      toAccountId: fuel,
      extraSides: [{ accountId: savings, amountMinor: 1000 }],
      categoryAmountMinor: 4000,
    });
    expect(rearrange.ok).toBe(false);
  });

  it("refuses an opening balance or invoice posting through this door", () => {
    const result = createRecord(ctx(), {
      ...base,
      kind: "opening-balance",
      accountId: bank,
    });
    expect(result.ok).toBe(false);
  });

  it("keeps a payment and its settlements together or not at all", () => {
    const bill = createRecord(ctx(), {
      ...base,
      kind: "expense",
      categoryAccountId: fuel,
      paidFromAccountId: null,
      contactId: supplier,
    });
    if (!bill.ok) throw new Error(bill.reason);
    const owed = bill.value.record.movements.find(
      (m) => m.accountId === payable,
    )!;

    let events = 0;
    const listener = () => events++;
    ledgerEvents.on("record-update", listener);
    try {
      const tooMuch = createRecord(ctx(), {
        ...base,
        kind: "payment",
        paidFromAccountId: bank,
        contactId: supplier,
        direction: "we-pay",
        settlements: [{ owedMovementId: owed.id, amountMinor: 999_999 }],
      });
      expect(tooMuch.ok).toBe(false);
      expect(db.select().from(ledgerRecords).all()).toHaveLength(1);
      expect(events).toBe(0);

      const paid = createRecord(ctx(), {
        ...base,
        kind: "payment",
        paidFromAccountId: bank,
        contactId: supplier,
        direction: "we-pay",
        settlements: [{ owedMovementId: owed.id, amountMinor: 5000 }],
      });
      expect(paid.ok).toBe(true);
      expect(db.select().from(settlements).all()).toHaveLength(1);
      expect(events).toBeGreaterThan(0);
    } finally {
      ledgerEvents.off("record-update", listener);
    }
  });

  it("stores nothing and emits nothing on a dry run", () => {
    const auditBefore = db.select().from(auditLog).all().length;
    let events = 0;
    const listener = () => events++;
    ledgerEvents.on("record-update", listener);
    try {
      const result = createRecord(
        ctx(),
        { ...base, fromAccountId: bank, toAccountId: fuel },
        { dryRun: true },
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.record.movements).toHaveLength(2);
    } finally {
      ledgerEvents.off("record-update", listener);
    }
    expect(events).toBe(0);
    expect(db.select().from(ledgerRecords).all()).toHaveLength(0);
    expect(db.select().from(auditLog).all()).toHaveLength(auditBefore);
  });
});

describe("updateRecord", () => {
  function expense() {
    const result = createRecord(ctx(), {
      ...base,
      fromAccountId: bank,
      toAccountId: fuel,
    });
    if (!result.ok) throw new Error(result.reason);
    return result.value;
  }

  it("refuses a stale version and leaves the record as it was", () => {
    const written = expense();
    const first = updateRecord(
      ctx(),
      written.record.id,
      { description: "Diesel" },
      written.version,
    );
    expect(first.ok).toBe(true);
    const stale = updateRecord(
      ctx(),
      written.record.id,
      { description: "Petrol" },
      written.version,
    );
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.code).toBe("CONFLICT");
      expect(stale.currentVersion).toBe(recordVersion(db, written.record.id));
    }
  });

  it("gates extra lines restated without both accounts", () => {
    const written = expense();
    const refused = updateRecord(ctx(["records.adjust"]), written.record.id, {
      extraSides: [{ accountId: savings, amountMinor: 1000 }],
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("FORBIDDEN");

    const everyday = updateRecord(ctx(["records.adjust"]), written.record.id, {
      extraSides: [{ accountId: paper, amountMinor: 1000 }],
    });
    expect(everyday.ok).toBe(true);
  });

  it("checks records:change and records:delete", () => {
    const written = expense();
    const change = updateRecord(ctx(["records.update"]), written.record.id, {
      description: "x",
    });
    expect(change.ok).toBe(false);
    const remove = deleteRecord(ctx(["records.delete"]), written.record.id);
    expect(remove.ok).toBe(false);
    if (!remove.ok) expect(remove.code).toBe("FORBIDDEN");
    expect(deleteRecord(ctx(), written.record.id).ok).toBe(true);
  });
});

describe("the adjustments gate on kinds and single accounts", () => {
  const noAdjust = () => ctx(["records.adjust"]);

  it("refuses an explicit expense paid from equity, or a payment out of a category", () => {
    const expense = createRecord(noAdjust(), {
      ...base,
      kind: "expense",
      categoryAccountId: fuel,
      paidFromAccountId: equity,
    });
    expect(expense.ok).toBe(false);
    if (!expense.ok) expect(expense.code).toBe("FORBIDDEN");
    const payment = createRecord(noAdjust(), {
      ...base,
      kind: "payment",
      paidFromAccountId: fuel,
      contactId: supplier,
      direction: "we-pay",
      settlements: [],
    });
    expect(payment.ok).toBe(false);
    const transfer = createRecord(noAdjust(), {
      ...base,
      kind: "transfer",
      fromAccountId: bank,
      toAccountId: savings,
    });
    expect(transfer.ok).toBe(true);
    expect(db.select().from(ledgerRecords).all()).toHaveLength(1);
  });

  it("refuses an explicit transfer the two accounts would not make", () => {
    const sales = account("Sales", AccountType.Revenue);
    // Revenue into the bank derives income, and equity into it derives a
    // journal: filed as a "transfer", either is an adjustment.
    for (const fromAccountId of [sales, equity]) {
      const transfer = createRecord(noAdjust(), {
        ...base,
        kind: "transfer",
        fromAccountId,
        toAccountId: bank,
      });
      expect(transfer.ok).toBe(false);
      if (!transfer.ok) expect(transfer.code).toBe("FORBIDDEN");
    }
    expect(db.select().from(ledgerRecords).all()).toHaveLength(0);
  });

  it("refuses moving one side of an expense onto equity without the ability", () => {
    const written = createRecord(ctx(), {
      ...base,
      fromAccountId: bank,
      toAccountId: fuel,
    });
    if (!written.ok) throw new Error(written.reason);
    const id = written.value.record.id;
    const onEquity = updateRecord(noAdjust(), id, {
      categoryAccountId: equity,
    });
    expect(onEquity.ok).toBe(false);
    if (!onEquity.ok) expect(onEquity.code).toBe("FORBIDDEN");
    const paidFromCategory = updateRecord(noAdjust(), id, {
      paidFromAccountId: paper,
    });
    expect(paidFromCategory.ok).toBe(false);
    expect(updateRecord(noAdjust(), id, { categoryAccountId: paper }).ok).toBe(
      true,
    );
    expect(updateRecord(ctx(), id, { categoryAccountId: equity }).ok).toBe(
      true,
    );
  });

  it("keeps a record's version when only its search text is rewritten", () => {
    const written = createRecord(ctx(), {
      ...base,
      fromAccountId: bank,
      toAccountId: fuel,
    });
    if (!written.ok) throw new Error(written.reason);
    setExtractedText(db, written.value.record.id, "OCR text");
    expect(recordVersion(db, written.value.record.id)).toBe(
      written.value.version,
    );
  });
});

describe("record versions read in bulk", () => {
  /** The per-record hash as it was before the batch existed, kept verbatim. */
  function oneByOne(id: number): string {
    const found = db
      .select()
      .from(ledgerRecords)
      .where(eq(ledgerRecords.id, id))
      .get();
    if (!found) return "absent";
    const { extractedText: _searchText, ...row } = found;
    void _searchText;
    const movements = db
      .select({
        id: ledgerMovements.id,
        accountId: ledgerMovements.accountId,
        amountMinor: ledgerMovements.amountMinor,
        label: ledgerMovements.label,
      })
      .from(ledgerMovements)
      .where(eq(ledgerMovements.recordId, id))
      .orderBy(asc(ledgerMovements.id))
      .all();
    const attachments = db
      .select({ id: recordAttachments.id })
      .from(recordAttachments)
      .where(eq(recordAttachments.recordId, id))
      .orderBy(asc(recordAttachments.id))
      .all();
    return createHash("sha256")
      .update(JSON.stringify([row, movements, attachments]))
      .digest("hex")
      .slice(0, 16);
  }

  it("gives each record the version a single read gives, unchanged from before", () => {
    const ids = [fuel, paper].map((to) => {
      const written = createRecord(ctx(), {
        ...base,
        fromAccountId: bank,
        toAccountId: to,
      });
      if (!written.ok) throw new Error(written.reason);
      return written.value.record.id;
    });
    db.insert(recordAttachments)
      .values([
        { recordId: ids[0], filename: "a.pdf", displayName: "a.pdf" },
        { recordId: ids[0], filename: "b.pdf", displayName: "b.pdf" },
      ])
      .run();

    const batch = recordVersions(db, [...ids, 99_999]);
    for (const id of ids) {
      expect(batch[id]).toBe(recordVersion(db, id));
      expect(batch[id]).toBe(oneByOne(id));
    }
    expect(batch[99_999]).toBe("absent");
    expect(batch[ids[0]]).not.toBe(batch[ids[1]]);
    expect(recordVersions(db, [])).toEqual({});
  });
});

describe("controlled settled date correction", () => {
  function settled(income = false, allocation = 5000, foreign = false) {
    const revenue = income ? account("Sales", AccountType.Revenue) : fuel;
    const receivable = db
      .select()
      .from(accountDefaults)
      .where(eq(accountDefaults.purpose, DefaultAccountPurpose.Receivable))
      .get()!.accountId;
    const written = createRecord(ctx(), {
      ...base,
      currency: foreign ? "USD" : "MYR",
      exchangeRate: foreign ? 4 : 1,
      fromAccountId: income ? revenue : payable,
      toAccountId: income ? receivable : fuel,
      contactId: supplier,
    });
    if (!written.ok) throw new Error(written.reason);
    const owed = written.value.record.movements.find(
      (m) => m.accountId === (income ? receivable : payable),
    )!;
    const payment = createRecord(ctx(), {
      ...base,
      date: "2026-03-15",
      amount: allocation / 100,
      kind: "payment",
      direction: income ? "we-receive" : "we-pay",
      paidFromAccountId: bank,
      contactId: supplier,
      settlements: [{ owedMovementId: owed.id, amountMinor: allocation }],
    });
    if (!payment.ok) throw new Error(payment.reason);
    return { id: written.value.record.id, paymentId: payment.value.record.id };
  }

  function input(id: number, date = "2026-02-28") {
    return {
      date,
      reason: "Corrected against original receipt",
      expectedVersion: recordVersion(db, id),
      acknowledgePeriodChange: true,
    };
  }

  it.each([
    [false, 5000],
    [false, 2000],
    [true, 5000],
    [true, 2000],
  ])(
    "corrects expense/income (income=%s, allocated=%s) without touching money or payments",
    (income, allocation) => {
      const { id, paymentId } = settled(income, allocation);
      const before = getRecord(db, id)!;
      const payment = getRecord(db, paymentId)!;
      const allocations = db.select().from(settlements).all();
      const allTime = accountTotalsUpTo(db, "2099-12-31");
      const oldVersion = recordVersion(db, id);
      const result = correctRecordDate(ctx(), id, input(id));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.record.date).toBe("2026-02-28");
      expect(result.value.version).not.toBe(oldVersion);
      expect(result.value.version).toBe(recordVersion(db, id));
      expect(result.value.record.movements).toEqual(before.movements);
      expect(result.value.record.paid).toBe(before.paid);
      expect(result.value.record.outstandingMinor).toBe(
        before.outstandingMinor,
      );
      expect(result.value.record.locked).toBe(true);
      expect(getRecord(db, paymentId)).toEqual(payment);
      expect(db.select().from(settlements).all()).toEqual(allocations);
      expect(accountTotalsUpTo(db, "2099-12-31")).toEqual(allTime);
      const posted = income
        ? before.movements.find((m) => m.amountMinor < 0)!
        : before.movements.find((m) => m.accountId === fuel)!;
      expect(
        accountTotalsBetween(db, "2026-02-01", "2026-02-28").find(
          (a) => a.accountId === posted.accountId,
        )!.amountMinor,
      ).toBe(posted.amountMinor);
      expect(
        accountTotalsBetween(db, "2026-03-01", "2026-03-31").find(
          (a) => a.accountId === posted.accountId,
        )!.amountMinor,
      ).toBe(0);
    },
  );

  it("preserves foreign currency, exchange rate and stored amounts", () => {
    const { id } = settled(false, 10000, true);
    const before = getRecord(db, id)!;
    expect(correctRecordDate(ctx(), id, input(id)).ok).toBe(true);
    const after = getRecord(db, id)!;
    expect([
      after.currency,
      after.exchangeRate,
      after.amount,
      after.amountMinor,
      after.movements,
    ]).toEqual([
      before.currency,
      before.exchangeRate,
      before.amount,
      before.amountMinor,
      before.movements,
    ]);
  });

  it("requires all permissions and authentication", () => {
    const { id } = settled();
    for (const denied of [
      "records.correctDate",
      "records.update",
      "records.read",
    ]) {
      expect(correctRecordDate(ctx([denied]), id, input(id))).toMatchObject({
        ok: false,
        code: "FORBIDDEN",
      });
    }
    const anonymous = ctx();
    anonymous.locals.user = null;
    expect(correctRecordDate(anonymous, id, input(id))).toMatchObject({
      code: "FORBIDDEN",
    });
    expect(updateRecord(ctx(), id, { date: "2026-02-28" })).toMatchObject({
      ok: false,
      code: "REFUSED",
    });
    expect(getRecord(db, id)!.date).toBe(base.date);
  });

  it.each(["pat", "oauth"] as const)(
    "allows an authorized %s correction",
    (kind) => {
      const { id } = settled();
      const context = ctx();
      context.locals.credential =
        kind === "pat"
          ? { kind, tokenId: 1 }
          : { kind, grantId: "g", clientId: "c" };
      expect(prepareRecordDateCorrection(context, id).ok).toBe(true);
      expect(correctRecordDate(context, id, input(id)).ok).toBe(true);
      expect(getRecord(db, id)!.date).toBe("2026-02-28");
    },
  );

  it.each([
    { date: "2026-02-30" },
    { date: "2026-3-2" },
    { date: base.date },
    { reason: "short" },
    { reason: "          " },
    { reason: "x".repeat(501) },
    { expectedVersion: undefined },
    { expectedVersion: "" },
    { acknowledgePeriodChange: undefined },
    { acknowledgePeriodChange: false },
    { amount: 99 },
    { exchangeRate: 2 },
  ])("rejects invalid or incomplete requests: %j", (patch) => {
    const { id } = settled();
    const before = db.select().from(auditLog).all();
    expect(
      correctRecordDate(ctx(), id, { ...input(id), ...patch }),
    ).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(getRecord(db, id)!.date).toBe(base.date);
    expect(db.select().from(auditLog).all()).toEqual(before);
  });

  it("allows same-month corrections without the period acknowledgement, and requires it across years", () => {
    const { id } = settled();
    expect(
      correctRecordDate(ctx(), id, {
        ...input(id, "2026-03-02"),
        acknowledgePeriodChange: false,
      }).ok,
    ).toBe(true);
    expect(
      correctRecordDate(ctx(), id, {
        ...input(id, "2025-12-31"),
        acknowledgePeriodChange: false,
      }),
    ).toMatchObject({ code: "INVALID_INPUT" });
    expect(correctRecordDate(ctx(), id, input(id, "2025-12-31")).ok).toBe(true);
  });

  it("requires a fresh version and a new reasoned correction for a subsequent change", () => {
    const { id } = settled();
    const request = input(id);
    expect(prepareRecordDateCorrection(ctx(), id)).toMatchObject({
      ok: true,
      value: { version: request.expectedVersion },
    });
    expect(correctRecordDate(ctx(), id, request).ok).toBe(true);
    expect(correctRecordDate(ctx(), id, request)).toMatchObject({
      code: "CONFLICT",
    });
    expect(correctRecordDate(ctx(), id, input(id, base.date)).ok).toBe(true);
  });

  it("refuses payment, invoice and unsettled records", () => {
    const { id, paymentId } = settled();
    expect(correctRecordDate(ctx(), paymentId, input(paymentId))).toMatchObject(
      { code: "REFUSED" },
    );
    db.update(ledgerRecords)
      .set({ kind: LedgerRecordKind.InvoiceIssue })
      .where(eq(ledgerRecords.id, id))
      .run();
    expect(correctRecordDate(ctx(), id, input(id))).toMatchObject({
      code: "REFUSED",
    });
    const ordinary = createRecord(ctx(), {
      ...base,
      fromAccountId: bank,
      toAccountId: fuel,
    });
    if (!ordinary.ok) throw new Error(ordinary.reason);
    expect(
      correctRecordDate(
        ctx(),
        ordinary.value.record.id,
        input(ordinary.value.record.id),
      ),
    ).toMatchObject({ code: "REFUSED" });
    expect(correctRecordDate(ctx(), 999999, input(id))).toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("rechecks new partial bank matches even when the version is unchanged", () => {
    const { id } = settled();
    const request = input(id);
    const statement = db
      .insert(schema.bankStatements)
      .values({
        originalFilename: "test.pdf",
        storedFilePath: "test.pdf",
        accountId: payable,
      })
      .returning()
      .get();
    const line = db
      .insert(schema.bankStatementLines)
      .values({
        statementId: statement.id,
        date: base.date,
        amount: 50,
        direction: StatementDirection.Out,
      })
      .returning()
      .get();
    const movement = getRecord(db, id)!.movements.find(
      (m) => m.accountId === payable,
    )!;
    db.insert(schema.reconciliationAllocations)
      .values({
        lineId: line.id,
        movementId: movement.id,
        amount: 1,
        itemAmountSnapshot: 50,
      })
      .run();
    expect(recordVersion(db, id)).toBe(request.expectedVersion);
    expect(getRecord(db, id)!.cleared).toBe(false);
    expect(correctRecordDate(ctx(), id, request)).toMatchObject({
      code: "REFUSED",
      reason: expect.stringContaining("Unmatch"),
    });
  });

  it("rechecks settlement removal even when the version is unchanged", () => {
    const { id } = settled();
    const request = input(id);
    db.delete(settlements).run();
    expect(recordVersion(db, id)).toBe(request.expectedVersion);
    expect(correctRecordDate(ctx(), id, request)).toMatchObject({
      code: "REFUSED",
    });
  });

  it("records one audit entry and emits the corrected record after commit", () => {
    const { id } = settled();
    const before = db.select().from(auditLog).all().length;
    const seen: string[] = [];
    const listener = ({ record }: { record: { id: number; date: string } }) => {
      if (record.id === id) {
        expect(sqlite.inTransaction).toBe(false);
        seen.push(record.date);
      }
    };
    ledgerEvents.on("record-update", listener);
    try {
      const context = ctx();
      const scope = scopeFromLocals(
        context.locals,
        "POST /api/records/1/date-correction",
      );
      expect(
        runInAuditScope(scope, () =>
          correctRecordDate(context, id, {
            ...input(id),
            reason: "  Original receipt has February date  ",
          }),
        ).ok,
      ).toBe(true);
      const entries = db.select().from(auditLog).all();
      expect(entries).toHaveLength(before + 1);
      const entry = entries.at(-1)!;
      expect(entry).toMatchObject({
        recordType: "record",
        recordId: String(id),
        userId,
        via: "session",
      });
      expect(JSON.parse(entry.changes!)).toEqual([
        { field: "date", before: base.date, after: "2026-02-28" },
        {
          field: "dateCorrectionReason",
          before: null,
          after: "Original receipt has February date",
        },
      ]);
      expect(seen).toEqual(["2026-02-28"]);
    } finally {
      ledgerEvents.off("record-update", listener);
    }
  });

  it("rolls back the date and emits nothing if audit insertion fails", () => {
    const { id } = settled();
    const request = input(id);
    const before = getRecord(db, id);
    sqlite.exec(
      "CREATE TRIGGER reject_correction_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END",
    );
    let events = 0;
    const listener = () => events++;
    ledgerEvents.on("record-update", listener);
    try {
      expect(() => correctRecordDate(ctx(), id, request)).toThrow(
        "audit unavailable",
      );
      expect(getRecord(db, id)).toEqual(before);
      expect(recordVersion(db, id)).toBe(request.expectedVersion);
      expect(events).toBe(0);
    } finally {
      ledgerEvents.off("record-update", listener);
    }
  });
});

describe("payment correction and overpayment recovery", () => {
  function written(input: Parameters<typeof createRecord>[1]) {
    const result = createRecord(ctx(), input);
    if (!result.ok) throw new Error(result.reason);
    return result.value.record;
  }
  function bill(amount: number, contactId = supplier) {
    return written({
      ...base,
      kind: "expense",
      amount,
      paidFromAccountId: null,
      categoryAccountId: fuel,
      contactId,
    });
  }
  function side(record: ReturnType<typeof written>, accountId = payable) {
    return record.movements.find((m) => m.accountId === accountId)!.id;
  }
  function payment(
    amount: number,
    allocations: { owedMovementId: number; amountMinor: number }[] = [],
  ) {
    return written({
      ...base,
      kind: "payment",
      date: "2026-04-02",
      amount,
      direction: "we-pay",
      paidFromAccountId: bank,
      contactId: supplier,
      settlements: allocations,
    });
  }
  function request(paymentMovementId: number, removeSettlementIds: number[]) {
    return {
      paymentMovementId,
      removeSettlementIds,
      allocations: [],
      reason: "Company already paid this bill directly.",
      expectedVersion: paymentAllocationSnapshot(ctx(), paymentMovementId)!
        .version,
    };
  }
  function matchBank(record: ReturnType<typeof written>, amount: number) {
    const statement = db
      .insert(schema.bankStatements)
      .values({
        originalFilename: "fixture.pdf",
        storedFilePath: "fixture.pdf",
        accountId: bank,
      })
      .returning()
      .get();
    const line = db
      .insert(schema.bankStatementLines)
      .values({
        statementId: statement.id,
        date: record.date,
        amount,
        direction: StatementDirection.Out,
      })
      .returning()
      .get();
    db.insert(schema.reconciliationAllocations)
      .values({
        lineId: line.id,
        movementId: side(record, bank),
        amount,
        itemAmountSnapshot: amount,
      })
      .run();
  }

  it("corrects the RM28 case preserving eight legacy allocations, cash and attachments", () => {
    const amounts = [9857, 2800, 13800, 10000, 2450, 484, 700, 438, 17765];
    const bills = amounts.map((n) => bill(n / 100));
    const reimbursement = payment(
      582.94,
      bills.map((b, i) => ({
        owedMovementId: side(b),
        amountMinor: amounts[i],
      })),
    );
    // Fixture reproduces the historical cross-contact relationships found in the books.
    const easyParcel = db
      .insert(contacts)
      .values({ entityType: 2, legalName: "EasyParcel" })
      .returning()
      .get().id;
    db.update(ledgerRecords)
      .set({ contactId: easyParcel })
      .where(eq(ledgerRecords.id, bills[1].id))
      .run();
    db.update(ledgerRecords)
      .set({ contactId: easyParcel })
      .where(eq(ledgerRecords.id, bills[8].id))
      .run();
    db.insert(recordAttachments)
      .values({
        recordId: reimbursement.id,
        filename: "fixture.pdf",
        displayName: "Reimbursement receipt",
        addedDate: base.date,
      })
      .run();
    matchBank(reimbursement, 582.94);
    const beforeMovements = db
      .select()
      .from(ledgerMovements)
      .where(eq(ledgerMovements.recordId, reimbursement.id))
      .all();
    const beforeMatches = db
      .select()
      .from(schema.reconciliationAllocations)
      .all();
    const original = db.select().from(settlements).all();
    const mistaken = original.find((a) => a.owedMovementId === side(bills[1]))!;
    const corrected = correctPaymentAllocations(
      ctx(),
      request(side(reimbursement), [mistaken.id]),
    );
    expect(corrected).toMatchObject({
      ok: true,
      value: { undoneIds: [mistaken.id] },
    });
    const retained = db.select().from(settlements).all();
    expect(retained.filter((a) => a.reversedAt === null)).toEqual(
      original.filter((a) => a.id !== mistaken.id),
    );
    expect(retained.find((a) => a.id === mistaken.id)).toMatchObject({
      ...mistaken,
      reversedAt: expect.any(String),
      reversedBy: 1,
      reversalReason: "Company already paid this bill directly.",
    });
    expect(
      db
        .select()
        .from(ledgerMovements)
        .where(eq(ledgerMovements.recordId, reimbursement.id))
        .all(),
    ).toEqual(beforeMovements);
    expect(db.select().from(schema.reconciliationAllocations).all()).toEqual(
      beforeMatches,
    );
    expect(getRecord(db, reimbursement.id)).toMatchObject({
      amount: 582.94,
      outstandingMinor: 2800,
      attachmentCount: 1,
      cleared: true,
    });
    const direct = written({
      ...base,
      kind: "payment",
      date: "2026-02-23",
      amount: 28,
      direction: "we-pay",
      paidFromAccountId: bank,
      contactId: easyParcel,
      settlements: [{ owedMovementId: side(bills[1]), amountMinor: 2800 }],
    });
    matchBank(direct, 28);
    expect(getRecord(db, bills[1].id)).toMatchObject({
      amount: 28,
      paid: true,
    });
    expect(getRecord(db, direct.id)).toMatchObject({ cleared: true });
    expect(contactBalances(db, "we-owe", supplier)).toMatchObject([
      { outstandingMinor: -2800, obligationsMinor: 0, creditsMinor: 2800 },
    ]);
    const audits = db
      .select()
      .from(auditLog)
      .where(eq(auditLog.recordId, String(reimbursement.id)))
      .all();
    expect(
      audits.some(
        (a) =>
          a.changes?.includes("correctionReason") &&
          a.changes.includes("allocations"),
      ),
    ).toBe(true);
  });

  it("applies RM28 explicitly to a RM100 claim and records only RM72 cash", () => {
    const credit = payment(28);
    const claim = bill(100);
    const result = written({
      ...base,
      kind: "payment",
      amount: 72,
      direction: "we-pay",
      paidFromAccountId: bank,
      contactId: supplier,
      creditApplications: [
        {
          paymentMovementId: side(credit),
          owedMovementId: side(claim),
          amountMinor: 2800,
        },
      ],
      settlements: [{ owedMovementId: side(claim), amountMinor: 7200 }],
    });
    expect(
      result.movements.find((m) => m.accountId === bank)?.amountMinor,
    ).toBe(-7200);
    expect(getRecord(db, claim.id)).toMatchObject({ amount: 100, paid: true });
    expect(getRecord(db, credit.id)?.outstandingMinor).toBe(0);
  });

  it("settles a smaller claim entirely with credit, leaving RM8 and no cash posting", () => {
    const credit = payment(28);
    const claim = bill(20);
    const before = db.select().from(ledgerRecords).all().length;
    const result = written({
      ...base,
      kind: "payment",
      amount: 0,
      direction: "we-pay",
      paidFromAccountId: bank,
      contactId: supplier,
      creditApplications: [
        {
          paymentMovementId: side(credit),
          owedMovementId: side(claim),
          amountMinor: 2000,
        },
      ],
      settlements: [],
    });
    expect(result.id).toBe(claim.id);
    expect(db.select().from(ledgerRecords).all()).toHaveLength(before);
    expect(getRecord(db, claim.id)?.paid).toBe(true);
    expect(getRecord(db, credit.id)?.outstandingMinor).toBe(800);
  });

  it("rolls back credit application when the cash allocation fails, emitting nothing", () => {
    const credit = payment(28);
    const claim = bill(100);
    const before = db.select().from(settlements).all();
    let count = 0;
    const listener = () => count++;
    ledgerEvents.on("settlement-changed", listener);
    try {
      const result = createRecord(ctx(), {
        ...base,
        kind: "payment",
        amount: 72,
        direction: "we-pay",
        paidFromAccountId: bank,
        contactId: supplier,
        creditApplications: [
          {
            paymentMovementId: side(credit),
            owedMovementId: side(claim),
            amountMinor: 2800,
          },
        ],
        settlements: [{ owedMovementId: side(claim), amountMinor: 7300 }],
      });
      expect(result.ok).toBe(false);
      expect(db.select().from(settlements).all()).toEqual(before);
      expect(count).toBe(0);
    } finally {
      ledgerEvents.off("settlement-changed", listener);
    }
  });

  it("keeps signed net totals and gross credits consistent across pages", () => {
    bill(100);
    payment(28);
    const first = listOutstandingPage(
      db,
      { direction: "we-owe", contactId: supplier },
      { limit: 1, offset: 0 },
    );
    const second = listOutstandingPage(
      db,
      { direction: "we-owe", contactId: supplier },
      { limit: 1, offset: 1 },
    );
    expect(first).toMatchObject({
      totalOutstandingMinor: 7200,
      totalObligationsMinor: 10000,
      totalCreditsMinor: 2800,
      total: 2,
    });
    expect(second.totalOutstandingMinor).toBe(first.totalOutstandingMinor);
    expect(second.items[0]).toMatchObject({
      position: "credit",
      signedAmountMinor: 2800,
      daysOverdue: 0,
    });
    expect(
      listOutstanding(db, { direction: "we-owe" }).totalOutstandingMinor,
    ).toBe(7200);
    expect(
      accountTotalsUpTo(db, "2026-12-31").find((a) => a.accountId === payable)
        ?.amountMinor,
    ).toBe(-7200);
  });

  it("records partial refunds against payable credit without affecting expenses", () => {
    const credit = payment(28);
    const refund = written({
      ...base,
      kind: "payment",
      amount: 10,
      direction: "refund-received",
      paidFromAccountId: bank,
      contactId: supplier,
      settlements: [{ owedMovementId: side(credit), amountMinor: 1000 }],
    });
    expect(
      refund.movements.find((m) => m.accountId === bank)?.amountMinor,
    ).toBe(1000);
    expect(getRecord(db, credit.id)?.outstandingMinor).toBe(1800);
    expect(contactBalances(db, "we-owe", supplier)[0].outstandingMinor).toBe(
      -1800,
    );
    expect(refund.movements.every((m) => m.accountId !== fuel)).toBe(true);
    expect(
      createRecord(ctx(), {
        ...base,
        kind: "payment",
        amount: 30,
        direction: "refund-received",
        paidFromAccountId: bank,
        contactId: supplier,
        settlements: [{ owedMovementId: side(credit), amountMinor: 3000 }],
      }).ok,
    ).toBe(false);
  });

  it("refunds customer credits on receivable and can apply them to later income", () => {
    const receivable = db
      .select()
      .from(accountDefaults)
      .where(eq(accountDefaults.purpose, DefaultAccountPurpose.Receivable))
      .get()!.accountId;
    const received = written({
      ...base,
      kind: "payment",
      amount: 28,
      direction: "we-receive",
      paidFromAccountId: bank,
      contactId: supplier,
    });
    expect(
      contactBalances(db, "owed-to-us", supplier)[0].outstandingMinor,
    ).toBe(-2800);
    const refund = written({
      ...base,
      kind: "payment",
      amount: 10,
      direction: "refund-paid",
      paidFromAccountId: bank,
      contactId: supplier,
      settlements: [
        { owedMovementId: side(received, receivable), amountMinor: 1000 },
      ],
    });
    expect(
      refund.movements.find((m) => m.accountId === bank)?.amountMinor,
    ).toBe(-1000);
    const revenue = account("Sales", AccountType.Revenue);
    const invoice = written({
      ...base,
      kind: "income",
      amount: 18,
      categoryAccountId: revenue,
      receivedIntoAccountId: receivable,
      contactId: supplier,
    });
    const covered = written({
      ...base,
      kind: "payment",
      amount: 0,
      direction: "we-receive",
      paidFromAccountId: bank,
      contactId: supplier,
      creditApplications: [
        {
          paymentMovementId: side(received, receivable),
          owedMovementId: side(invoice, receivable),
          amountMinor: 1800,
        },
      ],
    });
    expect(covered.id).toBe(invoice.id);
    expect(getRecord(db, invoice.id)?.paid).toBe(true);
    expect(getRecord(db, received.id)?.outstandingMinor).toBe(0);
  });

  it("keeps credit-only dry runs free of settlements and events", () => {
    const credit = payment(28);
    const claim = bill(28);
    const result = createRecord(
      ctx(),
      {
        ...base,
        kind: "payment",
        amount: 0,
        direction: "we-pay",
        paidFromAccountId: bank,
        contactId: supplier,
        creditApplications: [
          {
            paymentMovementId: side(credit),
            owedMovementId: side(claim),
            amountMinor: 2800,
          },
        ],
      },
      { dryRun: true },
    );
    expect(result.ok).toBe(true);
    expect(db.select().from(settlements).all()).toHaveLength(0);
    expect(getRecord(db, claim.id)?.paid).toBe(false);
  });

  it("reallocates only selected amounts and leaves unrelated allocations untouched", () => {
    const first = bill(30);
    const keep = bill(20);
    const replacement = bill(30);
    const pay = payment(50, [
      { owedMovementId: side(first), amountMinor: 3000 },
      { owedMovementId: side(keep), amountMinor: 2000 },
    ]);
    const before = paymentAllocationSnapshot(ctx(), side(pay))!;
    const remove = before.allocations.find(
      (a) => a.owedMovementId === side(first),
    )!;
    const kept = before.allocations.find(
      (a) => a.owedMovementId === side(keep),
    )!;
    expect(
      correctPaymentAllocations(ctx(), {
        ...request(side(pay), [remove.id]),
        allocations: [{ owedMovementId: side(replacement), amountMinor: 3000 }],
      }).ok,
    ).toBe(true);
    expect(
      db.select().from(settlements).where(eq(settlements.id, kept.id)).get(),
    ).toEqual(kept);
    expect(getRecord(db, first.id)?.paid).toBe(false);
    expect(getRecord(db, replacement.id)?.paid).toBe(true);
  });

  it("rolls back a correction when the audit write fails", () => {
    const claim = bill(28);
    const pay = payment(28, [
      { owedMovementId: side(claim), amountMinor: 2800 },
    ]);
    const before = paymentAllocationSnapshot(ctx(), side(pay))!;
    sqlite.exec(
      "CREATE TRIGGER reject_allocation_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END",
    );
    let count = 0;
    const listener = () => count++;
    ledgerEvents.on("settlement-changed", listener);
    try {
      expect(() =>
        correctPaymentAllocations(
          ctx(),
          request(side(pay), [before.allocations[0].id]),
        ),
      ).toThrow("audit unavailable");
      expect(paymentAllocationSnapshot(ctx(), side(pay))).toEqual(before);
      expect(count).toBe(0);
    } finally {
      ledgerEvents.off("settlement-changed", listener);
    }
  });

  it("refuses wrong contacts and directions, incomplete refunds and credit over-allocation", () => {
    const credit = payment(28);
    const other = db
      .insert(contacts)
      .values({ entityType: 2, legalName: "Other" })
      .returning()
      .get().id;
    const claim = bill(100, other);
    expect(
      createRecord(ctx(), {
        ...base,
        kind: "payment",
        amount: 0,
        direction: "we-pay",
        paidFromAccountId: bank,
        contactId: other,
        creditApplications: [
          {
            paymentMovementId: side(credit),
            owedMovementId: side(claim),
            amountMinor: 2800,
          },
        ],
      }).ok,
    ).toBe(false);
    expect(
      createRecord(ctx(), {
        ...base,
        kind: "payment",
        amount: 28,
        direction: "refund-received",
        paidFromAccountId: bank,
        contactId: supplier,
      }).ok,
    ).toBe(false);
    expect(
      createRecord(ctx(), {
        ...base,
        kind: "payment",
        amount: 0,
        direction: "we-receive",
        paidFromAccountId: bank,
        contactId: supplier,
        creditApplications: [
          {
            paymentMovementId: side(credit),
            owedMovementId: side(claim),
            amountMinor: 2800,
          },
        ],
      }).ok,
    ).toBe(false);
  });

  it("rejects stale corrections, wrong settlement ids and missing reasons", () => {
    const claim = bill(100);
    const pay = payment(100, [
      { owedMovementId: side(claim), amountMinor: 10000 },
    ]);
    const snapshot = paymentAllocationSnapshot(ctx(), side(pay))!;
    const input = request(side(pay), [snapshot.allocations[0].id]);
    expect(
      correctPaymentAllocations(ctx(), { ...input, reason: "short" }),
    ).toMatchObject({ code: "INVALID_INPUT" });
    expect(
      correctPaymentAllocations(ctx(), { ...input, expectedVersion: "" }),
    ).toMatchObject({ code: "INVALID_INPUT" });
    expect(
      correctPaymentAllocations(ctx(), {
        ...input,
        removeSettlementIds: [999999],
      }),
    ).toMatchObject({ code: "REFUSED" });
    expect(correctPaymentAllocations(ctx(), input).ok).toBe(true);
    expect(correctPaymentAllocations(ctx(), input)).toMatchObject({
      code: "CONFLICT",
    });
  });

  it("requires correction permissions and refuses contact changes with active allocations", () => {
    const claim = bill(100);
    const pay = payment(100, [
      { owedMovementId: side(claim), amountMinor: 10000 },
    ]);
    const input = request(side(pay), [
      paymentAllocationSnapshot(ctx(), side(pay))!.allocations[0].id,
    ]);
    const other = db
      .insert(contacts)
      .values({ entityType: 2, legalName: "Other" })
      .returning()
      .get().id;
    expect(updateRecord(ctx(), claim.id, { contactId: other })).toMatchObject({
      code: "REFUSED",
    });
    expect(
      correctPaymentAllocations(
        ctx(["records.delete", "records.correctAllocations"]),
        input,
      ),
    ).toMatchObject({ code: "FORBIDDEN" });
    expect(
      preparePaymentCorrection(ctx(["records.read"]), side(pay)),
    ).toMatchObject({ code: "FORBIDDEN" });
    expect(correctPaymentAllocations(ctx(), input).ok).toBe(true);
    expect(updateRecord(ctx(), claim.id, { contactId: other }).ok).toBe(true);
  });

  it("rolls correction back when replacements fail, preserving allocations and events", () => {
    const claim = bill(100);
    const pay = payment(100, [
      { owedMovementId: side(claim), amountMinor: 10000 },
    ]);
    const before = paymentAllocationSnapshot(ctx(), side(pay))!;
    let count = 0;
    const listener = () => count++;
    ledgerEvents.on("settlement-changed", listener);
    try {
      const result = correctPaymentAllocations(ctx(), {
        ...request(side(pay), [before.allocations[0].id]),
        allocations: [{ owedMovementId: side(claim), amountMinor: 10001 }],
      });
      expect(result.ok).toBe(false);
      expect(paymentAllocationSnapshot(ctx(), side(pay))).toEqual(before);
      expect(count).toBe(0);
    } finally {
      ledgerEvents.off("settlement-changed", listener);
    }
  });

  it("reverses every allocation of a contactless batch together", () => {
    const first = bill(30);
    const second = bill(20);
    const batch = written({
      ...base,
      kind: "payment",
      amount: 50,
      direction: "we-pay",
      paidFromAccountId: bank,
      contactId: supplier,
      settlements: [
        { owedMovementId: side(first), amountMinor: 3000 },
        { owedMovementId: side(second), amountMinor: 2000 },
      ],
    });
    db.update(ledgerRecords)
      .set({ contactId: null })
      .where(eq(ledgerRecords.id, batch.id))
      .run();
    const before = paymentAllocationSnapshot(ctx(), side(batch))!;
    const result = correctPaymentAllocations(
      ctx(),
      request(side(batch), [before.allocations[0].id]),
    );
    expect(result).toMatchObject({
      ok: true,
      value: { undoneIds: before.allocations.map((a) => a.id) },
    });
    expect(settledMinorFor(db, [side(first), side(second)]).size).toBe(0);
  });
});

describe("single-recipient reimbursements", () => {
  function expense(amount = 28) {
    const result = createRecord(ctx(), {
      ...base,
      kind: "expense",
      amount,
      categoryAccountId: fuel,
      paidFromAccountId: null,
      contactId: supplier,
    });
    if (!result.ok) throw new Error(result.reason);
    return result.value.record;
  }
  function person(name = "Employee") {
    return db
      .insert(contacts)
      .values({ entityType: 2, legalName: name })
      .returning()
      .get()!.id;
  }
  function claim(
    recipient: number,
    bill: ReturnType<typeof expense>,
    cashMinor = 2800,
  ) {
    return {
      contactId: recipient,
      personallyPaid: true as const,
      date: base.date,
      description: "Employee reimbursement",
      reference: "",
      remark: "",
      items: [
        {
          owedMovementId: bill.movements.find((m) => m.accountId === payable)!
            .id,
          amountMinor: 2800,
        },
      ],
      cashMinor,
      paidFromAccountId: bank,
      credits: [],
    };
  }
  it("preserves suppliers and balances clearing with a partially paid recipient payable", () => {
    const bill = expense();
    const recipient = person();
    const result = createReimbursement(
      ctx(["records.adjust"]),
      claim(recipient, bill, 1000),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(getRecord(db, bill.id)!.contactId).toBe(supplier);
    expect(getRecord(db, bill.id)!.outstandingMinor).toBe(0);
    expect(result.value.payment!.contactId).toBe(recipient);
    expect(result.value.payable.contactId).toBe(recipient);
    expect(result.value.remainingMinor).toBe(1800);
    expect(result.value.payable.outstandingMinor).toBe(1800);
    const entries = db.select().from(schema.reimbursementEntries).all();
    expect(
      getRecord(
        db,
        entries.find((entry) => entry.role === "recipient")!.recordId,
      )!.description,
    ).toBe("Reimbursement summary: Employee reimbursement");
    expect(
      getRecord(
        db,
        entries.find((entry) => entry.role === "supplier")!.recordId,
      )!.description,
    ).toBe("Included expenses: Employee reimbursement");
    const sides = db
      .select()
      .from(ledgerMovements)
      .where(
        inArray(
          ledgerMovements.recordId,
          entries.map((e) => e.recordId),
        ),
      )
      .all();
    const clearing = sides.filter((m) => m.accountId !== payable);
    expect(clearing.reduce((n, m) => n + m.amountMinor, 0)).toBe(0);
    expect(
      accountTotalsUpTo(db, "2099-01-01").find((a) => a.accountId === fuel)
        ?.amountMinor,
    ).toBe(2800);
  });
  it("rejects absent acknowledgement, duplicate claims and excess cash atomically", () => {
    const bill = expense();
    const recipient = person();
    const input = claim(recipient, bill);
    const before = db.select().from(ledgerRecords).all().length;
    expect(
      createReimbursement(ctx(), { ...input, personallyPaid: false } as never)
        .ok,
    ).toBe(false);
    expect(
      createReimbursement(ctx(), {
        ...input,
        items: [...input.items, ...input.items],
      }).ok,
    ).toBe(false);
    expect(createReimbursement(ctx(), { ...input, cashMinor: 2801 }).ok).toBe(
      false,
    );
    expect(db.select().from(ledgerRecords).all()).toHaveLength(before);
    expect(db.select().from(schema.reimbursements).all()).toHaveLength(0);
  });
  it("applies only recipient credits and allows credit-only claims", () => {
    const bill = expense();
    const recipient = person();
    const credit = createRecord(ctx(), {
      ...base,
      kind: "payment",
      direction: "we-pay",
      amount: 28,
      contactId: recipient,
      paidFromAccountId: bank,
    });
    if (!credit.ok) throw new Error(credit.reason);
    const creditId = credit.value.record.movements.find(
      (m) => m.accountId === payable,
    )!.id;
    const result = createReimbursement(ctx(), {
      ...claim(recipient, bill, 0),
      credits: [{ paymentMovementId: creditId, amountMinor: 2800 }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.payment).toBeNull();
    expect(result.value.remainingMinor).toBe(0);
    expect(createReimbursement(ctx(), claim(recipient, bill)).ok).toBe(false);
  });
  it("rolls back generated entries when credit belongs to another person", () => {
    const bill = expense();
    const recipient = person();
    const credit = createRecord(ctx(), {
      ...base,
      kind: "payment",
      direction: "we-pay",
      amount: 28,
      contactId: supplier,
      paidFromAccountId: bank,
    });
    if (!credit.ok) throw new Error(credit.reason);
    const before = db.select().from(ledgerRecords).all().length;
    const result = createReimbursement(ctx(), {
      ...claim(recipient, bill, 0),
      credits: [
        {
          paymentMovementId: credit.value.record.movements.find(
            (m) => m.accountId === payable,
          )!.id,
          amountMinor: 2800,
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(db.select().from(ledgerRecords).all()).toHaveLength(before);
    expect(db.select().from(schema.reimbursements).all()).toHaveLength(0);
    expect(getRecord(db, bill.id)!.outstandingMinor).toBe(2800);
  });
  it("corrects completed reimbursement recipients without replacing cash movements", () => {
    const bill = expense();
    const recipient = person();
    const corrected = person("Correct recipient");
    const claimResult = createReimbursement(ctx(), claim(recipient, bill));
    if (!claimResult.ok) throw new Error(claimResult.reason);
    const payment = claimResult.value.payment!;
    const preview = prepareRecipientCorrection(ctx(), payment.id);
    if (!preview.ok) throw new Error(preview.reason);
    const result = correctPaymentRecipient(ctx(), {
      recordId: payment.id,
      contactId: corrected,
      reason: "Recipient was selected incorrectly",
      expectedVersion: preview.value.version,
    });
    expect(result.ok).toBe(true);
    expect(getRecord(db, payment.id)!.movements).toEqual(payment.movements);
    expect(getRecord(db, payment.id)!.contactId).toBe(corrected);
    expect(getRecord(db, claimResult.value.payable.id)!.contactId).toBe(
      corrected,
    );
    expect(getRecord(db, bill.id)!.contactId).toBe(supplier);
    expect(
      correctPaymentRecipient(ctx(), {
        recordId: payment.id,
        contactId: recipient,
        reason: "Old preview must be refused",
        expectedVersion: preview.value.version,
      }).ok,
    ).toBe(false);
  });

  for (const scenario of [
    { label: "full cash", cash: 2800, credit: 0 },
    { label: "partial cash", cash: 1000, credit: 0 },
    { label: "mixed funding", cash: 1800, credit: 1000 },
    { label: "credit only", cash: 0, credit: 2800 },
  ]) {
    it(`previews all expenses and actual credit released for ${scenario.label}`, () => {
      const bill = expense();
      const recipient = person();
      const advance = createRecord(ctx(), {
        ...base,
        kind: "payment",
        direction: "we-pay",
        amount: 50,
        contactId: recipient,
        paidFromAccountId: bank,
      });
      if (!advance.ok) throw new Error(advance.reason);
      const advanceSide = advance.value.record.movements.find(
        (m) => m.accountId === payable,
      )!;
      const result = createReimbursement(ctx(), {
        ...claim(recipient, bill, scenario.cash),
        credits: scenario.credit
          ? [
              {
                paymentMovementId: advanceSide.id,
                amountMinor: scenario.credit,
              },
            ]
          : [],
      });
      if (!result.ok) throw new Error(result.reason);
      const preview = prepareReimbursementReversal(ctx(), result.value.groupId);
      if (!preview.ok) throw new Error(preview.reason);
      expect(preview.value.summary.amountMinor).toBe(2800);
      expect(preview.value.summary.items).toEqual([
        { recordId: bill.id, description: bill.description, amountMinor: 2800 },
      ]);
      expect(preview.value.summary.unfundedMinor).toBe(
        2800 - scenario.cash - scenario.credit,
      );
      expect(
        preview.value.summary.funding.reduce(
          (sum, p) => sum + p.releasedMinor,
          0,
        ),
      ).toBe(scenario.cash + scenario.credit);
      if (scenario.credit)
        expect(
          preview.value.summary.funding.find(
            (p) => p.recordId === advance.value.record.id,
          ),
        ).toMatchObject({
          releasedMinor: scenario.credit,
          availableCreditBeforeMinor: 5000 - scenario.credit,
          availableCreditAfterMinor: 5000,
        });
      const reversed = reverseReimbursement(ctx(), {
        groupId: result.value.groupId,
        date: base.date,
        reason: "Correct the whole reimbursement",
        expectedVersion: preview.value.version,
      });
      expect(reversed.ok).toBe(true);
      for (const payment of preview.value.summary.funding) {
        expect(getRecord(db, payment.recordId)!.outstandingMinor).toBe(
          payment.availableCreditAfterMinor,
        );
      }
      expect(getRecord(db, bill.id)!.outstandingMinor).toBe(2800);
    });
  }

  it("rejects a reversal preview after its funding credit is used elsewhere", () => {
    const recipient = person();
    const advance = createRecord(ctx(), {
      ...base,
      kind: "payment",
      direction: "we-pay",
      amount: 50,
      contactId: recipient,
      paidFromAccountId: bank,
    });
    if (!advance.ok) throw new Error(advance.reason);
    const advanceSide = advance.value.record.movements.find(
      (m) => m.accountId === payable,
    )!;
    const result = createReimbursement(ctx(), {
      ...claim(recipient, expense(), 1800),
      credits: [{ paymentMovementId: advanceSide.id, amountMinor: 1000 }],
    });
    if (!result.ok) throw new Error(result.reason);
    const preview = prepareReimbursementReversal(ctx(), result.value.groupId);
    if (!preview.ok) throw new Error(preview.reason);
    const otherBill = createRecord(ctx(), {
      ...base,
      kind: "expense",
      amount: 5,
      contactId: recipient,
      categoryAccountId: fuel,
      paidFromAccountId: null,
    });
    if (!otherBill.ok) throw new Error(otherBill.reason);
    const allocated = createSettlements(db, userId, advanceSide.id, [
      {
        owedMovementId: otherBill.value.record.movements.find(
          (m) => m.accountId === payable,
        )!.id,
        amountMinor: 500,
      },
    ]);
    expect(allocated.ok).toBe(true);
    const reversed = reverseReimbursement(ctx(), {
      groupId: result.value.groupId,
      date: base.date,
      reason: "Correct the whole reimbursement",
      expectedVersion: preview.value.version,
    });
    expect(reversed.ok).toBe(false);
    if (!reversed.ok) expect(reversed.code).toBe("CONFLICT");
    expect(
      db.select().from(schema.reimbursements).get()!.reversedAt,
    ).toBeNull();
  });

  it("reverses the complete reimbursement with contra entries while retaining cash", () => {
    const bill = expense();
    const recipient = person();
    const result = createReimbursement(ctx(), claim(recipient, bill));
    if (!result.ok) throw new Error(result.reason);
    const preview = prepareReimbursementReversal(ctx(), result.value.groupId);
    if (!preview.ok) throw new Error(preview.reason);
    const payment = getRecord(db, result.value.payment!.id)!;
    const reversed = reverseReimbursement(ctx(), {
      groupId: result.value.groupId,
      date: "2026-10-21",
      reason: "One expense was paid by the company",
      expectedVersion: preview.value.version,
    });
    expect(reversed.ok).toBe(true);
    if (reversed.ok) {
      for (const id of reversed.value.reversalIds)
        expect(getRecord(db, id)!.description).toBe(
          "Full reimbursement reversal: Employee reimbursement",
        );
    }
    expect(getRecord(db, bill.id)!.outstandingMinor).toBe(2800);
    expect(getRecord(db, payment.id)!.movements).toEqual(payment.movements);
    expect(getRecord(db, payment.id)!.outstandingMinor).toBe(2800);
    expect(getRecord(db, result.value.payable.id)!.outstandingMinor).toBe(0);
    const list = listRecords(db, {});
    expect(list.records.map((r) => r.id)).toEqual(
      expect.arrayContaining([bill.id, payment.id]),
    );
    expect(list.records.some((r) => r.id === result.value.payable.id)).toBe(
      false,
    );
  });
  it("repairs legacy contactless and cross-contact payments once and preserves valid allocations", () => {
    const first = expense();
    const second = expense();
    const recipient = person();
    const own = createRecord(ctx(), {
      ...base,
      kind: "expense",
      amount: 10,
      categoryAccountId: paper,
      paidFromAccountId: null,
      contactId: recipient,
    });
    if (!own.ok) throw new Error(own.reason);
    const pay = createRecord(ctx(), {
      ...base,
      kind: "payment",
      direction: "we-pay",
      amount: 10,
      contactId: recipient,
      paidFromAccountId: bank,
      settlements: [
        {
          owedMovementId: own.value.record.movements.find(
            (m) => m.accountId === payable,
          )!.id,
          amountMinor: 1000,
        },
      ],
    });
    if (!pay.ok) throw new Error(pay.reason);
    const legacy = createRecord(ctx(), {
      ...base,
      kind: "payment",
      direction: "we-pay",
      amount: 56,
      contactId: supplier,
      paidFromAccountId: bank,
      settlements: [first, second].map((b) => ({
        owedMovementId: b.movements.find((m) => m.accountId === payable)!.id,
        amountMinor: 2800,
      })),
    });
    if (!legacy.ok) throw new Error(legacy.reason);
    db.update(ledgerRecords)
      .set({ contactId: null })
      .where(eq(ledgerRecords.id, legacy.value.record.id))
      .run();
    const untouched = db
      .select()
      .from(settlements)
      .where(
        eq(
          settlements.paymentMovementId,
          pay.value.record.movements.find((m) => m.accountId === payable)!.id,
        ),
      )
      .all();
    const previews = [pay.value.record, legacy.value.record].map((p) => {
      const preview = prepareRecipientCorrection(ctx(), p.id);
      if (!preview.ok) throw new Error(preview.reason);
      return { recordId: p.id, expectedVersion: preview.value.version };
    });
    const manifest = { recipientId: recipient, payments: previews };
    expect(repairPaymentRecipients(ctx(), manifest).ok).toBe(true);
    const recordCount = db.select().from(ledgerRecords).all().length;
    expect(repairPaymentRecipients(ctx(), manifest)).toMatchObject({
      ok: true,
      value: { alreadyApplied: true },
    });
    expect(db.select().from(ledgerRecords).all()).toHaveLength(recordCount);
    expect(getRecord(db, legacy.value.record.id)!.contactId).toBe(recipient);
    expect(getRecord(db, legacy.value.record.id)!.movements).toEqual(
      legacy.value.record.movements,
    );
    expect(getRecord(db, first.id)!.contactId).toBe(supplier);
    expect(
      db
        .select()
        .from(settlements)
        .where(
          eq(
            settlements.paymentMovementId,
            pay.value.record.movements.find((m) => m.accountId === payable)!.id,
          ),
        )
        .all(),
    ).toEqual(untouched);
  });
  it("blocks recipient correction after its credit funds a later reimbursement", () => {
    const bill = expense();
    const recipient = person();
    const credit = createRecord(ctx(), {
      ...base,
      kind: "payment",
      direction: "we-pay",
      amount: 28,
      contactId: recipient,
      paidFromAccountId: bank,
    });
    if (!credit.ok) throw new Error(credit.reason);
    const applied = createReimbursement(ctx(), {
      ...claim(recipient, bill, 0),
      credits: [
        {
          paymentMovementId: credit.value.record.movements.find(
            (m) => m.accountId === payable,
          )!.id,
          amountMinor: 2800,
        },
      ],
    });
    if (!applied.ok) throw new Error(applied.reason);
    const preview = prepareRecipientCorrection(ctx(), credit.value.record.id);
    if (!preview.ok) throw new Error(preview.reason);
    expect(preview.value.dependencies).toHaveLength(1);
    const corrected = correctPaymentRecipient(ctx(), {
      recordId: credit.value.record.id,
      contactId: supplier,
      reason: "Attempt to change a consumed credit",
      expectedVersion: preview.value.version,
    });
    expect(corrected.ok).toBe(false);
    expect(getRecord(db, credit.value.record.id)!.contactId).toBe(recipient);
    const movementId = credit.value.record.movements.find(
      (m) => m.accountId === payable,
    )!.id;
    const funding = paymentAllocationSnapshot(ctx(), movementId)!;
    expect(
      correctPaymentAllocations(ctx(), {
        paymentMovementId: movementId,
        removeSettlementIds: funding.allocations.map((a) => a.id),
        allocations: [],
        reason: "Release the credit before correcting its recipient",
        expectedVersion: funding.version,
      }).ok,
    ).toBe(true);
    const refreshed = prepareRecipientCorrection(ctx(), credit.value.record.id);
    if (!refreshed.ok) throw new Error(refreshed.reason);
    expect(refreshed.value.dependencies).toEqual([]);
    expect(
      correctPaymentRecipient(ctx(), {
        recordId: credit.value.record.id,
        contactId: supplier,
        reason: "Correct the recipient after releasing the credit",
        expectedVersion: refreshed.value.version,
      }).ok,
    ).toBe(true);
    // The released allocation remains history and must not be reversed a second time.
    const group = prepareReimbursementReversal(ctx(), applied.value.groupId);
    if (!group.ok) throw new Error(group.reason);
    expect(
      reverseReimbursement(ctx(), {
        groupId: applied.value.groupId,
        date: base.date,
        reason: "Reverse the original unfunded reimbursement",
        expectedVersion: group.value.version,
      }).ok,
    ).toBe(true);
  });
  it("rolls back the whole repair on a stale manifest", () => {
    const bill = expense();
    const recipient = person();
    const result = createReimbursement(ctx(), claim(recipient, bill));
    if (!result.ok) throw new Error(result.reason);
    const payment = result.value.payment!;
    const before = db.select().from(ledgerRecords).all();
    expect(
      repairPaymentRecipients(ctx(), {
        recipientId: supplier,
        payments: [{ recordId: payment.id, expectedVersion: "stale" }],
      }).ok,
    ).toBe(false);
    expect(db.select().from(ledgerRecords).all()).toEqual(before);
  });

  it("rolls back all earlier repairs when a later audit write fails", () => {
    const recipient = person();
    const payments = [expense(), expense()].map((bill) => {
      const result = createRecord(ctx(), {
        ...base,
        kind: "payment",
        direction: "we-pay",
        amount: 28,
        contactId: supplier,
        paidFromAccountId: bank,
        settlements: [
          {
            owedMovementId: bill.movements.find((m) => m.accountId === payable)!
              .id,
            amountMinor: 2800,
          },
        ],
      });
      if (!result.ok) throw new Error(result.reason);
      return result.value.record;
    });
    const before = {
      records: db.select().from(ledgerRecords).all(),
      movements: db.select().from(ledgerMovements).all(),
      allocations: db.select().from(settlements).all(),
    };
    const manifest = {
      recipientId: recipient,
      payments: payments.map((p) => {
        const preview = prepareRecipientCorrection(ctx(), p.id);
        if (!preview.ok) throw new Error(preview.reason);
        return { recordId: p.id, expectedVersion: preview.value.version };
      }),
    };
    sqlite.exec(
      `CREATE TRIGGER fail_second_repair BEFORE INSERT ON audit_log WHEN NEW.record_type = 'record' AND NEW.record_id = '${payments[1].id}' AND NEW.action = 'update' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`,
    );
    expect(() => repairPaymentRecipients(ctx(), manifest)).toThrow(
      "audit unavailable",
    );
    expect(db.select().from(ledgerRecords).all()).toEqual(before.records);
    expect(db.select().from(ledgerMovements).all()).toEqual(before.movements);
    expect(db.select().from(settlements).all()).toEqual(before.allocations);
    expect(db.select().from(schema.reimbursements).all()).toHaveLength(0);
  });
  it("refuses new payments without a single payee", () => {
    expect(
      createRecord(ctx(), {
        ...base,
        kind: "payment",
        direction: "we-pay",
        contactId: null,
        paidFromAccountId: bank,
        settlements: [],
      }).ok,
    ).toBe(false);
  });
});

describe("controlled expense contact correction", () => {
  function contact(name = "Correct supplier") {
    return db
      .insert(contacts)
      .values({ entityType: 2, legalName: name })
      .returning()
      .get().id;
  }
  function bill(personal = false, company = false) {
    if (personal) {
      const configured = ensureReimbursementsPayableAccount(db, userId);
      if (!configured.ok) throw new Error(configured.reason);
    }
    const result = createRecord(ctx(), {
      ...base,
      kind: "expense",
      categoryAccountId: fuel,
      paidFromAccountId: company ? bank : null,
      contactId: supplier,
      supplierContactId: supplier,
      expensePaymentSource: personal
        ? "personal"
        : company
          ? "company"
          : "unpaid",
    });
    if (!result.ok) throw new Error(result.reason);
    return result.value.record;
  }
  function prepared(id: number) {
    const result = prepareExpenseContactCorrection(ctx(), id);
    if (!result.ok) throw new Error(result.reason);
    return result.value;
  }
  function request(
    id: number,
    contactId: number,
    field: "supplier" | "paidBy" = "supplier",
  ) {
    return {
      field,
      contactId,
      reason: "Mislabeled contact on original receipt",
      expectedVersion: prepared(id).version,
    };
  }
  function pay(record: ReturnType<typeof bill>, amount = 20, payee = supplier) {
    const owed = record.movements.find((m) => m.amountMinor < 0)!;
    const result = createRecord(ctx(), {
      ...base,
      kind: "payment",
      direction: "we-pay",
      paidFromAccountId: bank,
      settlementAccountId: owed.accountId,
      amount,
      contactId: payee,
      settlements: [{ owedMovementId: owed.id, amountMinor: amount * 100 }],
    });
    if (!result.ok) throw new Error(result.reason);
    return result.value.record;
  }

  it.each([20, 50])(
    "preserves payment history and moves only the remaining balance for %s paid",
    (amount) => {
      const expense = bill();
      const payment = pay(expense, amount);
      const before = getRecord(db, expense.id)!;
      const allocations = db.select().from(settlements).all();
      const movements = db.select().from(ledgerMovements).all();
      const totals = accountTotalsUpTo(db, "2099-12-31");
      const next = contact();
      const result = correctExpenseContact(
        ctx(),
        expense.id,
        request(expense.id, next),
      );
      expect(result.ok).toBe(true);
      const after = getRecord(db, expense.id)!;
      expect(after).toMatchObject({
        contactId: next,
        supplierContactId: next,
        paid: before.paid,
        outstandingMinor: before.outstandingMinor,
        date: before.date,
        amount: before.amount,
      });
      expect(db.select().from(ledgerMovements).all()).toEqual(movements);
      expect(db.select().from(settlements).all()).toEqual(allocations);
      expect(getRecord(db, payment.id)).toEqual(payment);
      expect(accountTotalsUpTo(db, "2099-12-31")).toEqual(totals);
      expect(contactBalances(db, "we-owe", supplier)).toEqual([]);
      expect(
        contactBalances(db, "we-owe", next).reduce(
          (sum, c) => sum + c.outstandingMinor,
          0,
        ),
      ).toBe(5000 - amount * 100);
      const audit = db.select().from(auditLog).all().at(-1)!;
      expect(audit.changes).toContain("contactCorrectionReason");
    },
  );

  it("corrects a personally paid supplier without changing reimbursement ownership", () => {
    const configured = ensureReimbursementsPayableAccount(db, userId);
    if (!configured.ok) throw new Error(configured.reason);
    const expense = bill(true);
    pay(expense);
    const before = getRecord(db, expense.id)!;
    const allocations = db.select().from(settlements).all();
    const next = contact();
    expect(
      correctExpenseContact(ctx(), expense.id, request(expense.id, next)).ok,
    ).toBe(true);
    expect(getRecord(db, expense.id)).toMatchObject({
      contactId: supplier,
      supplierContactId: next,
      outstandingMinor: before.outstandingMinor,
    });
    expect(db.select().from(settlements).all()).toEqual(allocations);
    expect(
      correctExpenseContact(
        ctx(),
        expense.id,
        request(expense.id, next, "paidBy"),
      ),
    ).toMatchObject({ ok: false, code: "REFUSED" });
    expect(getRecord(db, expense.id)!.contactId).toBe(supplier);
  });

  it("corrects an unallocated personal payer without rebuilding movements", () => {
    const expense = bill(true);
    const next = contact("Correct person");
    expect(
      correctExpenseContact(
        ctx(),
        expense.id,
        request(expense.id, next, "paidBy"),
      ).ok,
    ).toBe(true);
    const after = getRecord(db, expense.id)!;
    expect(after.contactId).toBe(next);
    expect(after.supplierContactId).toBe(supplier);
    expect(after.movements).toEqual(expense.movements);
  });

  it("requires an explicit permission for preview and write; ordinary patches cannot bypass it", () => {
    const expense = bill();
    pay(expense);
    const next = contact();
    const input = request(expense.id, next);
    for (const denied of [
      "records.correctContact",
      "records.read",
      "records.update",
    ]) {
      expect(
        prepareExpenseContactCorrection(ctx([denied]), expense.id),
      ).toMatchObject({ code: "FORBIDDEN" });
      expect(
        correctExpenseContact(ctx([denied]), expense.id, input),
      ).toMatchObject({ code: "FORBIDDEN" });
    }
    expect(updateRecord(ctx(), expense.id, { contactId: next })).toMatchObject({
      code: "REFUSED",
    });
    expect(
      updateRecord(ctx(), expense.id, { supplierContactId: next }),
    ).toMatchObject({ code: "REFUSED" });
    expect(getRecord(db, expense.id)!.contactId).toBe(supplier);
  });

  it("detects allocation changes even when the record version is unchanged", () => {
    const expense = bill();
    const next = contact();
    const input = request(expense.id, next);
    const version = recordVersion(db, expense.id);
    pay(expense);
    expect(recordVersion(db, expense.id)).toBe(version);
    const audit = db.select().from(auditLog).all();
    expect(correctExpenseContact(ctx(), expense.id, input)).toMatchObject({
      code: "CONFLICT",
    });
    expect(getRecord(db, expense.id)!.contactId).toBe(supplier);
    expect(db.select().from(auditLog).all()).toEqual(audit);
  });

  it.each([
    { reason: "short" },
    { expectedVersion: "" },
    { contactId: null },
    { contactId: 0 },
    { amount: 10 },
    { field: "contactId" },
  ])("rejects invalid inputs without writing: %j", (patch) => {
    const expense = bill();
    const input = { ...request(expense.id, contact()), ...patch };
    const audit = db.select().from(auditLog).all();
    expect(correctExpenseContact(ctx(), expense.id, input)).toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(db.select().from(auditLog).all()).toEqual(audit);
  });

  it("rejects unchanged and missing contacts and non-expense records", () => {
    const expense = bill();
    expect(
      correctExpenseContact(ctx(), expense.id, request(expense.id, supplier)),
    ).toMatchObject({ code: "INVALID_INPUT" });
    expect(
      correctExpenseContact(ctx(), expense.id, request(expense.id, 999999)),
    ).toMatchObject({ code: "REFUSED" });
    const payment = pay(expense);
    expect(prepareExpenseContactCorrection(ctx(), payment.id)).toMatchObject({
      code: "REFUSED",
    });
  });

  it("preserves a company-paid expense bank match and rejects ordinary contact edits", () => {
    const expense = bill(false, true);
    const statement = db
      .insert(schema.bankStatements)
      .values({
        originalFilename: "fixture.pdf",
        storedFilePath: "fixture.pdf",
        accountId: bank,
      })
      .returning()
      .get();
    const line = db
      .insert(schema.bankStatementLines)
      .values({
        statementId: statement.id,
        date: base.date,
        amount: 50,
        direction: StatementDirection.Out,
      })
      .returning()
      .get();
    db.insert(schema.reconciliationAllocations)
      .values({
        lineId: line.id,
        movementId: expense.movements.find((m) => m.accountId === bank)!.id,
        amount: 50,
        itemAmountSnapshot: 50,
      })
      .run();
    const matches = db.select().from(schema.reconciliationAllocations).all();
    const next = contact();
    expect(updateRecord(ctx(), expense.id, { contactId: next })).toMatchObject({
      code: "REFUSED",
    });
    expect(
      correctExpenseContact(ctx(), expense.id, request(expense.id, next)).ok,
    ).toBe(true);
    expect(db.select().from(schema.reconciliationAllocations).all()).toEqual(
      matches,
    );
    const after = getRecord(db, expense.id)!;
    expect(after.reconciled).toBe(true);
    expect(after.movements).toEqual(expense.movements);
    expect(after.supplierContactId).toBe(next);
  });

  it("rolls back the contact if auditing fails", () => {
    const expense = bill();
    pay(expense);
    const input = request(expense.id, contact());
    const before = getRecord(db, expense.id)!;
    sqlite.exec(
      "CREATE TRIGGER reject_contact_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit failed'); END",
    );
    expect(() => correctExpenseContact(ctx(), expense.id, input)).toThrow(
      "audit failed",
    );
    expect(getRecord(db, expense.id)).toEqual(before);
  });

  it.each(["supplier", "paidBy"] as const)(
    "finds and corrects a %s beyond the initial 500 contacts without requiring directory access",
    (field) => {
      db.insert(contacts)
        .values(
          Array.from({ length: 501 }, (_, index) => ({
            entityType: 2 as const,
            legalName: `A contact ${index}`,
          })),
        )
        .run();
      const remote = createDirectoryContact(db, userId, {
        entityType: 2,
        legalName: "ZZ remote correction target",
      });
      expect(
        listContacts(db, { limit: 500 }).some((c) => c.id === remote.id),
      ).toBe(false);
      const expense = bill(field === "paidBy");
      const context = ctx(["contacts.read"]);
      const matches = searchContactCorrectionContacts(
        context,
        expense.id,
        "remote correction target",
      );
      expect(matches).toEqual({
        ok: true,
        value: [{ id: remote.id, legalName: remote.legalName }],
      });
      expect(
        correctExpenseContact(
          context,
          expense.id,
          request(expense.id, remote.id, field),
        ).ok,
      ).toBe(true);
      const after = getRecord(db, expense.id)!;
      expect(
        field === "paidBy" ? after.contactId : after.supplierContactId,
      ).toBe(remote.id);
      expect(
        searchContactCorrectionContacts(
          ctx(["records.correctContact"]),
          expense.id,
          "remote",
        ),
      ).toMatchObject({ code: "FORBIDDEN" });
    },
  );

  it("uses outgoing-payment correction permissions for contact search", () => {
    const expense = bill();
    const payment = pay(expense);
    const remote = createDirectoryContact(db, userId, {
      entityType: 2,
      legalName: "Remote payee",
    });
    expect(
      searchContactCorrectionContacts(
        ctx(["contacts.read", "records.correctContact", "records.delete"]),
        payment.id,
        "Remote payee",
      ),
    ).toEqual({
      ok: true,
      value: [{ id: remote.id, legalName: remote.legalName }],
    });
    expect(
      searchContactCorrectionContacts(
        ctx(["records.correctPaymentRecipient", "records.delete"]),
        payment.id,
        "Remote payee",
      ),
    ).toMatchObject({ code: "FORBIDDEN" });
  });

  it("blocks ownership changes linked to legacy reimbursement transfers", () => {
    const expense = bill();
    const owed = expense.movements.find((m) => m.accountId === payable)!;
    const person = contact("Employee");
    const claim = createReimbursement(ctx(), {
      contactId: person,
      date: base.date,
      description: "Claim",
      paidFromAccountId: bank,
      cashMinor: 2000,
      personallyPaid: true,
      reference: "",
      remark: "",
      credits: [],
      items: [{ owedMovementId: owed.id, amountMinor: 2000 }],
    });
    if (!claim.ok) throw new Error(claim.reason);
    expect(prepared(expense.id).fields[0].blockedReason).toMatch(
      /linked reimbursement/,
    );
    expect(
      correctExpenseContact(ctx(), expense.id, request(expense.id, contact())),
    ).toMatchObject({ code: "REFUSED" });
  });
});
