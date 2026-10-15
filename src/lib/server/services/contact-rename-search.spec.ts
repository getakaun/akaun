import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccountSubType, AccountType, EntityType } from "$lib/enums.js";
import * as schema from "../db/schema.js";
import { accounts, users } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { createAccount } from "./accounts.js";
import { createRecord } from "./ledger.js";
import {
  createContact,
  deleteContact,
  mergeContacts,
  patchContact,
} from "./contacts.js";
import { createInvoice, listInvoices } from "../queries/invoices.js";
import { createQuotation, listQuotations } from "../queries/quotations.js";
import { listRecords } from "../queries/ledger.js";
import type { AccountCreate, LedgerDb } from "../ledger/types.js";

/**
 * A record, a quotation and an invoice each hold their contact's name in their
 * own search text, written when the document was. Renaming the contact — or
 * merging it into another — must rewrite that text, or the lists find the
 * customer only under the name it no longer has. Run against a real in-memory
 * database, so nothing here can touch `data/`.
 */

let sqlite: Database;
let db: LedgerDb;
const userId = 1;

beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema }) as unknown as LedgerDb;
  migrate(db as never, { migrationsFolder: "drizzle" });
  sqlite.exec("PRAGMA foreign_keys = ON");
  db.insert(users)
    .values({ email: "u@test", username: "u", passwordHash: "x" })
    .run();
});
afterEach(() => sqlite.close());

function account(
  name: string,
  type: AccountCreate["type"],
  subType?: AccountCreate["subType"],
): number {
  const result = createAccount(db, userId, { name, type, subType });
  if (!result.ok) throw new Error(result.reason);
  return result.value.id;
}

/** One record, one quotation and one invoice, all naming `contactId`. */
function documentsFor(contactId: number) {
  const record = createRecord(db, userId, {
    kind: "income",
    date: "2026-08-01",
    description: "Consulting",
    amount: 100,
    currency: "MYR",
    exchangeRate: 1,
    contactId,
    categoryAccountId: account("Fees", AccountType.Revenue),
    receivedIntoAccountId: account(
      "Bank",
      AccountType.Asset,
      AccountSubType.Bank,
    ),
  });
  if (!record.ok) throw new Error(record.reason);
  const lines = [{ description: "Widget", quantity: 1, unitPrice: 100 }];
  const quotation = createQuotation(db, userId, {
    contactId,
    issueDate: "2026-08-01",
    lines,
  });
  const invoice = createInvoice(db, userId, {
    contactId,
    issueDate: "2026-08-01",
    lines,
  });
  return { recordId: record.value.id, quotation, invoice };
}

function found(search: string) {
  return {
    records: listRecords(db, { search }).records.map((r) => r.id),
    quotations: listQuotations(db, { search }).map((q) => q.id),
    invoices: listInvoices(db, { search }).map((i) => i.id),
  };
}

describe("renaming a contact", () => {
  it("finds its records, quotations and invoices by the new name, not the old", () => {
    const contact = createContact(db, userId, {
      entityType: EntityType.Business,
      legalName: "Acme Hardware",
    });
    const { recordId, quotation, invoice } = documentsFor(contact.id);

    patchContact(db, contact.id, userId, { legalName: "Zenith Tools" });

    expect(found("Zenith")).toEqual({
      records: [recordId],
      quotations: [quotation.id],
      invoices: [invoice.id],
    });
    expect(found("Acme")).toEqual({
      records: [],
      quotations: [],
      invoices: [],
    });
  });
});

describe("merging contacts", () => {
  it("finds the merged contact's documents under the survivor's name", () => {
    const survivor = createContact(db, userId, {
      entityType: EntityType.Business,
      legalName: "Zenith Tools",
    });
    const loser = createContact(db, userId, {
      entityType: EntityType.Business,
      legalName: "Acme Hardware",
    });
    const { recordId, quotation, invoice } = documentsFor(loser.id);

    mergeContacts(db, survivor.id, [loser.id], userId);

    expect(found("Zenith")).toEqual({
      records: [recordId],
      quotations: [quotation.id],
      invoices: [invoice.id],
    });
    expect(found("Acme")).toEqual({
      records: [],
      quotations: [],
      invoices: [],
    });
  });
});

describe("a partner's own account", () => {
  function partnerAccount(contactId: number) {
    const id = account("Capital", AccountType.Equity);
    db.update(accounts).set({ contactId }).where(eq(accounts.id, id)).run();
    return id;
  }
  const ownerOf = (id: number) =>
    db.select().from(accounts).where(eq(accounts.id, id)).get()!.contactId;

  it("moves to the survivor on a merge, rather than to nobody", () => {
    const survivor = createContact(db, userId, {
      entityType: EntityType.Individual,
      legalName: "Ali",
    });
    const loser = createContact(db, userId, {
      entityType: EntityType.Individual,
      legalName: "Ali bin Abu",
    });
    const capital = partnerAccount(loser.id);

    mergeContacts(db, survivor.id, [loser.id], userId);

    expect(ownerOf(capital)).toBe(survivor.id);
  });

  it("keeps its contact from being deleted", () => {
    const partner = createContact(db, userId, {
      entityType: EntityType.Individual,
      legalName: "Ali",
    });
    const capital = partnerAccount(partner.id);

    const result = deleteContact(db, partner.id, userId);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/partner/);
    expect(ownerOf(capital)).toBe(partner.id);
  });
});
