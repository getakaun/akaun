import { z } from "zod";
import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import { can } from "$lib/server/permissions.js";
import { badRequest, forbidden, notFound } from "$lib/server/api-response.js";
import { getSettlement } from "$lib/server/queries/settlements.js";
import {
  correctPaymentAllocations,
  preparePaymentCorrection,
} from "$lib/server/application/payment-corrections.js";
import { toResponse } from "$lib/server/application/http.js";

export const GET: RequestHandler = ({ locals, params }) => {
  if (!can(locals, "records.read")) return forbidden();
  const row = getSettlement(db, Number(params.id));
  return row
    ? toResponse(
        preparePaymentCorrection({ db, locals }, row.paymentMovementId),
      )
    : notFound("That allocation no longer exists.");
};

export const DELETE: RequestHandler = async ({ locals, params, request }) => {
  if (!can(locals, "records.delete")) return forbidden();
  const row = getSettlement(db, Number(params.id));
  if (!row) return notFound("That allocation no longer exists.");
  const parsed = z
    .object({
      reason: z.string().trim().min(10).max(2000),
      expectedVersion: z.string().min(1),
    })
    .strict()
    .safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);
  return toResponse(
    correctPaymentAllocations(
      { db, locals },
      {
        ...parsed.data,
        paymentMovementId: row.paymentMovementId,
        removeSettlementIds: [row.id],
        allocations: [],
      },
    ),
  );
};
