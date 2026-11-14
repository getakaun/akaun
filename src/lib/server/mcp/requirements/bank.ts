import { read, readTool, write, writeTool } from "./define.js";

/** Bank: `get_bank_reconciliation`, `match_bank_lines`, `unmatch_bank_lines`. */

/** v1 `get_bank_statement`: lines and the records they could match. */
export const GET_BANK_RECONCILIATION = readTool(
  read(["reconciliation:read", "records:read"]),
);

export const MATCH_BANK_LINES = writeTool({
  // v1 `set_movement_matches`.
  match: write(["reconciliation:write"], ["reconciliation.match"]),
  // v1 `record_transfer_from_line`, which `createRecordFromLines`
  // generalises. Every kind but a transfer matches the lines to the new
  // record, so the operation asks for reconciliation.match too; listing and
  // step-up ask the same. (A transfer alone needs only reconciliation.create
  // and records.create in the operation, as REST's one-line route always has;
  // this tool asks the fuller set for every kind.)
  create_from_lines: write(
    ["reconciliation:write", "records:write"],
    ["reconciliation.create", "reconciliation.match", "records.create"],
  ),
  // v1 `auto_match`.
  auto_match: write(["reconciliation:write"], ["reconciliation.match"]),
});

export const UNMATCH_BANK_LINES = writeTool({
  // v1 `set_movement_matches`: an unmatch replaces a movement's matches.
  unmatch: write(["reconciliation:write"], ["reconciliation.match"]),
});
