import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AccountSubType,
  AccountType,
  DefaultAccountPurpose,
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
import { createRecord, deleteRecord, updateRecord } from "./records.js";
import { recordVersion, recordVersions } from "./version.js";
import { setExtractedText } from "../queries/ledger.js";

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
