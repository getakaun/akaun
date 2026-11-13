import { DeferrableEmitter } from "../unit-of-work.js";

/**
 * Live updates for the import screens. Every change is emitted after the
 * database write it announces has committed.
 *
 * - `job-update` `{ userId, job: ImportJobEvent }` and `job-deleted`
 *   `{ userId, jobId }`: a queue row, without its document text.
 * - `item-update` `{ userId, jobId, item: ImportItemEvent }` and
 *   `item-deleted` `{ userId, jobId, itemId }`: one item of a group. The
 *   stream sends no snapshot of items: a group's page loads them, and these
 *   events only carry the changes (see `job-event.ts`).
 */
export const importEvents = new DeferrableEmitter();
// Each open SSE connection adds one listener to each of the four events and
// removes them on disconnect. The cap counts listeners per event, so adding
// the item events did not change it. See the matching note in
// $lib/server/finance/events.ts.
importEvents.setMaxListeners(200);
