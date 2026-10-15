import { z } from "zod";
import {
  AccountType,
  InvoiceStatus,
  QuotationStatus,
  Role,
} from "$lib/enums.js";
import { isQuotationSealed, SEALED_SALES_FIELDS } from "$lib/sales/status.js";
import { canEditQuotation } from "../locking.js";
import { salesLinesSchema, salesRateSchema } from "../sales/schema.js";
import { getInvoice } from "../queries/invoices.js";
import { getQuotation } from "../queries/quotations.js";
import { getAccount } from "../queries/accounts.js";
import {
  findContactByName,
  resolveOrCreateContact,
} from "../queries/contacts.js";
import {
  cancelInvoice,
  createInvoice as createInvoiceService,
  issueInvoice as issueInvoiceService,
  patchInvoice,
  removeInvoice,
  voidAndReissueInvoice,
} from "../services/invoices.js";
import {
  convertToInvoice,
  createQuotation as createQuotationService,
  patchQuotation,
  removeQuotation,
  reviseQuotation as reviseQuotationService,
  setQuotationStatus as setQuotationStatusService,
} from "../services/quotations.js";
import { can } from "../permissions.js";
import { actor, requirePermissions, type AppContext } from "./context.js";
import { fail, missing, ok, type AppResult } from "./result.js";
import { isoDate, positiveId } from "./records.js";
import { checkVersion, invoiceVersion, quotationVersion } from "./version.js";

/**
 * Invoices and quotations as authorized operations.
 *
 * What a sent document may still change used to be written in each PATCH route
 * (`SEALED_SALES_FIELDS`, `canEditQuotation`, the cancelled-invoice refusal);
 * it lives here now, so the MCP tools cannot get round it.
 */

type Invoice = NonNullable<ReturnType<typeof getInvoice>>;
type Quotation = NonNullable<ReturnType<typeof getQuotation>>;

const text = (max: number) => z.string().trim().max(max).nullable().optional();

/** What both documents carry. Unknown keys are dropped, as the routes always did. */
const documentShape = {
  contactId: positiveId.nullable().optional(),
  /** A customer to find by name, or create with the Customer role (needs contacts:add). */
  newContactName: z.string().trim().min(1).max(200).optional(),
  reference: text(200),
  issueDate: isoDate,
  currency: z.string().trim().length(3).toUpperCase().optional(),
  exchangeRate: salesRateSchema.optional(),
  notes: text(20000),
  terms: text(20000),
  lines: salesLinesSchema,
};

export const createInvoiceShape = {
  ...documentShape,
  dueDate: isoDate.nullable().optional(),
};
export const createQuotationShape = {
  ...documentShape,
  expiryDate: isoDate.nullable().optional(),
};

export const updateInvoiceShape = z.object(createInvoiceShape).partial().shape;
export const updateQuotationShape = z
  .object(createQuotationShape)
  .partial().shape;

const createInvoiceSchema = z.object(createInvoiceShape);
const createQuotationSchema = z.object(createQuotationShape);
const updateInvoiceSchema = z.object(updateInvoiceShape);
const updateQuotationSchema = z.object(updateQuotationShape);

/** A 400 whose sentence is the first problem, the one the forms show. */
function invalidDocument(error: z.ZodError) {
  return {
    ok: false as const,
    code: "INVALID_INPUT" as const,
    reason: error.issues[0]?.message ?? "Some of what was sent is not valid.",
    issues: error.issues,
  };
}

/**
 * The contact a document names. A new name that matches no customer creates
 * one, and that is adding a contact — asked for here rather than let through
 * on the document's own ability.
 */
function resolveContact(
  ctx: AppContext,
  input: { contactId?: number | null; newContactName?: string },
): AppResult<number | null | undefined> {
  if (input.contactId || !input.newContactName) return ok(input.contactId);
  const existing = findContactByName(
    ctx.db,
    input.newContactName,
    Role.Customer,
  );
  // Through a token or an app, `locals.permissions` already holds only what
  // it was granted, so this asks the token's scope and the user's role alike.
  if (!existing && !can(ctx.locals, "contacts.create")) {
    return fail(
      "FORBIDDEN",
      "Creating a new customer needs permission to add contacts. Choose an existing customer instead.",
    );
  }
  return ok(
    existing?.id ??
      resolveOrCreateContact(
        ctx.db,
        input.newContactName,
        Role.Customer,
        actor(ctx),
      ),
  );
}

function definedFields(input: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(input).filter(
      ([key, value]) => key !== "newContactName" && value !== undefined,
    ),
  );
}

