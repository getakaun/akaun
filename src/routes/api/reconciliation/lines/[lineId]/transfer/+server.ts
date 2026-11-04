import { z } from "zod";
import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import { recordTransferFromLine } from "$lib/server/application/reconciliation.js";
import { toResponse } from "$lib/server/application/http.js";

/**
 * The statement already says which account the line moved, so the only thing
 * left to ask is where the money came from or went (FR-023).
 */
const schema = z.object({
  otherAccountId: z.number().int().positive(),
  description: z.string().max(500).optional(),
});

export const POST: RequestHandler = async ({ locals, params, request }) => {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  const lineId = Number(params.lineId);
  if (!parsed.success || !Number.isInteger(lineId) || lineId <= 0)
    return Response.json(
      { error: "Choose the other account for this transfer" },
      { status: 400 },
    );
  return toResponse(
    recordTransferFromLine({ db, locals }, lineId, parsed.data),
    201,
    (value) => ({
      record: value.record,
      movement: value.movement,
      allocation: value.allocation,
    }),
  );
};
