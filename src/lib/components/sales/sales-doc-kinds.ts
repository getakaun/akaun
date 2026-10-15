import { Role } from "$lib/enums.js";
import type { getInvoice } from "$lib/server/queries/invoices.js";
import type { getQuotation } from "$lib/server/queries/quotations.js";

/**
 * What differs between a quotation and an invoice on the screens that write
 * them — and nothing else. The form, the create page and the read-only lines
 * are one component each; these are the only places the two kinds part ways.
 */

export type SalesDocKind = "invoice" | "quotation";

export type Invoice = NonNullable<ReturnType<typeof getInvoice>>;
export type Quotation = NonNullable<ReturnType<typeof getQuotation>>;
export type SalesDoc<K extends SalesDocKind> = K extends "invoice"
  ? Invoice
  : Quotation;

/** A quick-pick beside the second date: that many days after the issue date. */
export type TermOption = { days: number; label: string; title: string };

function dayTerms(days: number[]): TermOption[] {
  return days.map((d) => ({ days: d, label: `${d}d`, title: `${d} days` }));
}

type KindConfig = {
  /** The noun, capitalised, for headings. */
  noun: string;
  apiBase: string;
  listHref: string;
  listLabel: string;
  /** The date after the issue date: when it is due, or until when it holds. */
  dateField: "dueDate" | "expiryDate";
  dateLabel: string;
  datePlaceholder: string;
  /** What the term quick-picks are, for a screen reader. */
  termsLabel: string;
  terms: TermOption[];
  /** Prefix for element ids, so a label's `for` stays unique per kind. */
  idPrefix: string;
  /** The role a contact created from the form is given. */
  contactRole: number;
};

export const SALES_DOC_KINDS: Record<SalesDocKind, KindConfig> = {
  invoice: {
    noun: "Invoice",
    apiBase: "/api/invoices",
    listHref: "/invoices",
    listLabel: "Invoices",
    dateField: "dueDate",
    dateLabel: "Due date",
    datePlaceholder: "No due date",
    termsLabel: "Payment terms",
    terms: [
      { days: 0, label: "On receipt", title: "Due on receipt" },
      ...dayTerms([7, 14, 30, 60]),
    ],
    idPrefix: "inv",
    contactRole: Role.Customer,
  },
  quotation: {
    noun: "Quotation",
    apiBase: "/api/quotations",
    listHref: "/quotations",
    listLabel: "Quotations",
    dateField: "expiryDate",
    dateLabel: "Expiry date",
    datePlaceholder: "No expiry",
    termsLabel: "Valid for",
    terms: dayTerms([15, 30, 60]),
    idPrefix: "quo",
    contactRole: Role.Customer,
  },
};

/** A document's second date, whichever field it lives in. */
export function secondDateOf(doc: Invoice | Quotation): string | null {
  return "dueDate" in doc ? doc.dueDate : doc.expiryDate;
}
