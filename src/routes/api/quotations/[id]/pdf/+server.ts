import { redirect } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { db } from "$lib/server/db/client.js";
import { getQuotation } from "$lib/server/queries/quotations.js";
import { salesPdfResponse } from "$lib/server/pdf/sales-pdf.js";
import { can } from "$lib/server/permissions.js";
import { forbidden } from "$lib/server/api-response.js";

export const GET: RequestHandler = async ({ params, locals }) => {
  if (!locals.user) throw redirect(302, "/login");
  if (!can(locals, "quotations.read")) return forbidden();

  const quotation = getQuotation(db, parseInt(params.id));
  if (!quotation) throw redirect(302, "/quotations");

  return salesPdfResponse(db, "quotation", quotation);
};
