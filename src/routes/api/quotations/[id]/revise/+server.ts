import { json } from "@sveltejs/kit";
import type { RequestHandler } from "@sveltejs/kit";
import { db } from "$lib/server/db/client.js";
import { reviseQuotation } from "$lib/server/services/quotations.js";
import { getQuotation } from "$lib/server/queries/quotations.js";
import { hasPermission } from "$lib/server/permissions.js";
import { forbidden, notFound, refused } from "$lib/server/api-response.js";

/**
 * Revising a quotation that has gone to the customer: a new draft version of it
 * (`Q-0012-R1`) is made, and the old one becomes Superseded. It adds a
 * quotation and changes one, so it needs both abilities.
 */
export const POST: RequestHandler = async ({ locals, params }) => {
  if (
    !hasPermission(locals, "quotations", "add") ||
    !hasPermission(locals, "quotations", "change")
  ) {
    return forbidden();
  }
  const id = parseInt(params.id!);
  if (!getQuotation(db, id))
    return notFound("That quotation no longer exists.");

  const result = reviseQuotation(db, id, locals.user!.id);
  if (!result.ok) return refused(result.reason);

  return json(
    {
      previous: getQuotation(db, result.value.previousId),
      quotation: getQuotation(db, result.value.quotationId),
    },
    { status: 201 },
  );
};
