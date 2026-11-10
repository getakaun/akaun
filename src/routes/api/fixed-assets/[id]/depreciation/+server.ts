import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import {
  readAssetDepreciation,
  previewDepreciationProfile,
  approveDepreciationProfile,
  stopDepreciation,
  previewAssetCatchUp,
  postAssetCatchUp,
  linkManualDepreciation,
  unlinkManualDepreciation,
} from "$lib/server/application/depreciation.js";
import { toResponse } from "$lib/server/application/http.js";
export const GET: RequestHandler = ({ locals, params }) =>
  toResponse(readAssetDepreciation({ db, locals }, Number(params.id)));
export const POST: RequestHandler = async ({ locals, params, request }) => {
  const body = await request.json().catch(() => null);
  if (
    !body ||
    ![
      "preview",
      "approve",
      "stop",
      "catch-up-preview",
      "catch-up",
      "link-manual",
      "unlink-manual",
    ].includes(body.action)
  )
    return Response.json(
      { error: "Choose a valid depreciation action." },
      { status: 400 },
    );
  const ctx = { db, locals };
  const id = Number(params.id);
  if (body.action === "catch-up-preview")
    return toResponse(previewAssetCatchUp(ctx, id));
  if (body.action === "catch-up")
    return toResponse(postAssetCatchUp(ctx, id, body.input));
  if (body.action === "link-manual")
    return toResponse(linkManualDepreciation(ctx, id, body.input));
  if (body.action === "unlink-manual")
    return toResponse(unlinkManualDepreciation(ctx, id, body.input));
  if (body.action === "preview")
    return toResponse(previewDepreciationProfile(ctx, id, body.input));
  if (body.action === "approve")
    return toResponse(approveDepreciationProfile(ctx, id, body.input));
  return toResponse(stopDepreciation(ctx, id, body.input));
};
