import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import {
  previewDepreciationMonth,
  postDepreciationMonth,
} from "$lib/server/application/depreciation.js";
import { toResponse } from "$lib/server/application/http.js";
export const GET: RequestHandler = ({ locals, url }) =>
  toResponse(
    previewDepreciationMonth(
      { db, locals },
      url.searchParams.get("month") ?? "",
    ),
  );
export const POST: RequestHandler = async ({ locals, request }) =>
  toResponse(
    postDepreciationMonth(
      { db, locals },
      await request.json().catch(() => null),
    ),
  );
