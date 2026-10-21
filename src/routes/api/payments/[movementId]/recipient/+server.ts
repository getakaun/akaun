import { z } from "zod";
import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import { badRequest } from "$lib/server/api-response.js";
import { toResponse } from "$lib/server/application/http.js";
import {
  recipientCorrectionShape,
  prepareRecipientCorrection,
  correctPaymentRecipient,
} from "$lib/server/application/payment-recipient.js";
export const GET: RequestHandler = ({ locals, params }) =>
  toResponse(
    prepareRecipientCorrection({ db, locals }, Number(params.movementId)),
  );
export const POST: RequestHandler = async ({ locals, params, request }) => {
  const parsed = z
    .object(recipientCorrectionShape)
    .strict()
    .safeParse({
      ...(await request.json().catch(() => ({}))),
      recordId: Number(params.movementId),
    });
  if (!parsed.success) return badRequest(parsed.error);
  return toResponse(correctPaymentRecipient({ db, locals }, parsed.data));
};
