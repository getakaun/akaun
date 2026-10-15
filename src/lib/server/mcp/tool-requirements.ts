import type { OAuthScope } from "../oauth/config.js";
import {
  hasPermission,
  type ActionName,
  type ResourceName,
} from "../permissions.js";

/**
 * What every MCP tool needs, in one table: the OAuth scopes a token must hold
 * and the RBAC abilities the user must have.
 *
 * Read by three things that used to keep their own lists — discovery (a tool
 * the caller cannot use is never listed), the check when a tool runs, and the
 * `insufficient_scope` challenge in `http.ts` — so they cannot disagree. A spec
 * asserts that every registered tool has an entry here and every entry is
 * registered.
 *
 * Some abilities depend on the input (a record that turns out to be an
 * adjustment, an invoice naming a new contact). Those are asked by the
 * operation in `application/` when it knows, never here.
 */
export type ToolRequirement = {
  scopes: OAuthScope[];
  rbac: [ResourceName, ActionName][];
  /** Changes the books. Hidden from an API token unless MCP_BEARER_WRITES is on. */
  writes: boolean;
};

const read = (
  scopes: OAuthScope[],
  rbac: ResourceName[] = scopes.map((s) => s.split(":")[0] as ResourceName),
): ToolRequirement => ({
  scopes,
  rbac: rbac.map((resource) => [resource, "view"]),
  writes: false,
});

const write = (
  scopes: OAuthScope[],
  rbac: [ResourceName, ActionName][],
): ToolRequirement => ({ scopes, rbac, writes: true });

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
  // The resource depends on what is asked about; checked when it runs.
  get_audit_history: { scopes: [], rbac: [], writes: false },

  // Records and settlements
  create_record: write(["records:write"], [["records", "add"]]),
  record_payment: write(["records:write"], [["records", "add"]]),
  update_record: write(["records:write"], [["records", "change"]]),
  delete_record: write(["records:delete"], [["records", "delete"]]),
  settle_payment: write(["records:write"], [["records", "add"]]),
  undo_settlement: write(["records:delete"], [["records", "delete"]]),
  attach_file: write(["records:write"], [["records", "change"]]),
  // Removing a file is permanent, so it needs the delete scope even though
  // the app gates it on `change` like attaching one.
  delete_attachment: write(["records:delete"], [["records", "change"]]),

  // Accounts and contacts
  create_account: write(["accounts:write"], [["accounts", "add"]]),
  update_account: write(["accounts:write"], [["accounts", "change"]]),
  delete_account: write(["accounts:delete"], [["accounts", "delete"]]),
  set_opening_balance: write(
    ["accounts:write", "records:write"],
    [["accounts", "change"]],
  ),
  create_contact: write(["contacts:write"], [["contacts", "add"]]),
  update_contact: write(["contacts:write"], [["contacts", "change"]]),
  delete_contact: write(["contacts:delete"], [["contacts", "delete"]]),
  merge_contacts: write(
    ["contacts:write", "contacts:delete"],
    [
      ["contacts", "change"],
      ["contacts", "delete"],
    ],
  ),

  // Invoices and quotations
  create_invoice: write(["invoices:write"], [["invoices", "add"]]),
  update_invoice: write(["invoices:write"], [["invoices", "change"]]),
  issue_invoice: write(
    ["invoices:write", "records:write"],
    [
      ["invoices", "change"],
      ["records", "add"],
    ],
  ),
  void_invoice: write(
    ["invoices:write", "records:write"],
    [
      ["invoices", "change"],
      ["records", "change"],
    ],
  ),
  delete_invoice: write(["invoices:delete"], [["invoices", "delete"]]),
  create_quotation: write(["quotations:write"], [["quotations", "add"]]),
  update_quotation: write(["quotations:write"], [["quotations", "change"]]),
  set_quotation_status: write(["quotations:write"], [["quotations", "change"]]),
  revise_quotation: write(
    ["quotations:write"],
    [
      ["quotations", "add"],
      ["quotations", "change"],
    ],
  ),
  convert_quotation_to_invoice: write(
    ["quotations:write", "invoices:write"],
    [
      ["quotations", "change"],
      ["invoices", "add"],
    ],
  ),
  delete_quotation: write(["quotations:delete"], [["quotations", "delete"]]),

  // Reconciliation
  update_statement_line: write(
    ["reconciliation:write"],
    [["reconciliation", "change"]],
  ),
  delete_statement_line: write(
    ["reconciliation:delete"],
    [["reconciliation", "delete"]],
  ),
  set_movement_matches: write(
    ["reconciliation:write"],
    [["reconciliation", "change"]],
  ),
  auto_match: write(["reconciliation:write"], [["reconciliation", "change"]]),
  record_transfer_from_line: write(
    ["reconciliation:write", "records:write"],
    [
      ["reconciliation", "add"],
      ["records", "add"],
    ],
  ),

  // Import
  update_import_item: write(["import:write"], [["import", "change"]]),
  // Makes records, but needs only import.change, as in the app (006 FR-045).
  confirm_import: write(["import:write"], [["import", "change"]]),
  skip_import: write(["import:write"], [["import", "change"]]),
  discard_import_job: write(["import:delete"], [["import", "delete"]]),
};

/**
 * Whether this caller may see and run the tool. Scopes are checked before
 * RBAC so a superuser's token is still bounded by what it was granted.
 */
export function toolAllowed(
  locals: App.Locals,
  requirement: ToolRequirement,
  bearerWrites: boolean,
): boolean {
  if (!locals.user) return false;
  if (locals.oauth) {
    if (!requirement.scopes.every((s) => locals.oauth!.scopes.includes(s)))
      return false;
  } else if (requirement.writes && !bearerWrites) {
    return false;
  }
  return requirement.rbac.every(([resource, action]) =>
    hasPermission(locals, resource, action),
  );
}
