import { read, readToolBy, write, writeTool } from "./define.js";

/**
 * Sales documents: `get_sales_documents`, `create_sales_documents` and
 * `change_sales_documents`, action by action as v1's sales tools.
 */

/**
 * v1 `list_invoices` / `get_invoice` and `list_quotations` /
 * `get_quotation`. Listed to a caller who can read either kind; a call for
 * one kind needs that kind's read.
 */
export const GET_SALES_DOCUMENTS = readToolBy("kind", {
  invoice: read(["invoices:read"]),
  quotation: read(["quotations:read"]),
});

export const CREATE_SALES_DOCUMENTS = writeTool({
  // v1 `create_invoice`. Naming a new customer also needs contacts.create,
  // asked by the operation (as in v1).
  invoices: write(["invoices:write"], ["invoices.create"]),
  // v1 `create_quotation`.
  quotations: write(["quotations:write"], ["quotations.create"]),
});

export const CHANGE_SALES_DOCUMENTS = writeTool(
  {
    // v1 `update_invoice`.
    invoice_update: write(["invoices:write"], ["invoices.update"]),
    // v1 `issue_invoice`: issuing posts it to the ledger.
    invoice_issue: write(
      ["invoices:write", "records:write"],
      ["invoices.issue", "records.create"],
    ),
    // v1 `void_invoice`.
    invoice_void: write(
      ["invoices:write", "records:write"],
      ["invoices.void", "records.update"],
    ),
    // v1 `delete_invoice`.
    invoice_delete: write(["invoices:delete"], ["invoices.delete"]),
    // v1 `update_quotation`.
    quotation_update: write(["quotations:write"], ["quotations.update"]),
    // v1 `set_quotation_status`.
    quotation_status: write(["quotations:write"], ["quotations.update"]),
    // v1 `revise_quotation`.
    quotation_revise: write(
      ["quotations:write"],
      ["quotations.revise", "quotations.create"],
    ),
    // v1 `convert_quotation_to_invoice`.
    quotation_convert: write(
      ["quotations:write", "invoices:write"],
      ["quotations.convert", "invoices.create"],
    ),
    // v1 `delete_quotation`.
    quotation_delete: write(["quotations:delete"], ["quotations.delete"]),
  },
  {
    // `voidInvoice` with `reissue` also creates the replacement draft.
    invoice_void_reissue: write(
      ["invoices:write", "records:write"],
      ["invoices.void", "records.update", "invoices.create"],
    ),
  },
);
