import { desc, eq, sql } from "drizzle-orm";
import {
  accounts,
  contacts,
  ledgerMovements,
  ledgerRecords,
} from "../db/schema.js";
import {
  AccountSubType,
  AccountType,
  LedgerRecordKind,
  type AccountTypeCode,
  type LedgerRecordKindCode,
} from "$lib/enums.js";
import type { LedgerDb, Minor } from "../ledger/types.js";
import { balanceSheetReport, cashFlowReport, profitLossReport } from "./reports.js";

/**
 * Dashboard aggregates computed in SQL (SUM / COUNT / GROUP BY) instead of
 * loading every row into JS. The dashboard is the PWA start_url, so keeping this
 * load cheap directly improves cold-start time. (SQLite here is synchronous, so
 * streaming / Promise.all would not help — doing less work is the win.)
 *
 * Every figure is the sum of `ledger_movements.amount_minor` over a window of
 * record dates — the same rows, and the same arithmetic, the profit and loss
 * runs (FR-031). Because a category is an account (FR-006a), "income" and
 * "expenses" here mean the movements on income-category and expense-category
 * accounts, so money moved between two places the business holds touches
 * neither and can never show up as either (FR-007).
 *
 * Movement amounts are whole cents, positive when value goes into the account.
 * Income therefore accumulates negative and is turned the right way up by
 * `displaySign`, in the same one place every report uses (D-03). The figures
 * leave here in whole currency units, which is what the dashboard formats.
 */

/** Cents, turned the way a reader expects, in whole currency units. */
function toDisplayAmount(amountMinor: number, type: AccountTypeCode): number {
  const sign =
    type === AccountType.Asset || type === AccountType.Expense ? 1 : -1;
  return (amountMinor * sign) / 100;
}

/**
 * The newest records of one kind with the contact they name and the figure that
 * landed on their category, newest first.
 *
 * One statement however many sides each record has: the movements are joined in
 * and summed per record, counting only the sides on a category account so the
 * figure shown is what was spent or earned rather than every side added up.
 */
function recentRecords(
  db: LedgerDb,
  kind: LedgerRecordKindCode,
  type: AccountTypeCode,
  limit: number,
) {
  // Which side of the record carries the figure to show. An expense record can
  // name equipment, which is an asset (002 FR-006b), so a plain type test leaves
  // those rows reading 0.00 — the one place the row set is chosen by `kind` and
  // the figure by the account. The period totals above stay type-only on
  // purpose: they must agree with the profit and loss, which equipment leaves.
  const onCategorySide =
    type === AccountType.Expense
      ? sql`(${accounts.type} = ${type} or ${accounts.subType} = ${AccountSubType.Equipment})`
      : sql`${accounts.type} = ${type}`;
  return db
    .select({
      date: ledgerRecords.date,
      description: ledgerRecords.description,
      contactName: contacts.legalName,
      totalMinor: sql<number>`coalesce(sum(case when ${onCategorySide} then ${ledgerMovements.amountMinor} else 0 end), 0)`,
    })
    .from(ledgerRecords)
    .leftJoin(ledgerMovements, eq(ledgerMovements.recordId, ledgerRecords.id))
    .leftJoin(accounts, eq(accounts.id, ledgerMovements.accountId))
    .leftJoin(contacts, eq(contacts.id, ledgerRecords.contactId))
    .where(eq(ledgerRecords.kind, kind))
    .groupBy(ledgerRecords.id)
    .orderBy(desc(ledgerRecords.date), desc(ledgerRecords.id))
    .limit(limit)
    .all()
    .map((r) => ({
      date: r.date,
      description: r.description,
      contactName: r.contactName,
      amount: toDisplayAmount(r.totalMinor, type),
    }));
}

/** Most recent expenses (with contact name), newest first. */
export function recentExpenses(db: LedgerDb, limit: number) {
  return recentRecords(
    db,
    LedgerRecordKind.Expense,
    AccountType.Expense,
    limit,
  ).map((r) => ({
    date: r.date,
    name: r.description,
    sub: r.contactName,
    amount: r.amount,
  }));
}

/** Most recent incomes (with contact name), newest first. */
export function recentIncomes(db: LedgerDb, limit: number) {
  return recentRecords(
    db,
    LedgerRecordKind.Income,
    AccountType.Revenue,
    limit,
  ).map((r) => ({
    date: r.date,
    name: r.contactName,
    sub: r.description,
    amount: r.amount,
  }));
}

// ---------------------------------------------------------------------------
// The three statement-based indicators (005 FR-013, FR-014). Each is a thin
// read of the same report function `/reports` itself calls — never a second,
// separately written calculation — so the dashboard and Reports can never
// disagree (User Story 4's tally guarantee, research.md §9).
// ---------------------------------------------------------------------------

export type NetProfitIndicator = {
  amountMinor: Minor;
  dateFrom: string;
  dateTo: string;
};

/** Income less expenses over the period — the same figure `/reports/profit-loss` shows. */
export function netProfitIndicator(
  db: LedgerDb,
  dateFrom: string,
  dateTo: string,
): NetProfitIndicator {
  return {
    amountMinor: profitLossReport(db, dateFrom, dateTo).resultMinor,
    dateFrom,
    dateTo,
  };
}

export type PositionIndicator = {
  assetsTotalMinor: Minor;
  liabilitiesTotalMinor: Minor;
  equityTotalMinor: Minor;
  balances: boolean;
  asAt: string;
};

/**
 * What the business owns, owes and is worth, as at a date.
 *
 * This calls the balance sheet rather than summing the three types again, so
 * the dashboard's figures and `/reports/balance-sheet` are the same
 * arithmetic over the same rows and cannot drift (FR-031). `balances` comes
 * along for the ride: it is false only when the books do not add up, and a
 * dashboard that showed a net worth without saying so would be the more
 * misleading of the two (FR-016). The old standalone "current assets" and
 * "accounts payable" tiles are lines *within* this one statement, not figures
 * beside it (research.md §11) — `assetsTotalMinor`/`liabilitiesTotalMinor`
 * already include them.
 */
export function positionIndicator(
  db: LedgerDb,
  asAt: string,
): PositionIndicator {
  const report = balanceSheetReport(db, asAt);
  return {
    assetsTotalMinor: report.owned.totalMinor,
    liabilitiesTotalMinor: report.owed.totalMinor,
    equityTotalMinor: report.ownersStake.totalMinor,
    balances: report.balances,
    asAt,
  };
}

export type CashFlowIndicator = {
  netChangeMinor: Minor;
  needsReviewMinor: Minor;
  dateFrom: string;
  dateTo: string;
};

/** The same net change in cash `/reports/cash-flow` shows, for the same period. */
export function cashFlowIndicator(
  db: LedgerDb,
  dateFrom: string,
  dateTo: string,
): CashFlowIndicator {
  const report = cashFlowReport(db, dateFrom, dateTo);
  return {
    netChangeMinor: report.netChangeMinor,
    needsReviewMinor: report.needsReviewMinor,
    dateFrom,
    dateTo,
  };
}
