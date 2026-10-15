import { createHash } from "node:crypto";
import { asc, eq, inArray } from "drizzle-orm";
import type { LedgerDb } from "../ledger/types.js";
import {
  accounts,
  bankStatementLines,
  contactRoles,
  contacts,
  importItems,
  importQueue,
  invoiceLines,
  invoices,
  ledgerMovements,
  ledgerRecords,
  quotationLines,
  quotations,
  recordAttachments,
  reconciliationAllocations,
} from "../db/schema.js";
import { conflict, type AppFailure } from "./result.js";

/**
 * An opaque token for "the thing as it was when you read it".
 *
 * Why not `updatedAt`: a new row gets `datetime('now')` (whole seconds) and an
 * update writes an ISO string (milliseconds), so two edits inside a second can
 * share one; `bank_statement_lines` and `import_queue` have no such column at
 * all; and a change to a child row — a movement, a role, an invoice line, an
 * allocation — never touches the parent's. A hash of the rows a caller would
 * have seen has none of those holes, and needs no migration.
 *
 * Checked by `checkVersion` in the same synchronous span as the write it
 * guards. bun:sqlite is synchronous and the app is one writer process, so
 * nothing can land in between.
 */
function digest(parts: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex")
    .slice(0, 16);
}

export const ABSENT = "absent";

export function recordVersion(db: LedgerDb, id: number): string {
  return recordVersions(db, [id])[id];
}

/**
 * Several records' versions in three queries rather than three each, for a
 * list that hands out a version per row. `recordVersion` is this with one id,
 * so the two can never disagree — a list version that hashed differently
 * from the one `checkVersion` recomputes would turn every update into a
 * conflict.
 */
export function recordVersions(
  db: LedgerDb,
  ids: number[],
): Record<number, string> {
  const wanted = [...new Set(ids)];
  const out: Record<number, string> = {};
  if (wanted.length === 0) return out;
  const rows = new Map(
    db
      .select()
      .from(ledgerRecords)
      .where(inArray(ledgerRecords.id, wanted))
      .all()
      .map((row) => [row.id, row]),
  );
  const movements = groupBy(
    db
      .select({
        recordId: ledgerMovements.recordId,
        id: ledgerMovements.id,
        accountId: ledgerMovements.accountId,
        amountMinor: ledgerMovements.amountMinor,
        label: ledgerMovements.label,
      })
      .from(ledgerMovements)
      .where(inArray(ledgerMovements.recordId, wanted))
      .orderBy(asc(ledgerMovements.id))
      .all(),
  );
  const attachments = groupBy(
    db
      .select({
        recordId: recordAttachments.recordId,
        id: recordAttachments.id,
      })
      .from(recordAttachments)
      .where(inArray(recordAttachments.recordId, wanted))
      .orderBy(asc(recordAttachments.id))
      .all(),
  );
  for (const id of wanted) {
    const found = rows.get(id);
    if (!found) {
      out[id] = ABSENT;
      continue;
    }
    // The search text is derived, and is rewritten in the background after an
    // attachment is indexed. Leaving it in would make the version an agent
    // just got back from attach_file go stale with nobody having edited
    // anything.
    const { extractedText: _searchText, ...row } = found;
    void _searchText;
    out[id] = digest([row, movements.get(id) ?? [], attachments.get(id) ?? []]);
  }
  return out;
}

/** Child rows by their record, in the order queried, without the record id. */
function groupBy<T extends { recordId: number }>(
  rows: T[],
): Map<number, Omit<T, "recordId">[]> {
  const grouped = new Map<number, Omit<T, "recordId">[]>();
  for (const { recordId, ...rest } of rows) {
    const list = grouped.get(recordId) ?? [];
    list.push(rest);
    grouped.set(recordId, list);
  }
  return grouped;
}

export function accountVersion(db: LedgerDb, id: number): string {
  const row = db.select().from(accounts).where(eq(accounts.id, id)).get();
  return row ? digest(row) : ABSENT;
}

export function contactVersion(db: LedgerDb, id: number): string {
  const row = db.select().from(contacts).where(eq(contacts.id, id)).get();
  if (!row) return ABSENT;
  const roles = db
    .select({ role: contactRoles.role })
    .from(contactRoles)
    .where(eq(contactRoles.contactId, id))
    .orderBy(asc(contactRoles.role))
    .all();
  return digest([row, roles]);
}

export function invoiceVersion(db: LedgerDb, id: number): string {
  const row = db.select().from(invoices).where(eq(invoices.id, id)).get();
  if (!row) return ABSENT;
  const lines = db
    .select()
    .from(invoiceLines)
    .where(eq(invoiceLines.invoiceId, id))
    .orderBy(asc(invoiceLines.id))
    .all();
  return digest([row, lines]);
}

export function quotationVersion(db: LedgerDb, id: number): string {
  const row = db.select().from(quotations).where(eq(quotations.id, id)).get();
  if (!row) return ABSENT;
  const lines = db
    .select()
    .from(quotationLines)
    .where(eq(quotationLines.quotationId, id))
    .orderBy(asc(quotationLines.id))
    .all();
  return digest([row, lines]);
}

export function statementLineVersion(db: LedgerDb, id: number): string {
  const row = db
    .select()
    .from(bankStatementLines)
    .where(eq(bankStatementLines.id, id))
    .get();
  if (!row) return ABSENT;
  const allocations = db
    .select({
      id: reconciliationAllocations.id,
      movementId: reconciliationAllocations.movementId,
      amount: reconciliationAllocations.amount,
    })
    .from(reconciliationAllocations)
    .where(eq(reconciliationAllocations.lineId, id))
    .orderBy(asc(reconciliationAllocations.id))
    .all();
  return digest([row, allocations]);
}

/** What a movement is matched to: the thing `set_movement_matches` replaces. */
export function movementMatchesVersion(
  db: LedgerDb,
  movementId: number,
): string {
  const movement = db
    .select({ id: ledgerMovements.id })
    .from(ledgerMovements)
    .where(eq(ledgerMovements.id, movementId))
    .get();
  if (!movement) return ABSENT;
  const allocations = db
    .select({
      id: reconciliationAllocations.id,
      lineId: reconciliationAllocations.lineId,
      amount: reconciliationAllocations.amount,
    })
    .from(reconciliationAllocations)
    .where(eq(reconciliationAllocations.movementId, movementId))
    .orderBy(asc(reconciliationAllocations.id))
    .all();
  return digest(allocations);
}

export function importJobVersion(db: LedgerDb, id: string): string {
  const row = db.select().from(importQueue).where(eq(importQueue.id, id)).get();
  if (!row) return ABSENT;
  const items = db
    .select()
    .from(importItems)
    .where(eq(importItems.jobId, id))
    .orderBy(asc(importItems.id))
    .all();
  return digest([row, items]);
}

export function importItemVersion(db: LedgerDb, id: string): string {
  const row = db.select().from(importItems).where(eq(importItems.id, id)).get();
  return row ? digest(row) : ABSENT;
}

/**
 * Null when the caller saw what is there now, or when it sent no version
 * (REST callers may leave it out; the MCP tools always require one).
 */
export function checkVersion(
  current: string,
  expected: string | undefined,
): AppFailure | null {
  if (expected === undefined || expected === current) return null;
  return conflict(current);
}
