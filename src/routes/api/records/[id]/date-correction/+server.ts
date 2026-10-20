import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import { notFound } from "$lib/server/api-response.js";
import {
  correctRecordDate,
  prepareRecordDateCorrection,
} from "$lib/server/application/record-date-correction.js";
import { toResponse } from "$lib/server/application/http.js";

export const GET: RequestHandler = ({ locals, params }) => {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0)
    return notFound("That record no longer exists.");
  const response = toResponse(prepareRecordDateCorrection({ db, locals }, id));
  response.headers.set("Cache-Control", "no-store");
  return response;
};

export const POST: RequestHandler = async ({ locals, params, request }) => {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0)
    return notFound("That record no longer exists.");
  return toResponse(
    correctRecordDate(
      { db, locals },
      id,
      await request.json().catch(() => null),
    ),
  );
};
