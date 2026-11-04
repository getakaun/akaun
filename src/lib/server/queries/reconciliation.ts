import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type { AccountTypeCode, LedgerRecordKindCode } from "$lib/enums.js";
import * as schema from "../db/schema.js";
import {
  accounts,
  bankStatements,
  bankStatementLines,
  contacts,
  ledgerMovements,
  ledgerRecords,
  reconciliationAllocations,
} from "../db/schema.js";
import { fromMinor } from "../ledger/money.js";
import type {
  MovementCandidate,
  ReconciliationAllocation,
  StatementLineRow,
  StatementWithAccount,
} from "../reconciliation/types.js";
import { round2 } from "../reconciliation/types.js";
import { inVoidPair, notVoided } from "./void-state.js";

export type ReconciliationDb = BunSQLiteDatabase<typeof schema>;

/**
 * The roles where money actually sits. A bank statement can only belong to one
 * of these, and only these are offered as the other side of a transfer — a
 * category or a "money we owe" account has no statement and no balance to move
 * between (FR-021, FR-023).
 */
// ---------------------------------------------------------------------------
// Allocations — a bank line covering part or all of one movement
// ---------------------------------------------------------------------------

/**
 * `item_type`/`item_id` are deliberately not selected: they are kept for one
 * release so the upgrade's backfill stays inspectable, and reading them is what
 * would let the two models drift apart again (D-17).
 */
const allocationColumns = {
  id: reconciliationAllocations.id,
  lineId: reconciliationAllocations.lineId,
  movementId: reconciliationAllocations.movementId,
  amount: reconciliationAllocations.amount,
  itemAmountSnapshot: reconciliationAllocations.itemAmountSnapshot,
  createdBy: reconciliationAllocations.createdBy,
  createdAt: reconciliationAllocations.createdAt,
};

export const listAllocations = (db: ReconciliationDb) =>
  db
    .select(allocationColumns)
    .from(reconciliationAllocations)
    .all() as ReconciliationAllocation[];
export const listLineAllocations = (db: ReconciliationDb, lineId: number) =>
  db
    .select(allocationColumns)
    .from(reconciliationAllocations)
    .where(eq(reconciliationAllocations.lineId, lineId))
    .all() as ReconciliationAllocation[];
export const listMovementAllocations = (
  db: ReconciliationDb,
  movementId: number,
) =>
  db
    .select(allocationColumns)
    .from(reconciliationAllocations)
    .where(eq(reconciliationAllocations.movementId, movementId))
    .all() as ReconciliationAllocation[];

export function replaceMovementAllocations(
  db: ReconciliationDb,
  movementId: number,
  snapshot: number,
  values: { lineId: number; amount: number }[],
  createdBy: number,
) {
  return db.transaction(() => {
    db.delete(reconciliationAllocations)
      .where(eq(reconciliationAllocations.movementId, movementId))
      .run();
    if (!values.length) return [];
    return db
      .insert(reconciliationAllocations)
      .values(
        values.map((v) => ({
          ...v,
          movementId,
          itemAmountSnapshot: snapshot,
          createdBy,
        })),
      )
      .returning(allocationColumns)
      .all() as ReconciliationAllocation[];
  });
}

/** One allocation, written alongside the record it belongs to (FR-023). */
export const insertAllocation = (
  db: ReconciliationDb,
  value: {
    lineId: number;
    movementId: number;
    amount: number;
    itemAmountSnapshot: number;
    createdBy: number;
  },
) =>
  db
    .insert(reconciliationAllocations)
    .values(value)
    .returning(allocationColumns)
    .get() as ReconciliationAllocation;

// ---------------------------------------------------------------------------
// Statements and their lines
// ---------------------------------------------------------------------------

const statementColumns = {
  id: bankStatements.id,
  originalFilename: bankStatements.originalFilename,
  storedFilePath: bankStatements.storedFilePath,
  extractionState: bankStatements.extractionState,
  extractionError: bankStatements.extractionError,
  uploadedBy: bankStatements.uploadedBy,
  createdAt: bankStatements.createdAt,
  updatedAt: bankStatements.updatedAt,
  accountId: bankStatements.accountId,
  accountName: accounts.name,
};

export const listStatements = (db: ReconciliationDb) =>
  db
    .select(statementColumns)
    .from(bankStatements)
    .leftJoin(accounts, eq(accounts.id, bankStatements.accountId))
    .orderBy(desc(bankStatements.id))
    .all() as StatementWithAccount[];
