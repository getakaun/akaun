import { DeferrableEmitter } from "../unit-of-work.js";

/**
 * One write, one emit.
 *
 * A single record change can alter what the Expenses list, the Income list, an
 * account balance and a report all show. `ledgerEvents` carries the record's
 * `kind` so the service layer never has to remember which of several emitters to
 * fire — forgetting one is silent, and silence is exactly the failure FR-042 is
 * written against (D-21). It replaces `expenseEvents`, `incomeEvents` and
 * `claimEvents`.
 *
 * Events (see specs/002-double-entry-ledger/contracts/events.md):
 *   record-update      { record }        — the shape GET /api/records returns
 *   record-deleted     { id }
 *   settlement-changed { recordIds: [] } — both sides, so each view refreshes its own
 *   account-update     { account }
 *   account-deleted    { id }
 */
export const ledgerEvents = new DeferrableEmitter();

/** Any write to an account, including archiving and an opening balance. */
export const accountEvents = new DeferrableEmitter();

// Each open SSE connection registers a small fixed number of listeners and
// removes them all on disconnect, so the cap guards against a genuine leak
// rather than normal load. Matches the ceiling in $lib/server/finance/events.ts.
const MAX_LISTENERS = 200;
for (const emitter of [ledgerEvents, accountEvents]) {
  emitter.setMaxListeners(MAX_LISTENERS);
}
