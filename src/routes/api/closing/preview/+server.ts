import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import { previewClosing } from "$lib/server/application/closing.js";
import { toResponse } from "$lib/server/application/http.js";

export const GET: RequestHandler = ({ locals, url }) =>
  toResponse(
    previewClosing(
      { db, locals },
      { monthEnd: url.searchParams.get("monthEnd") },
    ),
  );