export const getStatement = (db: ReconciliationDb, id: number) =>
  db
    .select(statementColumns)
    .from(bankStatements)
    .leftJoin(accounts, eq(accounts.id, bankStatements.accountId))
    .where(eq(bankStatements.id, id))
    .get() as StatementWithAccount | undefined;
export function insertStatement(
  db: ReconciliationDb,
  data: typeof bankStatements.$inferInsert,
) {
  const row = db.insert(bankStatements).values(data).returning().get();
  return getStatement(db, row.id)!;
}
export function updateStatement(
  db: ReconciliationDb,
  id: number,
  data: Partial<typeof bankStatements.$inferInsert>,
) {
  const row = db
    .update(bankStatements)
    .set({ ...data, updatedAt: sql`datetime('now')` })
    .where(eq(bankStatements.id, id))
    .returning({ id: bankStatements.id })
    .get();
  return row ? getStatement(db, row.id) : undefined;
}
export function deleteStatement(db: ReconciliationDb, id: number) {
  const before = getStatement(db, id);
  if (!before) return undefined;
  db.delete(bankStatements).where(eq(bankStatements.id, id)).run();
  return before;
}
export const listLines = (db: ReconciliationDb, statementId?: number) => {
  const q = db.select().from(bankStatementLines);
  return (
    statementId == null
      ? q
          .orderBy(asc(bankStatementLines.date), asc(bankStatementLines.id))
          .all()
      : q
          .where(eq(bankStatementLines.statementId, statementId))
          .orderBy(asc(bankStatementLines.date), asc(bankStatementLines.id))
          .all()
  ) as StatementLineRow[];
};
export const getLine = (db: ReconciliationDb, id: number) =>
  db
    .select()
    .from(bankStatementLines)
    .where(eq(bankStatementLines.id, id))
    .get() as StatementLineRow | undefined;
export const insertLines = (
  db: ReconciliationDb,
  values: (typeof bankStatementLines.$inferInsert)[],
) =>
  values.length
    ? (db
        .insert(bankStatementLines)
        .values(values)
        .returning()
        .all() as StatementLineRow[])
    : [];
export const updateLine = (
  db: ReconciliationDb,
  id: number,
  data: Partial<
    Pick<
      StatementLineRow,
      "date" | "description" | "amount" | "direction" | "note"
    >
  >,
) =>
  db
    .update(bankStatementLines)
    .set(data)
    .where(eq(bankStatementLines.id, id))
    .returning()
    .get() as StatementLineRow | undefined;
export const deleteLine = (db: ReconciliationDb, id: number) =>
  db
    .delete(bankStatementLines)
    .where(eq(bankStatementLines.id, id))
    .returning()
    .get() as StatementLineRow | undefined;

// ---------------------------------------------------------------------------
// Candidates — the sides of records that touched a statement's account
// ---------------------------------------------------------------------------

/** The accounts a statement can belong to, and the accounts a transfer can name. */
export const listReconciliableAccounts = (db: ReconciliationDb) => {
  const rows = db.select({
    id: accounts.id, name: accounts.name,
    type: accounts.type, code: accounts.code, archivedAt: accounts.archivedAt,
    mergedIntoAccountId: accounts.mergedIntoAccountId,
  }).from(accounts).orderBy(asc(accounts.type), asc(accounts.code)).all();
  return rows.filter((row) => row.type != null && row.code != null && row.archivedAt == null && row.mergedIntoAccountId == null) as {
    id: number; name: string; type: AccountTypeCode; code: number;
  }[];
};

const candidateColumns = {
  movementId: ledgerMovements.id,
  recordId: ledgerMovements.recordId,
  accountId: ledgerMovements.accountId,
  amountMinor: ledgerMovements.amountMinor,
  accountName: accounts.name,
  kind: ledgerRecords.kind,
  date: ledgerRecords.date,
  recordNumber: ledgerRecords.recordNumber,
  description: ledgerRecords.description,
  contactName: contacts.legalName,
};

type CandidateRow = {
  movementId: number;
  recordId: number;
  accountId: number;
  amountMinor: number;
  accountName: string;
  kind: number;
  date: string;
  recordNumber: string | null;
  description: string;
  contactName: string | null;
};

function toCandidate(row: CandidateRow): MovementCandidate {
  return {
    movementId: row.movementId,
    recordId: row.recordId,
    accountId: row.accountId,
    amountMinor: row.amountMinor,
    amount: fromMinor(Math.abs(row.amountMinor)),
    // A transfer and an opening balance carry no reference number, so the
    // description is what a person would call it on screen (D-13).
    label: row.recordNumber ?? row.description ?? `Record ${row.recordId}`,
    date: row.date,
    description: row.description,
    contactName: row.contactName,
    kind: row.kind as LedgerRecordKindCode,
    accountName: row.accountName,
  };
}

