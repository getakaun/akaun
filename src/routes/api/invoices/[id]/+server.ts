import type { RequestHandler } from "@sveltejs/kit";
import { db } from "$lib/server/db/client.js";
import { getInvoice } from "$lib/server/queries/invoices.js";
import { hasPermission } from "$lib/server/permissions.js";
import {
  deleteInvoice,
  updateInvoice,
} from "$lib/server/application/sales.js";
import { toResponse } from "$lib/server/application/http.js";

export const GET: RequestHandler = async ({ locals, params }) => {
  if (!hasPermission(locals, "invoices", "view"))
    return new Response("Forbidden", { status: 403 });
  const id = parseInt(params.id!);
  const invoice = getInvoice(db, id);
  if (!invoice) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(invoice);
};

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
  const id = parseInt(params.id!);
  const body = await request.json().catch(() => null);
  // No `status` in the body: sending and cancelling are their own actions,
  // because each changes the books. What a sent invoice may still change is
  // the operation's to say (`application/sales.ts`).
  return toResponse(
    updateInvoice({ db, locals }, id, body),
    200,
    (written) => written.invoice,
  );
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
  const id = parseInt(params.id!);
  return toResponse(deleteInvoice({ db, locals }, id), 204);
};
