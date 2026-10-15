import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AccountSubType,
  AccountType,
  DefaultAccountPurpose,
  EntityType,
} from "$lib/enums.js";
import * as schema from "../db/schema.js";
import { accountDefaults, contacts, users } from "../db/schema.js";
import { createAccount } from "../services/accounts.js";
import { issueInvoice } from "../services/invoices.js";
import { createInvoice } from "../queries/invoices.js";
import type { AccountCreate } from "../ledger/types.js";
import { loadPaymentNew } from "./records.js";

// The same stand-ins as `detail-loaders.spec.ts`: `db/client.js` hands out this
// spec's own in-memory database, the storage paths point nowhere, and
// permissions answer from `holder.allow`. Nothing here can touch `data/`.
const holder = vi.hoisted(() => ({
  db: null as unknown,
  allow: (() => true) as (resource: string, action: string) => boolean,
}));

vi.mock("$lib/server/db/client.js", () => ({
  get db() {
    return holder.db;
  },
}));

vi.mock("$lib/server/env.js", () => ({
  STORAGE_PATH: "/dev/null",
  DATABASE_PATH: "/dev/null",
  OCR_CACHE_PATH: "/dev/null",
}));

vi.mock("$lib/server/permissions.js", async () => {
  // The fake answers in the old grid's terms; each leaf is asked as the
  // (resource, action) it came from.
  const { legacyPairOf } = await import("$lib/server/permissions/legacy-map.js");
  const allow = (resource: string, action: string) =>
    holder.allow(resource, action);
  return {
    can: (_locals: unknown, permission: string) =>
      allow(...legacyPairOf(permission)),
    canAll: (_locals: unknown, permissions: string[]) =>
      permissions.every((permission) => allow(...legacyPairOf(permission))),
  };
});

/**
 * `/records/new/payment?invoice=<id>`: the invoice page's "Record payment".
 * The loader answers with the invoice's customer, a receipt, the owed side to
 * tick, and the way back — and with the ordinary blank form for anyone who may
 * not see invoices, or an id that names none.
 */

let sqlite: Database;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
const userId = 1;
const locals = { user: { id: userId } } as App.Locals;

beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "drizzle" });
  db.insert(users)
    .values({ email: "q@test", username: "q", passwordHash: "x" })
    .run();
  holder.db = db;
  holder.allow = () => true;
});
afterEach(() => {
  holder.db = null;
  sqlite.close();
});

function account(
  name: string,
  type: AccountCreate["type"],
  subType?: AccountCreate["subType"],
): number {
  const result = createAccount(db, userId, { name, type, subType });
  if (!result.ok) throw new Error(result.reason);
  return result.value.id;
}

/** A sent invoice to a customer, in a book that can issue one. */
function sentInvoice() {
  const receivable = account(
    "Accounts Receivable",
    AccountType.Asset,
    AccountSubType.Receivable,
  );
  db.insert(accountDefaults)
    .values({
      purpose: DefaultAccountPurpose.Receivable,
      accountId: receivable,
      updatedBy: userId,
    })
    .run();
  const sales = account("Sales", AccountType.Revenue);
  const customer = db
    .insert(contacts)
    .values({ entityType: EntityType.Business, legalName: "Acme Sdn Bhd" })
    .returning({ id: contacts.id })
    .get().id;
  const draft = createInvoice(db, userId, {
    contactId: customer,
    issueDate: "2026-08-01",
    lines: [{ description: "Consulting", quantity: 1, unitPrice: 100 }],
  });
  const issued = issueInvoice(db, draft.id, userId, { incomeAccountId: sales });
  if (!issued.ok) throw new Error(issued.reason);
  return issued.value;
}

function load(query: string) {
  return loadPaymentNew(
    locals,
    new URL(`http://localhost/records/new/payment${query}`),
  );
}

describe("recording a payment from an invoice", () => {
  it("opens as a receipt from its customer, with its owed side to tick and the invoice to return to", () => {
    const invoice = sentInvoice();
    // Whatever else the address says, the invoice decides.
    const data = load(
      `?invoice=${invoice.id}&direction=we-pay&batch=1&contactId=999`,
    );

    expect(data.contactId).toBe(invoice.contactId);
    expect(data.direction).toBe("we-receive");
    expect(data.batch).toBe(false);
    expect(data.preselectMovementId).not.toBeNull();
    expect(data.preselectMovementId).toBe(invoice.owedMovementId);
    expect(data.returnTo).toEqual({
      href: `/invoices/${invoice.id}`,
      label: invoice.invoiceNumber,
    });
  });

  it("ignores the invoice for a user who may not see invoices", () => {
    const invoice = sentInvoice();
    holder.allow = (resource) => resource !== "invoices";

    const data = load(`?invoice=${invoice.id}`);
    expect(data.contactId).toBeNull();
    expect(data.direction).toBe("we-pay");
    expect(data.preselectMovementId).toBeNull();
    expect(data.returnTo).toBeNull();
  });

  it("ignores an id that names no invoice, or is not an id at all", () => {
    sentInvoice();
    for (const raw of ["999", "abc", "-1", "1.5", ""]) {
      const data = load(`?invoice=${encodeURIComponent(raw)}&contactId=7`);
      expect(data.preselectMovementId).toBeNull();
      expect(data.returnTo).toBeNull();
      // The rest of the address still means what it always did.
      expect(data.contactId).toBe(7);
    }
  });

  it("still needs records:add, whatever the invoice", () => {
    const invoice = sentInvoice();
    holder.allow = (resource, action) =>
      !(resource === "records" && action === "add");
    expect(() => load(`?invoice=${invoice.id}`)).toThrow();
  });
});
