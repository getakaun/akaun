import { redirect } from "@sveltejs/kit";
import { db } from "$lib/server/db/client.js";
import { can } from "$lib/server/permissions.js";
import { AccountType, LedgerRecordKindDisplayLabels } from "$lib/enums.js";
import { localToday } from "$lib/local-date.js";
import {
  COMPARE_OPTIONS,
  PERIOD_OPTIONS,
  parseCompareMode,
  parsePeriodId,
  resolveDashboardPeriod,
  type ResolvedPeriod,
} from "$lib/dashboard-periods.js";
import {
  accountTotalsByRanges,
  balanceSheetReport,
  cashBalancesAsAt,
  cashFlowReport,
  cashOnHandAsAt,
  profitLossReport,
} from "$lib/server/queries/reports.js";
import {
  AGEING_BANDS,
  balancesByContact,
  outstandingAgeing,
} from "$lib/server/queries/settlements.js";
import { listRecords } from "$lib/server/queries/ledger.js";
import { invoiceSummary } from "$lib/server/queries/invoices.js";
import { openQuotationSummary } from "$lib/server/queries/quotations.js";
import { loadAttention } from "$lib/server/queries/books-review.js";
import { CASH_AND_EQUIVALENT_SUBTYPES } from "$lib/server/ledger/account-type.js";
import {
  cashBridge,
  hasAnyRecord,
  monthlySeries,
  netMarginPct,
  runwayMonths,
  topLinesWithOther,
} from "$lib/server/queries/dashboard.js";
import type {
  CashSection,
  OwedSection,
  OwedSide,
  PerformanceSection,
  PipelineSection,
  PositionSection,
  RecentItem,
} from "$lib/components/dashboard/types.js";
import type {
  LedgerDb,
  OutstandingDirection,
  ProfitLossReport,
  RecordView,
} from "$lib/server/ledger/types.js";

/** How many expense and income lines the "where money goes" lists show before "Other". */
const TOP_LINES = 6;

/**
 * The dashboard (007).
 *
 * `dashboard.read` opens the page; each section then asks for the permission
 * of the screen its figures come from, and is `null` when the user lacks it,
 * so the page leaves it out rather than showing zeros (007 FR-013). Nothing
 * here computes a statement: every money figure is a report function's own
 * output for the same dates, which is what lets each one link to that report
 * and show the same number there (005 FR-014, FR-015).
 *
 * "Today" is the server's local calendar day, resolved once and handed to the
 * page with every range already worked out (007 FR-003).
 */
export function loadDashboardPage(locals: App.Locals, url: URL) {
  if (!can(locals, "dashboard.read")) throw redirect(302, "/settings");

  const today = localToday();
  const period = resolveDashboardPeriod(
    parsePeriodId(url.searchParams.get("period")),
    parseCompareMode(url.searchParams.get("compare")),
    today,
  );

  const canReports = can(locals, "reports.read");
  const canRecords = can(locals, "records.read");

  // The period's own Profit & Loss, read once for the headline figures and
  // the profit-to-cash bridge.
  const currentPl = canReports
    ? profitLossReport(db, period.current.from, period.current.to)
    : null;
  const performance = currentPl ? loadPerformance(db, period, currentPl) : null;
  const cash = currentPl ? loadCash(db, period, currentPl) : null;
  const position = canReports ? loadPosition(db, today) : null;
  const owed = canRecords
    ? loadOwed(db, today, can(locals, "contacts.read"))
    : null;
  const pipeline: PipelineSection = {
    quotations: can(locals, "quotations.read")
      ? openQuotationSummary(db, today)
      : null,
    invoices: can(locals, "invoices.read")
      ? invoiceSummary(db, period.current, today)
      : null,
  };

  return {
    period,
    periodOptions: PERIOD_OPTIONS,
    compareOptions: COMPARE_OPTIONS,
    isEmptyBook: !hasAnyRecord(db),
    canAddRecord: can(locals, "records.create"),
    canImport: can(locals, "import.create"),
    performance,
    cash,
    position,
    owed,
    pipeline: pipeline.quotations || pipeline.invoices ? pipeline : null,
    attention: loadAttention(db, locals, today, position, pipeline),
    recent: canRecords ? loadRecent(db) : null,
  };
}

