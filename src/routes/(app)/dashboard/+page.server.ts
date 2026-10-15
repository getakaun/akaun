import type { PageServerLoad } from "./$types.js";
import { redirect } from "@sveltejs/kit";
import { db } from "$lib/server/db/client.js";
import {
  cashFlowIndicator,
  netProfitIndicator,
  positionIndicator,
  recentExpenses,
  recentIncomes,
} from "$lib/server/queries/dashboard.js";
import { can } from "$lib/server/permissions.js";
import {
  periodDateRange,
  isDashboardPeriod,
  toISODate,
} from "$lib/dashboard-periods.js";

export const load: PageServerLoad = async ({ locals, url }) => {
  if (!can(locals, "dashboard.read"))
    throw redirect(302, "/settings");
  const requestedPeriod = url.searchParams.get("period");
  const period = isDashboardPeriod(requestedPeriod) ? requestedPeriod : "m";

  const now = new Date();
  const { start: periodStart, end: periodEnd } = periodDateRange(period, now);

  // Net profit and cash flow read the selected period; financial position is
  // "as at today" — a balance sheet dated last month would read as a stale
  // bank balance, so the period selector governs the other two figures only.
  const today = toISODate(now);

  const netProfit = netProfitIndicator(db, periodStart, periodEnd);
  const position = positionIndicator(db, today);
  const cashFlow = cashFlowIndicator(db, periodStart, periodEnd);

  // Recent activity — 7 newest of each, merged and trimmed to 7 (FR-017).
  const recentEx = recentExpenses(db, 7).map((e) => ({
    kind: "expense" as const,
    date: e.date,
    name: e.name,
    sub: e.sub ?? "",
    amount: e.amount,
  }));
  const recentInc = recentIncomes(db, 7).map((i) => ({
    kind: "income" as const,
    date: i.date,
    name: i.name ?? "",
    sub: i.sub,
    amount: i.amount,
  }));
  const recent = [...recentEx, ...recentInc]
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, 7);

  return {
    period,
    netProfit,
    position,
    cashFlow,
    recent,
  };
};
