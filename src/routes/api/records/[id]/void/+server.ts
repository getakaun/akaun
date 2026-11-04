import { z } from "zod";
import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import { notFound } from "$lib/server/api-response.js";
import { toResponse } from "$lib/server/application/http.js";
import { fail } from "$lib/server/application/result.js";
import {
  prepareVoidRecord,
  voidRecord,
  voidShape,
} from "$lib/server/application/records.js";

const voidSchema = z.object(voidShape).strict();

/** What voiding would do, its version, and why it is blocked (if it is). */
export const GET: RequestHandler = ({ locals, params }) => {
  const id = Number(params.id);
  if (!Number.isSafeInteger(id) || id <= 0)
    return notFound("That record no longer exists.");
  const response = toResponse(prepareVoidRecord({ db, locals }, id));
  response.headers.set("Cache-Control", "no-store");
  return response;
};

/** Voids the record. Needs `records.void`; asked inside `voidRecord`. */
export const POST: RequestHandler = async ({ locals, params, request }) => {
  const id = Number(params.id);
  if (!Number.isSafeInteger(id) || id <= 0)
    return notFound("That record no longer exists.");
  const parsed = voidSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return toResponse(
      fail(
        "INVALID_INPUT",
        "Explain the void in 10 to 2000 characters, and send the record's version.",
      ),
    );
  return toResponse(voidRecord({ db, locals }, id, parsed.data));
};