function loadPerformance(
  db: LedgerDb,
  period: ResolvedPeriod,
  current: ProfitLossReport,
): PerformanceSection {
  const previous = profitLossReport(
    db,
    period.comparison.from,
    period.comparison.to,
  );
  const totalsByMonth = accountTotalsByRanges(
    db,
    period.months.map((m) => ({ dateFrom: m.from, dateTo: m.to })),
  );
  return {
    totalIncomeMinor: current.totalIncomeMinor,
    totalIncomePrevMinor: previous.totalIncomeMinor,
    totalExpensesMinor: current.totalExpensesMinor,
    totalExpensesPrevMinor: previous.totalExpensesMinor,
    resultMinor: current.resultMinor,
    resultPrevMinor: previous.resultMinor,
    netMarginPct: netMarginPct(current),
    netMarginPrevPct: netMarginPct(previous),
    months: monthlySeries(period.months, totalsByMonth),
    topExpenses: topLinesWithOther(
      current.expenses,
      previous.expenses,
      TOP_LINES,
    ),
    topIncome: topLinesWithOther(current.income, previous.income, TOP_LINES),
    notes: current.notes,
  };
}

function loadCash(
  db: LedgerDb,
  period: ResolvedPeriod,
  pl: ProfitLossReport,
): CashSection {
  const cf = cashFlowReport(db, period.current.from, period.current.to);
  const monthEndBalances = cashBalancesAsAt(
    db,
    period.months.map((m) => m.to),
  );
  const runway = runwayMonths(monthEndBalances);
  return {
    // The statement's own closing figure; the period always ends today.
    onHandMinor: cf.closingCashMinor,
    onHandPrevMinor: cashOnHandAsAt(db, period.comparison.to),
    monthEnds: period.months.map((m, i) => ({
      key: m.key,
      label: m.label,
      asAt: m.to,
      cashMinor: monthEndBalances[i],
    })),
    runwayMonths: runway?.months ?? null,
    monthlyBurnMinor: runway?.burnMinor ?? null,
    bridge: cashBridge(pl, cf),
    ties: cf.ties,
  };
}

function loadPosition(db: LedgerDb, today: string): PositionSection {
  const bs = balanceSheetReport(db, today);
  const needsReviewCount = [bs.owned, bs.owed]
    .flatMap((section) => section.subsections ?? [])
    .filter((sub) => sub.label === "Unclassified")
    .reduce((count, sub) => count + sub.lines.length, 0);
  return {
    asAt: today,
    assetsMinor: bs.owned.totalMinor,
    liabilitiesMinor: bs.owed.totalMinor,
    equityMinor: bs.ownersStake.totalMinor,
    balances: bs.balances,
    differenceMinor: bs.differenceMinor,
    needsReviewCount,
  };
}

function owedSide(
  db: LedgerDb,
  direction: OutstandingDirection,
  today: string,
): OwedSide {
  const ageing = outstandingAgeing(db, {
    direction,
    asOf: today,
    dateTo: today,
  });
  const notYetDue = AGEING_BANDS[0].label;
  const bands = AGEING_BANDS.map((band) => {
    const found = ageing.bands.find((b) => b.label === band.label);
    return {
      label: band.label,
      count: found?.count ?? 0,
      totalMinor: found?.totalMinor ?? 0,
    };
  });
  const overdue = bands.filter((b) => b.label !== notYetDue);
  return {
    totalMinor: ageing.totalOutstandingMinor,
    obligationsMinor: ageing.totalObligationsMinor,
    creditsMinor: ageing.totalCreditsMinor,
    overdueMinor: overdue.reduce((sum, b) => sum + b.totalMinor, 0),
    overdueCount: overdue.reduce((sum, b) => sum + b.count, 0),
    bands,
    top: balancesByContact(ageing.items).slice(0, 3),
  };
}

function loadOwed(
  db: LedgerDb,
  today: string,
  canOpenContacts: boolean,
): OwedSection {
  return {
    owedToUs: owedSide(db, "owed-to-us", today),
    weOwe: owedSide(db, "we-owe", today),
    canOpenContacts,
  };
}

/** Which way money went, judged by what the record did to cash and equivalents. */
function directionOf(record: RecordView): RecentItem["direction"] {
  const cashMinor = record.movements
    .filter(
      (m) =>
        m.accountType === AccountType.Asset &&
        m.accountSubType !== null &&
        (CASH_AND_EQUIVALENT_SUBTYPES as readonly number[]).includes(
          m.accountSubType,
        ),
    )
    .reduce((sum, m) => sum + m.amountMinor, 0);
  return cashMinor > 0 ? "in" : cashMinor < 0 ? "out" : "neutral";
}

function loadRecent(db: LedgerDb): RecentItem[] {
  return listRecords(db, { limit: 8 }).records.map((record) => ({
    id: record.id,
    date: record.date,
    kindLabel: LedgerRecordKindDisplayLabels[record.kind] ?? "Record",
    description: record.description,
    contactName: record.contactName,
    amountMinor: Math.abs(record.amountMinor),
    direction: directionOf(record),
  }));
}
