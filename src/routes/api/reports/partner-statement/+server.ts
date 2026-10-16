import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import { can } from "$lib/server/permissions.js";
import { badRequest, forbidden } from "$lib/server/api-response.js";
import { partnerStatementCsv } from "$lib/server/ledger/reports/csv.js";
import { partnerStatementReport } from "$lib/server/queries/reports.js";
import {
  formatFrom,
  periodQuery,
  queryValues,
  reportResponse,
} from "../report-endpoint.js";

/**
 * What each partner put in, their share of the result, and what they took back
 * out, over a date range (FR-027).
 */
export const GET: RequestHandler = async ({ locals, url }) => {
  if (!can(locals, "reports.read")) return forbidden();

  const parsed = periodQuery.safeParse(
    queryValues(url, ["dateFrom", "dateTo"]),
  );
  if (!parsed.success) return badRequest(parsed.error);

  const { dateFrom, dateTo } = parsed.data;
  const report = partnerStatementReport(db, dateFrom, dateTo);

  return reportResponse(
    formatFrom(url),
    report,
    () => partnerStatementCsv(report),
    `partners-equity-${dateFrom}-to-${dateTo}`,
  );
};
