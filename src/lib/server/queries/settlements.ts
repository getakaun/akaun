import { and, asc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import {
  accounts,
  accountDefaults,
  contacts,
  invoices,
  ledgerMovements,
  ledgerRecords,
  settlements,
} from "../db/schema.js";
import {
  DefaultAccountPurpose,
  type LedgerRecordKindCode,
} from "$lib/enums.js";
import { outstandingOf } from "../ledger/settlement-rules.js";
import type {
  LedgerDb,
  Minor,
  OutstandingDirection,
  OutstandingItem,
  OutstandingResult,
  SettlementSide,
} from "../ledger/types.js";

/**
 * Who owes what, and what a payment may be put against.
 *
 * Everything here is worked out from movements on the two shared owed accounts
 * less the settlements written against them. Nothing is stored, so a contact's
 * balance on the Expenses screen and the same figure on a report are the same
 * arithmetic over the same rows (FR-012, FR-014).
 */

const PURPOSE_FOR = {
  "owed-to-us": DefaultAccountPurpose.Receivable,
  "we-owe": DefaultAccountPurpose.Payable,
};

function savedAccountId(db: LedgerDb, purpose: number): number | null {
  return (
    db
      .select({ accountId: accountDefaults.accountId })
      .from(accountDefaults)
      .where(eq(accountDefaults.purpose, purpose))
      .get()?.accountId ?? null
  );
}

/** How much of each movement settlements already cover, from either side. */
export function settledMinorFor(
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

/** Whole days between `date` and `today`, negative while it is not yet due. */
function daysBetween(date: string, today: string): number {
  const ms = Date.parse(`${today}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(ms)) return 0;
  return Math.floor(ms / 86_400_000);
}

export type OutstandingFilters = {
  direction: OutstandingDirection;
  contactId?: number;
  /** Drop items nothing is left on. Defaults to true — a payment screen only
   *  offers what can still be paid. */
  openOnly?: boolean;
  /** "Today" for the ageing arithmetic; the caller supplies it so a report for
   *  a past date ages against that date rather than now. */
  asOf?: string;
};

/**
 * An outstanding item with the two extras only the who-owes-what views need:
 * which age group it falls in, and enough about the record behind it to open
 * that record from a row (US6, CLAUDE.md § Cross-Feature Relation Cards).
 */
export type AgeingItem = OutstandingItem & {
  kind: LedgerRecordKindCode;
  /** Set only when the record is one an invoice issued. */
  invoiceId: number | null;
  band: string;
};

/**
 * The outstanding items a payment can be allocated against, each with how much
 * of it is left and how overdue it is.
 *
 * A due date comes from the invoice that issued the record where there is one,
 * and from the record's own date otherwise — an expense someone paid on your
 * behalf is owed from the day they paid it (US6 AC1, AC2).
 */
function collectOutstanding(
  db: LedgerDb,
  filters: OutstandingFilters,
  page?: { limit: number; offset: number },
): {
  asOf: string;
  items: AgeingItem[];
  totalOutstandingMinor: Minor;
  total: number;
} {
  const asOf = filters.asOf ?? new Date().toISOString().slice(0, 10);
  const openOnly = filters.openOnly ?? true;

  const defaultId = savedAccountId(db, PURPOSE_FOR[filters.direction]);
  const conditions: SQL[] = [eq(ledgerMovements.accountId, defaultId ?? -1)];
  if (filters.contactId !== undefined) {
    conditions.push(eq(ledgerRecords.contactId, filters.contactId));
  }

  // SQL equivalent of outstandingOf(): clamp abs(side) minus settlements at
  // zero. Apply before LIMIT so fully paid items do not consume a page.
  const remaining = sql<number>`max(0, abs(${ledgerMovements.amountMinor}) - coalesce((
    SELECT sum(${settlements.amountMinor}) FROM ${settlements}
    WHERE ${settlements.owedMovementId} = ${ledgerMovements.id}
       OR ${settlements.paymentMovementId} = ${ledgerMovements.id}
  ), 0))`;
  if (openOnly) conditions.push(sql`${remaining} > 0`);
  const totals = page
    ? db
        .select({
          total: sql<number>`count(*)`,
          totalOutstandingMinor: sql<number>`coalesce(sum(${remaining}), 0)`,
        })
        .from(ledgerMovements)
        .innerJoin(
          ledgerRecords,
          eq(ledgerRecords.id, ledgerMovements.recordId),
        )
        .where(and(...conditions))
        .get()
    : null;

  const rows = db
    .select({
      movementId: ledgerMovements.id,
      amountMinor: ledgerMovements.amountMinor,
      recordId: ledgerRecords.id,
      recordNumber: ledgerRecords.recordNumber,
      kind: ledgerRecords.kind,
      date: ledgerRecords.date,
      description: ledgerRecords.description,
      contactId: ledgerRecords.contactId,
      contactName: contacts.legalName,
      dueDate: invoices.dueDate,
      invoiceId: invoices.id,
    })
    .from(ledgerMovements)
    .innerJoin(accounts, eq(accounts.id, ledgerMovements.accountId))
    .innerJoin(ledgerRecords, eq(ledgerRecords.id, ledgerMovements.recordId))
    .leftJoin(contacts, eq(contacts.id, ledgerRecords.contactId))
    .leftJoin(invoices, eq(invoices.ledgerRecordId, ledgerRecords.id))
    .where(and(...conditions))
    .orderBy(
      asc(ledgerRecords.date),
      asc(ledgerRecords.id),
      asc(ledgerMovements.id),
    )
    .limit(page?.limit ?? -1)
    .offset(page?.offset ?? 0)
    .all();

  const settled = settledMinorFor(
    db,
    rows.map((r) => r.movementId),
  );

  const items: AgeingItem[] = [];
  for (const row of rows) {
    const side: SettlementSide = {
      movementId: row.movementId,
      amountMinor: row.amountMinor,
      settledMinor: settled.get(row.movementId) ?? 0,
    };
    const outstandingMinor = outstandingOf(side);
    if (openOnly && outstandingMinor === 0) continue;

    const dueDate = row.dueDate ?? row.date;
    const daysOverdue = Math.max(0, daysBetween(dueDate, asOf));
    items.push({
      movementId: row.movementId,
      recordId: row.recordId,
      recordNumber: row.recordNumber,
      kind: row.kind as LedgerRecordKindCode,
      invoiceId: row.invoiceId,
      date: row.date,
      dueDate,
      description: row.description,
      contactId: row.contactId,
      contactName: row.contactName ?? null,
      amountMinor: Math.abs(row.amountMinor),
      settledMinor: side.settledMinor,
      outstandingMinor,
      daysOverdue,
      band: bandFor(daysOverdue),
    });
  }

  return {
    asOf,
    items,
    total: totals?.total ?? items.length,
    totalOutstandingMinor:
      totals?.totalOutstandingMinor ??
      items.reduce((sum, i) => sum + i.outstandingMinor, 0),
  };
}

export function listOutstanding(
  db: LedgerDb,
  filters: OutstandingFilters,
): OutstandingResult {
  const { asOf, items, totalOutstandingMinor } = collectOutstanding(
    db,
    filters,
  );
  const result = { asOf, items, totalOutstandingMinor };
  return result;
}

/** Bounded rows with totals over the whole filtered set, using the same rules. */
export function listOutstandingPage(
  db: LedgerDb,
  filters: OutstandingFilters,
  page: { limit: number; offset: number },
) {
  return collectOutstanding(db, filters, page);
}

/** One outstanding side, for the allocation check on the way in. */
export function getSide(
  db: LedgerDb,
  movementId: number,
): (SettlementSide & { accountId: number; contactId: number | null }) | null {
  const row = db
    .select({
      id: ledgerMovements.id,
      accountId: ledgerMovements.accountId,
      amountMinor: ledgerMovements.amountMinor,
      contactId: ledgerRecords.contactId,
    })
    .from(ledgerMovements)
    .innerJoin(ledgerRecords, eq(ledgerRecords.id, ledgerMovements.recordId))
    .where(eq(ledgerMovements.id, movementId))
    .get();
  if (!row) return null;

  return {
    movementId: row.id,
    amountMinor: row.amountMinor,
    settledMinor: settledMinorFor(db, [movementId]).get(movementId) ?? 0,
    accountId: row.accountId,
    contactId: row.contactId,
  };
}

/** The same, for several movements at once. */
export function getSides(
  db: LedgerDb,
  movementIds: number[],
): Map<
  number,
  SettlementSide & { accountId: number; contactId: number | null }
> {
  const out = new Map<
    number,
    SettlementSide & { accountId: number; contactId: number | null }
  >();
  if (movementIds.length === 0) return out;

  const rows = db
    .select({
      id: ledgerMovements.id,
      accountId: ledgerMovements.accountId,
      amountMinor: ledgerMovements.amountMinor,
      contactId: ledgerRecords.contactId,
    })
    .from(ledgerMovements)
    .innerJoin(ledgerRecords, eq(ledgerRecords.id, ledgerMovements.recordId))
    .where(inArray(ledgerMovements.id, movementIds))
    .all();

  const settled = settledMinorFor(db, movementIds);
  for (const row of rows) {
    out.set(row.id, {
      movementId: row.id,
      amountMinor: row.amountMinor,
      settledMinor: settled.get(row.id) ?? 0,
      accountId: row.accountId,
      contactId: row.contactId,
    });
  }
  return out;
}

export type ContactBalance = {
  contactId: number;
  contactName: string;
  outstandingMinor: Minor;
};

/** What each contact is still owed, or still owes, in one query per direction. */
export function contactBalances(
  db: LedgerDb,
  direction: OutstandingDirection,
  contactId?: number,
): ContactBalance[] {
  const { items } = listOutstanding(db, {
    direction,
    contactId,
    openOnly: true,
  });
  return balancesByContact(items);
}

/**
 * Outstanding items totalled per contact, largest first — the one rule behind
 * `contactBalances`, split out so a screen that already holds the items (the
 * dashboard's ageing) gets the same answer without a second read.
 */
export function balancesByContact(items: OutstandingItem[]): ContactBalance[] {
  const byContact = new Map<number, ContactBalance>();
  for (const item of items) {
    if (item.contactId === null) continue;
    const existing = byContact.get(item.contactId);
    if (existing) {
      existing.outstandingMinor += item.outstandingMinor;
    } else {
      byContact.set(item.contactId, {
        contactId: item.contactId,
        contactName: item.contactName ?? "",
        outstandingMinor: item.outstandingMinor,
      });
    }
  }
  return [...byContact.values()].sort(
    (a, b) => b.outstandingMinor - a.outstandingMinor,
  );
}

/** The settlements written against a record, for the "what paid this" list (FR-018). */
export type SettlementLink = {
  settlementId: number;
  amountMinor: Minor;
  createdAt: string;
  /** The record on the other side of this settlement. */
  otherRecordId: number;
  otherRecordNumber: string | null;
  otherDate: string;
  otherDescription: string;
  otherKind: number;
  /** Null for a batch payment covering several contacts, or any other kind
   *  with no contact of its own. */
  otherContactId: number | null;
  otherContactName: string | null;
};

export function settlementsForRecord(
  db: LedgerDb,
  recordId: number,
): SettlementLink[] {
  const ourMovements = db
    .select({ id: ledgerMovements.id })
    .from(ledgerMovements)
    .where(eq(ledgerMovements.recordId, recordId))
    .all()
    .map((m) => m.id);
  if (ourMovements.length === 0) return [];

  const rows = db
    .select({
      settlementId: settlements.id,
      amountMinor: settlements.amountMinor,
      createdAt: settlements.createdAt,
      paymentMovementId: settlements.paymentMovementId,
      owedMovementId: settlements.owedMovementId,
    })
    .from(settlements)
    .where(
      or(
        inArray(settlements.paymentMovementId, ourMovements),
        inArray(settlements.owedMovementId, ourMovements),
      ),
    )
    .all();
  if (rows.length === 0) return [];

  const ours = new Set(ourMovements);
  const otherMovementIds = rows.map((r) =>
    ours.has(r.paymentMovementId) ? r.owedMovementId : r.paymentMovementId,
  );

  const others = db
    .select({
      movementId: ledgerMovements.id,
      recordId: ledgerRecords.id,
      recordNumber: ledgerRecords.recordNumber,
      date: ledgerRecords.date,
      description: ledgerRecords.description,
      kind: ledgerRecords.kind,
      contactId: ledgerRecords.contactId,
      contactName: contacts.legalName,
    })
    .from(ledgerMovements)
    .innerJoin(ledgerRecords, eq(ledgerRecords.id, ledgerMovements.recordId))
    .leftJoin(contacts, eq(contacts.id, ledgerRecords.contactId))
    .where(inArray(ledgerMovements.id, otherMovementIds))
    .all();
  const otherByMovement = new Map(others.map((o) => [o.movementId, o]));

  const links: SettlementLink[] = [];
  for (const row of rows) {
    const otherId = ours.has(row.paymentMovementId)
      ? row.owedMovementId
      : row.paymentMovementId;
    const other = otherByMovement.get(otherId);
    if (!other) continue;
    links.push({
      settlementId: row.settlementId,
      amountMinor: row.amountMinor,
      createdAt: row.createdAt,
      otherRecordId: other.recordId,
      otherRecordNumber: other.recordNumber,
      otherDate: other.date,
      otherDescription: other.description,
      otherKind: other.kind,
      otherContactId: other.contactId,
      otherContactName: other.contactName ?? null,
    });
  }
  return links;
}

export function getSettlement(db: LedgerDb, id: number) {
  return (
    db.select().from(settlements).where(eq(settlements.id, id)).get() ?? null
  );
}

export function insertSettlements(
  db: LedgerDb,
  actingUserId: number | null,
  paymentMovementId: number,
  allocations: { owedMovementId: number; amountMinor: Minor }[],
): number[] {
  if (allocations.length === 0) return [];
  const rows = db
    .insert(settlements)
    .values(
      allocations.map((a) => ({
        paymentMovementId,
        owedMovementId: a.owedMovementId,
        amountMinor: a.amountMinor,
        createdBy: actingUserId,
      })),
    )
    .returning({ id: settlements.id })
    .all();
  return rows.map((r) => r.id);
}

/** Every settlement a payment movement makes. */
export function settlementIdsForPayment(
  db: LedgerDb,
  paymentMovementId: number,
): number[] {
  return db
    .select({ id: settlements.id })
    .from(settlements)
    .where(eq(settlements.paymentMovementId, paymentMovementId))
    .all()
    .map((row) => row.id);
}

export function deleteSettlement(db: LedgerDb, id: number): boolean {
  const row = db
    .delete(settlements)
    .where(eq(settlements.id, id))
    .returning({ id: settlements.id })
    .get();
  return row !== undefined;
}

/** The two records a settlement touches, so both views can be told to refresh. */
export function recordIdsForSettlement(
  db: LedgerDb,
  paymentMovementId: number,
  owedMovementId: number,
): number[] {
  const rows = db
    .select({ recordId: ledgerMovements.recordId })
    .from(ledgerMovements)
    .where(inArray(ledgerMovements.id, [paymentMovementId, owedMovementId]))
    .all();
  return [...new Set(rows.map((r) => r.recordId))];
}

/** Records with no contact but money on a shared owed account — the upgrade flags these. */
export function owedWithNoContact(db: LedgerDb): number[] {
  const owedAccountIds = [
    savedAccountId(db, DefaultAccountPurpose.Receivable),
    savedAccountId(db, DefaultAccountPurpose.Payable),
  ].filter((id): id is number => id !== null);
  if (owedAccountIds.length === 0) return [];
  return db
    .selectDistinct({ recordId: ledgerRecords.id })
    .from(ledgerMovements)
    .innerJoin(accounts, eq(accounts.id, ledgerMovements.accountId))
    .innerJoin(ledgerRecords, eq(ledgerRecords.id, ledgerMovements.recordId))
    .where(
      and(
        inArray(ledgerMovements.accountId, owedAccountIds),
        isNull(ledgerRecords.contactId),
      ),
    )
    .all()
    .map((r) => r.recordId);
}

/** Total still outstanding in one direction, for a headline figure. */
export function totalOutstandingMinor(
  db: LedgerDb,
  direction: OutstandingDirection,
): Minor {
  return listOutstanding(db, { direction, openOnly: true })
    .totalOutstandingMinor;
}

/** Kept for the ageing views, which group by band rather than by contact (US6). */
export const AGEING_BANDS = [
  { label: "Not yet due", from: -Infinity, to: 0 },
  { label: "1–30 days", from: 1, to: 30 },
  { label: "31–60 days", from: 31, to: 60 },
  { label: "61–90 days", from: 61, to: 90 },
  { label: "Over 90 days", from: 91, to: Infinity },
] as const;

export function bandFor(daysOverdue: number): string {
  const band = AGEING_BANDS.find(
    (b) => daysOverdue >= b.from && daysOverdue <= b.to,
  );
  return band?.label ?? AGEING_BANDS[0].label;
}

/** One age group, with everything that falls in it and what it comes to. */
export type AgeingBand = {
  label: string;
  count: number;
  totalMinor: Minor;
  items: AgeingItem[];
};

export type OutstandingAgeing = {
  direction: OutstandingDirection;
  /** The day the ageing was measured against. */
  asOf: string;
  items: AgeingItem[];
  totalOutstandingMinor: Minor;
  bands: AgeingBand[];
};

/**
 * The same items, grouped by how overdue they are (US6 AC1).
 *
 * Pure, and separated from the read above so the grouping can be checked
 * without a database. A band nothing falls in is left out: a screen listing
 * "61–90 days: nothing" for every empty group is harder to read, not more
 * complete. The order is AGEING_BANDS' own, freshest first.
 */
export function groupIntoBands(items: AgeingItem[]): AgeingBand[] {
  return AGEING_BANDS.map((band) => {
    const inBand = items.filter((item) => item.band === band.label);
    return {
      label: band.label,
      count: inBand.length,
      totalMinor: inBand.reduce((sum, item) => sum + item.outstandingMinor, 0),
      items: inBand,
    };
  }).filter((band) => band.count > 0);
}

/**
 * What is still outstanding in one direction, grouped by how overdue.
 *
 * Only what is still outstanding is counted, so a part-paid invoice shows the
 * remainder and never its full amount (US6 AC3).
 */
export function outstandingAgeing(
  db: LedgerDb,
  filters: OutstandingFilters,
): OutstandingAgeing {
  const { asOf, items, totalOutstandingMinor } = collectOutstanding(
    db,
    filters,
  );
  return {
    direction: filters.direction,
    asOf,
    items,
    totalOutstandingMinor,
    bands: groupIntoBands(items),
  };
}
