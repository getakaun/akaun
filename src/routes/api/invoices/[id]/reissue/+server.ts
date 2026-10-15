import type { RequestHandler } from "@sveltejs/kit";
import { db } from "$lib/server/db/client.js";
import { voidInvoice } from "$lib/server/application/sales.js";
import { toResponse } from "$lib/server/application/http.js";

/**
 * Voiding a sent invoice and issuing a corrected draft in its place. The void
 * follows the same rules as `cancel`; the new draft gets the next number. It
 * changes one invoice and adds another, so it needs both abilities.
 */
export const POST: RequestHandler = async ({ locals, params }) => {
  const id = parseInt(params.id!);
  return toResponse(
    voidInvoice({ db, locals }, id, { reissue: true }),
    201,
    (written) => ({ voided: written.invoice, invoice: written.reissued!.invoice }),
  );
};
