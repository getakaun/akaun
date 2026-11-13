import { z } from "zod";
import { eq } from "drizzle-orm";
import { AccountType, QuotationStatusLabels } from "$lib/enums.js";
import { invoiceStatusKey } from "$lib/sales/status.js";
import { invoices, ledgerRecords, quotations } from "../../../db/schema.js";
import { can } from "../../../permissions.js";
import { runBatch } from "../../../application/batch.js";
import type { AppContext } from "../../../application/context.js";
import {
  convertQuotation,
  createInvoice,
  createQuotation,
  deleteInvoice,
  deleteQuotation,
  issueInvoice,
  QUOTATION_STATUS_BY_NAME,
  reviseQuotation,
  setQuotationStatus,
  updateInvoice,
  updateQuotation,
  voidInvoice,
  type InvoiceWritten,
  type QuotationWritten,
} from "../../../application/sales.js";
import {
  resolveContact,
  similarity,
  type Candidate,
  type Resolved,
} from "../../../application/refs.js";
import type { AppResult } from "../../../application/result.js";
import { formatMinor, parseMinor, toMinor } from "../../../ledger/money.js";
import type { LedgerDb } from "../../../ledger/types.js";
import { normalizeName } from "../../../queries/contacts.js";
import { batchToolResult } from "../../batch-result.js";
import { toolError } from "../../envelope.js";
import { dateInput, enumLabel, mainCurrency, money } from "../../format.js";
import { resolveError } from "../../resolve.js";
import { defineWriteTool, type ToolDefinition } from "../../registry.js";
import {
  actionRefusal,
  actionsInArguments,
  CHANGE_SALES_DOCUMENTS,
  CREATE_SALES_DOCUMENTS,
  missingForActions,
} from "../../requirements/index.js";
import {
  batchControls,
  idempotencyOf,
  nothingToDo,
  refInput,
  refuseActions,
  Refs,
  SPLIT_CALL,
} from "./payments.js";

/**
 * The sales write tools: `create_sales_documents` and `change_sales_documents`.
 *
 * They mirror v1's invoice and quotation tools action by action. Every rule
 * is in `application/sales.ts`: a sent invoice is sealed (void it, with
 * `reissue` for a corrected draft), a sent quotation is revised, a delivered
 * document cannot be deleted, issuing needs `records.create` as well as
 * `invoices.issue`. An item calls exactly one operation, so what the app
 * refuses, this refuses with the same sentence.
 *
 * Invoices and quotations are named by id or number and
 * resolved before the batch opens, with every miss reported together.
 */

// --- input ---------------------------------------------------------------------

/** A price per unit as a decimal string, up to four places, e.g. "12.50". */
const unitPriceInput = z
  .union([z.string(), z.number()])
  .transform((value, ctx) => {
    const parsed = parseMinor(value, 4);
    if (!parsed.ok || parsed.minor < 0) {
      ctx.addIssue({
        code: "custom",
        message: parsed.ok
          ? "A unit price cannot be negative."
          : parsed.message,
      });
      return z.NEVER;
    }
    return Number(formatMinor(parsed.minor, 4));
  })
  .describe(
    'Price of one unit in the document\'s currency, e.g. "12.50" (up to 4 decimals).',
  );

const lineInput = z
  .object({
    description: z.string().trim().min(1).max(500),
    quantity: z
      .number()
      .finite()
      .positive()
      .describe("Units, above zero. May be fractional."),
    unit_price: unitPriceInput,
  })
  .strict();

const linesInput = z
  .array(lineInput)
  .min(1)
  .max(200)
  .describe("The line items. Totals are worked out by the server.");

const text = (max: number) => z.string().trim().max(max);

const contactFields = {
  new_contact: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "A customer to find by exact name, or create. Creating needs permission to add contacts.",
    ),
  force_new_contact: z
    .boolean()
    .optional()
    .describe(
      "true: create the new_contact even when a contact with a similar name exists.",
    ),
};

const currencyFields = {
  currency: z
    .string()
    .trim()
    .length(3)
    .toUpperCase()
    .optional()
    .describe(
      "ISO code, e.g. USD. Without one a draft is in the main currency; a foreign currency needs exchange_rate.",
    ),
  exchange_rate: z
    .number()
    .finite()
    .positive()
    .optional()
    .describe("Main-currency units per 1 unit of currency, e.g. 4.42."),
};

