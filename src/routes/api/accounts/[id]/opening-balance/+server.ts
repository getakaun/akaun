import { z } from "zod";
import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import { badRequest, notFound } from "$lib/server/api-response.js";
import { setOpeningBalance } from "$lib/server/application/accounts.js";
import { toResponse } from "$lib/server/application/http.js";
import { isValidDate } from "$lib/server/date.js";

const schema = z
  .object({
    date: z.string().refine(isValidDate, {
      message: "The date must be in YYYY-MM-DD form.",
    }),
    // Whole cents. Negative is allowed: an account can start overdrawn.
    amountMinor: z.number().int(),
  })
  .strict();

export const PUT: RequestHandler = async ({ locals, params, request }) => {
  const id = Number((params as { id: string }).id);
  if (!Number.isInteger(id) || id <= 0) {
    return notFound("That account no longer exists.");
  }

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);

  // Creates or replaces the account's single opening balance — there is only
  // ever one, so sending this again corrects it rather than adding a second
  // (FR-010).
  // The opening balance is a record, so the operation also asks for the
  // records ability the write amounts to (`application/accounts.ts`).
  return toResponse(setOpeningBalance({ db, locals }, id, parsed.data), 204);
};
