import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  lte,
  sql,
  getTableColumns,
  type SQL,
} from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import * as schema from "../db/schema.js";
import {
  accounts,
  invoices,
  invoiceLines,
  invoiceSearchText,
  contacts,
  ledgerMovements,
  quotations,
} from "../db/schema.js";
import { nextNumber } from "../running-number.js";
import { AccountSubType, InvoiceStatus, QuotationStatus } from "$lib/enums.js";
import { localToday } from "$lib/local-date.js";
import {
  upsertSearchText,
  searchTextExists,
  joinSearchText,
} from "../search-text.js";
import { recordAudit, diffRecords } from "../audit.js";
import { toMinor } from "../ledger/money.js";
import { outstandingOf } from "../ledger/settlement-rules.js";
import { settledMinorFor, settlementsForRecord } from "./settlements.js";
import type { LedgerDb, Minor, SettlementSide } from "../ledger/types.js";
import {
  computeTotals,
  contactNameFor,
  lineRows,
  type SalesLineInput,
  type SalesTotals,
} from "./sales-doc-shared.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = BunSQLiteDatabase<typeof schema> | BunSQLiteDatabase<any>;

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export type InvoiceLineInput = SalesLineInput;

export type InvoiceCreate = {
  contactId?: number | null;
  reference?: string | null;
  issueDate: string; // YYYY-MM-DD, required
  dueDate?: string | null;
  currency?: string; // defaults to 'USD'
  exchangeRate?: number; // defaults to 1
  notes?: string | null;
  terms?: string | null;
  lines: InvoiceLineInput[]; // required, non-empty
  // For conversion from quotation (optional, set by service layer):
  sourceQuotationId?: number | null;
  // For a reissue: the voided invoice this one replaces (set by service layer).
  replacesInvoiceId?: number | null;
};

export type InvoicePatch = Partial<Omit<InvoiceCreate, "lines">> & {
  lines?: InvoiceLineInput[];
};