const invoiceCreateInput = z
  .object({
    contact: refInput
      .optional()
      .describe("The customer: id or exact name. Or use new_contact."),
    ...contactFields,
    reference: text(200).optional(),
    issue_date: dateInput,
    due_date: dateInput.optional(),
    ...currencyFields,
    notes: text(20000).optional(),
    terms: text(20000).optional(),
    lines: linesInput,
  })
  .strict();

const quotationCreateInput = z
  .object({
    contact: refInput
      .optional()
      .describe("The customer: id or exact name. Or use new_contact."),
    ...contactFields,
    reference: text(200).optional(),
    issue_date: dateInput,
    expiry_date: dateInput.optional(),
    ...currencyFields,
    notes: text(20000).optional(),
    terms: text(20000).optional(),
    lines: linesInput,
  })
  .strict();

const createInput = z.object({
  invoices: z.array(invoiceCreateInput).max(50, SPLIT_CALL).optional(),
  quotations: z.array(quotationCreateInput).max(50, SPLIT_CALL).optional(),
  ...batchControls,
});
type CreateArgs = z.output<typeof createInput>;

const CREATE_DESCRIPTION = `Create draft invoices and quotations. A draft is not in the books: nothing is posted to the ledger until the invoice is issued with change_sales_documents. Use it to prepare what a customer will be sent; to record money received, record a payment instead.

- invoices[]: contact (id or exact name) or new_contact, issue_date, due_date, reference, currency, exchange_rate, notes, terms, lines.
- quotations[]: the same, with expiry_date instead of due_date.
- lines[]: {description, quantity, unit_price}. Unit prices are decimal strings in the document's currency ("12.50"); totals are worked out by the server and shown in the result.

new_contact finds a customer by exact name or creates one (needs permission to add contacts). A close name that is not exact answers AMBIGUOUS with candidates: send contact with the id of the one meant, or force_new_contact: true.

The result gives each document's number, total and v (needed to change it later). Up to 50 documents per call, saved together or not at all. dry_run: true saves nothing; idempotency_key makes a retried call return the first result. Nothing is emailed.`;

const invoiceSetInput = z
  .object({
    contact: refInput
      .nullable()
      .optional()
      .describe("A different customer: id or exact name. null removes it."),
    ...contactFields,
    reference: text(200).nullable().optional(),
    issue_date: dateInput.optional(),
    due_date: dateInput.nullable().optional(),
    ...currencyFields,
    notes: text(20000).nullable().optional(),
    terms: text(20000).nullable().optional(),
    lines: linesInput.optional().describe("Replaces every line."),
  })
  .strict();

const quotationSetInput = z
  .object({
    contact: refInput
      .nullable()
      .optional()
      .describe("A different customer: id or exact name. null removes it."),
    ...contactFields,
    reference: text(200).nullable().optional(),
    issue_date: dateInput.optional(),
    expiry_date: dateInput.nullable().optional(),
    ...currencyFields,
    notes: text(20000).nullable().optional(),
    terms: text(20000).nullable().optional(),
    lines: linesInput.optional().describe("Replaces every line."),
  })
  .strict();

const expectedVersion = z
  .string()
  .min(1)
  .describe("The document's v, from when it was read or created.");

const invoiceRef = refInput.describe(
  "The invoice: its id, or its number as get_sales_documents shows it.",
);
const quotationRef = refInput.describe(
  "The quotation: its id, or its number as get_sales_documents shows it.",
);

