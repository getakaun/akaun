import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import { canAll } from "$lib/server/permissions.js";
import { forbidden } from "$lib/server/api-response.js";
import {
  previewBulkTax,
  BULK_TAX_PERMISSIONS,
} from "$lib/server/application/bulk-expense-tax.js";
import { toResponse } from "$lib/server/application/http.js";

export const POST: RequestHandler = async ({ locals, request }) => {
  if (!canAll(locals, BULK_TAX_PERMISSIONS)) return forbidden();
  return toResponse(
    previewBulkTax({ db, locals }, await request.json().catch(() => null)),
  );
};
