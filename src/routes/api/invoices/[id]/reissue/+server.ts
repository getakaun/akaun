import { json } from "@sveltejs/kit";
import type { RequestHandler } from "@sveltejs/kit";
import { db } from "$lib/server/db/client.js";
import { getInvoice } from "$lib/server/queries/invoices.js";
import { voidAndReissueInvoice } from "$lib/server/services/invoices.js";
import { hasPermission } from "$lib/server/permissions.js";
import { forbidden, notFound, refused } from "$lib/server/api-response.js";

/**
 * Voiding a sent invoice and issuing a corrected draft in its place. The void
 * follows the same rules as `cancel`; the new draft gets the next number. It
 * changes one invoice and adds another, so it needs both abilities.
 */
export const POST: RequestHandler = async ({ locals, params }) => {
  if (
    !hasPermission(locals, "invoices", "change") ||
    !hasPermission(locals, "invoices", "add")
  ) {
    return forbidden();
  }

  const id = parseInt(params.id!);
  if (!getInvoice(db, id)) return notFound("That invoice no longer exists.");

  const result = voidAndReissueInvoice(db, id, locals.user!.id);
  if (!result.ok) return refused(result.reason);

  return json(result.value, { status: 201 });
};