const changeInput = z.object({
  invoice_update: z
    .array(
      z
        .object({
          invoice: invoiceRef,
          expected_version: expectedVersion,
          set: invoiceSetInput,
        })
        .strict(),
    )
    .max(50, SPLIT_CALL)
    .optional(),
  invoice_issue: z
    .array(
      z
        .object({
          invoice: invoiceRef,
          expected_version: expectedVersion,
          income_account: refInput
            .optional()
            .describe(
              "The income account the sale is booked to. Default: the sales account.",
            ),
        })
        .strict(),
    )
    .max(50, SPLIT_CALL)
    .optional(),
  invoice_void: z
    .array(
      z
        .object({
          invoice: invoiceRef,
          expected_version: expectedVersion,
          reissue: z
            .boolean()
            .optional()
            .describe(
              "true: also create a corrected draft copy to edit and issue.",
            ),
        })
        .strict(),
    )
    .max(50, SPLIT_CALL)
    .optional(),
  invoice_delete: z
    .array(
      z
        .object({ invoice: invoiceRef, expected_version: expectedVersion })
        .strict(),
    )
    .max(50, SPLIT_CALL)
    .optional(),
  quotation_update: z
    .array(
      z
        .object({
          quotation: quotationRef,
          expected_version: expectedVersion,
          set: quotationSetInput,
        })
        .strict(),
    )
    .max(50, SPLIT_CALL)
    .optional(),
  quotation_status: z
    .array(
      z
        .object({
          quotation: quotationRef,
          expected_version: expectedVersion,
          status: z
            .enum(
              Object.keys(QUOTATION_STATUS_BY_NAME) as [
                "sent",
                "accepted",
                "declined",
              ],
            )
            .describe(
              "sent seals the quotation. Converted and superseded are reached only by convert and revise.",
            ),
        })
        .strict(),
    )
    .max(50, SPLIT_CALL)
    .optional(),
  quotation_revise: z
    .array(
      z
        .object({ quotation: quotationRef, expected_version: expectedVersion })
        .strict(),
    )
    .max(50, SPLIT_CALL)
    .optional(),
  quotation_convert: z
    .array(
      z
        .object({ quotation: quotationRef, expected_version: expectedVersion })
        .strict(),
    )
    .max(50, SPLIT_CALL)
    .optional(),
  quotation_delete: z
    .array(
      z
        .object({ quotation: quotationRef, expected_version: expectedVersion })
        .strict(),
    )
    .max(50, SPLIT_CALL)
    .optional(),
  ...batchControls,
});
type ChangeArgs = z.output<typeof changeInput>;

const CHANGE_DESCRIPTION = `Change, issue, void or delete invoices, and change, send, revise, convert or delete quotations. Each item names the document by id or number and carries its expected_version (the v from when it was read or created); a stale one answers CONFLICT with current_version.

- invoice_update[]: set {...}. A draft can change anything. A sent invoice is sealed: its customer, dates, currency, rate and lines are fixed, but reference, due date, notes and terms can still be corrected.
- invoice_issue[]: marks a draft as sent and posts it to the ledger: it needs a customer and an income account (income_account, default the sales account). Does not email anyone.
- invoice_void[]: a sent invoice keeps its number and its posting leaves the books, so past reports change. Refused once anything is paid against it. reissue: true also creates a corrected draft.
- invoice_delete[]: drafts only.
- quotation_update[], quotation_status[] (sent, accepted, declined), quotation_revise[] (a sent quotation: makes a new draft and supersedes the old), quotation_convert[] (an accepted quotation becomes a draft invoice), quotation_delete[] (not converted or superseded).

Unit prices are decimal strings in the document's currency. These change the books or what a customer holds: dry_run: true first, show the result, save only after the user agrees. Up to 50 items per call, saved together or not at all. idempotency_key makes a retry return the first result.`;

// --- references ----------------------------------------------------------------

type DocKind = "invoice" | "quotation";
type DocBrief = { id: number; number: string };

function documentRows(ctx: AppContext, kind: DocKind): DocBrief[] {
  return kind === "invoice"
    ? ctx.db
        .select({ id: invoices.id, number: invoices.invoiceNumber })
        .from(invoices)
        .all()
    : ctx.db
        .select({ id: quotations.id, number: quotations.quotationNumber })
        .from(quotations)
        .all();
}

/**
 * An invoice or quotation by id, number (any case) or `#id`.
 * Anything else is a miss with the nearest numbers; a close number is never
 * used on its own.
 */
