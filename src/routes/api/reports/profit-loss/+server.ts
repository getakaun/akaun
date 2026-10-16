import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import { can } from "$lib/server/permissions.js";
import { badRequest, forbidden } from "$lib/server/api-response.js";
import { profitLossCsv } from "$lib/server/ledger/reports/csv.js";
import { profitLossReport } from "$lib/server/queries/reports.js";
import {
  formatFrom,
  periodQuery,
  queryValues,
  reportResponse,
} from "../report-endpoint.js";

/** What came in, what went out and what is left, over a date range (FR-025). */
export const GET: RequestHandler = async ({ locals, url }) => {
  // Seeing a report never allows recording one (FR-039).
  if (!can(locals, "reports.read")) return forbidden();

  const parsed = periodQuery.safeParse(
    queryValues(url, ["dateFrom", "dateTo"]),
  );
  if (!parsed.success) return badRequest(parsed.error);

  const { dateFrom, dateTo } = parsed.data;
  const report = profitLossReport(db, dateFrom, dateTo);

  return reportResponse(
    formatFrom(url),
    report,
    () => profitLossCsv(report),
    `profit-and-loss-${dateFrom}-to-${dateTo}`,
  );
};
