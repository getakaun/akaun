import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import { badRequest } from "$lib/server/api-response.js";
import { toResponse } from "$lib/server/application/http.js";
import {
  reimbursementSchema,
  createReimbursement,
} from "$lib/server/application/reimbursements.js";
export const POST: RequestHandler = async ({ locals, request }) => {
  const parsed = reimbursementSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) return badRequest(parsed.error);
  return toResponse(createReimbursement({ db, locals }, parsed.data));
};
