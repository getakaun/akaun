import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import {
  readAssetTaxSchemes,
  saveAssetTaxScheme,
} from "$lib/server/application/asset-tax-schemes.js";
import { toResponse } from "$lib/server/application/http.js";
export const GET: RequestHandler = ({ locals }) =>
  toResponse(readAssetTaxSchemes({ db, locals }));
export const POST: RequestHandler = async ({ locals, request }) =>
  toResponse(
    saveAssetTaxScheme({ db, locals }, await request.json().catch(() => null)),
  );
