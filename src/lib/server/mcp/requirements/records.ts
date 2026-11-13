import {
  either,
  read,
  readTool,
  singleWriteTool,
  write,
  writeTool,
} from "./define.js";

/**
 * Records: `search_records`, `get_record`, `get_category_history`,
 * `attach_file`, `create_records` and `change_records`. Each entry names the
 * v1 tool it copies; the operation in `application/` still asks for every
 * permission itself.
 */

/** v1 `list_records` (and `get_account_statement` for the running balance). */
export const SEARCH_RECORDS = readTool(read(["records:read"]));

/** v1 `get_record`. */
export const GET_RECORD = readTool(read(["records:read"]));

/** v1 `list_records`: past categories are read from the records. */
export const GET_CATEGORY_HISTORY = readTool(read(["records:read"]));

/** Exactly v1 `attach_file`: the contract is unchanged. */
export const ATTACH_FILE = singleWriteTool(
  write(["records:write"], ["records.update"]),
);

export const CREATE_RECORDS = writeTool(
  {
    // v1 `create_record`.
    records: write(["records:write"], ["records.create"]),
  },
  {
    // A journal, or sides that derive to an adjustment. `createRecord` asks
    // for `records.adjust` once it has derived the kind.
    records_adjust: write(
      ["records:write", "records:adjust"],
      ["records.create", "records.adjust"],
    ),
  },
);

export const CHANGE_RECORDS = writeTool(
  {
    // v1 `update_record`. Every path an update can take needs this; the
    // correction paths below add their own abilities.
    update: write(["records:write"], ["records.update"]),
    // v1 `void_record`: `voidRecord` also asks for `records.read`.
    void: write(
      ["records:read", "records:void"],
      ["records.read", "records.void"],
    ),
    // v1 `delete_record`.
    delete: write(["records:delete"], ["records.delete"]),
  },
  {
    // --- the paths `update[]` routes to ---
    // v1 `correct_record_date`.
    correct_record_date: either(
      write(
        ["records:read", "records:write", "records:correct-date"],
        ["records.read", "records.update", "records.correctDate"],
      ),
      write(
        ["records:read", "records:write", "records:correction"],
        ["records.read", "records.update", "records.correctDate"],
      ),
    ),
    // v1 `correct_expense_contact`. Outside the grouped correction scope.
    correct_expense_contact: write(
      ["records:read", "records:write", "records:correct-contact"],
      ["records.read", "records.update", "records.correctContact"],
    ),
    // v1 `correct_payment_recipient`.
    correct_payment_recipient: either(
      write(
        ["records:write", "records:correction"],
        ["records.create", "records.update", "records.correctPaymentRecipient"],
      ),
      write(
        ["records:write", "records:delete"],
        ["records.create", "records.update", "records.delete"],
      ),
    ),
    // v1 `correct_reimbursement_amount`.
    correct_reimbursement_amount: either(
      write(
        [
          "records:read",
          "records:write",
          "records:correct-reimbursement-amount",
        ],
        [
          "records.read",
          "records.update",
          "records.correctReimbursementAmount",
        ],
      ),
      write(
        ["records:read", "records:write", "records:correction"],
        [
          "records.read",
          "records.update",
          "records.correctReimbursementAmount",
        ],
      ),
    ),
    // `correctSettledAmount` (no v1 tool): records.update and records.create,
    // and reversing allocations through Correct allocations or the delete
    // route it grew from — v1 `correct_payment_allocations`' alternatives.
    correct_settled_amount: either(
      write(
        ["records:write", "records:correction"],
        ["records.update", "records.create", "records.correctAllocations"],
      ),
      write(
        ["records:write", "records:delete"],
        ["records.update", "records.create", "records.delete"],
      ),
    ),
    // An update that unmatches and rematches bank lines on the way.
    release_bank_matches: write(
      ["records:write", "reconciliation:write"],
      ["records.update", "reconciliation.match"],
    ),
    // An update whose sides re-derive to an adjustment.
    records_adjust: write(
      ["records:write", "records:adjust"],
      ["records.update", "records.adjust"],
    ),
    // --- the paths `void[]` routes to ---
    // `release: "allocations"`: `voidRecord` reverses them first.
    void_release_allocations: either(
      write(
        ["records:read", "records:void", "records:correction"],
        ["records.read", "records.void", "records.correctAllocations"],
      ),
      write(
        ["records:read", "records:void", "records:delete"],
        ["records.read", "records.void", "records.delete"],
      ),
    ),
    // `release: "all"`: the allocations and the bank matches.
    void_release_all: either(
      write(
        [
          "records:read",
          "records:void",
          "records:correction",
          "reconciliation:write",
        ],
        [
          "records.read",
          "records.void",
          "records.correctAllocations",
          "reconciliation.match",
        ],
      ),
      write(
        [
          "records:read",
          "records:void",
          "records:delete",
          "reconciliation:write",
        ],
        [
          "records.read",
          "records.void",
          "records.delete",
          "reconciliation.match",
        ],
      ),
    ),
    // A reimbursement payment's void is `reverseReimbursement`: what v1
    // `reverse_reimbursement` needed, on top of the `void` action's own.
    reverse_reimbursement: write(
      ["records:read", "records:void", "records:write", "records:delete"],
      ["records.read", "records.void", "records.create", "records.delete"],
    ),
  },
);
