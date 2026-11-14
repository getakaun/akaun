import { ANY_READ, readTool } from "./define.js";

/**
 * `get_change_history`: listed to anyone who can read some area, like v1
 * `get_audit_history`. It checks each item's own read when it runs
 * (`AUDIT_PERMISSION`), and a request's entries are only those of item types
 * this credential may read. Administrative kinds need `audit.read`, which is
 * never delegable, so no token or app reads them.
 */
export const GET_CHANGE_HISTORY = readTool(ANY_READ);
