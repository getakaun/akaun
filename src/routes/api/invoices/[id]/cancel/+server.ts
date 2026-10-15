import type { RequestHandler } from "@sveltejs/kit";
import { db } from "$lib/server/db/client.js";
import { voidInvoice } from "$lib/server/application/sales.js";
import { toResponse } from "$lib/server/application/http.js";

/**
 * Voiding a sent invoice. It keeps its number and is marked Cancelled, and its
 * issue posting leaves the books — including the reports for the period it was
 * issued in. Refused while anything has been paid against it, and for a draft,
 * which is deleted instead. The refusal's own sentence is what the screen shows.
 */
export const POST: RequestHandler = async ({ locals, params }) => {
  const id = parseInt(params.id!);
  return toResponse(
    voidInvoice({ db, locals }, id, { reissue: false }),
    200,
    (written) => written.invoice,
  );
};
