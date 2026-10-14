import {
  InvoiceStatus,
  QuotationStatus,
  QuotationStatusLabels,
} from "$lib/enums.js";

/**
 * The status rules for quotations and invoices, written once for both sides.
 *
 * Outside `$lib/server` on purpose: the screens and the endpoints import this
 * same file, so there is no `// Mirrors` copy to keep in step by hand.
 *
 * Each key is one of `StatusBadge.svelte`'s lowercase `byLabel` keys. A badge
 * given anything else falls back to "Unpaid", which is how both detail pages
 * came to show the wrong chip.
 */

export type InvoiceStatusKey =
  | "cancelled"
  | "draft"
  | "paid"
  | "part-paid"
  | "overdue"
  | "sent";

/**
 * What an invoice's chip says. The stored status only ever says draft, sent or
 * cancelled; paid and part-paid come from what has been settled against it, and
 * overdue from its due date (D-10).
 */
export function invoiceStatusKey(inv: {
  status: number;
  paid: boolean;
  paidMinor: number;
  isOverdue: boolean;
}): InvoiceStatusKey {
  if (inv.status === InvoiceStatus.Cancelled) return "cancelled";
  if (inv.status === InvoiceStatus.Draft) return "draft";
  if (inv.paid) return "paid";
  if (inv.isOverdue) return "overdue";
  if (inv.paidMinor > 0) return "part-paid";
  return "sent";
}

/** What a quotation's chip says. Expired is worked out from the date, never stored. */
export function quotationStatusKey(q: {
  status: number;
  isExpired: boolean;
}): string {
  if (
    q.isExpired &&
    (q.status === QuotationStatus.Draft || q.status === QuotationStatus.Sent)
  ) {
    return "expired";
  }
  return QuotationStatusLabels[q.status] ?? "draft";
}

const QUOTATION_CODES = new Set<number>(Object.values(QuotationStatus));

/**
 * Whether a quotation may be moved from one status to another by hand.
 *
 * Converted is reached only by converting, and left only by deleting the
 * invoice it became; Superseded only by revising, and left only by deleting the
 * revision. Neither is ever a choice on either end. Nor is going back to Draft:
 * a quote the customer has seen is sealed (`isQuotationSealed`), and moving it
 * back to Draft would unseal it — a change to one that has gone out is a
 * revision.
 */
export function canSetQuotationStatus(from: number, to: number): boolean {
  if (!QUOTATION_CODES.has(from) || !QUOTATION_CODES.has(to)) return false;
  const terminal: number[] = [
    QuotationStatus.Converted,
    QuotationStatus.Superseded,
  ];
  if (terminal.includes(from) || terminal.includes(to)) return false;
  if (to === QuotationStatus.Draft) return false;
  return from !== to;
}

/**
 * A quote becomes an invoice once it has gone to the customer: Sent or
 * Accepted. Not once a sent quote has expired — the price it offered has
 * lapsed, so it is extended or revised first.
 */
export function canConvert(q: {
  status: number;
  isExpired?: boolean;
}): boolean {
  if (q.isExpired) return false;
  return (
    q.status === QuotationStatus.Sent || q.status === QuotationStatus.Accepted
  );
}

/**
 * A quotation is sealed once it has left Draft: the customer has a copy, so
 * what it offers — customer, date, currency, rate and lines — is fixed, and a
 * change to it is a revision. The wording around it (reference, notes, terms)
 * and its expiry can still be corrected, the same four a sent invoice keeps.
 */
export function isQuotationSealed(q: { status: number }): boolean {
  return q.status !== QuotationStatus.Draft;
}

/**
 * What a sealed quotation or sent invoice no longer takes in an edit. One list,
 * so the form and both endpoints agree on it.
 */
export const SEALED_SALES_FIELDS = [
  "contactId",
  "issueDate",
  "currency",
  "exchangeRate",
  "lines",
] as const;

/**
 * Whether a quotation can be revised into a new draft: it has gone out and is
 * still the live version — not a draft (edit it), not converted (the invoice is
 * the record now), not already superseded.
 */
export function canRevise(q: { status: number }): boolean {
  return (
    q.status === QuotationStatus.Sent ||
    q.status === QuotationStatus.Accepted ||
    q.status === QuotationStatus.Declined
  );
}

/**
 * Whether an invoice can be voided: it was sent, and nothing has been paid
 * against it. An invoice cancelled before voiding removed its posting still
 * carries one, and can be finished the same way.
 */
export function canCancelInvoice(inv: {
  status: number;
  ledgerRecordId: number | null;
  paidMinor: number;
}): boolean {
  if (inv.paidMinor > 0) return false;
  if (inv.status === InvoiceStatus.Sent) return true;
  return inv.status === InvoiceStatus.Cancelled && inv.ledgerRecordId !== null;
}
