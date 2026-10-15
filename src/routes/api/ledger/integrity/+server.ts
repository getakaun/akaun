import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import { can } from "$lib/server/permissions.js";
import { forbidden } from "$lib/server/api-response.js";
import { checkIntegrity } from "$lib/server/ledger/integrity.js";
import { integrityInputs } from "$lib/server/queries/ledger.js";

/**
 * "Check the books": does every record's two sides still cancel out, and do
 * they cancel out across the whole store? (FR-003, SC-002)
 *
 * `elapsedMs` is returned so the answer to "is this still fast enough as the
 * books grow?" is a figure the user can read, rather than a claim.
 */
export const GET: RequestHandler = async ({ locals }) => {
  if (!can(locals, "reports.read")) return forbidden();

  const startedAt = performance.now();
  const report = checkIntegrity(integrityInputs(db));
  const elapsedMs = Math.round(performance.now() - startedAt);

  return Response.json({ ...report, elapsedMs });
};
