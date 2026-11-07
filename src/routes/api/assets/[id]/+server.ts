import { z } from "zod";
import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import { saveAsset } from "$lib/server/application/fixed-assets.js";
import { toResponse } from "$lib/server/application/http.js";
import { badRequest } from "$lib/server/api-response.js";
const correction = z
  .object({
    input: z.unknown(),
    expectedVersion: z.number().int().positive(),
    reason: z.string().trim().min(1).max(4000),
  })
  .strict();
export const PATCH: RequestHandler = async ({ locals, request, params }) => {
  const parsed = correction.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);
  return toResponse(
    saveAsset({ db, locals }, parsed.data.input, {
      id: Number(params.id),
      expectedVersion: parsed.data.expectedVersion,
      reason: parsed.data.reason,
    }),
  );
};
