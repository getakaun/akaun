import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import { addTaxAdjustment } from "$lib/server/application/tax-worksheets.js";
import { toResponse } from "$lib/server/application/http.js";
export const POST: RequestHandler = async ({ locals, params, request }) =>
  toResponse(
    addTaxAdjustment(
      { db, locals },
      Number(params.id),
      await request.json().catch(() => null),
    ),
    201,
  );
