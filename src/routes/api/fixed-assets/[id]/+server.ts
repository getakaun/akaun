import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import { updateFixedAsset } from "$lib/server/application/fixed-assets.js";
import { toResponse } from "$lib/server/application/http.js";
import { notFound } from "$lib/server/api-response.js";

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
  const id = Number(params.id);
  if (!Number.isSafeInteger(id) || id <= 0)
    return notFound("That asset no longer exists.");
  return toResponse(
    updateFixedAsset(
      { db, locals },
      id,
      await request.json().catch(() => null),
    ),
  );
};
