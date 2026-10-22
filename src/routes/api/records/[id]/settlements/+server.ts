import { allocationHistoryDeletionReason } from "$lib/server/queries/allocation-state.js";
import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import { can } from "$lib/server/permissions.js";
import { forbidden, notFound } from "$lib/server/api-response.js";
import { getRecord } from "$lib/server/queries/ledger.js";
import { recordRelations } from "$lib/server/queries/reimbursements.js";
import { permissionForKind } from "$lib/server/ledger/record-permissions.js";

/**
 * What paid this record, or — on a payment — what this record paid off.
 *
 * `GET /api/settlements` answers "what is still outstanding", which is the
 * question a payment screen asks before it writes anything. This answers the
 * other one: what has already been put against this particular record, so its
 * page can list the payments and offer to take one back (FR-018).
 *
 * A read, so it is gated on `view` for whichever screen the record belongs to.
 */
export const GET: RequestHandler = async ({ locals, params }) => {
  const id = Number((params as { id: string }).id);
  if (!Number.isInteger(id) || id <= 0) {
    return notFound("That record no longer exists.");
  }

  const record = getRecord(db, id);
  if (!record) return notFound("That record no longer exists.");
  if (!can(locals, permissionForKind(record.kind, "read"))) {
    return forbidden();
  }

  return Response.json({
    record,
    ...recordRelations(db, id),
    allocationHistoryDeleteReason: allocationHistoryDeletionReason(db, id),
  });
};
