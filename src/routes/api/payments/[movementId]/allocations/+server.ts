import { z } from "zod";
import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import { badRequest } from "$lib/server/api-response.js";
import { toResponse } from "$lib/server/application/http.js";
import {
  correctPaymentAllocations,
  preparePaymentCorrection,
  correctionShape,
} from "$lib/server/application/payment-corrections.js";

export const GET: RequestHandler = ({ locals, params }) =>
  toResponse(
    preparePaymentCorrection({ db, locals }, Number(params.movementId)),
  );

export const POST: RequestHandler = async ({ locals, params, request }) => {
  const parsed = z
    .object(correctionShape)
    .strict()
    .safeParse({
      ...(await request.json().catch(() => ({}))),
      paymentMovementId: Number(params.movementId),
    });
  if (!parsed.success) return badRequest(parsed.error);
  return toResponse(correctPaymentAllocations({ db, locals }, parsed.data));
};
