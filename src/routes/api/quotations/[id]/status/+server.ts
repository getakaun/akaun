import { z } from "zod";
import type { RequestHandler } from "@sveltejs/kit";
import { db } from "$lib/server/db/client.js";
import { setQuotationStatus } from "$lib/server/application/sales.js";
import { toResponse } from "$lib/server/application/http.js";
import { badRequest } from "$lib/server/api-response.js";

/**
 * Moving a quotation along by hand: sent, accepted or declined.
 * Converted is not on the list — it is reached only by converting — and
 * `setQuotationStatus` refuses any move out of it, so a converted quotation
 * cannot be pulled away from the invoice it became.
 */

const statusSchema = z.object({
  status: z.enum(["sent", "accepted", "declined"]),
});

export const POST: RequestHandler = async ({ locals, params, request }) => {
  const raw = await request.json().catch(() => ({}));
  const parsed = statusSchema.safeParse(raw ?? {});
  if (!parsed.success) return badRequest(parsed.error);
  const id = parseInt(params.id!);
  return toResponse(
    setQuotationStatus({ db, locals }, id, parsed.data.status),
    200,
    (written) => written.quotation,
  );
};
