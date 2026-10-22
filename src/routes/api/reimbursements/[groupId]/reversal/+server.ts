import { z } from "zod";
import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import { badRequest } from "$lib/server/api-response.js";
import { toResponse } from "$lib/server/application/http.js";
import {
  prepareReimbursementReversal,
  reverseReimbursement,
  reimbursementReversalShape,
} from "$lib/server/application/reimbursement-reversal.js";
export const GET: RequestHandler = ({ locals, params }) =>
  toResponse(
    prepareReimbursementReversal({ db, locals }, Number(params.groupId)),
  );
export const POST: RequestHandler = async ({ locals, params, request }) => {
  const parsed = z
    .object(reimbursementReversalShape)
    .strict()
    .safeParse({
      ...(await request.json().catch(() => ({}))),
      groupId: Number(params.groupId),
    });
  if (!parsed.success) return badRequest(parsed.error);
  return toResponse(reverseReimbursement({ db, locals }, parsed.data));
};