export type InvoiceWritten = { invoice: Invoice; version: string };
export type QuotationWritten = { quotation: Quotation; version: string };

function invoiceWritten(
  ctx: AppContext,
  id: number,
): AppResult<InvoiceWritten> {
  const invoice = getInvoice(ctx.db, id);
  return invoice
    ? ok({ invoice, version: invoiceVersion(ctx.db, id) })
    : missing("That invoice no longer exists.");
}

function quotationWritten(
  ctx: AppContext,
  id: number,
): AppResult<QuotationWritten> {
  const quotation = getQuotation(ctx.db, id);
  return quotation
    ? ok({ quotation, version: quotationVersion(ctx.db, id) })
    : missing("That quotation no longer exists.");
}

// ---------------------------------------------------------------- invoices

export function createInvoice(
  ctx: AppContext,
  raw: unknown,
): AppResult<InvoiceWritten> {
  const refused = requirePermissions(ctx, ["invoices.create"]);
  if (refused) return refused;
  const parsed = createInvoiceSchema.safeParse(raw);
  if (!parsed.success) return invalidDocument(parsed.error);
  const contact = resolveContact(ctx, parsed.data);
  if (!contact.ok) return contact;
  // `sourceQuotationId` is set only by converting a quotation, never taken
  // from a request: a client could otherwise tie any invoice to any quote.
  const invoice = createInvoiceService(ctx.db, actor(ctx), {
    ...definedFields(parsed.data),
    contactId: contact.value ?? null,
    issueDate: parsed.data.issueDate,
    lines: parsed.data.lines,
  });
  return invoiceWritten(ctx, invoice.id);
}

export function updateInvoice(
  ctx: AppContext,
  id: number,
  raw: unknown,
  expectedVersion?: string,
): AppResult<InvoiceWritten> {
  const refused = requirePermissions(ctx, ["invoices.update"]);
  if (refused) return refused;
  const invoice = getInvoice(ctx.db, id);
  if (!invoice) return missing("That invoice no longer exists.");
  if (invoice.status === InvoiceStatus.Cancelled)
    return fail(
      "REFUSED",
      "This invoice has been cancelled, so it can no longer be changed.",
    );
  const parsed = updateInvoiceSchema.safeParse(raw);
  if (!parsed.success) return invalidDocument(parsed.error);
  const stale = checkVersion(invoiceVersion(ctx.db, id), expectedVersion);
  if (stale) return stale;

  const patch: Record<string, unknown> = definedFields(parsed.data);
  // Once it has been sent, its amount is in the books and the customer has a
  // copy, so what the money says is fixed. The wording around it can still be
  // corrected (FR-018a). Checked before a new customer name is resolved, so a
  // refused edit cannot leave a contact behind.
  if (
    invoice.ledgerRecordId !== null &&
    (SEALED_SALES_FIELDS.some((f) => patch[f] !== undefined) ||
      Boolean(parsed.data.newContactName))
  ) {
    return fail(
      "REFUSED",
      "This invoice has been sent. Its amount, date and customer are fixed — void and reissue it if they are wrong.",
    );
  }
  if (!patch.contactId && parsed.data.newContactName) {
    const contact = resolveContact(ctx, parsed.data);
    if (!contact.ok) return contact;
    patch.contactId = contact.value;
  }
  patchInvoice(ctx.db, id, actor(ctx), patch);
  return invoiceWritten(ctx, id);
}

/**
 * Marks a draft as sent, which is what puts it in the books: its amount goes
 * into Money owed to us out of the income account (FR-018a). That is a new
 * record, so it needs `records:add` as well as `invoices:change`; and the
 * income account named must be an open Revenue account — the posting builder
 * would accept any account, and a sale "earned" into a bank account would make
 * the books wrong while still adding up.
 */
export function issueInvoice(
  ctx: AppContext,
  id: number,
  input: { incomeAccountId?: number },
  expectedVersion?: string,
): AppResult<InvoiceWritten> {
  // Sending puts a record in the books, so it also needs records.create.
  const refused = requirePermissions(ctx, ["invoices.issue", "records.create"]);
  if (refused) return refused;
  if (!getInvoice(ctx.db, id)) return missing("That invoice no longer exists.");
  if (input.incomeAccountId !== undefined) {
    const account = getAccount(ctx.db, input.incomeAccountId);
    if (
      !account ||
      account.type !== AccountType.Revenue ||
      account.archivedAt !== null
    )
      return fail(
        "REFUSED",
        "Choose an open income (Revenue) account for this sale.",
      );
  }
  const stale = checkVersion(invoiceVersion(ctx.db, id), expectedVersion);
  if (stale) return stale;
  const result = issueInvoiceService(ctx.db, id, actor(ctx), input);
  if (!result.ok) return fail("REFUSED", result.reason);
  return invoiceWritten(ctx, id);
}

