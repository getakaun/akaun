import { z } from "zod";
import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import { can } from "$lib/server/permissions.js";
import { badRequest, forbidden, notFound } from "$lib/server/api-response.js";
import { accountHistoryCsv } from "$lib/server/ledger/reports/csv.js";
import { historyGapNotes } from "$lib/server/ledger/reports/notes.js";
import { recordSelectionDetails } from "$lib/server/queries/ledger.js";
import { accountHistory } from "$lib/server/queries/accounts.js";
import { ledgerTrackingStartDate } from "$lib/server/queries/reports.js";
import {
  accountHistoryQuery,
  formatFrom,
  queryValues,
  reportResponse,
} from "../../reports/report-endpoint.js";

/**
 * One account's statement: every movement on it, with a running balance.
 *
 * This is the account-history report at a new address and under a new ability.
 * **Nothing about the arithmetic is rebuilt** — `accountHistory()`, the running
 * balance, the truncation note and the CSV writer are reused exactly as they
 * stand (FR-040–FR-046, research.md R-07). JSON also carries per-record
 * selection metadata for the list's bulk actions.
 *
 * What changes is who may read it. The old page shell was gated on
 * `accounts.view` while its data came from an endpoint gated on `reports.view`,
 * so one screen answered to two abilities and the shell could open on data it
 * was then refused. A statement is a way of reading records, so it is gated on
 * **`records.view`** — one screen, one ability (FR-046).
 *
 * A record touching the narrowed account twice appears once per side, which is
 * what makes the running balance add up (FR-042).
 */
const statementQuery = accountHistoryQuery.extend({
  // No `offset`. The running balance is worked out from the opening balance
  // forward, so a request that skipped the first movements would restate every
  // balance from the wrong starting point. `total` says when the caller has not
  // seen everything, and the answer to that is narrower dates, not a page two.
  limit: z.coerce.number().int().positive().max(5000).optional(),
});

export const GET: RequestHandler = async ({ locals, url }) => {
  if (!can(locals, "records.read")) return forbidden();

  const parsed = statementQuery.safeParse(
    queryValues(url, ["accountId", "dateFrom", "dateTo", "limit"]),
  );
  if (!parsed.success) return badRequest(parsed.error);

  const { accountId, ...options } = parsed.data;
  const history = accountHistory(db, accountId, options);
  if (!history) return notFound("That account no longer exists.");

  /**
   * A running balance may only appear when the rows are the whole story in date
   * order: the account, and at most a date range.
   *
   * Any other filter, or any other sort, and each figure would be the balance
   * of *the rows that survived the filter* — a number that looks like a bank
   * balance and is not one. A figure that would lie is removed and the reason
   * put in `notes`, because a missing figure with no explanation reads as a
   * fault (FR-043).
   */
  const extraFilters = [...url.searchParams.keys()].filter(
    (key) =>
      !["accountId", "dateFrom", "dateTo", "limit", "format"].includes(key),
  );
  const sort = url.searchParams.get("sort");
  const runningBalanceHolds =
    extraFilters.length === 0 && (sort === null || sort === "date");

  const report = {
    ...history,
    selectionRecords:
      formatFrom(url) === "csv"
        ? []
        : recordSelectionDetails(
            db,
            history.entries.map((entry) => entry.recordId),
          ),
    // `accountHistory` reads rows and says nothing about what is missing from
    // them, so the gap sentence is added here — same wording, same rule, as the
    // three period reports carry (FR-030).
    notes: [
      ...history.notes,
      ...historyGapNotes(options.dateFrom ?? null, ledgerTrackingStartDate(db)),
      ...(runningBalanceHolds
        ? []
        : [
            "The running balance shows only when this account's transactions are in date order and no other filter applies. Clear the other filters to see it again.",
          ]),
    ],
    ...(runningBalanceHolds
      ? {}
      : {
          openingBalanceMinor: undefined,
          closingBalanceMinor: undefined,
          entries: history.entries.map((entry) => ({
            ...entry,
            runningBalanceMinor: undefined,
          })),
        }),
  };

  return reportResponse(
    formatFrom(url),
    report,
    () => accountHistoryCsv(history),
    `statement-${report.account.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`,
  );
};
