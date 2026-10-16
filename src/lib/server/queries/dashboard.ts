import { sql } from "drizzle-orm";
import { ledgerRecords } from "../db/schema.js";
import { profitLoss } from "../ledger/reports/profit-loss.js";
import type {
  AccountTotal,
  CashFlowReport,
  LedgerDb,
  Minor,
  ProfitLossReport,
  ReportLine,
} from "../ledger/types.js";
import type {
  CashBridge,
  Delta,
  MonthPoint,
  TopLine,
} from "$lib/components/dashboard/types.js";
import type { MonthBucket } from "$lib/dashboard-periods.js";

/**
 * The dashboard's arithmetic, and only the arithmetic that is not a report's.
 *
 * Every money figure the dashboard shows is a report's own output (005 FR-014,
 * 007 FR-001). What lives here is what a report has no opinion on: how two of
 * its figures compare, how its lines are trimmed to the few worth a glance,
 * and how long the cash lasts. Each is pure so it can be checked without a
 * database; the reads are in `loaders/dashboard.ts`.
 */

/** How a figure moved against its comparison. No percentage off a zero base. */
export function delta(current: Minor, previous: Minor): Delta {
  return {
    diffMinor: current - previous,
    pct: previous === 0 ? null : (current - previous) / Math.abs(previous),
  };
}

/** Net result as a share of income; null when there was no income to share. */
export function netMarginPct(report: ProfitLossReport): number | null {
  return report.totalIncomeMinor > 0
    ? report.resultMinor / report.totalIncomeMinor
    : null;
}

/**
 * The largest `n` lines, with everything else folded into one "Other" line.
 *
 * "Other" is the *net* of the rest, so the lines shown always add up to the
 * report's own total — a refund (a negative line) lands in Other rather than
 * being dropped. The order is amount, then name, then id, so two equal lines
 * never swap places between refreshes.
 */
export function topLinesWithOther(
  lines: ReportLine[],
  previous: ReportLine[],
  n: number,
): TopLine[] {
  const prevById = new Map(previous.map((l) => [l.accountId, l.amountMinor]));
  const sorted = [...lines].sort(
    (a, b) =>
      b.amountMinor - a.amountMinor ||
      a.accountName.localeCompare(b.accountName) ||
      a.accountId - b.accountId,
  );
  const top = sorted.slice(0, n).filter((l) => l.amountMinor > 0);
  const topIds = new Set(top.map((l) => l.accountId));
  const rest = lines.filter((l) => !topIds.has(l.accountId));

  const out: TopLine[] = top.map((l) => ({
    accountId: l.accountId,
    name: l.accountName,
    amountMinor: l.amountMinor,
    prevMinor: prevById.get(l.accountId) ?? 0,
  }));
  if (rest.length > 0) {
    out.push({
      accountId: null,
      name: "Other",
      amountMinor: rest.reduce((sum, l) => sum + l.amountMinor, 0),
      prevMinor: previous
        .filter((l) => !topIds.has(l.accountId))
        .reduce((sum, l) => sum + l.amountMinor, 0),
    });
  }
  return out;
}

/**
 * How many months the cash on hand lasts, at the average monthly fall over the
 * last three complete months.
 *
 * `monthEnds` is the twelve month-end balances oldest first, the last being
 * today's. Only meaningful while cash is actually falling and there is some
 * left: a business whose cash grew has no runway to speak of.
 */
export function runwayMonths(
  monthEnds: Minor[],
): { months: number; burnMinor: Minor } | null {
  if (monthEnds.length < 5) return null;
  const onHand = monthEnds[monthEnds.length - 1];
  const lastComplete = monthEnds[monthEnds.length - 2];
  const threeBefore = monthEnds[monthEnds.length - 5];
  const burnMinor = Math.round((threeBefore - lastComplete) / 3);
  if (burnMinor <= 0 || onHand <= 0) return null;
  return { months: onHand / burnMinor, burnMinor };
}

/**
 * Each month's Profit & Loss, by the report's own pure rule over that month's
 * account totals (`accountTotalsByRanges`) — a trend is the report run twelve
 * times, never a second sum (007 FR-001).
 */
export function monthlySeries(
  months: MonthBucket[],
  totalsByMonth: AccountTotal[][],
): MonthPoint[] {
  return months.map((month, i) => {
    const report = profitLoss({
      dateFrom: month.from,
      dateTo: month.to,
      totals: totalsByMonth[i] ?? [],
    });
    return {
      key: month.key,
      label: month.label,
      from: month.from,
      to: month.to,
      incomeMinor: report.totalIncomeMinor,
      expensesMinor: report.totalExpensesMinor,
      resultMinor: report.resultMinor,
    };
  });
}

/**
 * Net profit to the change in cash, all read off the period's two statements
 * (007 FR-007). Investing is all capital spending today — the Cash Flow
 * Statement's only investing line — so free cash flow is operating plus
 * investing.
 */
export function cashBridge(
  pl: ProfitLossReport,
  cf: CashFlowReport,
): CashBridge {
  return {
    netProfitMinor: pl.resultMinor,
    operatingMinor: cf.operating.totalMinor,
    investingMinor: cf.investing.totalMinor,
    freeCashFlowMinor: cf.operating.totalMinor + cf.investing.totalMinor,
    financingMinor: cf.financing.totalMinor,
    netChangeMinor: cf.netChangeMinor,
    needsReviewMinor: cf.needsReviewMinor,
  };
}

/** Whether the book has any records at all — a new book gets one empty state. */
export function hasAnyRecord(db: LedgerDb): boolean {
  const row = db
    .select({ one: sql<number>`1` })
    .from(ledgerRecords)
    .limit(1)
    .get();
  return row !== undefined;
}
