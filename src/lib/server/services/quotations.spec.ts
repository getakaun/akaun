import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EntityType, InvoiceStatus, QuotationStatus } from "$lib/enums.js";
import * as schema from "../db/schema.js";
import {
  auditLog,
  contacts,
  invoices,
  quotations,
  users,
} from "../db/schema.js";
import { setSetting, SETTING_KEYS } from "../settings.js";
import { createQuotation, getQuotation } from "../queries/quotations.js";
import { createInvoice, getInvoice } from "../queries/invoices.js";
import {
  convertToInvoice,
  removeQuotation,
  reviseQuotation,
  setQuotationStatus,
} from "./quotations.js";
import { removeInvoice } from "./invoices.js";
import { quotationEvents } from "../finance/events.js";
import type { LedgerDb } from "../ledger/types.js";

/**
 * A quotation's life: moved along by hand, converted into a draft invoice, and
 * put back when that invoice is deleted. Run against a real in-memory
 * database, so nothing here can touch `data/`.
 */

let sqlite: Database;
let db: LedgerDb;
const userId = 1;
const TODAY = "2026-01-15";

beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema }) as unknown as LedgerDb;
  migrate(db as never, { migrationsFolder: "drizzle" });
  db.insert(users)
    .values({ email: "u@test", username: "u", passwordHash: "x" })
    .run();
});
afterEach(() => sqlite.close());

function customer(): number {
  return db
    .insert(contacts)
    .values({ entityType: EntityType.Business, legalName: "Acme Sdn Bhd" })
    .returning({ id: contacts.id })
    .get().id;
}

/** A quotation with two lines, put into `status` directly. */
function quote(status: number = QuotationStatus.Draft) {
  const created = createQuotation(db as never, userId, {
    contactId: customer(),
    reference: "PO-778",
    issueDate: "2025-12-01",
    expiryDate: "2026-01-31",
    currency: "USD",
    exchangeRate: 4.2,
    notes: "Delivery in two batches.",
    terms: "50% upfront.",
    lines: [
      { description: "Design", quantity: 2, unitPrice: 150 },
      { description: "Build", quantity: 1, unitPrice: 900 },
    ],
  });
  if (status !== QuotationStatus.Draft) {
    db.update(quotations)
      .set({ status })
      .where(eq(quotations.id, created.id))
      .run();
  }
  return created.id;
}

function auditFor(recordType: string, recordId: number) {
  return db
    .select()
    .from(auditLog)
    .where(
      and(eq(auditLog.recordType, recordType), eq(auditLog.recordId, recordId)),
    )
    .all();
}

function invoiceCount(): number {
  return db.select().from(invoices).all().length;
}

/** Every `quotation-update` emitted while `fn` runs. */
function quotationUpdatesDuring(
  fn: () => void,
): { id: number; status: number }[] {
  const seen: { id: number; status: number }[] = [];
  const listener = (payload: { item: { id: number; status: number } }) =>
    seen.push({ id: payload.item.id, status: payload.item.status });
  quotationEvents.on("quotation-update", listener);
  try {
    fn();
  } finally {
    quotationEvents.off("quotation-update", listener);
  }
  return seen;
}

function convert(id: number) {
  return convertToInvoice(db as never, id, userId, { today: TODAY });
}

