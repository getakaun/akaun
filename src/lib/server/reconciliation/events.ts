import { DeferrableEmitter } from "../unit-of-work.js";

// Bank reconciliation live-update bus: every mutating function in
// services/reconciliation.ts emits on this after its DB write, and the
// /api/reconciliation/stream SSE endpoint is the only consumer. Event types:
// `statement-update`, `statement-deleted`, `line-update`, `line-deleted`,
// `lines-added`, `allocation-update` (which now carries `movementId`, not the
// retired item type and id — D-11), and `allocations-bulk-update`.
//
// A new transfer created from a statement line also lands on the ledger stream,
// because `createRecord` emits `record-update` for the record it wrote.
export const reconciliationEvents = new DeferrableEmitter();
// Each open SSE connection registers one listener per event type above (7) and
// removes them all on disconnect — cap at ~100 concurrent streams. See the
// matching note in $lib/server/finance/events.ts.
reconciliationEvents.setMaxListeners(600);
