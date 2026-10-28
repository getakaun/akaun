import { eq } from "drizzle-orm";
import { setSetting, SETTING_KEYS } from "../settings.js";
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
  const { legacyPairOf } =
    await import("$lib/server/permissions/legacy-map.js");
  const allow = (resource: string, action: string) =>
    holder.allow(resource, action);
  return {
    can: (_locals: unknown, permission: string) =>
      allow(...legacyPairOf(permission)),
    canAll: (_locals: unknown, permissions: string[]) =>
      permissions.every((permission) => allow(...legacyPairOf(permission))),
    canAny: (_locals: unknown, alternatives: string[][]) =>
      alternatives.some((permissions) =>
        permissions.every((permission) => allow(...legacyPairOf(permission))),
      ),
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
  it("opens the general page as a reimbursement without an operation choice", () => {
    expect(load("").direction).toBe("reimburse");
    expect(load("?direction=reimburse").direction).toBe("reimburse");
  });

  it("preserves supplier payments and refunds opened from their own actions", () => {
    expect(load("?contactId=7").direction).toBe("we-pay");
    expect(load("?direction=we-pay").direction).toBe("we-pay");
    expect(load("?direction=refund-received&contactId=7").direction).toBe(
      "refund-received",
    );
    expect(load("?direction=refund-paid&contactId=7").direction).toBe(
      "refund-paid",
    );
  });

  it("opens as a receipt from its customer, with its owed side to tick and the invoice to return to", () => {
    const invoice = sentInvoice();
    // Whatever else the address says, the invoice decides.
    const data = load(
      `?invoice=${invoice.id}&direction=reimburse&batch=1&contactId=999`,
    );

    expect(data.contactId).toBe(invoice.contactId);
    expect(data.direction).toBe("we-receive");
    expect(data).not.toHaveProperty("batch");
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
    expect(data.direction).toBe("reimburse");
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

function payee(name = "Employee") {
  return db
    .insert(contacts)
    .values({ entityType: EntityType.Individual, legalName: name })
    .returning()
    .get().id as number;
}

function setDefault(id: number | string) {
  setSetting(db, SETTING_KEYS.reimbursementDefaultPayeeContactId, String(id));
}

describe("default reimbursement payee", () => {
  it("prefills reimbursements and permits an explicit recipient override", () => {
    const recipient = payee();
    const other = payee("Other employee");
    setDefault(recipient);
    expect(load("")).toMatchObject({
      direction: "reimburse",
      contactId: recipient,
    });
    expect(load("?direction=reimburse").contactId).toBe(recipient);
    expect(load(`?direction=reimburse&contactId=${other}`).contactId).toBe(
      other,
    );
    expect(load("").contactId).toBe(recipient);
  });

  it("leaves an unset, cleared, invalid or deleted default blank", () => {
    expect(load("").contactId).toBeNull();
    for (const raw of ["", "999", "abc", "-1", "1.5"]) {
      setDefault(raw);
      expect(load("").contactId).toBeNull();
    }
    const recipient = payee();
    setDefault(recipient);
    db.delete(contacts).where(eq(contacts.id, recipient)).run();
    expect(load("").contactId).toBeNull();
  });

  it("does not apply the default to direct payments, receipts or refunds", () => {
    const recipient = payee();
    setDefault(recipient);
    for (const direction of [
      "we-pay",
      "we-receive",
      "refund-paid",
      "refund-received",
    ]) {
      expect(load(`?direction=${direction}`).contactId).toBeNull();
      expect(load(`?direction=${direction}&contactId=999`).contactId).toBe(999);
    }
    const invoice = sentInvoice();
    expect(load(`?invoice=${invoice.id}`)).toMatchObject({
      direction: "we-receive",
      contactId: invoice.contactId,
    });
  });

  it("includes a default beyond the initial contact list in the form choices", () => {
    db.insert(contacts)
      .values(
        Array.from({ length: 501 }, (_, i) => ({
          entityType: EntityType.Business,
          legalName: `A supplier ${i}`,
        })),
      )
      .run();
    const recipient = payee("ZZ employee");
    setDefault(recipient);
    const data = load("");
    expect(data.contactId).toBe(recipient);
    expect(data.contacts).toContainEqual({
      id: recipient,
      legalName: "ZZ employee",
    });
  });
});
