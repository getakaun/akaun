import {
  createInvoice as _create,
  updateInvoice as _update,
  deleteInvoice as _delete,
  markInvoiceIssued,
  markInvoiceCancelled,
  relinkSourceQuotation,
  getInvoice,
  type InvoiceCreate,
  type InvoicePatch,
} from "$lib/server/queries/invoices.js";
import {
  createRecord,
  removeRecord,
  type DeferredEmits,
} from "$lib/server/services/ledger.js";
import { lockStateFor, reindexRecord } from "$lib/server/queries/ledger.js";
import { canDeleteRecord } from "$lib/server/ledger/locking.js";
import { requireAccountDefault } from "$lib/server/services/account-defaults.js";
import { getQuotation } from "$lib/server/queries/quotations.js";
import { invoiceEvents, quotationEvents } from "$lib/server/finance/events.js";
import { DefaultAccountPurpose, InvoiceStatus } from "$lib/enums.js";
import { canCancelInvoice } from "$lib/sales/status.js";
import { addDaysISO, daysBetweenISO, localToday } from "$lib/local-date.js";
import type { LedgerDb, Refusable } from "$lib/server/ledger/types.js";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = BunSQLiteDatabase<any>;
type Invoice = NonNullable<ReturnType<typeof getInvoice>>;

/** Thrown inside a transaction to undo every write in it. */
class Refused extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

export function createInvoice(
  db: Db,
  actingUserId: number,
  data: InvoiceCreate,
) {
  const invoice = _create(db, actingUserId, data);
  invoiceEvents.emit("invoice-update", { item: getInvoice(db, invoice.id) });
  return invoice;
}

export function patchInvoice(
  db: Db,
  id: number,
  actingUserId: number,
  patch: InvoicePatch,
) {
  const invoice = _update(db, id, actingUserId, patch);
  if (!invoice) return invoice;
  // A sent invoice's notes, terms and reference are part of its ledger record's
  // search text too (`reindexRecord`), so an edit has to reach both.
  if (invoice.ledgerRecordId !== null)
    reindexRecord(db as LedgerDb, invoice.ledgerRecordId);
  invoiceEvents.emit("invoice-update", { item: getInvoice(db, id) });
  return invoice;
}

export function removeInvoice(db: Db, id: number, actingUserId: number) {
  const result = _delete(db, id, actingUserId);
  if (result.ok) invoiceEvents.emit("invoice-delete", { id });
  // Deleting a converted quotation's invoice put that quotation back to
  // Accepted, so its list row changes too.
  if (result.revertedQuotationId !== undefined) {
    const quotation = getQuotation(db, result.revertedQuotationId);
    if (quotation)
      quotationEvents.emit("quotation-update", { item: quotation });
  }
  return result;
}

/**
 * Sending an invoice to the customer.
 *
 * Issuing is what puts the invoice into the books: its amount goes into Money
 * owed to us tagged with that customer, and out of the income account it earns
 * into. From then on the customer's payment is an ordinary payment settling
 * that amount, exactly like any other debt — so instalments and part payments
 * need nothing invoice-specific (FR-018a).
 *
 * The posting and the invoice's link to it are one transaction. Written as two,
 * a failure between them left a record in the books that no invoice pointed
 * at, and the invoice still a draft that could be sent — and owed — again.
 * Nothing is announced until it has committed.
 */
export function issueInvoice(
  db: Db,
  id: number,
  actingUserId: number,
  options: { incomeAccountId?: number } = {},
): Refusable<Invoice> {
  const deferredEmits: DeferredEmits = [];
  let issued: Invoice;
  try {
    issued = db.transaction((tx) => {
      // The ledger's functions are typed for the schema-aware handle; the
      // transaction is the same connection.
      const ledger = tx as unknown as LedgerDb;
      const invoice = getInvoice(tx, id);
      if (!invoice) throw new Refused("That invoice no longer exists.");

      if (
        invoice.ledgerRecordId !== null ||
        invoice.status !== InvoiceStatus.Draft
      ) {
        throw new Refused("This invoice has already been sent.");
      }
      if (invoice.contactId === null) {
        throw new Refused(
          "Choose a customer first — sending the invoice records that they owe you this amount.",
        );
      }

      const savedIncome =
        options.incomeAccountId === undefined
          ? requireAccountDefault(ledger, DefaultAccountPurpose.SalesRevenue)
          : ({ ok: true, value: options.incomeAccountId } as const);
      if (!savedIncome.ok) throw new Refused(savedIncome.reason);
      const incomeAccountId = savedIncome.value;

      const record = createRecord(
        ledger,
        actingUserId,
        {
          kind: "invoice-issue",
          date: invoice.issueDate,
          description: `Invoice ${invoice.invoiceNumber}`,
          amount: invoice.total,
          currency: invoice.currency,
          exchangeRate: invoice.exchangeRate,
          contactId: invoice.contactId,
          reference: invoice.invoiceNumber,
          incomeAccountId,
        },
        deferredEmits,
      );
      if (!record.ok) throw new Refused(record.reason);

      const marked = markInvoiceIssued(tx, id, actingUserId, {
        ledgerRecordId: record.value.id,
        incomeAccountId,
      });
      // The record was reindexed at creation, before this invoice was linked
      // back to it — its own notes/terms/lines only become findable now that
      // `reindexRecord` (queries/ledger.ts) can look the invoice back up by id.
      reindexRecord(ledger, record.value.id);
      return marked;
    });
  } catch (err) {
    if (err instanceof Refused) return { ok: false, reason: err.reason };
    throw err;
  }

  for (const emit of deferredEmits) emit();
  invoiceEvents.emit("invoice-update", { item: issued });
  return { ok: true, value: issued };
}

