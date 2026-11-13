import { read, readTool, write, writeTool } from "./define.js";

/** Imports: `get_import_queue` and `review_imports` (no new submissions). */

/** v1 `list_import_jobs` / `get_import_job`. */
export const GET_IMPORT_QUEUE = readTool(read(["import:read"]));

export const REVIEW_IMPORTS = writeTool({
  // v1 `update_import_item`.
  update_item: write(["import:write"], ["import.update"]),
  // v1 `confirm_import`. Makes records, but needs only the import ability,
  // as in the app (006 FR-045). Deliberate: do not add records.create.
  confirm: write(["import:write"], ["import.confirm"]),
  // v1 `skip_import`.
  skip: write(["import:write"], ["import.confirm"]),
  // v1 `discard_import_job`.
  discard: write(["import:delete"], ["import.delete"]),
});