/**
 * Voids a sent invoice: it keeps its number and its posting leaves the books.
 * Removing that posting changes a record, so `records:change` is asked too.
 * With `reissue`, a corrected draft copy is made in its place (`invoices:add`).
 */
export function voidInvoice(
  ctx: AppContext,
  id: number,
  input: { reissue: boolean },
  expectedVersion?: string,
): AppResult<InvoiceWritten & { reissued: InvoiceWritten | null }> {
  // Voiding takes the posting out of the books (records.update); reissuing
  // makes a new draft (invoices.create).
  const refused = requirePermissions(ctx, [
    "invoices.void",
    "records.update",
    ...(input.reissue ? (["invoices.create"] as const) : []),
  ]);
  if (refused) return refused;
  if (!getInvoice(ctx.db, id)) return missing("That invoice no longer exists.");
  const stale = checkVersion(invoiceVersion(ctx.db, id), expectedVersion);
  if (stale) return stale;
  if (input.reissue) {
    const result = voidAndReissueInvoice(ctx.db, id, actor(ctx));
    if (!result.ok) return fail("REFUSED", result.reason);
    const voided = invoiceWritten(ctx, id);
    const reissued = invoiceWritten(ctx, result.value.invoice.id);
    if (!voided.ok) return voided;
    if (!reissued.ok) return reissued;
    return ok({ ...voided.value, reissued: reissued.value });
  }
  const result = cancelInvoice(ctx.db, id, actor(ctx));
  if (!result.ok) return fail("REFUSED", result.reason);
  const voided = invoiceWritten(ctx, id);
  return voided.ok ? ok({ ...voided.value, reissued: null }) : voided;
}

export function deleteInvoice(
  ctx: AppContext,
  id: number,
  expectedVersion?: string,
): AppResult<{ id: number }> {
  const refused = requirePermissions(ctx, ["invoices.delete"]);
  if (refused) return refused;
  if (!getInvoice(ctx.db, id)) return missing("That invoice no longer exists.");
  const stale = checkVersion(invoiceVersion(ctx.db, id), expectedVersion);
  if (stale) return stale;
  const result = removeInvoice(ctx.db, id, actor(ctx));
  if (result.ok) return ok({ id });
  if (result.reason === "not_found")
    return missing("That invoice no longer exists.");
  if (result.reason === "cancelled")
    return fail(
      "REFUSED",
      "A cancelled invoice keeps its number, so it cannot be deleted.",
    );
  return fail(
    "REFUSED",
    "This invoice has been sent, so it cannot be deleted. Cancel it instead.",
  );
}

// -------------------------------------------------------------- quotations

export function createQuotation(
  ctx: AppContext,
  raw: unknown,
): AppResult<QuotationWritten> {
  const refused = requirePermissions(ctx, ["quotations.create"]);
  if (refused) return refused;
  const parsed = createQuotationSchema.safeParse(raw);
  if (!parsed.success) return invalidDocument(parsed.error);
  const contact = resolveContact(ctx, parsed.data);
  if (!contact.ok) return contact;
  const quotation = createQuotationService(ctx.db, actor(ctx), {
    ...definedFields(parsed.data),
    contactId: contact.value ?? null,
    issueDate: parsed.data.issueDate,
    lines: parsed.data.lines,
  });
  return quotationWritten(ctx, quotation.id);
}

export function updateQuotation(
  ctx: AppContext,
  id: number,
  raw: unknown,
  expectedVersion?: string,
): AppResult<QuotationWritten> {
  const refused = requirePermissions(ctx, ["quotations.update"]);
  if (refused) return refused;
  const quotation = getQuotation(ctx.db, id);
  if (!quotation) return missing("That quotation no longer exists.");
  if (!canEditQuotation(quotation)) {
    return fail(
      "REFUSED",
      quotation.status === QuotationStatus.Superseded
        ? "This quotation has been replaced by a revision, so it can no longer be changed."
        : "Converted quotations cannot be edited.",
    );
  }
  const parsed = updateQuotationSchema.safeParse(raw);
  if (!parsed.success) return invalidDocument(parsed.error);
  const stale = checkVersion(quotationVersion(ctx.db, id), expectedVersion);
  if (stale) return stale;

  const patch: Record<string, unknown> = definedFields(parsed.data);
  // Once it has gone to the customer, what it offers is fixed: a change to it
  // is a revision, so the customer can tell the new offer from the one they
  // hold.
  if (
    isQuotationSealed(quotation) &&
    (SEALED_SALES_FIELDS.some((f) => patch[f] !== undefined) ||
      Boolean(parsed.data.newContactName))
  ) {
    return fail(
      "REFUSED",
      "This quotation has been sent. Its customer, date, currency and line items are fixed — revise it to change them.",
    );
  }
  if (!patch.contactId && parsed.data.newContactName) {
    const contact = resolveContact(ctx, parsed.data);
    if (!contact.ok) return contact;
    patch.contactId = contact.value;
  }
  patchQuotation(ctx.db, id, actor(ctx), patch);
  return quotationWritten(ctx, id);
}

