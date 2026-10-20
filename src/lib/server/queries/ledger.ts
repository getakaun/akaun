import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import {
  accounts,
  accountDefaults,
  contacts,
  invoiceLines,
  invoices,
  ledgerMovements,
  ledgerRecords,
  recordAttachments,
  recordSearchText,
  reconciliationAllocations,
  settlements,
} from "../db/schema.js";
import {
  DefaultAccountPurpose,
  LedgerRecordKind,
  type AccountSubTypeCode,
  type AccountTypeCode,
  type LedgerRecordKindCode,
} from "$lib/enums.js";
import { lockStateOf } from "../ledger/locking.js";
import { toMinor } from "../ledger/money.js";
import { coverageFor } from "../ledger/coverage.js";
import { recordSettlementState } from "../ledger/settlement-rules.js";
import { resolveMovementLabel } from "../ledger/movement-label.js";
import type {
  LedgerDb,
  LedgerRecordRow,
  LegacyKind,
  LockState,
  Minor,
  MovementDraft,
  MovementView,
  RecordAttachmentRow,
  RecordBalanceInput,
  RecordCreate,
  RecordListFilters,
  RecordListResult,
  RecordView,
  SettlementSide,
} from "../ledger/types.js";
import { nextNumber } from "../running-number.js";
import {
  joinSearchText,
  searchTextExists,
  upsertSearchText,
} from "../search-text.js";
import type { SequenceDocumentType } from "../db/schema.js";

/**
 * Every read and write of the one record store.
 *
 * Nothing about payment state is stored. `paid`, `outstandingMinor` and
 * `locked` are computed on the way out of here from settlements and
 * reconciliation allocations, which is what stops two screens disagreeing
 * (FR-012). A list page costs a fixed handful of statements however many rows
 * it holds — the movements, settlements, matches and attachment counts for the
 * whole page are fetched once each and stitched together in memory, rather than
 * a query per row.
 *
 * Movements are only ever written from `entry-builder.ts`'s output, which is
 * where the balance rule is enforced. Nothing here constructs a movement.
 */

/**
 * Which running-number counter issues a record's number, or null for the kinds
 * that carry none (D-13). A transfer, an opening balance and a journal entry
 * are internal bookkeeping, not documents anyone refers to by number; an issued
 * invoice is referred to by the invoice's own number.
 */
function sequenceFor(kind: LedgerRecordKindCode): SequenceDocumentType | null {
  switch (kind) {
    case LedgerRecordKind.Expense:
      return "expense";
    case LedgerRecordKind.Income:
      return "income";
    case LedgerRecordKind.Payment:
      return "payment";
    default:
      return null;
  }
}

const KIND_BY_NAME: Record<RecordCreate["kind"], LedgerRecordKindCode> = {
  expense: LedgerRecordKind.Expense,
  income: LedgerRecordKind.Income,
  transfer: LedgerRecordKind.Transfer,
  payment: LedgerRecordKind.Payment,
  "opening-balance": LedgerRecordKind.OpeningBalance,
  "invoice-issue": LedgerRecordKind.InvoiceIssue,
  journal: LedgerRecordKind.Journal,
};

export function kindCodeFor(kind: RecordCreate["kind"]): LedgerRecordKindCode {
  return KIND_BY_NAME[kind];
}