/**
 * Every movement on these accounts, with how much of it bank lines already
 * cover.
 *
 * This is the whole of "which records could this bank line be" (D-11): a
 * movement exists on an account only because money actually moved there, so a
 * purchase paid from a wallet has nothing on the bank account and can never be
 * offered against a bank statement. That is the bug this feature exists to fix.
 */
export function listMovementCandidates(
  db: ReconciliationDb,
  accountIds: number[],
  from?: string | null,
  to?: string | null,
): MovementCandidate[] {
  if (accountIds.length === 0) return [];

  const rows = db
    .select(candidateColumns)
    .from(ledgerMovements)
    .innerJoin(ledgerRecords, eq(ledgerRecords.id, ledgerMovements.recordId))
    .innerJoin(accounts, eq(accounts.id, ledgerMovements.accountId))
    .leftJoin(contacts, eq(contacts.id, ledgerRecords.contactId))
    .where(
      and(
        inArray(ledgerMovements.accountId, accountIds),
        // A voided record and its reversal never moved money, so no bank line
        // can be either of them.
        notVoided(ledgerMovements.recordId),
        from ? gte(ledgerRecords.date, from) : undefined,
        to ? lte(ledgerRecords.date, to) : undefined,
      ),
    )
    .orderBy(desc(ledgerRecords.date), desc(ledgerRecords.id))
    .all() as CandidateRow[];

  const coverage = coverageByMovement(db);
  return rows.map((row) => withCoverage(toCandidate(row), coverage));
}

/** One candidate, for a caller acting on a single movement. */
export function getMovementCandidate(
  db: ReconciliationDb,
  movementId: number,
): MovementCandidate | undefined {
  const row = db
    .select(candidateColumns)
    .from(ledgerMovements)
    .innerJoin(ledgerRecords, eq(ledgerRecords.id, ledgerMovements.recordId))
    .innerJoin(accounts, eq(accounts.id, ledgerMovements.accountId))
    .leftJoin(contacts, eq(contacts.id, ledgerRecords.contactId))
    .where(eq(ledgerMovements.id, movementId))
    .get() as CandidateRow | undefined;
  if (!row) return undefined;
  return withCoverage(toCandidate(row), coverageByMovement(db));
}

/** Whether this movement belongs to a voided record or to a reversal. */
export function movementInVoidPair(
  db: ReconciliationDb,
  movementId: number,
): boolean {
  return !!db
    .select({ id: ledgerMovements.id })
    .from(ledgerMovements)
    .where(
      and(
        eq(ledgerMovements.id, movementId),
        inVoidPair(ledgerMovements.recordId),
      ),
    )
    .get();
}

/** The bank movement a record has on one account, or nothing if it has none. */
export function findRecordMovementOnAccount(
  db: ReconciliationDb,
  recordId: number,
  accountId: number,
): { id: number; amountMinor: number } | undefined {
  return db
    .select({
      id: ledgerMovements.id,
      amountMinor: ledgerMovements.amountMinor,
    })
    .from(ledgerMovements)
    .where(
      and(
        eq(ledgerMovements.recordId, recordId),
        eq(ledgerMovements.accountId, accountId),
      ),
    )
    .get();
}

type Coverage = Map<number, { amount: number; count: number }>;

/**
 * How much of each movement bank lines already cover. An allocation the upgrade
 * has not repointed yet carries a null `movement_id` and is skipped rather than
 * counted against anything (FR-034).
 */
function coverageByMovement(db: ReconciliationDb): Coverage {
  const coverage: Coverage = new Map();
  for (const allocation of listAllocations(db)) {
    if (allocation.movementId == null) continue;
    const covered = coverage.get(allocation.movementId) ?? {
      amount: 0,
      count: 0,
    };
    covered.amount = round2(covered.amount + allocation.amount);
    covered.count += 1;
    coverage.set(allocation.movementId, covered);
  }
  return coverage;
}

function withCoverage(
  candidate: MovementCandidate,
  coverage: Coverage,
): MovementCandidate {
  const covered = coverage.get(candidate.movementId) ?? { amount: 0, count: 0 };
  return {
    ...candidate,
    allocatedAmount: covered.amount,
    remainingAmount: round2(candidate.amount - covered.amount),
    allocationCount: covered.count,
  };
}
