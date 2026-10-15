import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  InvoiceStatusLabels,
  QuotationStatusLabels,
  invoiceStatusEnum,
  quotationStatusEnum,
} from "$lib/enums.js";
import { getInvoice, listInvoices } from "../../queries/invoices.js";
import { getQuotation, listQuotations } from "../../queries/quotations.js";
import {
  convertQuotation,
  createInvoice,
  createInvoiceShape,
  createQuotation,
  createQuotationShape,
  deleteInvoice,
  deleteQuotation,
  issueInvoice,
  QUOTATION_STATUS_BY_NAME,
  reviseQuotation,
  setQuotationStatus,
  updateInvoice,
  updateInvoiceShape,
  updateQuotation,
  updateQuotationShape,
  voidInvoice,
} from "../../application/sales.js";
import { invoiceVersion, quotationVersion } from "../../application/version.js";
import {
  checkDateRange,
  dateRangeShape,
  expectedVersion,
  id,
  McpToolError,
  pageShape,
  registerRead,
  registerWrite,
  type McpContext,
} from "../common.js";

type Invoice = NonNullable<ReturnType<typeof getInvoice>>;
type Quotation = NonNullable<ReturnType<typeof getQuotation>>;

function invoiceSummary(row: ReturnType<typeof listInvoices>[number]) {
  return {
    id: row.id,
    invoiceNumber: row.invoiceNumber,
    status: InvoiceStatusLabels[row.status],
    contactId: row.contactId,
    contactName: row.contactName,
    reference: row.reference,
    issueDate: row.issueDate,
    dueDate: row.dueDate,
    currency: row.currency,
    exchangeRate: row.exchangeRate,
    total: row.total,
    paid: row.paid,
    outstandingMinor: row.outstandingMinor,
    isOverdue: row.isOverdue,
    ledgerRecordId: row.ledgerRecordId,
    path: `/invoices/${row.id}`,
  };
}

function invoiceDetail(context: McpContext, invoice: Invoice) {
  return {
    ...invoiceSummary(invoice),
    notes: invoice.notes,
    terms: invoice.terms,
    lines: invoice.lines.map((line) => ({
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      lineTotal: line.lineTotal,
    })),
    owedMovementId: invoice.owedMovementId,
    settlements: invoice.settlements,
    sourceQuotationId: invoice.sourceQuotationId,
    replaces: invoice.replaces,
    replacedBy: invoice.replacedBy,
    version: invoiceVersion(context.db, invoice.id),
  };
}

function quotationSummary(row: ReturnType<typeof listQuotations>[number]) {
  return {
    id: row.id,
    quotationNumber: row.quotationNumber,
    status: QuotationStatusLabels[row.status],
    contactId: row.contactId,
    contactName: row.contactName,
    reference: row.reference,
    issueDate: row.issueDate,
    expiryDate: row.expiryDate,
    isExpired: row.isExpired,
    currency: row.currency,
    exchangeRate: row.exchangeRate,
    total: row.total,
    path: `/quotations/${row.id}`,
  };
}

function quotationDetail(context: McpContext, quotation: Quotation) {
  return {
    ...quotationSummary(quotation),
    notes: quotation.notes,
    terms: quotation.terms,
    lines: quotation.lines.map((line) => ({
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      lineTotal: line.lineTotal,
    })),
    revisedFrom: quotation.revisedFrom,
    supersededBy: quotation.supersededBy,
    version: quotationVersion(context.db, quotation.id),
  };
}

/** Lists have no count query, so ask for one more row to know if there is more. */
function page<T>(rows: T[], input: { limit: number; offset: number }) {
  const hasMore = rows.length > input.limit;
  const items = rows.slice(0, input.limit);
  return {
    items,
    pagination: {
      returned: items.length,
      limit: input.limit,
      offset: input.offset,
      hasMore,
      nextOffset: hasMore ? input.offset + items.length : null,
    },
  };
}