function resolveDocument(
  ctx: AppContext,
  kind: DocKind,
  ref: number | string,
): Resolved<DocBrief> {
  const rows = documentRows(ctx, kind);
  const candidate = (row: DocBrief): Candidate => ({
    id: row.id,
    name: row.number,
  });
  const byId = (id: number): Resolved<DocBrief> => {
    const hit = rows.find((row) => row.id === id);
    return hit
      ? { ok: true, id: hit.id, value: hit }
      : {
          ok: false,
          kind: "not_found",
          message: `No ${kind} has id ${id}.`,
          candidates: rows.slice(-5).reverse().map(candidate),
        };
  };
  if (typeof ref === "number") return byId(ref);
  const text_ = ref.trim();
  const hash = /^#(\d+)$/.exec(text_);
  if (hash) return byId(Number(hash[1]));
  const wanted = normalizeName(text_);
  const exact = rows.filter((row) => normalizeName(row.number) === wanted);
  if (exact.length === 1) return { ok: true, id: exact[0].id, value: exact[0] };
  const near = rows
    .map((row) => ({
      row,
      score: normalizeName(row.number).includes(wanted)
        ? 1
        : similarity(wanted, normalizeName(row.number)),
    }))
    .filter((entry) => entry.score >= 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((entry) => candidate(entry.row));
  // Numbers follow the book's own template, so when nothing is alike the
  // newest ones show what a number looks like.
  return {
    ok: false,
    kind: exact.length > 1 ? "ambiguous" : "not_found",
    message: `No ${kind} is numbered "${text_}".`,
    candidates: near.length
      ? near
      : rows
          .slice(-5)
          .reverse()
          .map((row) => ({ ...candidate(row), detail: "most recent" })),
  };
}

function documentOf(
  refs: Refs,
  kind: DocKind,
  ref: number | string,
  path: string,
): DocBrief | undefined {
  const result = resolveDocument(refs.ctx, kind, ref);
  if (result.ok) return result.value;
  const readable = can(
    refs.ctx.locals,
    kind === "invoice" ? "invoices.read" : "quotations.read",
  );
  refs.errors.push(
    resolveError(readable ? result : { kind: "not_found", candidates: [] }, {
      what: kind,
      ref,
      path,
      lookup: readable ? refs.meta.nameOf("get_sales_documents") : undefined,
    }),
  );
  return undefined;
}

/** What a document names as its customer, once resolved. */
type ContactPart = { contactId?: number | null; newContactName?: string };

/**
 * The customer an item names: `contact` resolves to an existing contact,
 * `new_contact` to the exact-named one or to a name the operation creates.
 * A name that is only close is AMBIGUOUS unless `force_new_contact`: a fuzzy
 * match never links, and a new contact is never made from a typo unasked.
 * `false` when it missed (the miss is in `refs`).
 */
function contactPart(
  refs: Refs,
  item: {
    contact?: number | string | null;
    new_contact?: string;
    force_new_contact?: boolean;
  },
  path: string,
): ContactPart | false {
  if (item.contact !== undefined && item.new_contact !== undefined) {
    refs.invalid(
      path,
      "Send contact or new_contact, not both.",
      "Send contact (an existing customer) or new_contact (a name to find or create).",
    );
    return false;
  }
  if (item.contact === null) return { contactId: null };
  if (item.contact !== undefined) {
    const found = refs.contact(item.contact, `${path}.contact`);
    return found ? { contactId: found.id } : false;
  }
  if (item.new_contact === undefined) return {};
  const found = resolveContact(refs.ctx, item.new_contact);
  if (found.ok) return { contactId: found.id };
  const readable = can(refs.ctx.locals, "contacts.read");
  if (found.kind === "ambiguous" || !readable) {
    if (!readable) return { newContactName: item.new_contact };
    refs.errors.push(
      resolveError(found, {
        what: "contact",
        ref: item.new_contact,
        path: `${path}.new_contact`,
      }),
    );
    return false;
  }
  if (found.candidates.length && !item.force_new_contact) {
    refs.errors.push({
      code: "AMBIGUOUS",
      path: `${path}.new_contact`,
      message: `${path}.new_contact: A contact like "${item.new_contact}" already exists, but not by that exact name.`,
      fix: "Send contact with the id of the one meant, or add force_new_contact: true to create a new customer.",
      candidates: found.candidates.slice(0, 5),
    });
    return false;
  }
  return { newContactName: item.new_contact };
}

// --- operation input -----------------------------------------------------------

type Doc = {
  reference?: string | null;
  issue_date?: string;
  due_date?: string | null;
  expiry_date?: string | null;
  currency?: string;
  exchange_rate?: number;
  notes?: string | null;
  terms?: string | null;
  lines?: { description: string; quantity: number; unit_price: number }[];
};

/** The operation's field names, only for what the item sent. */
function documentFields(item: Doc): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const copy = (from: keyof Doc, to: string) => {
    if (item[from] !== undefined) out[to] = item[from];
  };
  copy("reference", "reference");
  copy("issue_date", "issueDate");
  copy("due_date", "dueDate");
  copy("expiry_date", "expiryDate");
  copy("currency", "currency");
  copy("exchange_rate", "exchangeRate");
  copy("notes", "notes");
  copy("terms", "terms");
  if (item.lines)
    out.lines = item.lines.map((line) => ({
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unit_price,
    }));
  return out;
}

/**
 * The currency and rate a document is made with. A draft without a currency
 * is in the book's main currency, not the database's own default, and a
 * foreign currency must come with its rate: a sent invoice posts its total
 * at that rate, so one left at 1 would post the wrong amount. `false` when
 * the pair is not usable (recorded in `refs`).
 */
