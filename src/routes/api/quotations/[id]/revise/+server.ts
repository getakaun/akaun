import type { RequestHandler } from "@sveltejs/kit";
import { db } from "$lib/server/db/client.js";
import { reviseQuotation } from "$lib/server/application/sales.js";
import { toResponse } from "$lib/server/application/http.js";

/**
 * Revising a quotation that has gone to the customer: a new draft version of it
 * (`Q-0012-R1`) is made, and the old one becomes Superseded. It adds a
 * quotation and changes one, so it needs both abilities.
 */
export const POST: RequestHandler = async ({ locals, params }) => {
  const id = parseInt(params.id!);
  return toResponse(reviseQuotation({ db, locals }, id), 201, (written) => ({
    previous: written.previous.quotation,
    quotation: written.quotation,
  }));
};
