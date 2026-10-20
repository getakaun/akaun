import { z } from "zod";
import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import {
  autoMatchMovements,
  ReconciliationError,
} from "$lib/server/services/reconciliation.js";

const schema = z.object({
  statementId: z.number().int().positive().optional(),
  movementIds: z
    .array(z.number().int().positive())
    // Mirrors BULK_MATCH_CHUNK in ReconciliationPage.svelte, which slices
    // larger selections into requests of this size.
    .max(500),
});

export const POST: RequestHandler = async ({ locals, request }) => {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return Response.json({ error: "Invalid movements" }, { status: 400 });
  try {
    return Response.json(
      autoMatchMovements(
        db,
        locals,
        parsed.data.movementIds,
        parsed.data.statementId,
      ),
    );
  } catch (e) {
    if (e instanceof ReconciliationError)
      return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
};