function currencyAndRate(
  refs: Refs,
  item: { currency?: string; exchange_rate?: number },
  path: string,
  creating = true,
): Record<string, unknown> | false {
  const main = mainCurrency(refs.ctx.db);
  if (item.currency === undefined && !creating) {
    return item.exchange_rate === undefined
      ? {}
      : { exchangeRate: item.exchange_rate };
  }
  const currency = item.currency ?? main;
  if (currency !== main && item.exchange_rate === undefined) {
    refs.invalid(
      `${path}.exchange_rate`,
      `The currency is ${currency}, not ${main}, so the exchange rate is needed.`,
      `Send exchange_rate: ${main} per 1 ${currency}.`,
    );
    return false;
  }
  if (currency === main && ![undefined, 1].includes(item.exchange_rate)) {
    refs.invalid(
      `${path}.exchange_rate`,
      `The currency is ${main}, the main currency, so its rate is 1.`,
      "Leave exchange_rate out, or send a different currency.",
    );
    return false;
  }
  return {
    currency,
    exchangeRate: currency === main ? 1 : item.exchange_rate,
  };
}

function withContact(fields: Record<string, unknown>, part: ContactPart) {
  return {
    ...fields,
    ...(part.contactId !== undefined ? { contactId: part.contactId } : {}),
    ...(part.newContactName !== undefined
      ? { newContactName: part.newContactName }
      : {}),
  };
}

// --- output --------------------------------------------------------------------

type Value = Record<string, unknown>;

/** A figure stored as a decimal in the document's own currency, as an exact string. */
const total = (value: number) => money(toMinor(value, 1));

/** A unit price: two places at least, more when it has them (never rounded). */
function price(value: number): string {
  const clean = String(Number(value.toPrecision(12)));
  if (/e/i.test(clean)) return value.toFixed(4);
  const [whole, decimals = ""] = clean.split(".");
  return `${whole}.${decimals.padEnd(2, "0")}`;
}

function lineRows(
  lines: {
    description: string;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
  }[],
) {
  return lines.map((line) => ({
    description: line.description,
    quantity: line.quantity,
    unit_price: price(line.unitPrice),
    amount: total(line.lineTotal),
  }));
}

function recordNumberOf(db: LedgerDb, id: number | null): string | undefined {
  if (id === null) return undefined;
  const row = db
    .select({ no: ledgerRecords.recordNumber })
    .from(ledgerRecords)
    .where(eq(ledgerRecords.id, id))
    .get();
  return row?.no ?? `#${id}`;
}

function numberOf(db: LedgerDb, kind: DocKind, id: number | null) {
  if (id === null) return undefined;
  const row =
    kind === "invoice"
      ? db
          .select({ no: invoices.invoiceNumber })
          .from(invoices)
          .where(eq(invoices.id, id))
          .get()
      : db
          .select({ no: quotations.quotationNumber })
          .from(quotations)
          .where(eq(quotations.id, id))
          .get();
  return row?.no;
}

/** An invoice as an agent reads it. `v` is what the next change asks as expected_version. */
function invoiceOut(db: LedgerDb, written: InvoiceWritten): Value {
  const inv = written.invoice;
  const main = mainCurrency(db);
  const status = invoiceStatusKey({
    status: inv.status,
    paid: inv.paid,
    paidMinor: inv.paidMinor,
    isOverdue: inv.isOverdue,
  });
  return {
    id: inv.id,
    no: inv.invoiceNumber,
    status: status.replaceAll("-", "_"),
    contact: inv.contactName ?? undefined,
    reference: inv.reference ?? undefined,
    issue_date: inv.issueDate,
    due_date: inv.dueDate ?? undefined,
    currency: inv.currency,
    exchange_rate: inv.currency === main ? undefined : inv.exchangeRate,
    total: total(inv.total),
    outstanding:
      inv.ledgerRecordId === null ? undefined : money(inv.outstandingMinor),
    posted_as: recordNumberOf(db, inv.ledgerRecordId),
    from_quotation: numberOf(db, "quotation", inv.sourceQuotationId),
    replaces: inv.replaces?.invoiceNumber,
    replaced_by: inv.replacedBy?.invoiceNumber,
    notes: inv.notes ?? undefined,
    terms: inv.terms ?? undefined,
    lines: lineRows(inv.lines),
    v: written.version,
  };
}