export type InvoiceFilters = {
  status?: number;
  contactId?: number;
  overdueOnly?: boolean; // when true, only return rows where isOverdue===true
  search?: string; // matches invoice_number or reference or contact name
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
  offset?: number;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Past its due date and still unpaid. Only a sent invoice can be: a draft owes
 * nothing yet and a cancelled one never will. "Today" is the local day, the
 * same calendar the due date was typed in.
 */
export function deriveOverdue(
  inv: { dueDate: string | null; status: number },
  paid: boolean,
  today: string = localToday(),
): boolean {
  if (!inv.dueDate || inv.status !== InvoiceStatus.Sent) return false;
  return inv.dueDate < today && !paid;
}

// ---------------------------------------------------------------------------
// How much of an invoice is paid — always computed, never stored (D-10)
// ---------------------------------------------------------------------------

export type InvoicePaymentState = {
  /** The invoice total in whole cents of the main currency. */
  totalMinor: Minor;
  paidMinor: Minor;
  outstandingMinor: Minor;
  paid: boolean;
  /**
   * The Money-owed-to-us movement the issue posted — what a customer's payment
   * settles. Null until the invoice is sent, and for one sent before the upgrade.
   */
  owedMovementId: number | null;
};

/**
 * What an invoice's payment state is, given the movement issuing it created.
 *
 * Issuing an invoice puts its amount on the Money-owed-to-us account, and a
 * customer's payment is an ordinary settlement against that movement — so how
 * much is paid is that movement's amount less what settlements cover, and
 * nothing needs storing (FR-018a, D-10).
 *
 * An invoice with no movement was either never issued or was issued before the
 * upgrade, which left no ledger history behind it (FR-030). All that is left to
 * read in that case is the document's own status, so that is what is used.
 */
export function invoicePaymentState(
  totalMinor: Minor,
  status: number,
  owedSide: SettlementSide | null,
): InvoicePaymentState {
  if (owedSide) {
    const outstandingMinor = outstandingOf(owedSide);
    return {
      totalMinor,
      paidMinor: Math.abs(owedSide.amountMinor) - outstandingMinor,
      outstandingMinor,
      paid: outstandingMinor === 0,
      owedMovementId: owedSide.movementId,
    };
  }

  if (status === InvoiceStatus.Paid) {
    return {
      totalMinor,
      paidMinor: totalMinor,
      outstandingMinor: 0,
      paid: true,
      owedMovementId: null,
    };
  }
  // Sent before the upgrade: owed, but with nothing recorded against it.
  if (status === InvoiceStatus.Sent) {
    return {
      totalMinor,
      paidMinor: 0,
      outstandingMinor: totalMinor,
      paid: false,
      owedMovementId: null,
    };
  }
  // Still a draft, or cancelled — nobody owes anything yet.
  return {
    totalMinor,
    paidMinor: 0,
    outstandingMinor: 0,
    paid: false,
    owedMovementId: null,
  };
}

type InvoiceRow = {
  id: number;
  status: number;
  total: number;
  exchangeRate: number;
  ledgerRecordId: number | null;
};

/**
 * The payment state of a whole page of invoices, in two statements however many
 * invoices there are.
 *
 * The owed side is found by what its account *is* (subtype Receivable), not by
 * which account is the Receivable default today. Changing that default later
 * must not make every invoice issued before the change read as unpaid, with
 * nothing to settle against.
 */
function paymentStatesFor(
  db: Db,
  rows: InvoiceRow[],
): Map<number, InvoicePaymentState> {
  const recordIds = rows
    .map((r) => r.ledgerRecordId)
    .filter((id): id is number => id !== null);

  const owedMovements = recordIds.length
    ? db
        .select({
          recordId: ledgerMovements.recordId,
          movementId: ledgerMovements.id,
          amountMinor: ledgerMovements.amountMinor,
        })
        .from(ledgerMovements)
        .innerJoin(accounts, eq(accounts.id, ledgerMovements.accountId))
        .where(
          and(
            inArray(ledgerMovements.recordId, recordIds),
            eq(accounts.subType, AccountSubType.Receivable),
          ),
        )
        .all()
    : [];

  const settled = settledMinorFor(
    db as LedgerDb,
    owedMovements.map((m) => m.movementId),
  );
  const byRecord = new Map(owedMovements.map((m) => [m.recordId, m]));

  const out = new Map<number, InvoicePaymentState>();
  for (const row of rows) {
    const movement =
      row.ledgerRecordId === null
        ? undefined
        : byRecord.get(row.ledgerRecordId);
    const owedSide: SettlementSide | null = movement
      ? {
          movementId: movement.movementId,
          amountMinor: movement.amountMinor,
          settledMinor: settled.get(movement.movementId) ?? 0,
        }
      : null;
    out.set(
      row.id,
      invoicePaymentState(
        toMinor(row.total, row.exchangeRate),
        row.status,
        owedSide,
      ),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Search text
// ---------------------------------------------------------------------------

/** Recomputes and upserts invoice_search_text for one invoice. Also used by the search-rebuild worker. */
export function reindexInvoice(db: Db, invoiceId: number) {
  const row = db
    .select()
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .get();
  if (!row) return;
  const lines = db
    .select({ description: invoiceLines.description })
    .from(invoiceLines)
    .where(eq(invoiceLines.invoiceId, invoiceId))
    .all();
  const text = joinSearchText(
    row.invoiceNumber,
    contactNameFor(db, row.contactId),
    row.reference,
    row.notes,
    row.terms,
    ...lines.map((l) => l.description),
  );
  upsertSearchText(
    db,
    invoiceSearchText,
    invoiceSearchText.invoiceId,
    invoiceSearchText.text,
    invoiceId,
    text,
  );
}

// ---------------------------------------------------------------------------
// Shared select shape
// ---------------------------------------------------------------------------

const invoiceWithContact = {
  ...getTableColumns(invoices),
  contactName: contacts.legalName,
  contactAddress: contacts.address,
  contactRegistrationNo: contacts.registrationNo,
  contactPhone: contacts.phone,
  mainAmount: sql<number>`${invoices.total} * ${invoices.exchangeRate}`,
};

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export function listInvoices(db: Db, filters: InvoiceFilters = {}) {
  const {
    limit = 100,
    offset = 0,
    status,
    contactId,
    overdueOnly,
    search,
    dateFrom,
    dateTo,
  } = filters;

  const conditions: SQL[] = [];
  if (status !== undefined) conditions.push(eq(invoices.status, status));
  if (contactId !== undefined)
    conditions.push(eq(invoices.contactId, contactId));
  if (dateFrom) conditions.push(gte(invoices.issueDate, dateFrom));
  if (dateTo) conditions.push(lte(invoices.issueDate, dateTo));
  if (overdueOnly) {
    // Past due is a column, but "still unpaid" is derived from settlements, so
    // the query narrows to what it can and the final filter happens below.
    // Same rule as `deriveOverdue`: sent invoices only, local "today".
    conditions.push(sql`${invoices.dueDate} < ${localToday()}`);
    conditions.push(eq(invoices.status, InvoiceStatus.Sent));
  }
  if (search) {
    const term = `%${search}%`;
    conditions.push(
      searchTextExists(
        invoiceSearchText,
        invoiceSearchText.invoiceId,
        invoiceSearchText.text,
        invoices.id,
        term,
      ),
    );
  }

  const rows = db
    .select(invoiceWithContact)
    .from(invoices)
    .leftJoin(contacts, eq(contacts.id, invoices.contactId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(invoices.issueDate), desc(invoices.id))
    .limit(limit)
    .offset(offset)
    .all();

  const states = paymentStatesFor(db, rows);
  const withState = rows.map((row) => {
    const state = states.get(row.id)!;
    return { ...row, ...state, isOverdue: deriveOverdue(row, state.paid) };
  });

  return overdueOnly ? withState.filter((row) => row.isOverdue) : withState;
}

export type InvoiceSummary = {
  unpaidCount: number;
  unpaidMinor: Minor;
  overdueCount: number;
  overdueMinor: Minor;
  issuedInPeriodCount: number;
  /** Invoice totals in main-currency cents, issued (sent) within the range. */
  issuedInPeriodMinor: Minor;
};

/**
 * Headline invoice figures for the dashboard's pipeline (007 FR-010), by the
 * same payment-state and overdue rules the Invoices list applies to each row —
 * no second definition of "unpaid" or "overdue".
 */
export function invoiceSummary(
  db: Db,
  range: { from: string; to: string },
  today: string = localToday(),
): InvoiceSummary {
  const rows = db
    .select({
      id: invoices.id,
      status: invoices.status,
      total: invoices.total,
      exchangeRate: invoices.exchangeRate,
      ledgerRecordId: invoices.ledgerRecordId,
      issueDate: invoices.issueDate,
      dueDate: invoices.dueDate,
    })
    .from(invoices)
    .where(inArray(invoices.status, [InvoiceStatus.Sent, InvoiceStatus.Paid]))
    .all();
  const states = paymentStatesFor(db, rows);

  const summary: InvoiceSummary = {
    unpaidCount: 0,
    unpaidMinor: 0,
    overdueCount: 0,
    overdueMinor: 0,
    issuedInPeriodCount: 0,
    issuedInPeriodMinor: 0,
  };
  for (const row of rows) {
    const state = states.get(row.id)!;
    if (row.issueDate >= range.from && row.issueDate <= range.to) {
      summary.issuedInPeriodCount += 1;
      summary.issuedInPeriodMinor += state.totalMinor;
    }
    if (state.outstandingMinor > 0) {
      summary.unpaidCount += 1;
      summary.unpaidMinor += state.outstandingMinor;
    }
    if (deriveOverdue(row, state.paid, today)) {
      summary.overdueCount += 1;
      summary.overdueMinor += state.outstandingMinor;
    }
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Get single
// ---------------------------------------------------------------------------

export function getInvoice(db: Db, id: number) {
  const row = db
    .select(invoiceWithContact)
    .from(invoices)
    .leftJoin(contacts, eq(contacts.id, invoices.contactId))
    .where(eq(invoices.id, id))
    .get();

  if (!row) return null;

  const lines = db
    .select()
    .from(invoiceLines)
    .where(eq(invoiceLines.invoiceId, id))
    .orderBy(asc(invoiceLines.sortOrder))
    .all();

  const state = paymentStatesFor(db, [row]).get(id)!;
  // What has actually been paid against it, for the "payments" list on the
  // detail sheet. Empty until the invoice is sent — there is nothing to pay yet.
  const settlements =
    row.ledgerRecordId === null
      ? []
      : settlementsForRecord(db as LedgerDb, row.ledgerRecordId);

  return {
    ...row,
    ...state,
    lines,
    settlements,
    isOverdue: deriveOverdue(row, state.paid),
    ...reissueLinks(db, row),
  };
}

/**
 * The invoices either side of this one in a void-and-reissue: the voided one it
 * replaces, and the one that replaced it. Each is what the detail page links to.
 */
function reissueLinks(
  db: Db,
  row: { id: number; replacesInvoiceId: number | null },
) {
  const pick = { id: invoices.id, invoiceNumber: invoices.invoiceNumber };
  const replaces =
    row.replacesInvoiceId === null
      ? null
      : (db
          .select(pick)
          .from(invoices)
          .where(eq(invoices.id, row.replacesInvoiceId))
          .get() ?? null);
  const replacedBy =
    db
      .select(pick)
      .from(invoices)
      .where(eq(invoices.replacesInvoiceId, row.id))
      .get() ?? null;
  return { replaces, replacedBy };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export function createInvoice(db: Db, userId: number, data: InvoiceCreate) {
  return db.transaction((tx) => {
    if (!data.lines || data.lines.length === 0) {
      throw new Error("Invoice must have at least one line");
    }

    const totals = computeTotals(data.lines);
    const invoiceNumber = nextNumber(tx, "invoice", data.issueDate);

    const { id: newId } = tx
      .insert(invoices)
      .values({
        invoiceNumber,
        contactId: data.contactId ?? null,
        reference: data.reference ?? null,
        issueDate: data.issueDate,
        dueDate: data.dueDate ?? null,
        currency: data.currency ?? "USD",
        exchangeRate: data.exchangeRate ?? 1,
        subtotal: totals.subtotal,
        taxAmount: totals.taxAmount,
        total: totals.total,
        notes: data.notes ?? null,
        terms: data.terms ?? null,
        sourceQuotationId: data.sourceQuotationId ?? null,
        replacesInvoiceId: data.replacesInvoiceId ?? null,
        createdBy: userId,
        updatedBy: userId,
      })
      .returning({ id: invoices.id })
      .get()!;

    tx.insert(invoiceLines)
      .values(lineRows(data.lines).map((row) => ({ ...row, invoiceId: newId })))
      .run();

    reindexInvoice(tx, newId);
    recordAudit(tx, {
      recordType: "invoice",
      recordId: newId,
      userId,
      action: "create",
    });
    return getInvoice(tx, newId)!;
  });
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export function updateInvoice(
  db: Db,
  id: number,
  userId: number,
  patch: InvoicePatch,
) {
  return db.transaction((tx) => {
    const existing = tx
      .select()
      .from(invoices)
      .where(eq(invoices.id, id))
      .get();
    if (!existing) return null;

    let totalsUpdate: SalesTotals | null = null;
    if (patch.lines) {
      totalsUpdate = computeTotals(patch.lines);
      tx.delete(invoiceLines).where(eq(invoiceLines.invoiceId, id)).run();
      tx.insert(invoiceLines)
        .values(lineRows(patch.lines).map((row) => ({ ...row, invoiceId: id })))
        .run();
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { lines: _lines, ...headerPatch } = patch;
    const setValues = {
      ...headerPatch,
      ...(totalsUpdate ?? {}),
      updatedBy: userId,
      updatedAt: new Date().toISOString(),
    };

    tx.update(invoices).set(setValues).where(eq(invoices.id, id)).run();

    reindexInvoice(tx, id);
    const updatedRow = tx
      .select()
      .from(invoices)
      .where(eq(invoices.id, id))
      .get();
    recordAudit(tx, {
      recordType: "invoice",
      recordId: id,
      userId,
      action: "update",
      changes: diffRecords(existing, updatedRow),
    });
    return getInvoice(tx, id)!;
  });
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * Deletes a draft invoice. When it is the invoice a quotation was converted
 * into, that quotation goes back to Accepted and loses the link, in the same
 * transaction — otherwise it would stay Converted, pointing at nothing, with
 * no way to convert it again. `revertedQuotationId` names it, so the service
 * can tell the quotations list.
 */
export function deleteInvoice(
  db: Db,
  id: number,
  userId: number,
): {
  ok: boolean;
  reason?: "issued" | "cancelled" | "not_found";
  revertedQuotationId?: number;
} {
  return db.transaction((tx) => {
    const existing = tx
      .select()
      .from(invoices)
      .where(eq(invoices.id, id))
      .get();
    if (!existing) return { ok: false, reason: "not_found" };
    // A cancelled invoice keeps its number: the customer may hold a copy, and a
    // gap in the sequence would have nothing to explain it.
    if (existing.status === InvoiceStatus.Cancelled)
      return { ok: false, reason: "cancelled" };
    // Once it has been sent, its amount sits in Money owed to us. Deleting the
    // document would leave that behind with nothing to explain it, so a sent
    // invoice is cancelled rather than deleted. A sent invoice from before the
    // upgrade has no posting, but the customer still has it.
    if (
      existing.ledgerRecordId !== null ||
      existing.status !== InvoiceStatus.Draft
    )
      return { ok: false, reason: "issued" };
    tx.delete(invoices).where(eq(invoices.id, id)).run();
    recordAudit(tx, {
      recordType: "invoice",
      recordId: id,
      userId,
      action: "delete",
      changes: diffRecords(existing, null),
    });

    // Only the quotation that still points here: an invoice whose quote was
    // since converted again (or edited by hand) leaves that quote alone.
    const source =
      existing.sourceQuotationId === null
        ? undefined
        : tx
            .select()
            .from(quotations)
            .where(eq(quotations.id, existing.sourceQuotationId))
            .get();
    if (!source || source.convertedInvoiceId !== id) return { ok: true };

    tx.update(quotations)
      .set({
        status: QuotationStatus.Accepted,
        convertedInvoiceId: null,
        updatedBy: userId,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(quotations.id, source.id))
      .run();
    const reverted = tx
      .select()
      .from(quotations)
      .where(eq(quotations.id, source.id))
      .get();
    recordAudit(tx, {
      recordType: "quotation",
      recordId: source.id,
      userId,
      action: "update",
      changes: diffRecords(source, reverted),
    });
    return { ok: true, revertedQuotationId: source.id };
  });
}

// ---------------------------------------------------------------------------
// Issue (FR-018a)
// ---------------------------------------------------------------------------

/**
 * Records that the invoice has been sent and which record and income account
 * that produced. The record itself is created by `services/invoices.ts`, which
 * owns the rule; this is only the write.
 */
export function markInvoiceIssued(
  db: Db,
  id: number,
  userId: number,
  issued: { ledgerRecordId: number; incomeAccountId: number },
) {
  return db.transaction((tx) => {
    const existing = tx
      .select()
      .from(invoices)
      .where(eq(invoices.id, id))
      .get()!;
    tx.update(invoices)
      .set({
        status: InvoiceStatus.Sent,
        ledgerRecordId: issued.ledgerRecordId,
        incomeAccountId: issued.incomeAccountId,
        updatedBy: userId,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(invoices.id, id))
      .run();
    const updated = tx.select().from(invoices).where(eq(invoices.id, id)).get();
    recordAudit(tx, {
      recordType: "invoice",
      recordId: id,
      userId,
      action: "update",
      changes: diffRecords(existing, updated),
    });
    return getInvoice(tx, id)!;
  });
}

/**
 * Moves the quotation an invoice was converted from off that invoice, when it
 * is voided: onto `toInvoiceId`, the invoice reissued in its place, so the quote
 * stays Converted and points at the live one; or, with nothing reissued, back
 * to Accepted with no link, as deleting a draft invoice does — so the deal can
 * be invoiced again. Only a quotation that still points at `invoiceId` is
 * touched. Returns the quotation it moved, if any.
 */
export function relinkSourceQuotation(
  db: Db,
  invoiceId: number,
  toInvoiceId: number | null,
  userId: number,
): number | null {
  const invoice = db
    .select({ sourceQuotationId: invoices.sourceQuotationId })
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .get();
  if (!invoice || invoice.sourceQuotationId === null) return null;
  const source = db
    .select()
    .from(quotations)
    .where(eq(quotations.id, invoice.sourceQuotationId))
    .get();
  if (!source || source.convertedInvoiceId !== invoiceId) return null;

  const set =
    toInvoiceId === null
      ? { status: QuotationStatus.Accepted, convertedInvoiceId: null }
      : { convertedInvoiceId: toInvoiceId };
  db.update(quotations)
    .set({ ...set, updatedBy: userId, updatedAt: new Date().toISOString() })
    .where(eq(quotations.id, source.id))
    .run();
  const updated = db
    .select()
    .from(quotations)
    .where(eq(quotations.id, source.id))
    .get();
  recordAudit(db, {
    recordType: "quotation",
    recordId: source.id,
    userId,
    action: "update",
    changes: diffRecords(source, updated),
  });
  return source.id;
}

/**
 * Records that the invoice was cancelled: status Cancelled, and no longer
 * linked to an issue posting. The posting itself is removed by
 * `services/invoices.ts`, which owns the rule; this is only the write.
 *
 * Unlinking here, before that record goes, is deliberate. The foreign key would
 * clear `ledger_record_id` on its own (`onDelete: "set null"`), but then this
 * diff would see the link already gone, and the audit entry of an invoice
 * cancelled before voiding removed postings would say nothing changed.
 */
export function markInvoiceCancelled(db: Db, id: number, userId: number) {
  return db.transaction((tx) => {
    const existing = tx
      .select()
      .from(invoices)
      .where(eq(invoices.id, id))
      .get()!;
    tx.update(invoices)
      .set({
        status: InvoiceStatus.Cancelled,
        ledgerRecordId: null,
        updatedBy: userId,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(invoices.id, id))
      .run();
    const updated = tx.select().from(invoices).where(eq(invoices.id, id)).get();
    recordAudit(tx, {
      recordType: "invoice",
      recordId: id,
      userId,
      action: "update",
      changes: diffRecords(existing, updated),
    });
  });
}

// ---------------------------------------------------------------------------
// Which invoices a ledger record belongs to
// ---------------------------------------------------------------------------

/**
 * The invoices whose issue posting is one of `recordIds`. A settlement against
 * that posting changes how much of the invoice is paid without touching the
 * invoice row, so this is how the ledger side finds whom to tell.
 */
export function invoiceIdsForLedgerRecords(
  db: Db,
  recordIds: number[],
): number[] {
  if (recordIds.length === 0) return [];
  return db
    .select({ id: invoices.id })
    .from(invoices)
    .where(inArray(invoices.ledgerRecordId, recordIds))
    .all()
    .map((r) => r.id);
}
