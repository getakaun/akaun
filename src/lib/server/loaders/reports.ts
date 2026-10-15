import { redirect } from "@sveltejs/kit";
import { db } from "$lib/server/db/client.js";
import { can } from "$lib/server/permissions.js";
import { normalizeDate, today } from "$lib/server/date.js";
import {
  balanceSheetReport,
  cashFlowReport,
  partnerContacts,
  partnerStatementReport,
  profitLossReport,
} from "$lib/server/queries/reports.js";
import type {
  BalanceSheetReport,
  CashFlowReport,
  PartnerStatementReport,
  ProfitLossReport,
} from "$lib/server/ledger/types.js";

/**
 * The reports screen, shared by `/reports` and `/reports/[view]` so the two
 * routes stay thin wrappers over one load.
 *
 * Each view is its own URL and each carries its dates in the query string, so
 * the report a user is looking at is the report they get when they send someone
 * the link. Nothing here computes a report: the four period reports come from
 * `queries/reports.ts`, which is what keeps every figure on this screen the
 * same arithmetic as the same figure anywhere else in the app (FR-031).
 */

export const REPORT_VIEWS = [
  "profit-loss",
  "balance-sheet",
  "cash-flow",
  "partners",
] as const;

export type ReportView = (typeof REPORT_VIEWS)[number];

/**
 * Retired report tabs, replaced by Contacts (005 FR-009, research.md §8): the
 * balance either direction owed was always a duplicate of what Contacts
 * already shows for a person or entity, not a movement list.
 */
const RETIRED_VIEWS = ["owed-to-us", "we-owe"] as const;

const DEFAULT_VIEW: ReportView = "profit-loss";

/** Both ends of the period the screen is showing, and the single date form of it. */
export type ReportPeriod = { dateFrom: string; dateTo: string; asAt: string };

export type ReportsPageData = {
  hasPartners: boolean;
} & (
  | { view: "profit-loss"; period: ReportPeriod; report: ProfitLossReport }
  | { view: "balance-sheet"; period: ReportPeriod; report: BalanceSheetReport }
  | { view: "cash-flow"; period: ReportPeriod; report: CashFlowReport }
  | { view: "partners"; period: ReportPeriod; report: PartnerStatementReport }
);

function isReportView(value: string): value is ReportView {
  return (REPORT_VIEWS as readonly string[]).includes(value);
}

function isRetiredView(value: string): boolean {
  return (RETIRED_VIEWS as readonly string[]).includes(value);
}

/**
 * The period a report covers when the link carries none: this year so far.
 *
 * A year to date is the range someone asking "how are we doing?" means, and it
 * is the one an accountant asks for. The dates stay in the URL from the first
 * load, so what the screen is showing is never a hidden default.
 */
function defaultPeriod(url: URL): ReportPeriod {
  const dateTo = normalizeDate(url.searchParams.get("to"));
  const dateFrom = normalizeDate(
    url.searchParams.get("from"),
    `${dateTo.slice(0, 4)}-01-01`,
  );
  return {
    // A range that runs backwards is a typo, not a request for nothing; it
    // collapses to the single day the user last set rather than showing an
    // empty report with no explanation.
    dateFrom: dateFrom > dateTo ? dateTo : dateFrom,
    dateTo,
    asAt: normalizeDate(url.searchParams.get("asAt"), today()),
  };
}

export function loadReportsPage(
  locals: App.Locals,
  viewParam: string | null,
  url: URL,
): ReportsPageData {
  if (!can(locals, "reports.read"))
    throw redirect(302, "/dashboard");

  // Contacts already renders the balance either direction owed, for every
  // contact — one navigation step, not an explanation of an absence.
  if (viewParam !== null && isRetiredView(viewParam))
    throw redirect(302, "/contacts");

  // A link to a report that does not exist lands on the first one rather than
  // on an error page.
  if (viewParam !== null && !isReportView(viewParam))
    throw redirect(302, "/reports");
  const view: ReportView = viewParam === null ? DEFAULT_VIEW : viewParam;

  const period = defaultPeriod(url);
  const hasPartners = partnerContacts(db).length > 0;

  switch (view) {
    case "profit-loss":
      return {
        view,
        period,
        report: profitLossReport(db, period.dateFrom, period.dateTo),
        hasPartners,
      };
    case "balance-sheet":
      return {
        view,
        period,
        report: balanceSheetReport(db, period.asAt),
        hasPartners,
      };
    case "cash-flow":
      return {
        view,
        period,
        report: cashFlowReport(db, period.dateFrom, period.dateTo),
        hasPartners,
      };
    case "partners":
      return {
        view,
        period,
        report: partnerStatementReport(db, period.dateFrom, period.dateTo),
        hasPartners,
      };
  }
}