describe("setting a quotation's status by hand", () => {
  it("moves it, writes an audit entry, and tells the list", () => {
    const id = quote();
    let result!: ReturnType<typeof setQuotationStatus>;
    const updates = quotationUpdatesDuring(() => {
      result = setQuotationStatus(
        db as never,
        id,
        userId,
        QuotationStatus.Sent,
      );
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.status).toBe(QuotationStatus.Sent);
    expect(getQuotation(db as never, id)!.status).toBe(QuotationStatus.Sent);
    expect(updates).toEqual([{ id, status: QuotationStatus.Sent }]);

    const update = auditFor("quotation", id).find((a) => a.action === "update");
    expect(JSON.parse(update!.changes!)).toEqual([
      {
        field: "status",
        before: QuotationStatus.Draft,
        after: QuotationStatus.Sent,
      },
    ]);
  });

  it("goes back and forth along the buttons' moves", () => {
    const id = quote(QuotationStatus.Sent);
    for (const to of [
      QuotationStatus.Accepted,
      QuotationStatus.Sent, // Undo acceptance
      QuotationStatus.Declined,
      QuotationStatus.Sent, // Reopen
    ]) {
      const result = setQuotationStatus(db as never, id, userId, to);
      expect(result.ok).toBe(true);
    }
    expect(getQuotation(db as never, id)!.status).toBe(QuotationStatus.Sent);
  });

  it("refuses to make one Converted by hand", () => {
    const id = quote(QuotationStatus.Accepted);
    const result = setQuotationStatus(
      db as never,
      id,
      userId,
      QuotationStatus.Converted,
    );
    expect(result.ok).toBe(false);
    expect(getQuotation(db as never, id)!.status).toBe(
      QuotationStatus.Accepted,
    );
  });

  it("refuses to move a converted one, and writes nothing", () => {
    const id = quote(QuotationStatus.Sent);
    expect(convert(id).ok).toBe(true);
    const auditBefore = auditFor("quotation", id).length;

    const updates = quotationUpdatesDuring(() => {
      const result = setQuotationStatus(
        db as never,
        id,
        userId,
        QuotationStatus.Sent,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/invoice/);
    });

    expect(getQuotation(db as never, id)!.status).toBe(
      QuotationStatus.Converted,
    );
    expect(auditFor("quotation", id)).toHaveLength(auditBefore);
    expect(updates).toEqual([]);
  });

  it("refuses a move to the status it already has", () => {
    const id = quote(QuotationStatus.Sent);
    const result = setQuotationStatus(
      db as never,
      id,
      userId,
      QuotationStatus.Sent,
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.reason).toBe("This quotation is already sent.");
  });

  it("refuses a quotation that does not exist", () => {
    const result = setQuotationStatus(
      db as never,
      999,
      userId,
      QuotationStatus.Sent,
    );
    expect(result.ok).toBe(false);
  });
});

describe("converting a quotation into an invoice", () => {
  for (const [name, status] of [
    ["a draft", QuotationStatus.Draft],
    ["a declined one", QuotationStatus.Declined],
  ] as const) {
    it(`refuses ${name}, and makes no invoice`, () => {
      const id = quote(status);
      const result = convert(id);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).not.toBe("");
      expect(invoiceCount()).toBe(0);
      expect(getQuotation(db as never, id)!.status).toBe(status);
    });
  }

  it("refuses one already converted, and makes no second invoice", () => {
    const id = quote(QuotationStatus.Sent);
    expect(convert(id).ok).toBe(true);
    const again = convert(id);
    expect(again.ok).toBe(false);
    if (!again.ok)
      expect(again.reason).toBe(
        "This quotation has already been converted to an invoice.",
      );
    expect(invoiceCount()).toBe(1);
  });

  it("turns a sent one into a draft invoice and marks it Converted", () => {
    const id = quote(QuotationStatus.Sent);
    const before = getQuotation(db as never, id)!;
    const result = convert(id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const invoice = getInvoice(db as never, result.value.invoiceId)!;
    expect(invoice.status).toBe(InvoiceStatus.Draft);
    expect(invoice.ledgerRecordId).toBeNull();
    expect(invoice.sourceQuotationId).toBe(id);
    expect(invoice.contactId).toBe(before.contactId);
    expect(invoice.currency).toBe("USD");
    expect(invoice.exchangeRate).toBe(4.2);
    expect(invoice.total).toBe(1200);
    expect(
      invoice.lines.map((l) => [
        l.description,
        l.quantity,
        l.unitPrice,
        l.lineTotal,
      ]),
    ).toEqual([
      ["Design", 2, 150, 300],
      ["Build", 1, 900, 900],
    ]);

    const after = getQuotation(db as never, id)!;
    expect(after.status).toBe(QuotationStatus.Converted);
    expect(after.convertedInvoiceId).toBe(invoice.id);
    // Built through `createInvoice`, so it gets the same audit entry as one
    // typed in by hand.
    expect(auditFor("invoice", invoice.id).map((a) => a.action)).toEqual([
      "create",
    ]);
  });

  it("converts an accepted one too", () => {
    const id = quote(QuotationStatus.Accepted);
    expect(convert(id).ok).toBe(true);
  });

  it("copies the notes, terms and reference", () => {
    const id = quote(QuotationStatus.Sent);
    const result = convert(id);
    if (!result.ok) throw new Error(result.reason);
    const invoice = getInvoice(db as never, result.value.invoiceId)!;
    expect(invoice.notes).toBe("Delivery in two batches.");
    expect(invoice.terms).toBe("50% upfront.");
    expect(invoice.reference).toBe("PO-778");
  });

  it("dates the invoice today, due 30 days later when the term was never set", () => {
    const result = convert(quote(QuotationStatus.Sent));
    if (!result.ok) throw new Error(result.reason);
    const invoice = getInvoice(db as never, result.value.invoiceId)!;
    expect(invoice.issueDate).toBe(TODAY);
    expect(invoice.dueDate).toBe("2026-02-14");
  });

  it("uses the saved invoice term for the due date", () => {
    setSetting(db as never, SETTING_KEYS.invoiceDueDays, "14");
    const result = convert(quote(QuotationStatus.Sent));
    if (!result.ok) throw new Error(result.reason);
    expect(getInvoice(db as never, result.value.invoiceId)!.dueDate).toBe(
      "2026-01-29",
    );
  });

  it("leaves the due date empty when the invoice term is set to none", () => {
    setSetting(db as never, SETTING_KEYS.invoiceDueDays, "");
    const result = convert(quote(QuotationStatus.Sent));
    if (!result.ok) throw new Error(result.reason);
    const invoice = getInvoice(db as never, result.value.invoiceId)!;
    expect(invoice.issueDate).toBe(TODAY);
    expect(invoice.dueDate).toBeNull();
  });
});

describe("deleting an invoice a quotation was converted into", () => {
  it("puts the quotation back to Accepted, audits it, and tells the list", () => {
    const id = quote(QuotationStatus.Sent);
    const result = convert(id);
    if (!result.ok) throw new Error(result.reason);
    const invoiceId = result.value.invoiceId;

    let removed!: ReturnType<typeof removeInvoice>;
    const updates = quotationUpdatesDuring(() => {
      removed = removeInvoice(db as never, invoiceId, userId);
    });

    expect(removed).toEqual({ ok: true, revertedQuotationId: id });
    expect(getInvoice(db as never, invoiceId)).toBeNull();
    const after = getQuotation(db as never, id)!;
    expect(after.status).toBe(QuotationStatus.Accepted);
    expect(after.convertedInvoiceId).toBeNull();
    expect(updates).toEqual([{ id, status: QuotationStatus.Accepted }]);

    const last = auditFor("quotation", id).at(-1)!;
    expect(last.action).toBe("update");
    expect(JSON.parse(last.changes!)).toEqual(
      expect.arrayContaining([
        {
          field: "status",
          before: QuotationStatus.Converted,
          after: QuotationStatus.Accepted,
        },
        { field: "convertedInvoiceId", before: invoiceId, after: null },
      ]),
    );

    // Back to Accepted, so it can be converted again.
    expect(convert(id).ok).toBe(true);
  });

  it("leaves quotations alone when the invoice did not come from one", () => {
    const id = quote(QuotationStatus.Sent);
    const invoice = createInvoice(db as never, userId, {
      issueDate: TODAY,
      lines: [{ description: "Ad hoc", quantity: 1, unitPrice: 10 }],
    });

    const updates = quotationUpdatesDuring(() => {
      expect(removeInvoice(db as never, invoice.id, userId)).toEqual({
        ok: true,
      });
    });

    expect(getQuotation(db as never, id)!.status).toBe(QuotationStatus.Sent);
    expect(updates).toEqual([]);
  });

  it("leaves a quotation alone when it no longer points at that invoice", () => {
    const id = quote(QuotationStatus.Sent);
    const result = convert(id);
    if (!result.ok) throw new Error(result.reason);
    // A second invoice that names the same quote, but is not the one the quote
    // became.
    const stray = createInvoice(db as never, userId, {
      issueDate: TODAY,
      sourceQuotationId: id,
      lines: [{ description: "Extra", quantity: 1, unitPrice: 10 }],
    });

    expect(removeInvoice(db as never, stray.id, userId)).toEqual({ ok: true });
    const after = getQuotation(db as never, id)!;
    expect(after.status).toBe(QuotationStatus.Converted);
    expect(after.convertedInvoiceId).toBe(result.value.invoiceId);
  });
});

describe("revising a quotation that has gone out", () => {
  function revise(id: number) {
    const result = reviseQuotation(db as never, id, userId, { today: TODAY });
    if (!result.ok) throw new Error(result.reason);
    return result.value;
  }

  it("copies it into a draft -R1 and marks the old one Superseded, linked both ways", () => {
    const id = quote(QuotationStatus.Accepted);
    const original = getQuotation(db as never, id)!;

    let value!: ReturnType<typeof revise>;
    const updates = quotationUpdatesDuring(() => {
      value = revise(id);
    });
    const revision = getQuotation(db as never, value.quotationId)!;
    const old = getQuotation(db as never, id)!;

    expect(revision.status).toBe(QuotationStatus.Draft);
    expect(revision.quotationNumber).toBe(`${original.quotationNumber}-R1`);
    expect(revision.revision).toBe(1);
    expect(revision.issueDate).toBe(TODAY);
    expect(revision.contactId).toBe(original.contactId);
    expect(revision.currency).toBe("USD");
    expect(revision.exchangeRate).toBe(4.2);
    expect(revision.total).toBe(original.total);
    expect(revision.notes).toBe(original.notes);
    expect(
      revision.lines.map((l) => [l.description, l.quantity, l.unitPrice]),
    ).toEqual(
      original.lines.map((l) => [l.description, l.quantity, l.unitPrice]),
    );
    expect(revision.revisedFrom).toEqual({
      id,
      quotationNumber: original.quotationNumber,
    });

    expect(old.status).toBe(QuotationStatus.Superseded);
    expect(old.supersededBy).toEqual({
      id: revision.id,
      quotationNumber: revision.quotationNumber,
    });
    // The old one is otherwise untouched: it is what the customer was sent.
    expect(old.lines).toEqual(original.lines);
    expect(old.total).toBe(original.total);

    expect(updates).toEqual([
      { id, status: QuotationStatus.Superseded },
      { id: revision.id, status: QuotationStatus.Draft },
    ]);
  });

  it("numbers a revision of a revision from the same root", () => {
    const id = quote(QuotationStatus.Sent);
    const root = getQuotation(db as never, id)!.quotationNumber;
    const r1 = revise(id).quotationId;
    setQuotationStatus(db as never, r1, userId, QuotationStatus.Sent);
    const r2 = revise(r1).quotationId;
    expect(getQuotation(db as never, r2)!.quotationNumber).toBe(`${root}-R2`);
    expect(getQuotation(db as never, r2)!.revision).toBe(2);
  });

  it("refuses a draft, a converted one, and one already superseded", () => {
    const draft = quote(QuotationStatus.Draft);
    const converted = quote(QuotationStatus.Sent);
    expect(convert(converted).ok).toBe(true);
    const superseded = quote(QuotationStatus.Sent);
    revise(superseded);

    for (const id of [draft, converted, superseded]) {
      const result = reviseQuotation(db as never, id, userId, { today: TODAY });
      expect(result.ok).toBe(false);
    }
  });

  it("leaves a superseded one unable to be converted, moved, or deleted", () => {
    const id = quote(QuotationStatus.Accepted);
    revise(id);

    expect(convert(id).ok).toBe(false);
    expect(
      setQuotationStatus(db as never, id, userId, QuotationStatus.Sent).ok,
    ).toBe(false);
    expect(removeQuotation(db as never, id, userId)).toEqual({
      ok: false,
      reason: "superseded",
    });
  });

  it("puts the old one back to Sent when the draft revision is deleted", () => {
    const id = quote(QuotationStatus.Accepted);
    const { quotationId: r1 } = revise(id);

    let result!: ReturnType<typeof removeQuotation>;
    const updates = quotationUpdatesDuring(() => {
      result = removeQuotation(db as never, r1, userId);
    });

    expect(result.ok).toBe(true);
    const back = getQuotation(db as never, id)!;
    expect(back.status).toBe(QuotationStatus.Sent);
    expect(back.supersededById).toBeNull();
    expect(back.supersededBy).toBeNull();
    expect(updates).toEqual([{ id, status: QuotationStatus.Sent }]);
    // And it can be revised again, taking the freed -R1.
    const again = revise(id);
    expect(getQuotation(db as never, again.quotationId)!.quotationNumber).toBe(
      `${back.quotationNumber}-R1`,
    );
  });
});

describe("rules a sent quotation keeps", () => {
  it("cannot go back to Draft by hand", () => {
    const id = quote(QuotationStatus.Sent);
    const result = setQuotationStatus(
      db as never,
      id,
      userId,
      QuotationStatus.Draft,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/Revise/);
  });

  it("cannot be converted once it has expired", () => {
    const id = quote(QuotationStatus.Sent);
    const result = convertToInvoice(db as never, id, userId, {
      today: "2026-02-15",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/expired/);
    // An accepted one is not "expired": the customer took it in time.
    const accepted = quote(QuotationStatus.Accepted);
    expect(
      convertToInvoice(db as never, accepted, userId, { today: "2026-02-15" })
        .ok,
    ).toBe(true);
  });
});
