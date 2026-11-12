import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import {
  readTaxSettings,
  saveTaxSettings,
} from "$lib/server/application/tax-settings.js";
import { toResponse } from "$lib/server/application/http.js";

export const GET: RequestHandler = ({ locals }) =>
  toResponse(readTaxSettings({ db, locals }));
export const POST: RequestHandler = async ({ locals, request }) =>
  toResponse(
    saveTaxSettings({ db, locals }, await request.json().catch(() => null)),
  );
