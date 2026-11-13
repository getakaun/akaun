import { read, readTool } from "./define.js";

/**
 * The two file reads whose v1 contract is kept exactly. Their requirements
 * are v1's too. (`attach_file` is in `records.ts`, beside the other record
 * writes, as its tool is.)
 */

/** Exactly v1 `get_attachment`. */
export const GET_ATTACHMENT = readTool(read(["records:read"]));

/** Exactly v1 `get_bank_statement_file`. */
export const GET_BANK_STATEMENT_FILE = readTool(read(["reconciliation:read"]));
