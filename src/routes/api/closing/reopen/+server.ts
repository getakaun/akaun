import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import { reopenMonths } from "$lib/server/application/closing.js";
import { toResponse } from "$lib/server/application/http.js";

export const POST: RequestHandler = async ({ locals, request }) =>
  toResponse(
    reopenMonths({ db, locals }, await request.json().catch(() => null)),
  );