/**
 * Voiding a sent invoice: it keeps its number and is marked Cancelled, and the
 * posting that put it in the books is removed.
 *
 * Removed, not reversed — `ledger/types.ts` is frozen, so there is no reversing
 * kind to write. The cost is that the totals of the period it was issued in
 * change afterwards; the audit log keeps a snapshot of the deleted record.
 * Only while nothing has been paid: a payment settles the posting's owed side,
 * and removing it would leave that payment settling nothing.
 *
 * An invoice cancelled by the old PATCH still carries its posting, and is
 * finished the same way, so no migration is needed for it.
 *
 * One transaction, and every refusal comes before its first write.
 */
export function cancelInvoice(
  db: Db,
  id: number,
  actingUserId: number,
): Refusable<Invoice> {
  const result = voidInvoice(db, id, actingUserId, { reissue: false });
  return result.ok ? { ok: true, value: result.value.voided } : result;
}

/**
 * Voiding a sent invoice and issuing a corrected one in its place: the
 * standard way to change what a sent invoice says. The old one is voided
 * exactly as `cancelInvoice` does; the new one is a draft copy of it with the
 * next invoice number, dated today with the same term, linked back by
 * `replacesInvoiceId`. A quotation it was converted from follows it to the new
 * one. The draft is edited and sent like any other.
 *
 * `today` is a parameter only so a test can pin it.
 */
export function voidAndReissueInvoice(
  db: Db,
  id: number,
  actingUserId: number,
  options: { today?: string } = {},
): Refusable<{ voided: Invoice; invoice: Invoice }> {
  const result = voidInvoice(db, id, actingUserId, {
    reissue: true,
    today: options.today,
  });
  if (!result.ok) return result;
  return {
    ok: true,
    value: { voided: result.value.voided, invoice: result.value.reissued! },
  };
}

function voidInvoice(
  db: Db,
  id: number,
  actingUserId: number,
  options: { reissue: boolean; today?: string },
): Refusable<{ voided: Invoice; reissued: Invoice | null }> {
  const deferredEmits: DeferredEmits = [];
  let voided: Invoice;
  // Assigned inside the transaction's callback, which TS cannot see into —
  // without the casts it narrows both to `null` for good.
  let reissued = null as Invoice | null;
  let movedQuotationId = null as number | null;
  try {
    voided = db.transaction((tx) => {
      const ledger = tx as unknown as LedgerDb;
      const invoice = getInvoice(tx, id);
      if (!invoice) throw new Refused("That invoice no longer exists.");

      if (
        invoice.status === InvoiceStatus.Draft &&
        invoice.ledgerRecordId === null
      ) {
        throw new Refused(
          "This invoice has not been sent, so nothing is in the books yet. Delete it instead.",
        );
      }
      if (
        invoice.status === InvoiceStatus.Cancelled &&
        invoice.ledgerRecordId === null
      ) {
        throw new Refused("This invoice is already cancelled.");
      }
      if (invoice.paidMinor > 0) {
        throw new Refused(
          "A payment has been recorded against this invoice. Remove that payment first, then cancel the invoice.",
        );
      }
      // What is left: one marked paid before the upgrade, with nothing in the
      // books to say how much.
      if (!canCancelInvoice(invoice)) {
        throw new Refused(
          "This invoice is marked paid, so it cannot be cancelled.",
        );
      }

      const recordId = invoice.ledgerRecordId;
      if (recordId !== null) {
        // `removeRecord`'s own rule, asked before anything is written — a bank
        // match on the posting, say. Its wording is passed through as it is.
        const allowed = canDeleteRecord(lockStateFor(ledger, recordId));
        if (!allowed.ok) throw new Refused(allowed.reason);
      }

      // The invoice lets go of the posting first, and then the posting goes —
      // see `markInvoiceCancelled` for why the order matters to the audit log.
      // Its movements, and anything else hanging off it, cascade with it.
      markInvoiceCancelled(tx, id, actingUserId);
      if (recordId !== null) {
        const removed = removeRecord(ledger, recordId, actingUserId, {
          allowReadOnlyKind: true,
          deferredEmits,
        });
        // Its refusals were all asked above, so this should not refuse. If it
        // ever does, throwing undoes the cancellation written just before it.
        if (!removed.ok) throw new Refused(removed.reason);
      }

      if (options.reissue) {
        const today = options.today ?? localToday();
        // The same term the customer was given, counted from the new date.
        const termDays =
          invoice.dueDate === null
            ? null
            : daysBetweenISO(invoice.issueDate, invoice.dueDate);
        reissued = _create(tx, actingUserId, {
          contactId: invoice.contactId ?? null,
          reference: invoice.reference,
          issueDate: today,
          dueDate: termDays === null ? null : addDaysISO(today, termDays),
          currency: invoice.currency,
          exchangeRate: invoice.exchangeRate,
          notes: invoice.notes,
          terms: invoice.terms,
          sourceQuotationId: invoice.sourceQuotationId,
          replacesInvoiceId: id,
          lines: invoice.lines.map((line) => ({
            description: line.description,
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            sortOrder: line.sortOrder,
          })),
        });
      }
      movedQuotationId = relinkSourceQuotation(
        tx,
        id,
        reissued?.id ?? null,
        actingUserId,
      );
      return getInvoice(tx, id)!;
    });
  } catch (err) {
    if (err instanceof Refused) return { ok: false, reason: err.reason };
    throw err;
  }

  for (const emit of deferredEmits) emit();
  invoiceEvents.emit("invoice-update", { item: voided });
  if (reissued) invoiceEvents.emit("invoice-update", { item: reissued });
  if (movedQuotationId !== null) {
    quotationEvents.emit("quotation-update", {
      item: getQuotation(db, movedQuotationId),
    });
  }
  return { ok: true, value: { voided, reissued } };
}
