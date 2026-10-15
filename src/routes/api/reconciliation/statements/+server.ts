import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import { can } from "$lib/server/permissions.js";
import { listStatementSummaries } from "$lib/server/services/reconciliation.js";

export const GET: RequestHandler = ({ locals }) => {
  if (!locals.user) return new Response("Unauthorized", { status: 401 });
  if (!can(locals, "reconciliation.read"))
    return new Response("Forbidden", { status: 403 });
  return Response.json({ statements: listStatementSummaries(db, locals) });
};
// POST moved to `/api/accounts/[id]/reconciliation/statements`: a statement
// belongs to one account, and reconciling is reached from that account, so the
// account comes from the path rather than from a field the user had to fill in
// twice (FR-050, contracts/api.md).
//
// GET stays. Every other reconciliation endpoint is unchanged, including
// `PATCH /statements/[statementId]`, the move-to-another-account action that
// makes FR-054 reachable.
