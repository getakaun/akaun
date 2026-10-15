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
  const found = db
    .select()
    .from(ledgerRecords)
    .where(eq(ledgerRecords.id, id))
    .get();
  if (!found) return ABSENT;
  // The search text is derived, and is rewritten in the background after an
  // attachment is indexed. Leaving it in would make the version an agent just
  // got back from attach_file go stale with nobody having edited anything.
  const { extractedText: _searchText, ...row } = found;
  void _searchText;
  const movements = db
    .select({
      id: ledgerMovements.id,
      accountId: ledgerMovements.accountId,
      amountMinor: ledgerMovements.amountMinor,
      label: ledgerMovements.label,
    })
    .from(ledgerMovements)
    .where(eq(ledgerMovements.recordId, id))
    .orderBy(asc(ledgerMovements.id))
    .all();
  const attachments = db
    .select({ id: recordAttachments.id })
    .from(recordAttachments)
    .where(eq(recordAttachments.recordId, id))
    .orderBy(asc(recordAttachments.id))
    .all();
  return digest([row, movements, attachments]);
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

/** Several contacts at once, for a merge that must see all of them unchanged. */
export function contactVersions(
  db: LedgerDb,
  ids: number[],
): Record<number, string> {
  const present = new Set(
    db
      .select({ id: contacts.id })
      .from(contacts)
      .where(inArray(contacts.id, ids))
      .all()
      .map((row) => row.id),
  );
  return Object.fromEntries(
    ids.map((id) => [id, present.has(id) ? contactVersion(db, id) : ABSENT]),
  );
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
