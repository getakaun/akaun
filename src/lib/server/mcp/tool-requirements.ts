import type { OAuthScope } from "../oauth/config.js";
import { canAll } from "../permissions.js";
import type { LeafPermission } from "$lib/permissions/catalog.js";

/**
 * What every MCP tool needs, in one table: the OAuth scopes an app's token
 * must hold, and the catalog permissions the request must have.
 *
 * Read by three things that used to keep their own lists — discovery (a tool
 * the caller cannot use is never listed), the check when a tool runs, and the
 * `insufficient_scope` challenge in `http.ts` — so they cannot disagree. A spec
 * asserts that every registered tool has an entry here and every entry is
 * registered, and that each tool's scopes stand for its permissions.
 *
 * Some abilities depend on the input (a record that turns out to be an
 * adjustment, an invoice naming a new customer). Those are asked by the
 * operation in `application/` when it knows, never here.
 */
export type ToolRequirement = {
  scopes: OAuthScope[];
  permissions: LeafPermission[];
  /** Changes the books. */
  writes: boolean;
};

const read = (
  scopes: OAuthScope[],
  permissions: LeafPermission[] = scopes.map(
    (s) => `${s.split(":")[0]}.read` as LeafPermission,
  ),
): ToolRequirement => ({ scopes, permissions, writes: false });

const write = (
  scopes: OAuthScope[],
  permissions: LeafPermission[],
): ToolRequirement => ({ scopes, permissions, writes: true });

export const TOOL_REQUIREMENTS: Record<string, ToolRequirement> = {
  // Reads
  list_records: read(["records:read"]),
  get_record: read(["records:read"]),
  get_attachment: read(["records:read"]),
  list_outstanding: read(["records:read"]),
  get_account_statement: read(["records:read"]),
  list_accounts: read(["accounts:read"]),
  list_contacts: read(["contacts:read"]),
  get_contact_balance: read(["contacts:read", "records:read"]),
  get_financial_report: read(["reports:read"]),
  list_import_jobs: read(["import:read"]),
  get_import_job: read(["import:read"]),
  list_invoices: read(["invoices:read"]),
  get_invoice: read(["invoices:read"]),
  list_quotations: read(["quotations:read"]),
  get_quotation: read(["quotations:read"]),
  list_bank_statements: read(["reconciliation:read"]),
  get_bank_statement: read(["reconciliation:read", "records:read"]),
  // What it reads depends on what is asked about; checked when it runs.
  get_audit_history: { scopes: [], permissions: [], writes: false },

  // Records and settlements
  create_record: write(["records:write"], ["records.create"]),
  get_reimbursement_reversal: read(["records:read"]),
  reverse_reimbursement: write(
    ["records:write", "records:delete"],
    ["records.create", "records.delete"],
  ),
  get_reimbursement_candidates: read(["records:read"]),
  create_reimbursement: write(["records:write"], ["records.create"]),
  get_payment_recipient_correction: read(["records:read"]),
  correct_payment_recipient: write(
    ["records:write", "records:delete"],
    ["records.create", "records.update", "records.delete"],
  ),
  record_payment: write(["records:write"], ["records.create"]),
  update_record: write(["records:write"], ["records.update"]),
  delete_record: write(["records:delete"], ["records.delete"]),
  settle_payment: write(["records:write"], ["records.create"]),
  get_payment_allocations: read(["records:read"]),
  correct_payment_allocations: write(
    ["records:delete", "records:write"],
    ["records.delete", "records.create"],
  ),
  undo_settlement: write(["records:delete"], ["records.delete"]),
  attach_file: write(["records:write"], ["records.update"]),

  // Accounts and contacts
  create_account: write(["accounts:write"], ["accounts.create"]),
  update_account: write(["accounts:write"], ["accounts.update"]),
  delete_account: write(["accounts:delete"], ["accounts.delete"]),
  // Also records.create, records.update or (setting it to zero) records.delete,
  // decided by whether one exists.
  set_opening_balance: write(
    ["accounts:write", "records:write"],
    ["accounts.update"],
  ),
  create_contact: write(["contacts:write"], ["contacts.create"]),
  update_contact: write(["contacts:write"], ["contacts.update"]),
  delete_contact: write(["contacts:delete"], ["contacts.delete"]),

  // Invoices and quotations
  create_invoice: write(["invoices:write"], ["invoices.create"]),
  update_invoice: write(["invoices:write"], ["invoices.update"]),
  issue_invoice: write(
    ["invoices:write", "records:write"],
    ["invoices.issue", "records.create"],
  ),
  // Also invoices.create when it reissues.
  void_invoice: write(
    ["invoices:write", "records:write"],
    ["invoices.void", "records.update"],
  ),
  delete_invoice: write(["invoices:delete"], ["invoices.delete"]),
  create_quotation: write(["quotations:write"], ["quotations.create"]),
  update_quotation: write(["quotations:write"], ["quotations.update"]),
  set_quotation_status: write(["quotations:write"], ["quotations.update"]),
  revise_quotation: write(
    ["quotations:write"],
    ["quotations.revise", "quotations.create"],
  ),
  convert_quotation_to_invoice: write(
    ["quotations:write", "invoices:write"],
    ["quotations.convert", "invoices.create"],
  ),
  delete_quotation: write(["quotations:delete"], ["quotations.delete"]),

  // Reconciliation
  set_movement_matches: write(
    ["reconciliation:write"],
    ["reconciliation.match"],
  ),
  auto_match: write(["reconciliation:write"], ["reconciliation.match"]),
  record_transfer_from_line: write(
    ["reconciliation:write", "records:write"],
    ["reconciliation.create", "records.create"],
  ),

  // Import
  update_import_item: write(["import:write"], ["import.update"]),
  // Makes records, but needs only the import ability, as in the app (006 FR-045).
  confirm_import: write(["import:write"], ["import.confirm"]),
  skip_import: write(["import:write"], ["import.confirm"]),
  discard_import_job: write(["import:delete"], ["import.delete"]),
};

/**
 * Whether this caller may see and run the tool.
 *
 * `locals.permissions` already is role ∩ delegation ceiling ∩ the
 * credential's own permissions, so the permission check bounds a personal
 * access token and an OAuth app alike. The scope check stays for OAuth because
 * a tool may ask for more scope than its permission comes from: setting an
 * opening balance also asks for `records:write`, since it writes a record.
 */
export function toolAllowed(
  locals: App.Locals,
  requirement: ToolRequirement,
): boolean {
  if (!locals.user) return false;
  if (
    locals.oauth &&
    !requirement.scopes.every((s) => locals.oauth!.scopes.includes(s))
  )
    return false;
  return canAll(locals, requirement.permissions);
}
