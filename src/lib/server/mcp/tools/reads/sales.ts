import { z } from "zod";
import { desc, eq, like, or } from "drizzle-orm";
import {
  InvoiceStatus,
  InvoiceStatusLabels,
  QuotationStatusLabels,
} from "$lib/enums.js";
import { resolveRecord } from "../../../application/refs.js";
import {
  invoiceVersion,
  quotationVersion,
} from "../../../application/version.js";
import { invoices, quotations } from "../../../db/schema.js";
import { toMinor } from "../../../ledger/money.js";
import { getInvoice, listInvoices } from "../../../queries/invoices.js";
import { getQuotation, listQuotations } from "../../../queries/quotations.js";
import { toolError, type ToolErrorBody } from "../../envelope.js";
import {
  enumCodec,
  enumLabel,
  mainCurrency,
  money,
  parsePeriodText,
} from "../../format.js";
import { pageResult, pagingShape, startPage } from "../../paging.js";
import { defineReadTool, type ToolDefinition } from "../../registry.js";
import { resolveError } from "../../resolve.js";
import {
  actionRefusal,
  GET_SALES_DOCUMENTS,
  missingForActions,
} from "../../requirements/index.js";
import { Refs, refInput } from "../writes/payments.js";

/**
 * `get_sales_documents`: invoices and quotations, one document or a list.
 *
 * `kind` is the argument the OAuth step-up reads (invoices need invoices read,
 * quotations quotations read), so it is required, and the handler checks it
 * again for the kind asked for. An invoice's owed movement and its
 * settlements' ids stay on the server: its payments are shown as the records
 * that paid it.
 */

/** Both kinds' status words, for the schema; each kind checks its own. */
const STATUS_FIELD = z
  .string()
  .trim()
  .max(40)
  .optional()
  .describe(
    "invoice: draft, sent, paid or cancelled. quotation: draft, sent, accepted, declined, converted or superseded.",
  );

const input = z.object({
  kind: z.enum(["invoice", "quotation"]).describe("Which documents."),
  id: z
    .union([z.number().int().positive(), z.string().trim().min(1).max(100)])
    .optional()
    .describe(
      "One document: its id (a number) or its number (a string). Omit to list.",
    ),
  status: STATUS_FIELD,
  contact: refInput
    .optional()
    .describe("Only this customer: id or exact name."),
  overdue: z
    .boolean()
    .optional()
    .describe("Invoices only: sent, past due and not fully paid."),
  query: z
    .string()
    .trim()
    .max(200)
    .optional()
    .describe("Text in the number, reference, contact or lines."),
  period: z
    .string()
    .optional()
    .describe(
      'Issue date: "2026-03", "2026-Q1", "2026" or "2026-03-01..2026-03-31".',
    ),
  detail: z
    .enum(["concise", "full"])
    .optional()
    .describe("full adds notes and terms to a list's rows."),
  ...pagingShape,
});

const DESCRIPTION = `Read invoices or quotations: one document in full, or a list. kind is required: invoice or quotation.

One document: send id, its id (a number) or its number (a string). You get the lines, the customer, dates, amounts and, for an invoice, what is paid and outstanding, the payments that settled it, the record it posted when sent, and the invoice it replaced or was replaced by; for a quotation, its revision chain and the invoice it became. v is the version change_sales_documents needs.

A list: filter by status (invoice: draft, sent, paid, cancelled; quotation: draft, sent, accepted, declined, converted, superseded), contact (id or exact name), overdue (invoices: sent, past due and not fully paid), query (text) and period (issue date). Newest first. Rows carry id, no, status, contact, issued, due or expires, amount, outstanding (invoices) and v. For a customer's whole position use get_contact; for receivables by age use get_report with aged_receivables.

Amounts are decimal strings. A document in another currency carries its own currency beside amount, and amount_main in the main currency; outstanding is always in the main currency. detail: "full" adds notes and terms to list rows. Paging: limit (50, at most 200) and cursor.`;

/**
 * An invoice's status as the app shows it: sent and fully paid is paid. Payment
 * is derived from the allocations and never stored, so the stored status stays
 * "sent" after the last payment.
 */
function invoiceStatus(doc: { status: number; paid: boolean }) {
  return doc.status === InvoiceStatus.Sent && doc.paid
    ? "paid"
    : enumLabel(InvoiceStatusLabels, doc.status);
}

const own = (amount: number) => money(toMinor(amount, 1));

type Brief = { currency: string; exchangeRate: number; total: number };

/**
 * A document's amount in its own currency, with the main-currency figure when
 * they differ. In a list the row names its own currency as `currency`; a single
 * document already has the response's `currency` (the main one), so it names
 * its own as `document_currency`.
 */