export const QUOTATION_STATUS_BY_NAME = {
  sent: QuotationStatus.Sent,
  accepted: QuotationStatus.Accepted,
  declined: QuotationStatus.Declined,
} as const;

export function setQuotationStatus(
  ctx: AppContext,
  id: number,
  status: keyof typeof QUOTATION_STATUS_BY_NAME,
  expectedVersion?: string,
): AppResult<QuotationWritten> {
  const refused = requirePermissions(ctx, ["quotations.update"]);
  if (refused) return refused;
  if (!getQuotation(ctx.db, id))
    return missing("That quotation no longer exists.");
  const stale = checkVersion(quotationVersion(ctx.db, id), expectedVersion);
  if (stale) return stale;
  const result = setQuotationStatusService(
    ctx.db,
    id,
    actor(ctx),
    QUOTATION_STATUS_BY_NAME[status],
  );
  if (!result.ok) return fail("REFUSED", result.reason);
  return quotationWritten(ctx, id);
}

export function reviseQuotation(
  ctx: AppContext,
  id: number,
  expectedVersion?: string,
): AppResult<QuotationWritten & { previous: QuotationWritten }> {
  const refused = requirePermissions(ctx, [
    "quotations.revise",
    "quotations.create",
  ]);
  if (refused) return refused;
  if (!getQuotation(ctx.db, id))
    return missing("That quotation no longer exists.");
  const stale = checkVersion(quotationVersion(ctx.db, id), expectedVersion);
  if (stale) return stale;
  const result = reviseQuotationService(ctx.db, id, actor(ctx));
  if (!result.ok) return fail("REFUSED", result.reason);
  const revision = quotationWritten(ctx, result.value.quotationId);
  const previous = quotationWritten(ctx, result.value.previousId);
  if (!revision.ok) return revision;
  if (!previous.ok) return previous;
  return ok({ ...revision.value, previous: previous.value });
}

export function convertQuotation(
  ctx: AppContext,
  id: number,
  expectedVersion?: string,
): AppResult<QuotationWritten & { invoice: InvoiceWritten }> {
  const refused = requirePermissions(ctx, [
    "quotations.convert",
    "invoices.create",
  ]);
  if (refused) return refused;
  if (!getQuotation(ctx.db, id))
    return missing("That quotation no longer exists.");
  const stale = checkVersion(quotationVersion(ctx.db, id), expectedVersion);
  if (stale) return stale;
  const result = convertToInvoice(ctx.db, id, actor(ctx));
  if (!result.ok) return fail("REFUSED", result.reason);
  const quotation = quotationWritten(ctx, result.value.quotationId);
  const invoice = invoiceWritten(ctx, result.value.invoiceId);
  if (!quotation.ok) return quotation;
  if (!invoice.ok) return invoice;
  return ok({ ...quotation.value, invoice: invoice.value });
}

export function deleteQuotation(
  ctx: AppContext,
  id: number,
  expectedVersion?: string,
): AppResult<{ id: number }> {
  const refused = requirePermissions(ctx, ["quotations.delete"]);
  if (refused) return refused;
  if (!getQuotation(ctx.db, id))
    return missing("That quotation no longer exists.");
  const stale = checkVersion(quotationVersion(ctx.db, id), expectedVersion);
  if (stale) return stale;
  const result = removeQuotation(ctx.db, id, actor(ctx));
  if (result.ok) return ok({ id });
  if (result.reason === "not_found")
    return missing("That quotation no longer exists.");
  if (result.reason === "converted")
    return fail("REFUSED", "Converted quotations cannot be deleted.");
  return fail(
    "REFUSED",
    "A quotation replaced by a revision is kept, so it cannot be deleted.",
  );
}
