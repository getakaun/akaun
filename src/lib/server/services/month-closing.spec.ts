import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  AccountSubType,
  AccountType,
  DefaultAccountPurpose,
  EntityType,
  Role,
} from "$lib/enums.js";
import * as schema from "../db/schema.js";
import type { LedgerDb } from "../ledger/types.js";
import { createAccount, patchAccount, setOpeningBalance } from "./accounts.js";
import { createRecord, patchRecord, removeRecord } from "./ledger.js";
import {
  createContact,
  getContact,
  hardDeleteContact,
  mergeContacts,
  setContactRoles,
} from "../queries/contacts.js";
import { setSetting } from "../settings.js";
import { getRecord } from "../queries/ledger.js";
import { ledgerEvents } from "../ledger/events.js";
import { applySubTypeBackfill } from "../db/auto-upgrade.js";
import { applyContraRevenueReclassification } from "../db/contra-revenue-reclassification.js";

let sqlite: Database;
let db: LedgerDb;
let bank: number;
let expense: number;

function account(name: string, type: number, subType?: number) {
  const result = createAccount(db, 1, {
    name,
    type: type as never,
    ...(subType === undefined ? {} : { subType: subType as never }),
  });
  if (!result.ok) throw new Error(result.reason);
  return result.value.id;
}

function purchase(date = "2026-10-15", contactId?: number) {
  const result = createRecord(db, 1, {
    kind: "expense",
    date,
    description: "Stationery",
    amount: 20,
    currency: "MYR",
    exchangeRate: 1,
    categoryAccountId: expense,
    paidFromAccountId: bank,
    contactId,
  });
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}

function close() {
  setSetting(db, "accounting.closedThrough", "2026-10-31");
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "drizzle" });
  db.insert(schema.users)
    .values({ email: "close@test", username: "close", passwordHash: "x" })
    .run();
  bank = account("Bank", AccountType.Asset, AccountSubType.Bank);
  expense = account("Stationery", AccountType.Expense);
  const receivable = account(
    "Receivable",
    AccountType.Asset,
    AccountSubType.Receivable,
  );
  const payable = account(
    "Payable",
    AccountType.Liability,
    AccountSubType.AccountsPayable,
  );
  const opening = account("Opening", AccountType.Equity);
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
    ])
    .run();
});
afterEach(() => sqlite.close());

