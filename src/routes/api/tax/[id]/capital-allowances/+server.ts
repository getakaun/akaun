import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import { changeCapitalSchedule } from "$lib/server/application/capital-allowances.js";
import { toResponse } from "$lib/server/application/http.js";
export const POST: RequestHandler = async ({ locals, params, request }) =>
  toResponse(
    changeCapitalSchedule(
      { db, locals },
      Number(params.id),
      await request.json().catch(() => null),
    ),
  );
