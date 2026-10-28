import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import { toResponse } from "$lib/server/application/http.js";
import {
  prepareExpenseContactCorrection,
  correctExpenseContact,
} from "$lib/server/application/expense-contact-correction.js";

export const GET: RequestHandler = ({ locals, params }) =>
  toResponse(
    prepareExpenseContactCorrection({ db, locals }, Number(params.id)),
  );

export const POST: RequestHandler = async ({ locals, params, request }) =>
  toResponse(
    correctExpenseContact(
      { db, locals },
      Number(params.id),
      await request.json().catch(() => null),
    ),
  );
