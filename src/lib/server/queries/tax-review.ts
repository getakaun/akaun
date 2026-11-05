import { and, asc, eq, gt, lte, or, isNull, sql } from "drizzle-orm";
import { AccountType } from "$lib/enums.js";
import { accounts, ledgerMovements, ledgerRecords } from "../db/schema.js";
import { notVoided } from "./void-state.js";
import type { LedgerDb } from "../ledger/types.js";

/** Only actual entries being newly frozen; refunds count even when their net amount is zero. */
export function unresolvedTaxLines(
  db: LedgerDb,
  after: string | null,
  through: string,
) {
  return db
    .select({
      movementId: ledgerMovements.id,
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
    .where(
      and(
        eq(accounts.type, AccountType.Expense),
        notVoided(ledgerRecords.id),
        after ? gt(ledgerRecords.date, after) : undefined,
        lte(ledgerRecords.date, through),
        or(
          isNull(ledgerMovements.taxClassification),
          sql`json_extract(${ledgerMovements.taxClassification}, '$.percentageBps') IS NULL`,
          sql`json_extract(${ledgerMovements.taxClassification}, '$.treatment') = 'requires_review'`,
        ),
      ),
    )
    .orderBy(
      asc(ledgerRecords.date),
      asc(ledgerRecords.id),
      asc(ledgerMovements.sortOrder),
      asc(ledgerMovements.id),
    )
    .all();
}
