import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import { reverseDepreciationRun } from "$lib/server/application/depreciation.js";
import { toResponse } from "$lib/server/application/http.js";
export const POST: RequestHandler = async ({ locals, params, request }) =>
  toResponse(
    reverseDepreciationRun(
      { db, locals },
      Number(params.runId),
      await request.json().catch(() => null),
    ),
  );
