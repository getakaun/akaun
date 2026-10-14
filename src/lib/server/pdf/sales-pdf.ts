import { existsSync } from "fs";
import { join } from "path";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { InvoiceStatus, QuotationStatus } from "$lib/enums.js";
import { DEFAULT_PDF_THEME_COLOR } from "$lib/pdf/theme-presets.js";
import { STORAGE_PATH } from "$lib/server/env.js";
import type { LayoutRenderData, StatusStamp } from "$lib/pdf/render-types.js";
import { getSetting, SETTING_KEYS } from "$lib/server/settings.js";
import { toMinor } from "$lib/server/ledger/money.js";
import type { getInvoice } from "$lib/server/queries/invoices.js";
import type { getQuotation } from "$lib/server/queries/quotations.js";
import { getLayout } from "./layouts/index.js";

/**
 * The printable copy of a quotation or an invoice, written once for both.
 *
 * The two PDF routes used to be near-copies: each read the company settings,
 * picked a layout, fell back to a theme colour of its own, and spread the
 * document into the renderer. What they differ in is the document; everything
 * else lives here, so a route is a permission check and one call.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = BunSQLiteDatabase<any>;
type Invoice = NonNullable<ReturnType<typeof getInvoice>>;
type Quotation = NonNullable<ReturnType<typeof getQuotation>>;

/**
 * How much of an invoice is paid and how much is still due, in the invoice's
 * own currency.
 *
 * The ledger keeps whole cents of the main currency, so `outstandingMinor` is
 * MYR cents on a USD invoice. Printing it beside "USD" would be wrong, so it is
 * taken back through the invoice's rate. When nothing has been paid the total
 * is used as it is, so an unpaid invoice — and every invoice at rate 1 — prints
 * exactly what its lines add up to, with no trip through the rate at all.
 *
 * A draft owes nothing yet, but its copy is a preview of what it will ask for,
 * so it shows the whole total as due. A cancelled one owes nothing and asks for
 * nothing.
 */
export function invoicePdfAmounts(
  doc: Pick<
    Invoice,
    "status" | "total" | "exchangeRate" | "totalMinor" | "outstandingMinor"
  >,
): { amountDue: number; amountPaid: number } {
  if (doc.status === InvoiceStatus.Cancelled) {
    return { amountDue: 0, amountPaid: 0 };
  }
  if (doc.status === InvoiceStatus.Draft) {
    return { amountDue: doc.total, amountPaid: 0 };
  }
  // Whole cents of the invoice's own currency, so the two figures always add
  // back up to the total.
  const totalCents = toMinor(doc.total, 1);
  const dueCents =
    doc.outstandingMinor === doc.totalMinor
      ? totalCents
      : Math.round(doc.outstandingMinor / doc.exchangeRate);
  return {
    amountDue: dueCents / 100,
    amountPaid: (totalCents - dueCents) / 100,
  };
}

/**
 * The word across the page, if any. A quotation has one only once a revision
 * has replaced it; a draft quotation is not stamped, since sending one is not
 * a demand for anything.
 */
export function statusStampFor(
  kind: "invoice" | "quotation",
  doc: { status: number },
): StatusStamp | null {
  if (kind === "quotation") {
    return doc.status === QuotationStatus.Superseded ? "SUPERSEDED" : null;
  }
  if (doc.status === InvoiceStatus.Cancelled) return "VOID";
  if (doc.status === InvoiceStatus.Draft) return "DRAFT";
  return null;
}

/**
 * The letterhead file to print in place of the company name, or undefined to
 * print the name. Only when the book chose the letterhead header and its file
 * is still there — a choice left behind by a removed letterhead falls back to
 * the name rather than leaving the top of the page empty.
 */
export function resolveLetterhead(
  header: string | null,
  relPath: string | null,
  storageRoot: string,
): string | undefined {
  if (header !== "letterhead" || !relPath) return undefined;
  const abs = join(storageRoot, relPath);
  return existsSync(abs) ? abs : undefined;
}

/** What the layout is handed: the document's fields, named the layout's way. */
export function salesPdfData(
  kind: "invoice" | "quotation",
  doc: Invoice | Quotation,
  settings: LayoutRenderData["settings"],
): LayoutRenderData {
  const common = {
    issueDate: doc.issueDate,
    reference: doc.reference,
    currency: doc.currency,
    lines: doc.lines.map((l) => ({
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      lineTotal: l.lineTotal,
    })),
    subtotal: doc.subtotal,
    total: doc.total,
    notes: doc.notes,
    terms: doc.terms,
    contactName: doc.contactName ?? null,
    contactAddress: doc.contactAddress ?? null,
    contactRegistrationNo: doc.contactRegistrationNo ?? null,
    contactPhone: doc.contactPhone ?? null,
  };

  if (kind === "quotation") {
    const quotation = doc as Quotation;
    return {
      document: {
        ...common,
        quotationNumber: quotation.quotationNumber,
        expiryDate: quotation.expiryDate,
      },
      settings,
      docTypeLabel: "QUOTATION",
      statusStamp: statusStampFor("quotation", quotation),
    };
  }

  const invoice = doc as Invoice;
  return {
    document: {
      ...common,
      invoiceNumber: invoice.invoiceNumber,
      dueDate: invoice.dueDate,
      isOverdue: invoice.isOverdue,
      // A cancelled invoice is never "paid", whatever its old status said.
      paid: invoice.status !== InvoiceStatus.Cancelled && invoice.paid,
      ...invoicePdfAmounts(invoice),
      settlements: invoice.settlements,
    },
    settings,
    docTypeLabel: "INVOICE",
    statusStamp: statusStampFor("invoice", invoice),
  };
}

export function salesPdfResponse(
  db: Db,
  kind: "invoice",
  doc: Invoice,
): Promise<Response>;
export function salesPdfResponse(
  db: Db,
  kind: "quotation",
  doc: Quotation,
): Promise<Response>;
export async function salesPdfResponse(
  db: Db,
  kind: "invoice" | "quotation",
  doc: Invoice | Quotation,
): Promise<Response> {
  const number =
    kind === "invoice"
      ? (doc as Invoice).invoiceNumber
      : (doc as Quotation).quotationNumber;

  const settings = {
    companyName: getSetting(db, SETTING_KEYS.companyName) ?? "",
    companyAddress: getSetting(db, SETTING_KEYS.companyAddress) ?? "",
    companyRegistrationNo:
      getSetting(db, SETTING_KEYS.companyRegistrationNo) ?? "",
    letterheadPath: resolveLetterhead(
      getSetting(db, SETTING_KEYS.pdfHeader),
      getSetting(db, SETTING_KEYS.companyLetterheadPath),
      STORAGE_PATH,
    ),
  };
  // The same default the Settings picker shows, so a book that never chose a
  // colour prints in the one it was shown.
  const theme = {
    color:
      getSetting(db, SETTING_KEYS.pdfThemeColor) || DEFAULT_PDF_THEME_COLOR,
  };

  try {
    const render = getLayout(
      getSetting(
        db,
        kind === "invoice"
          ? SETTING_KEYS.pdfInvoiceLayoutKey
          : SETTING_KEYS.pdfQuotationLayoutKey,
      ),
    );
    const buffer = await render(
      salesPdfData(kind, doc, settings),
      theme,
      number,
    );
    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${number}.pdf"`,
      },
    });
  } catch (err) {
    console.error(`PDF generation failed for ${kind}`, doc.id, err);
    return new Response("PDF generation failed", { status: 500 });
  }
}
