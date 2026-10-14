import type { RequestHandler } from "@sveltejs/kit";
import { db } from "$lib/server/db/client.js";
import { getInvoice } from "$lib/server/queries/invoices.js";
import { patchInvoice, removeInvoice } from "$lib/server/services/invoices.js";
import { resolveOrCreateContact } from "$lib/server/queries/contacts.js";
import { InvoiceStatus, Role } from "$lib/enums.js";
import { hasPermission } from "$lib/server/permissions.js";
import { notFound, refused } from "$lib/server/api-response.js";
import { SEALED_SALES_FIELDS } from "$lib/sales/status.js";
import {
  salesLinesSchema,
  salesRateSchema,
  invalidLines,
} from "$lib/server/sales/schema.js";

export const GET: RequestHandler = async ({ locals, params }) => {
  if (!hasPermission(locals, "invoices", "view"))
    return new Response("Forbidden", { status: 403 });
  const id = parseInt(params.id!);
  const invoice = getInvoice(db, id);
  if (!invoice) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(invoice);
};

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
  if (!hasPermission(locals, "invoices", "change"))
    return new Response("Forbidden", { status: 403 });
  const user = locals.user!;
  const id = parseInt(params.id!);

  const invoice = getInvoice(db, id);
  if (!invoice) return Response.json({ error: "Not found" }, { status: 404 });

  if (invoice.status === InvoiceStatus.Cancelled) {
    return refused(
      "This invoice has been cancelled, so it can no longer be changed.",
    );
  }

  const body = await request.json();
  const patch: Record<string, unknown> = {};
  // No `status`: sending and cancelling are their own actions, because each
  // changes the books. Setting it here skipped both.
  const fields = [
    "contactId",
    "reference",
    "issueDate",
    "dueDate",
    "currency",
    "exchangeRate",
    "notes",
    "terms",
  ];
  for (const f of fields) {
    if (body[f] !== undefined) patch[f] = body[f];
  }
  if (body.lines !== undefined) {
    const lines = salesLinesSchema.safeParse(body.lines);
    if (!lines.success) return invalidLines(lines.error);
    patch.lines = lines.data;
  }
  if (patch.exchangeRate !== undefined) {
    const rate = salesRateSchema.safeParse(patch.exchangeRate);
    if (!rate.success) return invalidLines(rate.error);
  }

  // Once it has been sent, its amount is in the books and the customer has a
  // copy, so what the money says is fixed. The wording around it can still be
  // corrected (FR-018a). Checked before a new customer name is resolved, so a
  // refused edit cannot leave a contact behind.
  if (invoice.ledgerRecordId !== null) {
    if (
      SEALED_SALES_FIELDS.some((f) => patch[f] !== undefined) ||
      Boolean(body.newContactName)
    ) {
      return refused(
        "This invoice has been sent. Its amount, date and customer are fixed — void and reissue it if they are wrong.",
      );
    }
  }

  if (!patch.contactId && body.newContactName) {
    patch.contactId = resolveOrCreateContact(
      db,
      body.newContactName,
      Role.Customer,
      user.id,
    );
  }

  const updated = patchInvoice(db, id, user.id, patch);
  return Response.json(updated);
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
  if (!hasPermission(locals, "invoices", "delete"))
    return new Response("Forbidden", { status: 403 });
  const id = parseInt(params.id!);

  const result = removeInvoice(db, id, locals.user!.id);
  if (!result.ok) {
    if (result.reason === "not_found")
      return notFound("That invoice no longer exists.");
    if (result.reason === "cancelled")
      return refused(
        "A cancelled invoice keeps its number, so it cannot be deleted.",
      );
    return refused(
      "This invoice has been sent, so it cannot be deleted. Cancel it instead.",
    );
  }
  return new Response(null, { status: 204 });
};
