import { redirect } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { db } from "$lib/server/db/client.js";
import { getInvoice } from "$lib/server/queries/invoices.js";
import { salesPdfResponse } from "$lib/server/pdf/sales-pdf.js";
import { can } from "$lib/server/permissions.js";
import { forbidden } from "$lib/server/api-response.js";

export const GET: RequestHandler = async ({ params, locals }) => {
  if (!locals.user) throw redirect(302, "/login");
  if (!can(locals, "invoices.read")) return forbidden();

  const invoice = getInvoice(db, parseInt(params.id));
  if (!invoice) throw redirect(302, "/invoices");

  return salesPdfResponse(db, "invoice", invoice);
};