function toRecordRow(row: typeof ledgerRecords.$inferSelect): LedgerRecordRow {
  return {
    id: row.id,
    kind: row.kind as LedgerRecordKindCode,
    date: row.date,
    recordNumber: row.recordNumber,
    description: row.description,
    contactId: row.contactId,
    reference: row.reference,
    remark: row.remark,
    currency: row.currency,
    exchangeRate: row.exchangeRate,
    amount: row.amount,
    extractedText: row.extractedText,
    legacyKind: row.legacyKind as LegacyKind | null,
    legacyId: row.legacyId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Search text
// ---------------------------------------------------------------------------

/**
 * Everything a record can be found by. The record number goes in exactly as it
 * was issued, so searching for a reference number someone wrote down still
 * finds the record after the upgrade (SC-013).
 */
export function buildRecordSearchText(parts: {
  recordNumber: string | null;
  description: string;
  reference: string;
  remark: string;
  contactName: string | null;
  accountNames: string[];
  extractedText: string | null;
}): string {
  return joinSearchText(
    parts.recordNumber,
    parts.description,
    parts.contactName,
    parts.reference,
    parts.remark,
    ...parts.accountNames,
    parts.extractedText,
  );
}

/** Recomputes and upserts one record's search text. Also used by the rebuild worker. */
export function reindexRecord(db: LedgerDb, recordId: number): void {
  const row = db
    .select()
    .from(ledgerRecords)
    .where(eq(ledgerRecords.id, recordId))
    .get();
  if (!row) return;

  const contactName = row.contactId
    ? (db
        .select({ legalName: contacts.legalName })
        .from(contacts)
        .where(eq(contacts.id, row.contactId))
        .get()?.legalName ?? null)
    : null;

  const accountNames = db
    .select({ name: accounts.name })
    .from(ledgerMovements)
    .innerJoin(accounts, eq(accounts.id, ledgerMovements.accountId))
    .where(eq(ledgerMovements.recordId, recordId))
    .all()
    .map((r) => r.name);

  let text = buildRecordSearchText({
    recordNumber: row.recordNumber,
    description: row.description,
    reference: row.reference,
    remark: row.remark,
    contactName,
    accountNames,
    extractedText: row.extractedText,
  });

  // An issued invoice's own notes/terms/line items live on `invoices`, not on
  // this record's columns — fold them in here (search only, never written back
  // to the record's own `remark`) so the record is findable by that content
  // too, not just from /invoices.
  if (row.kind === LedgerRecordKind.InvoiceIssue) {
    const invoice = db
      .select({ id: invoices.id, notes: invoices.notes, terms: invoices.terms })
      .from(invoices)
      .where(eq(invoices.ledgerRecordId, recordId))
      .get();
    if (invoice) {
      const lines = db
        .select({ description: invoiceLines.description })
        .from(invoiceLines)
        .where(eq(invoiceLines.invoiceId, invoice.id))
        .all();
      text = joinSearchText(
        text,
        invoice.notes,
        invoice.terms,
        ...lines.map((l) => l.description),
      );
    }
  }

  upsertSearchText(
    db,
    recordSearchText,
    recordSearchText.recordId,
    recordSearchText.text,
    recordId,
    text,
  );
}

/**
 * Sets just the extracted-text column and re-indexes, without touching
 * updatedBy/updatedAt — a bulk re-extraction must not look like a user edit.
 */
export function setExtractedText(
  db: LedgerDb,
  recordId: number,
  text: string | null,
): void {
  db.update(ledgerRecords)
    .set({ extractedText: text })
    .where(eq(ledgerRecords.id, recordId))
    .run();
  reindexRecord(db, recordId);
}

// ---------------------------------------------------------------------------
// Derived state — settlements and bank matches, for a page of records at once
// ---------------------------------------------------------------------------

type DerivedState = {
  movements: Map<number, MovementView[]>;
  paidState: Map<number, { paid: boolean; outstandingMinor: Minor }>;
  lockState: Map<number, LockState>;
  /** How much bank lines cover, per record, before the coverage rule runs. */
  allocatedMinor: Map<number, Minor>;
  attachmentCount: Map<number, number>;
};

/**
 * How much of each of these movements settlements already cover.
 *
 * A movement counts as covered whether it is the side being paid or the side
 * doing the paying, so undoing a settlement gives both of them back what it
 * took (FR-017).
 */
function settledByMovement(
  db: LedgerDb,
  movementIds: number[],
): Map<number, Minor> {
  const out = new Map<number, Minor>();
  if (movementIds.length === 0) return out;

  const rows = db
    .select({
      paymentMovementId: settlements.paymentMovementId,
      owedMovementId: settlements.owedMovementId,
      amountMinor: settlements.amountMinor,
    })
    .from(settlements)
    .where(
      or(
        inArray(settlements.paymentMovementId, movementIds),
        inArray(settlements.owedMovementId, movementIds),
      ),
    )
    .all();

  const wanted = new Set(movementIds);
  for (const row of rows) {
    for (const id of [row.paymentMovementId, row.owedMovementId]) {
      if (!wanted.has(id)) continue;
      out.set(id, (out.get(id) ?? 0) + row.amountMinor);
    }
  }
  return out;
}

/** Which of these movements a bank line has been matched to. */
function matchedMovements(db: LedgerDb, movementIds: number[]): Set<number> {
  if (movementIds.length === 0) return new Set();
  const rows = db
    .selectDistinct({ movementId: reconciliationAllocations.movementId })
    .from(reconciliationAllocations)
    .where(inArray(reconciliationAllocations.movementId, movementIds))
    .all();
  return new Set(
    rows.map((r) => r.movementId).filter((id): id is number => id !== null),
  );
}

/**
 * How much of each of these movements bank lines account for.
 *
 * One grouped aggregate beside the existence check above, on the same table and
 * the same movement ids — a worklist needs the size of the cover, not just
 * whether any exists (research.md R-08). Whole cents: `amount` is the
 * allocation's decimal figure, so it is converted once, here, and never summed
 * as a float (D-02).
 */
function allocatedByMovement(
  db: LedgerDb,
  movementIds: number[],
): Map<number, Minor> {
  const out = new Map<number, Minor>();
  if (movementIds.length === 0) return out;

  const rows = db
    .select({
      movementId: reconciliationAllocations.movementId,
      amountMinor: sql<number>`cast(round(sum(abs(${reconciliationAllocations.amount})) * 100) as integer)`,
    })
    .from(reconciliationAllocations)
    .where(inArray(reconciliationAllocations.movementId, movementIds))
    .groupBy(reconciliationAllocations.movementId)
    .all();

  for (const row of rows) {
    if (row.movementId === null) continue;
    out.set(row.movementId, row.amountMinor);
  }
  return out;
}

/** Everything derived, for a whole page of records, in a fixed number of queries. */
function deriveFor(db: LedgerDb, recordIds: number[]): DerivedState {
  const empty: DerivedState = {
    movements: new Map(),
    paidState: new Map(),
    lockState: new Map(),
    allocatedMinor: new Map(),
    attachmentCount: new Map(),
  };
  if (recordIds.length === 0) return empty;

  const movementRows = db
    .select({
      id: ledgerMovements.id,
      recordId: ledgerMovements.recordId,
      accountId: ledgerMovements.accountId,
      amountMinor: ledgerMovements.amountMinor,
      sortOrder: ledgerMovements.sortOrder,
      label: ledgerMovements.label,
      // Only for `displayLabel` below — a movement stores no description of
      // its own, and this is the one place `MovementView` is built, so the
      // fallback is resolved here rather than left for every reader to redo.
      recordDescription: ledgerRecords.description,
      accountName: accounts.name,
      accountType: accounts.type,
      accountRole: accounts.role,
      accountSubType: accounts.subType,
    })
    .from(ledgerMovements)
    .innerJoin(accounts, eq(accounts.id, ledgerMovements.accountId))
    .innerJoin(ledgerRecords, eq(ledgerRecords.id, ledgerMovements.recordId))
    .where(inArray(ledgerMovements.recordId, recordIds))
    .orderBy(asc(ledgerMovements.sortOrder), asc(ledgerMovements.id))
    .all();

  const movementIds = movementRows.map((m) => m.id);
  const owedAccountIds = new Set(
    db
      .select({ id: accountDefaults.accountId })
      .from(accountDefaults)
      .where(
        inArray(accountDefaults.purpose, [
          DefaultAccountPurpose.Receivable,
          DefaultAccountPurpose.Payable,
        ]),
      )
      .all()
      .map((row) => row.id),
  );
  const settled = settledByMovement(db, movementIds);
  const matched = matchedMovements(db, movementIds);
  const allocated = allocatedByMovement(db, movementIds);

  const movements = new Map<number, MovementView[]>();
  const owedSides = new Map<number, SettlementSide[]>();
  const lockState = new Map<number, LockState>();

  for (const id of recordIds) {
    movements.set(id, []);
    owedSides.set(id, []);
    lockState.set(id, { settled: false, reconciled: false });
  }

  for (const m of movementRows) {
    movements.get(m.recordId)?.push({
      id: m.id,
      accountId: m.accountId,
      accountName: m.accountName,
      accountType: m.accountType as AccountTypeCode,
      accountRole: m.accountRole,
      accountSubType: m.accountSubType as AccountSubTypeCode | null,
      amountMinor: m.amountMinor,
      label: m.label,
      displayLabel: resolveMovementLabel(m.label, m.recordDescription),
    });

    if (owedAccountIds.has(m.accountId)) {
      owedSides.get(m.recordId)?.push({
        movementId: m.id,
        amountMinor: m.amountMinor,
        settledMinor: settled.get(m.id) ?? 0,
      });
    }

    const lock = lockState.get(m.recordId);
    if (lock) {
      if ((settled.get(m.id) ?? 0) > 0) lock.settled = true;
      if (matched.has(m.id)) lock.reconciled = true;
    }
  }

  const paidState = new Map<
    number,
    { paid: boolean; outstandingMinor: Minor }
  >();
  for (const id of recordIds) {
    paidState.set(id, recordSettlementState(owedSides.get(id) ?? []));
  }

  // What bank lines cover, per record. Summed from the movement allocations
  // already fetched above, so the coverage rule has whole cents to work with
  // and no second pass over the hot path (FR-056).
  const allocatedMinor = new Map<number, Minor>();
  for (const id of recordIds) allocatedMinor.set(id, 0);
  for (const m of movementRows) {
    const covered = allocated.get(m.id) ?? 0;
    if (covered === 0) continue;
    allocatedMinor.set(
      m.recordId,
      (allocatedMinor.get(m.recordId) ?? 0) + covered,
    );
  }

  const attachmentRows = db
    .select({
      recordId: recordAttachments.recordId,
      n: sql<number>`count(*)`,
    })
    .from(recordAttachments)
    .where(inArray(recordAttachments.recordId, recordIds))
    .groupBy(recordAttachments.recordId)
    .all();

  return {
    movements,
    paidState,
    lockState,
    allocatedMinor,
    attachmentCount: new Map(attachmentRows.map((r) => [r.recordId, r.n])),
  };
}

function toRecordView(
  row: typeof ledgerRecords.$inferSelect,
  contactName: string | null,
  derived: DerivedState,
): RecordView {
  const base = toRecordRow(row);
  const paidState = derived.paidState.get(row.id) ?? {
    paid: true,
    outstandingMinor: 0,
  };
  const lockState = derived.lockState.get(row.id) ?? {
    settled: false,
    reconciled: false,
  };
  const lock = lockStateOf(lockState);
  const movements = derived.movements.get(row.id) ?? [];
  return {
    ...base,
    contactName,
    amountMinor: toMinor(base.amount, base.exchangeRate),
    movements,
    paid: paidState.paid,
    outstandingMinor: paidState.outstandingMinor,
    locked: lock.locked,
    lockedReason: lock.reason,
    reconciled: lockState.reconciled,
    // Every side of every record on the page is already loaded by deriveFor(),
    // so the count a row needs costs no extra query (FR-003).
    sideCount: movements.length,
    ...coverageFor({
      amountMinor: toMinor(base.amount, base.exchangeRate),
      allocations: [
        {
          movementId: 0,
          amountMinor: derived.allocatedMinor.get(row.id) ?? 0,
        },
      ],
    }),
    attachmentCount: derived.attachmentCount.get(row.id) ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

// Aliased purely to let a batch payment's own record — which touches this
// contact only through its settlements, not its own `contactId` — join back
// to that contact without colliding with the ledger_movements/ledger_records
// already selected from for the row itself (see the `contactId` filter below).
const paymentMovementsForContact = alias(
  ledgerMovements,
  "payment_movements_for_contact",
);
const owedMovementsForContact = alias(
  ledgerMovements,
  "owed_movements_for_contact",
);
const owedRecordsForContact = alias(ledgerRecords, "owed_records_for_contact");

function recordConditions(filters: RecordListFilters): SQL[] {
  const conditions: SQL[] = [];

  if (filters.kind !== undefined) {
    conditions.push(
      Array.isArray(filters.kind)
        ? inArray(ledgerRecords.kind, filters.kind)
        : eq(ledgerRecords.kind, filters.kind),
    );
  }
  if (filters.contactId !== undefined) {
    // A contact's own records, plus a batch payment that settled one of their
    // bills without naming them as its own single contact (FR-008's
    // exception for a payment covering several contacts at once) — that
    // attribution lives in `settlements`, not on the payment's own row.
    conditions.push(
      sql`(${eq(ledgerRecords.contactId, filters.contactId)} OR EXISTS (
        SELECT 1 FROM ${ledgerMovements} AS "payment_movements_for_contact"
        INNER JOIN ${settlements} ON ${settlements.paymentMovementId} = ${paymentMovementsForContact.id}
        INNER JOIN ${ledgerMovements} AS "owed_movements_for_contact" ON ${owedMovementsForContact.id} = ${settlements.owedMovementId}
        INNER JOIN ${ledgerRecords} AS "owed_records_for_contact" ON ${owedRecordsForContact.id} = ${owedMovementsForContact.recordId}
        WHERE ${paymentMovementsForContact.recordId} = ${ledgerRecords.id}
          AND ${owedRecordsForContact.contactId} = ${filters.contactId}
      ))`,
    );
  }
  if (filters.dateFrom)
    conditions.push(gte(ledgerRecords.date, filters.dateFrom));
  if (filters.dateTo) conditions.push(lte(ledgerRecords.date, filters.dateTo));
  if (filters.amountMin !== undefined) {
    conditions.push(gte(ledgerRecords.amount, filters.amountMin));
  }
  if (filters.amountMax !== undefined) {
    conditions.push(lte(ledgerRecords.amount, filters.amountMax));
  }

  // "Records touching this account" and "records in this category" are the same
  // question asked of the movements table, so both are one EXISTS.
  for (const accountId of [filters.accountId, filters.categoryAccountId]) {
    if (accountId === undefined) continue;
    conditions.push(
      sql`EXISTS (SELECT 1 FROM ${ledgerMovements} WHERE ${ledgerMovements.recordId} = ${ledgerRecords.id} AND ${ledgerMovements.accountId} = ${accountId})`,
    );
  }

  if (filters.search) {
    conditions.push(
      searchTextExists(
        recordSearchText,
        recordSearchText.recordId,
        recordSearchText.text,
        ledgerRecords.id,
        `%${filters.search}%`,
      ),
    );
  }

  if (filters.cleared !== undefined) {
    // Covered means: bank lines account for the whole of the record's own
    // figure. Asked of the database rather than of the page, so "not yet
    // cleared" can be paged through without loading everything first — the same
    // shape the `paid` filter uses below.
    //
    // Every account, not only those with a statement uploaded: a record on an
    // account nobody has reconciled has no allocations at all, so it is not
    // cleared, which is exactly what the worklist should say (FR-056).
    const covered = sql`coalesce((
      SELECT sum(abs(${reconciliationAllocations.amount}))
      FROM ${reconciliationAllocations}
      INNER JOIN ${ledgerMovements}
        ON ${ledgerMovements.id} = ${reconciliationAllocations.movementId}
      WHERE ${ledgerMovements.recordId} = ${ledgerRecords.id}
    ), 0) * 100 >= abs(round(${ledgerRecords.amount} * ${ledgerRecords.exchangeRate} * 100)) - 0.5`;
    conditions.push(filters.cleared ? covered : sql`NOT ${covered}`);
  }

  if (filters.paid !== undefined) {
    // Paid means: no side on a shared owed account is still uncovered. Asked of
    // the database rather than of the page, so `paid=false` can be paged
    // through without loading everything first (D-10).
    const stillOwed = sql`EXISTS (
      SELECT 1 FROM ${ledgerMovements}
      INNER JOIN ${accounts} ON ${accounts.id} = ${ledgerMovements.accountId}
      WHERE ${ledgerMovements.recordId} = ${ledgerRecords.id}
        AND ${accounts.id} IN (
          SELECT ${accountDefaults.accountId} FROM ${accountDefaults}
          WHERE ${accountDefaults.purpose} IN (
            ${DefaultAccountPurpose.Receivable},
            ${DefaultAccountPurpose.Payable}
          )
        )
        AND abs(${ledgerMovements.amountMinor}) > coalesce((
          SELECT sum(${settlements.amountMinor}) FROM ${settlements}
          WHERE ${settlements.owedMovementId} = ${ledgerMovements.id}
             OR ${settlements.paymentMovementId} = ${ledgerMovements.id}
        ), 0)
    )`;
    conditions.push(filters.paid ? sql`NOT ${stillOwed}` : stillOwed);
  }

  return conditions;
}

export function listRecords(
  db: LedgerDb,
  filters: RecordListFilters = {},
): RecordListResult {
  const { limit = 100, offset = 0, sort = "date" } = filters;
  const conditions = recordConditions(filters);
  const where = conditions.length ? and(...conditions) : undefined;

  // Newest first by default. `amount` sorts by the record's own figure, and the
  // id is the tie-break in both, so a page boundary never repeats or drops a
  // row. The running balance is only offered in date order (FR-043), which is
  // why the caller has to say which sort is in force.
  const orderBy =
    sort === "amount"
      ? [desc(ledgerRecords.amount), desc(ledgerRecords.id)]
      : [desc(ledgerRecords.date), desc(ledgerRecords.id)];

  const rows = db
    .select({
      record: ledgerRecords,
      contactName: contacts.legalName,
    })
    .from(ledgerRecords)
    .leftJoin(contacts, eq(contacts.id, ledgerRecords.contactId))
    .where(where)
    .orderBy(...orderBy)
    .limit(limit)
    .offset(offset)
    .all();

  const total =
    db
      .select({ n: sql<number>`count(*)` })
      .from(ledgerRecords)
      .where(where)
      .get()?.n ?? 0;

  const derived = deriveFor(
    db,
    rows.map((r) => r.record.id),
  );

  return {
    records: rows.map((r) =>
      toRecordView(r.record, r.contactName ?? null, derived),
    ),
    total,
  };
}

/** Selection metadata for statement rows, including records outside the list's initial batch. */
export function recordSelectionDetails(db: LedgerDb, recordIds: number[]) {
  const ids = [...new Set(recordIds)];
  if (!ids.length) return [];
  const rows = db
    .select()
    .from(ledgerRecords)
    .where(inArray(ledgerRecords.id, ids))
    .all();
  const derived = deriveFor(db, ids);
  return rows.map((row) => {
    const record = toRecordView(row, null, derived);
    return {
      id: record.id,
      amountMinor: record.amountMinor,
      locked: record.locked,
    };
  });
}

export function getRecord(db: LedgerDb, id: number): RecordView | null {
  const row = db
    .select({ record: ledgerRecords, contactName: contacts.legalName })
    .from(ledgerRecords)
    .leftJoin(contacts, eq(contacts.id, ledgerRecords.contactId))
    .where(eq(ledgerRecords.id, id))
    .get();
  if (!row) return null;
  return toRecordView(row.record, row.contactName ?? null, deriveFor(db, [id]));
}

/** The raw row, for a caller that needs what is stored rather than what is shown. */
export function getRecordRow(db: LedgerDb, id: number): LedgerRecordRow | null {
  const row = db
    .select()
    .from(ledgerRecords)
    .where(eq(ledgerRecords.id, id))
    .get();
  return row ? toRecordRow(row) : null;
}

// `findByLegacy()` was here: it resolved a pre-upgrade `/expenses/[id]` or
// `/income/[id]` link to the record that id became. The three addresses it
// served are retired outright rather than redirected, so nothing asks the
// question any more (FR-025a, D-04).
//
// The `legacy_kind` / `legacy_id` columns and their unique index STAY. They are
// provenance — which old table a record came from and what its id was there —
// and the upgrade's idempotency key. FR-037 does not name them; only the lookup
// went (research.md R-06).

export function getMovements(db: LedgerDb, recordId: number): MovementView[] {
  return deriveFor(db, [recordId]).movements.get(recordId) ?? [];
}

/** Whether a record is settled, matched to a bank line, or both (FR-017a). */
export function lockStateFor(db: LedgerDb, recordId: number): LockState {
  return (
    deriveFor(db, [recordId]).lockState.get(recordId) ?? {
      settled: false,
      reconciled: false,
    }
  );
}

// ---------------------------------------------------------------------------
// Writes — movements always come from entry-builder.ts
// ---------------------------------------------------------------------------

/**
 * A side that keeps its `sortOrder` is updated in place, not replaced — its
 * id stays the same, so a settlement or reconciliation allocation pointing at
 * it (via an `onDelete: "cascade"` foreign key) survives a rebuild that never
 * actually touched that side (FR-017a's category exception depends on this).
 * A side that gains or loses its place is inserted or deleted as before.
 */
function replaceMovements(
  db: LedgerDb,
  recordId: number,
  movements: MovementDraft[],
): void {
  const existingRows = db
    .select({ id: ledgerMovements.id, sortOrder: ledgerMovements.sortOrder })
    .from(ledgerMovements)
    .where(eq(ledgerMovements.recordId, recordId))
    .all();
  const existingBySortOrder = new Map(
    existingRows.map((r) => [r.sortOrder, r.id]),
  );
  const nextSortOrders = new Set(movements.map((m) => m.sortOrder));

  for (const m of movements) {
    const existingId = existingBySortOrder.get(m.sortOrder);
    if (existingId === undefined) continue;
    db.update(ledgerMovements)
      .set({
        accountId: m.accountId,
        amountMinor: m.amountMinor,
        label: m.label,
      })
      .where(eq(ledgerMovements.id, existingId))
      .run();
  }

  const toInsert = movements.filter(
    (m) => !existingBySortOrder.has(m.sortOrder),
  );
  if (toInsert.length > 0) {
    db.insert(ledgerMovements)
      .values(
        toInsert.map((m) => ({
          recordId,
          accountId: m.accountId,
          amountMinor: m.amountMinor,
          sortOrder: m.sortOrder,
          label: m.label,
        })),
      )
      .run();
  }

  const toDeleteIds = existingRows
    .filter((r) => !nextSortOrders.has(r.sortOrder))
    .map((r) => r.id);
  if (toDeleteIds.length > 0) {
    db.delete(ledgerMovements)
      .where(inArray(ledgerMovements.id, toDeleteIds))
      .run();
  }
}

export function insertRecord(
  db: LedgerDb,
  actingUserId: number | null,
  data: {
    kind: LedgerRecordKindCode;
    date: string;
    description: string;
    amount: number;
    currency: string;
    exchangeRate: number;
    contactId?: number | null;
    reference?: string;
    remark?: string;
    extractedText?: string | null;
    /** Supplied only by the upgrade, which never regenerates a number (FR-032d). */
    recordNumber?: string | null;
    /** Supplied only by the upgrade, to preserve a migrated expense's id (D-14). */
    id?: number;
    legacyKind?: LegacyKind | null;
    legacyId?: number | null;
  },
  movements: MovementDraft[],
): LedgerRecordRow {
  const sequence = sequenceFor(data.kind);
  const recordNumber =
    data.recordNumber !== undefined
      ? data.recordNumber
      : sequence
        ? nextNumber(db, sequence, data.date)
        : null;

  const row = db
    .insert(ledgerRecords)
    .values({
      ...(data.id !== undefined ? { id: data.id } : {}),
      kind: data.kind,
      date: data.date,
      recordNumber,
      description: data.description,
      contactId: data.contactId ?? null,
      reference: data.reference ?? "",
      remark: data.remark ?? "",
      currency: data.currency,
      exchangeRate: data.exchangeRate,
      amount: data.amount,
      extractedText: data.extractedText ?? null,
      legacyKind: data.legacyKind ?? null,
      legacyId: data.legacyId ?? null,
      createdBy: actingUserId,
      updatedBy: actingUserId,
    })
    .returning()
    .get()!;

  replaceMovements(db, row.id, movements);
  reindexRecord(db, row.id);
  return toRecordRow(row);
}

export function updateRecord(
  db: LedgerDb,
  id: number,
  actingUserId: number | null,
  patch: Partial<{
    date: string;
    description: string;
    amount: number;
    currency: string;
    exchangeRate: number;
    contactId: number | null;
    reference: string;
    remark: string;
    extractedText: string | null;
  }>,
  movements?: MovementDraft[],
): LedgerRecordRow | null {
  const existing = db
    .select()
    .from(ledgerRecords)
    .where(eq(ledgerRecords.id, id))
    .get();
  if (!existing) return null;

  const updated = db
    .update(ledgerRecords)
    .set({
      ...patch,
      updatedBy: actingUserId,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(ledgerRecords.id, id))
    .returning()
    .get()!;

  if (movements) replaceMovements(db, id, movements);
  reindexRecord(db, id);
  return toRecordRow(updated);
}

/** The row before a change, for the audit diff. */
export function snapshotForAudit(
  db: LedgerDb,
  id: number,
): Record<string, unknown> | null {
  const row = getRecordRow(db, id);
  if (!row) return null;
  const movements = db
    .select({
      accountId: ledgerMovements.accountId,
      amountMinor: ledgerMovements.amountMinor,
    })
    .from(ledgerMovements)
    .where(eq(ledgerMovements.recordId, id))
    .orderBy(asc(ledgerMovements.sortOrder), asc(ledgerMovements.id))
    .all();
  return { ...row, movements };
}

export function deleteRecord(db: LedgerDb, id: number): boolean {
  // Movements, attachments and search text all cascade from the record.
  const result = db
    .delete(ledgerRecords)
    .where(eq(ledgerRecords.id, id))
    .returning({ id: ledgerRecords.id })
    .get();
  return result !== undefined;
}

// ---------------------------------------------------------------------------
// The whole-books check
// ---------------------------------------------------------------------------

/**
 * Every record reduced to the figures the balance rules need, plus the sum of
 * the whole movements table.
 *
 * Two aggregates, both grouped on indexed columns, so the sweep stays the same
 * shape as the books grow rather than degrading into a scan per record
 * (SC-002). The arithmetic itself is `ledger/integrity.ts`'s, over plain rows.
 */
export function integrityInputs(db: LedgerDb): {
  records: RecordBalanceInput[];
  wholeBooksSumMinor: Minor;
} {
  const rows = db
    .select({
      recordId: ledgerRecords.id,
      kind: ledgerRecords.kind,
      amount: ledgerRecords.amount,
      exchangeRate: ledgerRecords.exchangeRate,
      contactId: ledgerRecords.contactId,
      movementCount: sql<number>`count(${ledgerMovements.id})`,
      movementSumMinor: sql<number>`coalesce(sum(${ledgerMovements.amountMinor}), 0)`,
      positiveSumMinor: sql<number>`coalesce(sum(case when ${ledgerMovements.amountMinor} > 0 then ${ledgerMovements.amountMinor} else 0 end), 0)`,
      zeroMovements: sql<number>`coalesce(sum(case when ${ledgerMovements.amountMinor} = 0 then 1 else 0 end), 0)`,
      touchesSharedOwed: sql<number>`coalesce(max(case when ${accounts.id} in (
        select ${accountDefaults.accountId} from ${accountDefaults}
        where ${accountDefaults.purpose} in (
          ${DefaultAccountPurpose.Receivable},
          ${DefaultAccountPurpose.Payable}
        )
      ) then 1 else 0 end), 0)`,
    })
    .from(ledgerRecords)
    .leftJoin(ledgerMovements, eq(ledgerMovements.recordId, ledgerRecords.id))
    .leftJoin(accounts, eq(accounts.id, ledgerMovements.accountId))
    .groupBy(ledgerRecords.id)
    .all();

  const wholeBooksSumMinor =
    db
      .select({
        total: sql<number>`coalesce(sum(${ledgerMovements.amountMinor}), 0)`,
      })
      .from(ledgerMovements)
      .get()?.total ?? 0;

  return {
    records: rows.map((row) => ({
      recordId: row.recordId,
      kind: row.kind as LedgerRecordKindCode,
      movementCount: row.movementCount,
      movementSumMinor: row.movementSumMinor,
      positiveSumMinor: row.positiveSumMinor,
      expectedMinor: toMinor(row.amount, row.exchangeRate),
      hasZeroMovement: row.zeroMovements > 0,
      missingContact: row.touchesSharedOwed === 1 && row.contactId === null,
    })),
    wholeBooksSumMinor,
  };
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

export function listAttachments(
  db: LedgerDb,
  recordId: number,
): RecordAttachmentRow[] {
  return db
    .select()
    .from(recordAttachments)
    .where(eq(recordAttachments.recordId, recordId))
    .orderBy(asc(recordAttachments.id))
    .all();
}

/**
 * The files attached to a record whose text may be searched as the record's
 * own: every attachment except a document imported as several items.
 *
 * One stored file is attached to every record made from a document with
 * several items (006 FR-027). Its text describes every one of those records,
 * so indexing it would make each of them match a search for any other line of
 * the document (FR-029). A record made that way is found by its own
 * description, contact, reference and amount instead. The attachment row says
 * so itself (`group_document`), so the rule still holds after the other
 * records have let the file go, or the import has been cleared from history.
 * A file another record also has is left out too, however it came to be
 * shared. A file only this record has, such as a receipt added by hand, is
 * indexed as before. Indexed or not, the file stays attached and opens from
 * every record.
 */
export function searchableAttachmentFilenames(
  db: LedgerDb,
  recordId: number,
): string[] {
  return db
    .select({ filename: recordAttachments.filename })
    .from(recordAttachments)
    .where(
      and(
        eq(recordAttachments.recordId, recordId),
        eq(recordAttachments.groupDocument, false),
        // Uses the index on record_attachments.filename (migration 0022).
        sql`not exists (select 1 from record_attachments as other where other.filename = ${recordAttachments.filename} and other.record_id <> ${recordAttachments.recordId})`,
      ),
    )
    .orderBy(asc(recordAttachments.id))
    .all()
    .map((row) => row.filename);
}

/**
 * Attaches a stored file to a record. `groupDocument` marks a document
 * imported as several items, whose text is then never searched as this
 * record's own (see `searchableAttachmentFilenames`).
 */
export function addAttachment(
  db: LedgerDb,
  recordId: number,
  filename: string,
  displayName: string,
  options: { groupDocument?: boolean } = {},
): RecordAttachmentRow {
  return db
    .insert(recordAttachments)
    .values({
      recordId,
      filename,
      displayName,
      groupDocument: options.groupDocument ?? false,
    })
    .returning()
    .get()!;
}

export function getAttachment(
  db: LedgerDb,
  attachmentId: number,
): RecordAttachmentRow | null {
  return (
    db
      .select()
      .from(recordAttachments)
      .where(eq(recordAttachments.id, attachmentId))
      .get() ?? null
  );
}

export function deleteAttachment(db: LedgerDb, attachmentId: number): boolean {
  const row = db
    .delete(recordAttachments)
    .where(eq(recordAttachments.id, attachmentId))
    .returning({ id: recordAttachments.id })
    .get();
  return row !== undefined;
}
