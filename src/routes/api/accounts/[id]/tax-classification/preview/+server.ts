import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import { canAll } from "$lib/server/permissions.js";
import { forbidden, notFound } from "$lib/server/api-response.js";
import {
  previewAccountTaxDefault,
  ACCOUNT_TAX_PERMISSIONS,
} from "$lib/server/application/account-tax-classification.js";
import { toResponse } from "$lib/server/application/http.js";

export const POST: RequestHandler = async ({ locals, params, request }) => {
  if (!canAll(locals, ACCOUNT_TAX_PERMISSIONS)) return forbidden();
  const id = Number(params.id);
  if (!Number.isSafeInteger(id) || id <= 0)
    return notFound("That account no longer exists.");
  return toResponse(
    previewAccountTaxDefault(
      { db, locals },
      id,
      await request.json().catch(() => null),
    ),
  );
};
