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
  // generalises: `createTransferForLine` asks for reconciliation.create and
  // records.create.
  create_from_lines: write(
    ["reconciliation:write", "records:write"],
    ["reconciliation.create", "records.create"],
  ),
  // v1 `auto_match`.
  auto_match: write(["reconciliation:write"], ["reconciliation.match"]),
});

export const UNMATCH_BANK_LINES = writeTool({
  // v1 `set_movement_matches`: an unmatch replaces a movement's matches.
  unmatch: write(["reconciliation:write"], ["reconciliation.match"]),
});