function quotationOut(db: LedgerDb, written: QuotationWritten): Value {
  const q = written.quotation;
  const main = mainCurrency(db);
  return {
    id: q.id,
    no: q.quotationNumber,
    status: enumLabel(QuotationStatusLabels, q.status),
    expired: q.isExpired || undefined,
    contact: q.contactName ?? undefined,
    reference: q.reference ?? undefined,
    issue_date: q.issueDate,
    expiry_date: q.expiryDate ?? undefined,
    currency: q.currency,
    exchange_rate: q.currency === main ? undefined : q.exchangeRate,
    total: total(q.total),
    converted_to: numberOf(db, "invoice", q.convertedInvoiceId),
    revised_from: q.revisedFrom?.quotationNumber,
    superseded_by: q.supersededBy?.quotationNumber,
    notes: q.notes ?? undefined,
    terms: q.terms ?? undefined,
    lines: lineRows(q.lines),
    v: written.version,
  };
}

// --- create_sales_documents ----------------------------------------------------

type CreatePlan = { path: string; fields: Record<string, unknown> };

function planCreate(
  refs: Refs,
  items: NonNullable<CreateArgs["invoices"] | CreateArgs["quotations"]>,
  kind: "invoices" | "quotations",
): CreatePlan[] {
  return items.flatMap((item, i): CreatePlan[] => {
    const path = `${kind}[${i}]`;
    const part = contactPart(refs, item, path);
    const money_ = currencyAndRate(refs, item, path);
    return part && money_
      ? [
          {
            path,
            fields: {
              ...withContact(documentFields(item), part),
              ...money_,
            },
          },
        ]
      : [];
  });
}

