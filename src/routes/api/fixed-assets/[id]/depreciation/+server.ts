import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import {
  readAssetDepreciation,
  previewDepreciationProfile,
  approveDepreciationProfile,
  stopDepreciation,
} from "$lib/server/application/depreciation.js";
import { toResponse } from "$lib/server/application/http.js";
export const GET: RequestHandler = ({ locals, params }) =>
  toResponse(readAssetDepreciation({ db, locals }, Number(params.id)));
export const POST: RequestHandler = async ({ locals, params, request }) => {
  const body = await request.json().catch(() => null);
  if (!body || !["preview", "approve", "stop"].includes(body.action))
    return Response.json(
      { error: "Choose preview, approve or stop." },
      { status: 400 },
    );
  const ctx = { db, locals };
  const id = Number(params.id);
  if (body.action === "preview")
    return toResponse(previewDepreciationProfile(ctx, id, body.input));
  if (body.action === "approve")
    return toResponse(approveDepreciationProfile(ctx, id, body.input));
  return toResponse(stopDepreciation(ctx, id, body.input));
};