function amounts(
  doc: Brief,
  main: string,
  key: "currency" | "document_currency" = "currency",
) {
  const foreign = doc.currency !== main;
  return {
    amount: own(doc.total),
    ...(foreign ? { [key]: doc.currency } : {}),
    amount_main: foreign
      ? money(toMinor(doc.total, doc.exchangeRate))
      : undefined,
  };
}

const lineRows = (
  lines: {
    description: string;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
  }[],
) =>
  lines.map((line) => ({
    description: line.description,
    quantity: line.quantity,
    unit_price: own(line.unitPrice),
    total: own(line.lineTotal),
  }));

const statusError = (
  kind: string,
  status: string,
  labels: readonly string[],
): ToolErrorBody => ({
  code: "INVALID_INPUT",
  path: "status",
  message: `"${status}" is not a ${kind} status.`,
  fix: `Use one of: ${labels.join(", ")}.`,
});

const getSalesDocuments = defineReadTool({
  base: "get_sales_documents",
  title: "Get invoices or quotations",
  description: DESCRIPTION,
  input,
  requirements: GET_SALES_DOCUMENTS.requirements,
  handler: (ctx, args, meta) => {
    const { db } = ctx;
    const { kind } = args;
    const shortfalls = missingForActions(ctx.locals, "get_sales_documents", [
      kind,
    ]);
    if (shortfalls.length)
      return toolError(actionRefusal(meta.name, shortfalls));
    const main = mainCurrency(db);
    const isInvoice = kind === "invoice";
    const codec = enumCodec(
      isInvoice ? InvoiceStatusLabels : QuotationStatusLabels,
    );

    // --- one document ---------------------------------------------------------
    if (args.id !== undefined) {
      const table = isInvoice ? invoices : quotations;
      const number = isInvoice
        ? invoices.invoiceNumber
        : quotations.quotationNumber;
      const row =
        typeof args.id === "number"
          ? db
              .select({ id: table.id })
              .from(table)
              .where(eq(table.id, args.id))
              .get()
          : db
              .select({ id: table.id })
              .from(table)
              .where(eq(number, args.id))
              .get();
      if (!row) {
        const text = String(args.id);
        const near = db
          .select({ id: table.id, name: number, date: table.issueDate })
          .from(table)
          .where(
            or(like(number, `%${text}%`), like(number, `${text.slice(0, 4)}%`)),
          )
          .orderBy(desc(table.id))
          .limit(5)
          .all();
        return toolError(
          resolveError(
            {
              kind: "not_found",
              candidates: near.map((n) => ({
                id: n.id,
                name: n.name,
                detail: n.date,
              })),
            },
            {
              what: kind,
              ref: args.id,
              path: "id",
              lookup: meta.name,
              fix: `Send the ${kind}'s id, or its exact number; omit id to list.`,
            },
          ),
        );
      }
      const recordOf = (recordId: number | null) => {
        if (recordId === null) return undefined;
        const found = resolveRecord(ctx, recordId);
        return found.ok
          ? { id: recordId, no: found.value.recordNumber ?? `#${recordId}` }
          : { id: recordId };
      };
      if (isInvoice) {
        const doc = getInvoice(db, row.id)!;
        const source = doc.sourceQuotationId
          ? db
              .select({ no: quotations.quotationNumber })
              .from(quotations)
              .where(eq(quotations.id, doc.sourceQuotationId))
              .get()
          : undefined;
        return {
          kind,
          id: doc.id,
          no: doc.invoiceNumber,
          status: invoiceStatus(doc),
          contact: doc.contactId
            ? { id: doc.contactId, name: doc.contactName }
            : undefined,
          reference: doc.reference,
          issued: doc.issueDate,
          due: doc.dueDate,
          overdue: doc.isOverdue || undefined,
          currency: main,
          ...amounts(doc, main, "document_currency"),
          paid: money(doc.paidMinor),
          outstanding: money(doc.outstandingMinor),
          lines: lineRows(doc.lines),
          notes: doc.notes,
          terms: doc.terms,
          record: recordOf(doc.ledgerRecordId),
          payments: doc.settlements.map((s) => ({
            id: s.otherRecordId,
            no: s.otherRecordNumber ?? `#${s.otherRecordId}`,
            date: s.otherDate,
            amount: money(s.amountMinor),
            contact: s.otherContactName,
          })),
          replaces: doc.replaces
            ? { id: doc.replaces.id, no: doc.replaces.invoiceNumber }
            : undefined,
          replaced_by: doc.replacedBy
            ? { id: doc.replacedBy.id, no: doc.replacedBy.invoiceNumber }
            : undefined,
          from_quotation: source
            ? { id: doc.sourceQuotationId, no: source.no }
            : undefined,
          closed_through: doc.periodClosedThrough,
          v: invoiceVersion(db, doc.id),
        };
      }
      const doc = getQuotation(db, row.id)!;
      const converted = doc.convertedInvoiceId
        ? db
            .select({ no: invoices.invoiceNumber })
            .from(invoices)
            .where(eq(invoices.id, doc.convertedInvoiceId))
            .get()
        : undefined;
      return {
        kind,
        id: doc.id,
        no: doc.quotationNumber,
        status: enumLabel(QuotationStatusLabels, doc.status),
        contact: doc.contactId
          ? { id: doc.contactId, name: doc.contactName }
          : undefined,
        reference: doc.reference,
        issued: doc.issueDate,
        expires: doc.expiryDate,
        expired: doc.isExpired || undefined,
        currency: main,
        ...amounts(doc, main, "document_currency"),
        lines: lineRows(doc.lines),
        notes: doc.notes,
        terms: doc.terms,
        revision: doc.revision || undefined,
        revised_from: doc.revisedFrom
          ? { id: doc.revisedFrom.id, no: doc.revisedFrom.quotationNumber }
          : undefined,
        superseded_by: doc.supersededBy
          ? { id: doc.supersededBy.id, no: doc.supersededBy.quotationNumber }
          : undefined,
        converted_to:
          doc.convertedInvoiceId && converted
            ? { id: doc.convertedInvoiceId, no: converted.no }
            : undefined,
        v: quotationVersion(db, doc.id),
      };
    }

    // --- a list ---------------------------------------------------------------
    if (args.overdue !== undefined && !isInvoice)
      return toolError({
        code: "INVALID_INPUT",
        path: "overdue",
        message: "overdue applies to invoices only.",
        fix: "Drop overdue, or use kind invoice. For quotations filter by status.",
      });
    let status: number | undefined;
    if (args.status !== undefined) {
      status = codec.code(args.status);
      if (status === undefined)
        return toolError(statusError(kind, args.status, codec.labels));
    }
    let dateFrom: string | undefined;
    let dateTo: string | undefined;
    if (args.period !== undefined) {
      const period = parsePeriodText(args.period);
      if (!period.ok) return toolError(period.error);
      dateFrom = period.value.from ?? undefined;
      dateTo = period.value.to;
    }
    const refs = new Refs(ctx, meta);
    const contact =
      args.contact !== undefined
        ? refs.contact(args.contact, "contact")
        : undefined;
    const missed = refs.failure();
    if (missed) return missed;
    const page = startPage(args, args);
    if (!page.ok) return toolError(page.error);
    const full = args.detail === "full";

    const common = {
      status,
      contactId: contact?.id,
      search: args.query || undefined,
      dateFrom,
      dateTo,
    };
    if (isInvoice) {
      // "Overdue" and "paid" are derived from allocations after the page is
      // cut, so those filters read everything and page in memory.
      const byPayment =
        status === InvoiceStatus.Sent || status === InvoiceStatus.Paid;
      const derived = args.overdue === true || byPayment;
      const rows = listInvoices(db, {
        ...common,
        status: derived ? undefined : status,
        overdueOnly: args.overdue === true || undefined,
        limit: derived ? 1_000_000 : page.value.limit + 1,
        offset: derived ? 0 : page.value.offset,
      }).filter(
        (doc) => !byPayment || invoiceStatus(doc) === codec.label(status!),
      );
      const shown = derived
        ? rows.slice(
            page.value.offset,
            page.value.offset + page.value.limit + 1,
          )
        : rows;
      return pageResult({
        rows: shown.map((doc) => ({
          id: doc.id,
          no: doc.invoiceNumber,
          status: invoiceStatus(doc),
          contact: doc.contactName,
          issued: doc.issueDate,
          due: doc.dueDate,
          ...amounts(doc, main),
          outstanding: money(doc.outstandingMinor),
          overdue: doc.isOverdue || undefined,
          reference: doc.reference,
          ...(full ? { notes: doc.notes, terms: doc.terms } : {}),
          v: invoiceVersion(db, doc.id),
        })),
        page: page.value,
        total: derived ? rows.length : undefined,
        narrow: "status, contact, period or query",
        key: "invoices",
        head: { currency: main },
      });
    }
    const rows = listQuotations(db, {
      ...common,
      limit: page.value.limit + 1,
      offset: page.value.offset,
    });
    return pageResult({
      rows: rows.map((doc) => ({
        id: doc.id,
        no: doc.quotationNumber,
        status: enumLabel(QuotationStatusLabels, doc.status),
        contact: doc.contactName,
        issued: doc.issueDate,
        expires: doc.expiryDate,
        expired: doc.isExpired || undefined,
        ...amounts(doc, main),
        reference: doc.reference,
        ...(full ? { notes: doc.notes, terms: doc.terms } : {}),
        v: quotationVersion(db, doc.id),
      })),
      page: page.value,
      narrow: "status, contact, period or query",
      key: "quotations",
      head: { currency: main },
    });
  },
});

/** The sales document read tools, in listing order. */
export const salesReadTools: readonly ToolDefinition[] = [getSalesDocuments];
