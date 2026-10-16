import { EventEmitter } from "events";

/**
 * Live updates for the Audit Log page.
 *
 *   entry-added {} — at least one entry was written. Carries nothing: the page
 *   asks `/api/audit?after=<newest id>` with its own filters, so one burst of
 *   writes (an import confirm) costs one fetch, and an entry whose transaction
 *   rolled back is simply never returned.
 */
export const auditEvents = new EventEmitter();
// One listener per open SSE connection, removed on disconnect. Matches the
// ceiling in $lib/server/ledger/events.ts.
auditEvents.setMaxListeners(200);
