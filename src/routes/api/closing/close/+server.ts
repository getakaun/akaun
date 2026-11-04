import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import { closeMonth } from "$lib/server/application/closing.js";
import { toResponse } from "$lib/server/application/http.js";

export const POST: RequestHandler = async ({ locals, request }) =>
  toResponse(
    closeMonth({ db, locals }, await request.json().catch(() => null)),
  );