describe("closed history at service boundaries", () => {
  it("rolls back record creation and numbering when its audit cannot be written", () => {
    const sequences = db.select().from(schema.appSequences).all();
    sqlite.exec(
      "CREATE TEMP TRIGGER refuse_record_audit BEFORE INSERT ON audit_log WHEN NEW.record_type = 'record' BEGIN SELECT RAISE(ABORT, 'test audit failure'); END",
    );
    let events = 0;
    const listener = () => {
      events++;
    };
    ledgerEvents.on("record-update", listener);
    try {
      expect(() => purchase()).toThrow();
      expect(db.select().from(schema.ledgerRecords).all()).toHaveLength(0);
      expect(db.select().from(schema.ledgerMovements).all()).toHaveLength(0);
      expect(db.select().from(schema.appSequences).all()).toEqual(sequences);
      expect(events).toBe(0);
    } finally {
      ledgerEvents.off("record-update", listener);
    }
  });

  it("rolls back changed record amounts when their audit fails", () => {
    const record = purchase();
    const before = db.select().from(schema.ledgerMovements).all();
    sqlite.exec(
      "CREATE TEMP TRIGGER refuse_record_audit BEFORE INSERT ON audit_log WHEN NEW.record_type = 'record' BEGIN SELECT RAISE(ABORT, 'test audit failure'); END",
    );
    expect(() => patchRecord(db, record.id, 1, { amount: 21 })).toThrow();
    expect(getRecord(db, record.id)?.amount).toBe(20);
    expect(db.select().from(schema.ledgerMovements).all()).toEqual(before);
  });

  it("rolls back a contact merge when its audit fails", () => {
    const first = createContact(db, 1, {
      entityType: EntityType.Business,
      legalName: "Original",
    });
    const second = createContact(db, 1, {
      entityType: EntityType.Business,
      legalName: "Survivor",
    });
    const record = purchase("2026-11-01", first.id);
    sqlite.exec(
      "CREATE TEMP TRIGGER refuse_contact_audit BEFORE INSERT ON audit_log WHEN NEW.record_type = 'contact' BEGIN SELECT RAISE(ABORT, 'test audit failure'); END",
    );
    expect(() => mergeContacts(db, second.id, [first.id], 1)).toThrow();
    expect(getContact(db, first.id)).not.toBeNull();
    expect(getRecord(db, record.id)?.contactId).toBe(first.id);
  });

  it("refuses classification changes but permits a rename and unchanged classification", () => {
    purchase();
    close();
    const before = db.select().from(schema.auditLog).all().length;
    expect(patchAccount(db, bank, 1, { subType: AccountSubType.Cash }).ok).toBe(
      false,
    );
    expect(db.select().from(schema.auditLog).all()).toHaveLength(before);
    expect(
      patchAccount(db, bank, 1, {
        name: "Renamed bank",
        subType: AccountSubType.Bank,
      }).ok,
    ).toBe(true);
    expect(
      db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.id, bank))
        .get()?.subType,
    ).toBe(AccountSubType.Bank);
  });

  it("allows classification changes for an account used only after the close", () => {
    purchase("2026-11-01");
    close();
    expect(patchAccount(db, bank, 1, { subType: AccountSubType.Cash }).ok).toBe(
      true,
    );
  });

  it("refuses new partner membership without leaving a contact or audit entry", () => {
    purchase();
    close();
    const before = db.select().from(schema.auditLog).all().length;
    expect(() =>
      createContact(db, 1, {
        entityType: EntityType.Individual,
        legalName: "New partner",
        roles: [Role.Partner],
      }),
    ).toThrow(/clos/i);
    expect(db.select().from(schema.contacts).all()).toHaveLength(0);
    expect(db.select().from(schema.auditLog).all()).toHaveLength(before);
  });

  it("protects the partner roster even when the changed contact has no postings", () => {
    const partner = createContact(db, 1, {
      entityType: EntityType.Individual,
      legalName: "Partner",
      roles: [Role.Partner],
    });
    purchase();
    close();
    expect(() => setContactRoles(db, partner.id, [])).toThrow(/clos/i);
    expect(() => hardDeleteContact(db, partner.id, 1)).toThrow(/clos/i);
    expect(getContact(db, partner.id)?.roles).toEqual([Role.Partner]);
    expect(
      setContactRoles(db, partner.id, [Role.Partner, Role.Supplier]),
    ).toEqual([Role.Supplier, Role.Partner]);
  });

  it("refuses merges that rewrite closed attribution without changing either contact", () => {
    const first = createContact(db, 1, {
      entityType: EntityType.Business,
      legalName: "Original",
    });
    const second = createContact(db, 1, {
      entityType: EntityType.Business,
      legalName: "Survivor",
    });
    const record = purchase("2026-10-15", first.id);
    close();
    const before = db.select().from(schema.auditLog).all().length;
    expect(() => mergeContacts(db, second.id, [first.id], 1)).toThrow(/clos/i);
    expect(getRecord(db, record.id)?.contactId).toBe(first.id);
    expect(getContact(db, first.id)).not.toBeNull();
    expect(db.select().from(schema.auditLog).all()).toHaveLength(before);
  });

  it("refuses merging an otherwise unused partner because it changes historical shares", () => {
    const first = createContact(db, 1, {
      entityType: EntityType.Individual,
      legalName: "Partner",
      roles: [Role.Partner],
    });
    const second = createContact(db, 1, {
      entityType: EntityType.Individual,
      legalName: "Survivor",
    });
    purchase();
    close();
    expect(() => mergeContacts(db, second.id, [first.id], 1)).toThrow(/clos/i);
    expect(getContact(db, first.id)).not.toBeNull();
    expect(getContact(db, second.id)?.roles).toEqual([]);
  });

  it("returns ordinary record refusals with no financial changes or success events", () => {
    const record = purchase();
    close();
    let events = 0;
    const listener = () => {
      events++;
    };
    ledgerEvents.on("record-update", listener);
    try {
      expect(patchRecord(db, record.id, 1, { amount: 21 }).ok).toBe(false);
      expect(removeRecord(db, record.id, 1).ok).toBe(false);
      expect(getRecord(db, record.id)?.amount).toBe(20);
      expect(events).toBe(0);
    } finally {
      ledgerEvents.off("record-update", listener);
    }
  });

  it("refuses replacing and removing a closed opening balance", () => {
    expect(
      setOpeningBalance(db, bank, 1, { date: "2026-10-01", amountMinor: 10000 })
        .ok,
    ).toBe(true);
    close();
    const before = db.select().from(schema.ledgerRecords).all();
    expect(
      setOpeningBalance(db, bank, 1, { date: "2026-11-01", amountMinor: 20000 })
        .ok,
    ).toBe(false);
    expect(
      setOpeningBalance(db, bank, 1, { date: "2026-10-01", amountMinor: 0 }).ok,
    ).toBe(false);
    expect(db.select().from(schema.ledgerRecords).all()).toEqual(before);
  });

  it("does not silently reclassify closed accounts during a startup backfill", () => {
    purchase();
    db.update(schema.accounts)
      .set({ code: 1100, subType: null })
      .where(eq(schema.accounts.id, bank))
      .run();
    close();
    applySubTypeBackfill(sqlite);
    expect(
      db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.id, bank))
        .get()?.subType,
    ).toBeNull();
    setSetting(db, "accounting.closedThrough", "");
    applySubTypeBackfill(sqlite);
    expect(
      db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.id, bank))
        .get()?.subType,
    ).toBe(AccountSubType.Bank);
  });

  it("does not rewrite a closed posting during a startup contra-revenue repair", () => {
    const record = purchase();
    const contra = account(
      "Contra revenue",
      AccountType.Revenue,
      AccountSubType.ContraOperatingRevenue,
    );
    db.update(schema.ledgerMovements)
      .set({ accountId: contra })
      .where(eq(schema.ledgerMovements.accountId, expense))
      .run();
    db.update(schema.ledgerRecords)
      .set({ kind: 2 })
      .where(eq(schema.ledgerRecords.id, record.id))
      .run();
    close();
    const before = db.select().from(schema.ledgerRecords).all();
    const warnings: object[] = [];
    const changed = applyContraRevenueReclassification(sqlite, {
      warn: (details) => {
        warnings.push(details);
      },
    });
    expect(changed).toBe(0);
    expect(db.select().from(schema.ledgerRecords).all()).toEqual(before);
    expect(warnings).toHaveLength(1);
  });
});