export function registerSales(server: McpServer, context: McpContext) {
  // ------------------------------------------------------------------ reads
  registerRead(
    server,
    context,
    "list_invoices",
    "Search invoices by status, customer, issue date or text. Amounts are in each invoice's own currency; outstandingMinor is main-currency cents still owed. Use get_invoice for lines, settlements and the owedMovementId a payment settles.",
    {
      ...dateRangeShape,
      ...pageShape,
      status: z.enum(["draft", "sent", "paid", "cancelled"]).optional(),
      contactId: id.optional(),
      overdueOnly: z.boolean().optional(),
      search: z.string().trim().max(200).optional(),
    },
    (input) => {
      checkDateRange(input);
      const rows = listInvoices(context.db, {
        ...input,
        status: input.status
          ? (invoiceStatusEnum.fromLabel(input.status) ?? undefined)
          : undefined,
        limit: input.limit + 1,
      });
      const { items, pagination } = page(rows, input);
      return {
        invoices: items.map(invoiceSummary),
        pagination,
        filters: input,
      };
    },
  );

  registerRead(
    server,
    context,
    "get_invoice",
    "Read one invoice: lines, payment state, settlements, the record it posted when sent, and `owedMovementId` — what record_payment settles to mark it paid. Returns `version` for changes.",
    { invoiceId: id },
    ({ invoiceId }) => {
      const invoice = getInvoice(context.db, invoiceId);
      if (!invoice)
        throw new McpToolError("NOT_FOUND", "That invoice does not exist.");
      return { invoice: invoiceDetail(context, invoice) };
    },
  );

  registerRead(
    server,
    context,
    "list_quotations",
    "Search quotations by status, customer, issue date or text.",
    {
      ...dateRangeShape,
      ...pageShape,
      status: z
        .enum([
          "draft",
          "sent",
          "accepted",
          "declined",
          "converted",
          "superseded",
        ])
        .optional(),
      contactId: id.optional(),
      search: z.string().trim().max(200).optional(),
    },
    (input) => {
      checkDateRange(input);
      const rows = listQuotations(context.db, {
        ...input,
        status: input.status
          ? (quotationStatusEnum.fromLabel(input.status) ?? undefined)
          : undefined,
        limit: input.limit + 1,
      });
      const { items, pagination } = page(rows, input);
      return {
        quotations: items.map(quotationSummary),
        pagination,
        filters: input,
      };
    },
  );

  registerRead(
    server,
    context,
    "get_quotation",
    "Read one quotation with its lines and revision chain. Returns `version` for changes.",
    { quotationId: id },
    ({ quotationId }) => {
      const quotation = getQuotation(context.db, quotationId);
      if (!quotation)
        throw new McpToolError("NOT_FOUND", "That quotation does not exist.");
      return { quotation: quotationDetail(context, quotation) };
    },
  );

  // ----------------------------------------------------------------- writes
  const invoiceResult = (result: ReturnType<typeof createInvoice>) =>
    result.ok
      ? {
          ok: true as const,
          value: { invoice: invoiceDetail(context, result.value.invoice) },
        }
      : result;
  const quotationResult = (result: ReturnType<typeof createQuotation>) =>
    result.ok
      ? {
          ok: true as const,
          value: {
            quotation: quotationDetail(context, result.value.quotation),
          },
        }
      : result;
  const linesNote =
    "`lines` are {description, quantity, unitPrice} in the document's currency; totals are worked out by the app.";

  registerWrite(
    server,
    context,
    "create_invoice",
    `Create a draft invoice. Name the customer by contactId, or by newContactName to match or create one (creating needs contacts access). ${linesNote} A draft is not in the books until issue_invoice.`,
    createInvoiceShape,
    (input) => invoiceResult(createInvoice(context, input)),
  );

  registerWrite(
    server,
    context,
    "update_invoice",
    `Change an invoice. A draft can change anything; once sent its customer, issue date, currency, rate and lines are fixed (void_invoice with reissue instead), but reference, due date, notes and terms can still be corrected. Cancelled invoices are refused. ${linesNote}`,
    { invoiceId: id, expectedVersion, ...updateInvoiceShape },
    ({ invoiceId, expectedVersion, ...input }) =>
      invoiceResult(updateInvoice(context, invoiceId, input, expectedVersion)),
    { idempotent: true, ids: (input) => ({ invoiceId: input.invoiceId }) },
  );

  registerWrite(
    server,
    context,
    "issue_invoice",
    "Mark a draft invoice as sent. This puts it in the books: the customer owes its total (Money owed to us) against the default sales account, or `incomeAccountId` (an open Revenue account). The app does not email it. Requires a customer.",
    { invoiceId: id, expectedVersion, incomeAccountId: id.optional() },
    ({ invoiceId, expectedVersion, incomeAccountId }) =>
      invoiceResult(
        issueInvoice(context, invoiceId, { incomeAccountId }, expectedVersion),
      ),
    { ids: (input) => ({ invoiceId: input.invoiceId }) },
  );

  registerWrite(
    server,
    context,
    "void_invoice",
    "Void a sent invoice: it keeps its number, is marked cancelled and its posting leaves the books (including past reports). Refused once anything is paid against it or its posting is bank-matched. With `reissue`, a corrected draft copy is created to edit and send. Confirm with the user before calling.",
    { invoiceId: id, expectedVersion, reissue: z.boolean().default(false) },
    ({ invoiceId, expectedVersion, reissue }) => {
      const result = voidInvoice(
        context,
        invoiceId,
        { reissue },
        expectedVersion,
      );
      return result.ok
        ? {
            ok: true as const,
            value: {
              voided: invoiceDetail(context, result.value.invoice),
              reissued: result.value.reissued
                ? invoiceDetail(context, result.value.reissued.invoice)
                : null,
            },
          }
        : result;
    },
    { destructive: true, ids: (input) => ({ invoiceId: input.invoiceId }) },
  );

  registerWrite(
    server,
    context,
    "delete_invoice",
    "Permanently delete a draft invoice. Sent invoices are voided instead, and cancelled ones keep their number. Confirm with the user before calling.",
    { invoiceId: id, expectedVersion },
    ({ invoiceId, expectedVersion }) =>
      deleteInvoice(context, invoiceId, expectedVersion),
    { destructive: true, ids: (input) => ({ invoiceId: input.invoiceId }) },
  );

  registerWrite(
    server,
    context,
    "create_quotation",
    `Create a draft quotation. Name the customer by contactId or newContactName. ${linesNote}`,
    createQuotationShape,
    (input) => quotationResult(createQuotation(context, input)),
  );

  registerWrite(
    server,
    context,
    "update_quotation",
    `Change a quotation. Once sent, its customer, date, currency, rate and lines are fixed: use revise_quotation. Converted and superseded quotations are refused. ${linesNote}`,
    { quotationId: id, expectedVersion, ...updateQuotationShape },
    ({ quotationId, expectedVersion, ...input }) =>
      quotationResult(
        updateQuotation(context, quotationId, input, expectedVersion),
      ),
    { idempotent: true, ids: (input) => ({ quotationId: input.quotationId }) },
  );

  registerWrite(
    server,
    context,
    "set_quotation_status",
    "Record that a quotation was sent, accepted or declined. Converted and superseded are reached only through their own tools.",
    {
      quotationId: id,
      expectedVersion,
      status: z.enum(
        Object.keys(QUOTATION_STATUS_BY_NAME) as [
          "sent",
          "accepted",
          "declined",
        ],
      ),
    },
    ({ quotationId, expectedVersion, status }) =>
      quotationResult(
        setQuotationStatus(context, quotationId, status, expectedVersion),
      ),
    { idempotent: true, ids: (input) => ({ quotationId: input.quotationId }) },
  );

  registerWrite(
    server,
    context,
    "revise_quotation",
    "Replace a sent quotation with a new draft revision to edit and send; the old one is kept as superseded.",
    { quotationId: id, expectedVersion },
    ({ quotationId, expectedVersion }) => {
      const result = reviseQuotation(context, quotationId, expectedVersion);
      return result.ok
        ? {
            ok: true as const,
            value: {
              quotation: quotationDetail(context, result.value.quotation),
              previous: quotationDetail(
                context,
                result.value.previous.quotation,
              ),
            },
          }
        : result;
    },
    { ids: (input) => ({ quotationId: input.quotationId }) },
  );

  registerWrite(
    server,
    context,
    "convert_quotation_to_invoice",
    "Turn an accepted quotation into a draft invoice with the same customer and lines. The invoice still needs issue_invoice to enter the books.",
    { quotationId: id, expectedVersion },
    ({ quotationId, expectedVersion }) => {
      const result = convertQuotation(context, quotationId, expectedVersion);
      return result.ok
        ? {
            ok: true as const,
            value: {
              quotation: quotationDetail(context, result.value.quotation),
              invoice: invoiceDetail(context, result.value.invoice.invoice),
            },
          }
        : result;
    },
    { ids: (input) => ({ quotationId: input.quotationId }) },
  );

  registerWrite(
    server,
    context,
    "delete_quotation",
    "Permanently delete a quotation. Converted and superseded quotations are kept. Confirm with the user before calling.",
    { quotationId: id, expectedVersion },
    ({ quotationId, expectedVersion }) =>
      deleteQuotation(context, quotationId, expectedVersion),
    { destructive: true, ids: (input) => ({ quotationId: input.quotationId }) },
  );
}