const createSalesDocuments = defineWriteTool({
  base: "create_sales_documents",
  title: "Create invoices and quotations",
  description: CREATE_DESCRIPTION,
  input: createInput,
  annotations: {
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  requirements: CREATE_SALES_DOCUMENTS.requirements,
  actions: CREATE_SALES_DOCUMENTS.actions,
  handler: async (ctx, args, meta) => {
    const refused = refuseActions(ctx, meta, "create_sales_documents", args);
    if (refused) return refused;
    if (!args.invoices?.length && !args.quotations?.length)
      return nothingToDo("invoices or quotations");

    const refs = new Refs(ctx, meta);
    const invoicePlans = args.invoices
      ? planCreate(refs, args.invoices, "invoices")
      : [];
    const quotationPlans = args.quotations
      ? planCreate(refs, args.quotations, "quotations")
      : [];
    const missed = refs.failure();
    if (missed) return missed;

    const result = await runBatch<Value>(ctx, {
      tool: meta.name,
      dryRun: args.dry_run ?? false,
      items: [
        ...invoicePlans.map((plan) => ({
          action: "invoices",
          label: plan.path,
          run: (c: AppContext): AppResult<Value> => {
            const created = createInvoice(c, plan.fields);
            return created.ok
              ? {
                  ok: true,
                  value: { invoice: invoiceOut(c.db, created.value) },
                }
              : created;
          },
        })),
        ...quotationPlans.map((plan) => ({
          action: "quotations",
          label: plan.path,
          run: (c: AppContext): AppResult<Value> => {
            const created = createQuotation(c, plan.fields);
            return created.ok
              ? {
                  ok: true,
                  value: { quotation: quotationOut(c.db, created.value) },
                }
              : created;
          },
        })),
      ],
      idempotency: idempotencyOf(args, {
        invoices: args.invoices,
        quotations: args.quotations,
      }),
    });
    return batchToolResult(result, {
      requestId: meta.requestId,
      formatValue: (value) => value,
    });
  },
});

// --- change_sales_documents ----------------------------------------------------

type ChangePlan<T> = {
  path: string;
  doc: DocBrief;
  expectedVersion: string;
  extra: T;
};

/** One action array's items, each with its document resolved (misses are collected in `refs`). */
function planDocuments<I extends { expected_version: string }, T>(
  refs: Refs,
  kind: DocKind,
  action: string,
  items: I[] | undefined,
  refOf: (item: I) => number | string,
  extra: (item: I, path: string) => T | false,
): ChangePlan<T>[] {
  return (items ?? []).flatMap((item, i): ChangePlan<T>[] => {
    const path = `${action}[${i}]`;
    const doc = documentOf(refs, kind, refOf(item), `${path}.${kind}`);
    const more = extra(item, path);
    return doc && more !== false
      ? [{ path, doc, expectedVersion: item.expected_version, extra: more }]
      : [];
  });
}

const none = () => ({});

/** The `set` of an update: its customer, then every field it names. */
function setFields(
  refs: Refs,
  set: Parameters<typeof contactPart>[1] & Doc,
  path: string,
): Record<string, unknown> | false {
  const part = contactPart(refs, set, `${path}.set`);
  if (Object.values(set).every((value) => value === undefined)) {
    refs.invalid(
      `${path}.set`,
      "Name at least one field to change.",
      "Add the fields to set, e.g. set: {reference: ...}.",
    );
    return false;
  }
  const money_ = currencyAndRate(refs, set, `${path}.set`, false);
  return part === false || money_ === false
    ? false
    : { ...withContact(documentFields(set), part), ...money_ };
}

const changeSalesDocuments = defineWriteTool({
  base: "change_sales_documents",
  title: "Change invoices and quotations",
  description: CHANGE_DESCRIPTION,
  input: changeInput,
  annotations: {
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  requirements: CHANGE_SALES_DOCUMENTS.requirements,
  actions: CHANGE_SALES_DOCUMENTS.actions,
  handler: async (ctx, args: ChangeArgs, meta) => {
    // A void with reissue also creates the replacement draft, which has its
    // own requirement (`invoice_void_reissue`).
    const asked = [
      ...actionsInArguments("change_sales_documents", args),
      ...(args.invoice_void?.some((item) => item.reissue)
        ? ["invoice_void_reissue"]
        : []),
    ];
    if (asked.length === 0)
      return nothingToDo(
        "invoice_update, invoice_issue, invoice_void, invoice_delete, quotation_update, quotation_status, quotation_revise, quotation_convert or quotation_delete",
      );
    const short = missingForActions(
      ctx.locals,
      "change_sales_documents",
      asked,
    );
    if (short.length) return toolError(actionRefusal(meta.name, short));

    const refs = new Refs(ctx, meta);
    const invoiceUpdates = planDocuments(
      refs,
      "invoice",
      "invoice_update",
      args.invoice_update,
      (item) => item.invoice,
      (item, path) => setFields(refs, item.set, path),
    );
    const invoiceIssues = planDocuments(
      refs,
      "invoice",
      "invoice_issue",
      args.invoice_issue,
      (item) => item.invoice,
      (item, path): { incomeAccountId?: number } | false => {
        if (item.income_account === undefined) return {};
        const account = refs.account(
          item.income_account,
          `${path}.income_account`,
          {
            types: [AccountType.Revenue],
            wanted: "an income (revenue) account",
          },
        );
        return account ? { incomeAccountId: account.id } : false;
      },
    );
    const invoiceVoids = planDocuments(
      refs,
      "invoice",
      "invoice_void",
      args.invoice_void,
      (item) => item.invoice,
      (item) => ({ reissue: item.reissue ?? false }),
    );
    const invoiceDeletes = planDocuments(
      refs,
      "invoice",
      "invoice_delete",
      args.invoice_delete,
      (item) => item.invoice,
      none,
    );
    const quotationUpdates = planDocuments(
      refs,
      "quotation",
      "quotation_update",
      args.quotation_update,
      (item) => item.quotation,
      (item, path) => setFields(refs, item.set, path),
    );
    const quotationStatuses = planDocuments(
      refs,
      "quotation",
      "quotation_status",
      args.quotation_status,
      (item) => item.quotation,
      (item) => ({ status: item.status }),
    );
    const quotationRevises = planDocuments(
      refs,
      "quotation",
      "quotation_revise",
      args.quotation_revise,
      (item) => item.quotation,
      none,
    );
    const quotationConverts = planDocuments(
      refs,
      "quotation",
      "quotation_convert",
      args.quotation_convert,
      (item) => item.quotation,
      none,
    );
    const quotationDeletes = planDocuments(
      refs,
      "quotation",
      "quotation_delete",
      args.quotation_delete,
      (item) => item.quotation,
      none,
    );
    const missed = refs.failure();
    if (missed) return missed;

    const label = (plan: ChangePlan<unknown>) =>
      `${plan.path} ${plan.doc.number}`;
    const result = await runBatch<Value>(ctx, {
      tool: meta.name,
      dryRun: args.dry_run ?? false,
      items: [
        ...invoiceUpdates.map((plan) => ({
          action: "invoice_update",
          label: label(plan),
          run: (c: AppContext): AppResult<Value> => {
            const done = updateInvoice(
              c,
              plan.doc.id,
              plan.extra,
              plan.expectedVersion,
            );
            return done.ok
              ? { ok: true, value: { invoice: invoiceOut(c.db, done.value) } }
              : done;
          },
        })),
        ...invoiceIssues.map((plan) => ({
          action: "invoice_issue",
          label: label(plan),
          run: (c: AppContext): AppResult<Value> => {
            const done = issueInvoice(
              c,
              plan.doc.id,
              plan.extra,
              plan.expectedVersion,
            );
            return done.ok
              ? { ok: true, value: { invoice: invoiceOut(c.db, done.value) } }
              : done;
          },
        })),
        ...invoiceVoids.map((plan) => ({
          action: "invoice_void",
          label: label(plan),
          run: (c: AppContext): AppResult<Value> => {
            const done = voidInvoice(
              c,
              plan.doc.id,
              { reissue: plan.extra.reissue },
              plan.expectedVersion,
            );
            return done.ok
              ? {
                  ok: true,
                  value: {
                    voided: invoiceOut(c.db, done.value),
                    reissued: done.value.reissued
                      ? invoiceOut(c.db, done.value.reissued)
                      : undefined,
                  },
                }
              : done;
          },
        })),
        ...invoiceDeletes.map((plan) => ({
          action: "invoice_delete",
          label: label(plan),
          run: (c: AppContext): AppResult<Value> => {
            const done = deleteInvoice(c, plan.doc.id, plan.expectedVersion);
            return done.ok
              ? {
                  ok: true,
                  value: { deleted: { id: plan.doc.id, no: plan.doc.number } },
                }
              : done;
          },
        })),
        ...quotationUpdates.map((plan) => ({
          action: "quotation_update",
          label: label(plan),
          run: (c: AppContext): AppResult<Value> => {
            const done = updateQuotation(
              c,
              plan.doc.id,
              plan.extra,
              plan.expectedVersion,
            );
            return done.ok
              ? {
                  ok: true,
                  value: { quotation: quotationOut(c.db, done.value) },
                }
              : done;
          },
        })),
        ...quotationStatuses.map((plan) => ({
          action: "quotation_status",
          label: label(plan),
          run: (c: AppContext): AppResult<Value> => {
            const done = setQuotationStatus(
              c,
              plan.doc.id,
              plan.extra.status,
              plan.expectedVersion,
            );
            return done.ok
              ? {
                  ok: true,
                  value: { quotation: quotationOut(c.db, done.value) },
                }
              : done;
          },
        })),
        ...quotationRevises.map((plan) => ({
          action: "quotation_revise",
          label: label(plan),
          run: (c: AppContext): AppResult<Value> => {
            const done = reviseQuotation(c, plan.doc.id, plan.expectedVersion);
            return done.ok
              ? {
                  ok: true,
                  value: {
                    quotation: quotationOut(c.db, done.value),
                    previous: quotationOut(c.db, done.value.previous),
                  },
                }
              : done;
          },
        })),
        ...quotationConverts.map((plan) => ({
          action: "quotation_convert",
          label: label(plan),
          run: (c: AppContext): AppResult<Value> => {
            const done = convertQuotation(c, plan.doc.id, plan.expectedVersion);
            return done.ok
              ? {
                  ok: true,
                  value: {
                    quotation: quotationOut(c.db, done.value),
                    invoice: invoiceOut(c.db, done.value.invoice),
                  },
                }
              : done;
          },
        })),
        ...quotationDeletes.map((plan) => ({
          action: "quotation_delete",
          label: label(plan),
          run: (c: AppContext): AppResult<Value> => {
            const done = deleteQuotation(c, plan.doc.id, plan.expectedVersion);
            return done.ok
              ? {
                  ok: true,
                  value: { deleted: { id: plan.doc.id, no: plan.doc.number } },
                }
              : done;
          },
        })),
      ],
      idempotency: idempotencyOf(args, {
        invoice_update: args.invoice_update,
        invoice_issue: args.invoice_issue,
        invoice_void: args.invoice_void,
        invoice_delete: args.invoice_delete,
        quotation_update: args.quotation_update,
        quotation_status: args.quotation_status,
        quotation_revise: args.quotation_revise,
        quotation_convert: args.quotation_convert,
        quotation_delete: args.quotation_delete,
      }),
    });
    return batchToolResult(result, {
      requestId: meta.requestId,
      formatValue: (value) => value,
    });
  },
});

/** The sales write tools, in listing order. */
export const salesWriteTools: readonly ToolDefinition[] = [
  createSalesDocuments,
  changeSalesDocuments,
];
