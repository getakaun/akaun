import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import {
  readFixedAssets,
  registerFixedAsset,
} from "$lib/server/application/fixed-assets.js";
import { toResponse } from "$lib/server/application/http.js";

export const GET: RequestHandler = ({ locals, url }) =>
  toResponse(
    readFixedAssets(
      { db, locals },
      url.searchParams.get("asAt") ?? new Date().toISOString().slice(0, 10),
    ),
  );

export const POST: RequestHandler = async ({ locals, request }) =>
  toResponse(
    registerFixedAsset({ db, locals }, await request.json().catch(() => null)),
    201,
  );
