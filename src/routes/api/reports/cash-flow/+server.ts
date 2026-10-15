import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import { can } from "$lib/server/permissions.js";
import { badRequest, forbidden } from "$lib/server/api-response.js";
import { cashFlowCsv } from "$lib/server/ledger/reports/csv.js";
import { cashFlowReport } from "$lib/server/queries/reports.js";
import {
  formatFrom,
  periodQuery,
  queryValues,
  reportResponse,
} from "../report-endpoint.js";

/** Where the period's cash came from and what it went on (FR-006, FR-010). */
export const GET: RequestHandler = async ({ locals, url }) => {
  // Seeing a report never allows recording one (FR-039).
  if (!can(locals, "reports.read")) return forbidden();

  const parsed = periodQuery.safeParse(
    queryValues(url, ["dateFrom", "dateTo"]),
  );
  if (!parsed.success) return badRequest(parsed.error);

  const { dateFrom, dateTo } = parsed.data;
  const report = cashFlowReport(db, dateFrom, dateTo);

  return reportResponse(
    formatFrom(url),
    report,
    () => cashFlowCsv(report),
    `cash-flow-${dateFrom}-to-${dateTo}`,
  );
};
