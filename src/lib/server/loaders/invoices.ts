import type { Actions } from "@sveltejs/kit";
import { db } from "$lib/server/db/client.js";
import { getInvoice, listInvoices } from "$lib/server/queries/invoices.js";
import { removeInvoice } from "$lib/server/services/invoices.js";
import { fail, redirect } from "@sveltejs/kit";
import { hasPermission } from "$lib/server/permissions.js";
import { documentDefaults } from "$lib/server/sales/defaults.js";

export function loadInvoicesPage(locals: App.Locals) {
  if (!hasPermission(locals, "invoices", "view"))
    throw redirect(302, "/dashboard");
  // The tab counts are worked out on the page, from the live list the stream
  // keeps current.
  return {
    invoices: listInvoices(db, { limit: 1000 }),
    perms: { add: hasPermission(locals, "invoices", "add") },
  };
}

/**
 * The blank form, for `/invoices/new`.
 *
 * Gated on `add`, not `view` — a create page's whole reason to exist fails
 * without it, so a user who lacks it is sent back rather than shown a form
 * that would 403 on submit.
 */
export function loadInvoiceNew(locals: App.Locals) {
  if (!hasPermission(locals, "invoices", "add"))
    throw redirect(302, "/invoices");
  // Days from the issue date to the due date a new invoice starts with; null
  // when the setting is empty (no due date).
  return { defaultDays: documentDefaults(db).invoiceDueDays };
}

/**
 * One invoice, for `/invoices/[id]`.
 *
 * The list carries a summary row; the page needs the lines and the payments
 * that settled it, which the drawer used to fetch after opening — so the
 * numbers a reader came to check arrived a moment after the panel did.
 */
export function loadInvoiceDetail(locals: App.Locals, id: number) {
  if (!hasPermission(locals, "invoices", "view"))
    throw redirect(302, "/dashboard");

  const invoice = getInvoice(db, id);
  if (!invoice) throw redirect(302, "/invoices");

  return {
    invoice,
    perms: {
      change: hasPermission(locals, "invoices", "change"),
      delete: hasPermission(locals, "invoices", "delete"),
      // Cancel & reissue changes this invoice and adds another.
      reissue:
        hasPermission(locals, "invoices", "change") &&
        hasPermission(locals, "invoices", "add"),
      // A customer's payment is a record, so recording one from the invoice
      // needs what recording it from the Records screen needs.
      recordPayment: hasPermission(locals, "records", "add"),
    },
  };
}

export const invoicesActions: Actions = {
  delete: async ({ locals, request }) => {
    if (!hasPermission(locals, "invoices", "delete"))
      return fail(403, { error: "Forbidden" });
    const userId = locals.user!.id;
    const data = await request.formData();
    const id = parseInt(String(data.get("id") ?? "0"));
    if (!id) return fail(400, { error: "Invalid invoice" });
    const result = removeInvoice(db, id, userId);
    if (!result.ok) {
      if (result.reason === "issued") {
        return fail(409, {
          error:
            "This invoice has been sent, so it cannot be deleted. Cancel it instead.",
        });
      }
      if (result.reason === "cancelled") {
        return fail(409, {
          error:
            "A cancelled invoice keeps its number, so it cannot be deleted.",
        });
      }
      return fail(404, { error: "Invoice not found" });
    }
    return { success: true };
  },
};
