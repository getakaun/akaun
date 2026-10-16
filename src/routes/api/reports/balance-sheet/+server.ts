import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import { can } from "$lib/server/permissions.js";
import { badRequest, forbidden } from "$lib/server/api-response.js";
import { balanceSheetCsv } from "$lib/server/ledger/reports/csv.js";
import { balanceSheetReport } from "$lib/server/queries/reports.js";
import {
  asAtQuery,
  formatFrom,
  queryValues,
  reportResponse,
} from "../report-endpoint.js";

/**
 * What the business owns, what it owes and what the owners have in it, as at a
 * date (FR-026). `balances` is false only if the books themselves do not add
 * up, and `differenceMinor` says by how much.
 */
export const GET: RequestHandler = async ({ locals, url }) => {
  if (!can(locals, "reports.read")) return forbidden();

  const parsed = asAtQuery.safeParse(queryValues(url, ["asAt"]));
  if (!parsed.success) return badRequest(parsed.error);

  const { asAt } = parsed.data;
  const report = balanceSheetReport(db, asAt);

  return reportResponse(
    formatFrom(url),
    report,
    () => balanceSheetCsv(report),
    `balance-sheet-${asAt}`,
  );
};
