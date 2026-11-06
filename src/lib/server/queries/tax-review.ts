import { and, asc, eq, gt, gte, lte, or, isNull, sql } from "drizzle-orm";
import { AccountType } from "$lib/enums.js";
import { accounts, ledgerMovements, ledgerRecords } from "../db/schema.js";
import { notVoided } from "./void-state.js";
import type { LedgerDb } from "../ledger/types.js";

function pendingTaxCondition(
  after: string | null,
  through: string,
  scope: { dateFrom?: string; accountId?: number | null } = {},
) {
  return and(
    eq(accounts.type, AccountType.Expense),
    notVoided(ledgerRecords.id),
    after ? gt(ledgerRecords.date, after) : undefined,
    scope.dateFrom ? gte(ledgerRecords.date, scope.dateFrom) : undefined,
    scope.accountId == null
      ? undefined
      : eq(ledgerMovements.accountId, scope.accountId),
    lte(ledgerRecords.date, through),
    or(
      isNull(ledgerMovements.taxClassification),
      sql`json_extract(${ledgerMovements.taxClassification}, '$.percentageBps') IS NULL`,
      sql`json_extract(${ledgerMovements.taxClassification}, '$.treatment') = 'requires_review'`,
    ),
  );
}

/** Same completeness rule as month close, without loading the entire backlog. */
export function unresolvedTaxLineCount(
  db: LedgerDb,
  dateFrom: string,
  dateTo: string,
  accountId: number | null,
) {
  return db
    .select({ count: sql<number>`count(*)` })
    .from(ledgerMovements)
    .innerJoin(ledgerRecords, eq(ledgerRecords.id, ledgerMovements.recordId))
    .innerJoin(accounts, eq(accounts.id, ledgerMovements.accountId))
    .where(pendingTaxCondition(null, dateTo, { dateFrom, accountId }))
    .get()!.count;
}

/** Only actual entries being newly frozen; refunds count even when their net amount is zero. */
export function unresolvedTaxLines(
  db: LedgerDb,
  after: string | null,
  through: string,
) {
  return db
    .select({
      movementId: ledgerMovements.id,
      accountId: ledgerMovements.accountId,
      recordId: ledgerRecords.id,
      recordNumber: ledgerRecords.recordNumber,
      description: ledgerRecords.description,
      label: ledgerMovements.label,
      accountName: accounts.name,
      date: ledgerRecords.date,
      amountMinor: ledgerMovements.amountMinor,
    })
    .from(ledgerMovements)
    .innerJoin(ledgerRecords, eq(ledgerRecords.id, ledgerMovements.recordId))
    .innerJoin(accounts, eq(accounts.id, ledgerMovements.accountId))
    .where(pendingTaxCondition(after, through))
    .orderBy(
      asc(ledgerRecords.date),
      asc(ledgerRecords.id),
      asc(ledgerMovements.sortOrder),
      asc(ledgerMovements.id),
    )
    .all();
}
