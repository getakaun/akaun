import type { RequestHandler } from "@sveltejs/kit";
import { db } from "$lib/server/db/client.js";
import { convertQuotation } from "$lib/server/application/sales.js";
import { toResponse } from "$lib/server/application/http.js";

/**
 * Converting a sent or accepted quotation into a draft invoice. It changes the
 * quotation (it becomes Converted) and adds an invoice, so it needs both
 * abilities — the same pair the Convert button is shown for.
 */
export const POST: RequestHandler = async ({ locals, params }) => {
  const id = parseInt(params.id!);
  return toResponse(convertQuotation({ db, locals }, id), 201, (written) => ({
    quotation: written.quotation,
    invoice: written.invoice.invoice,
  }));
};
