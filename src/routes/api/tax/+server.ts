import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import {
  createTaxWorksheet,
  readTaxWorksheets,
} from "$lib/server/application/tax-worksheets.js";
import { toResponse } from "$lib/server/application/http.js";
export const GET: RequestHandler = ({ locals }) =>
  toResponse(readTaxWorksheets({ db, locals }));
export const POST: RequestHandler = async ({ locals, request }) =>
  toResponse(
    createTaxWorksheet({ db, locals }, await request.json().catch(() => null)),
    201,
  );
