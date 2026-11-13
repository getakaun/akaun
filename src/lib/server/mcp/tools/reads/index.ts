import type { ToolDefinition } from "../../registry.js";
import { overviewReadTools } from "./overview.js";
import { recordsReadTools } from "./records.js";
import { accountsReadTools } from "./accounts.js";
import { contactsReadTools } from "./contacts.js";
import { reportsReadTools } from "./reports.js";
import { bankReadTools } from "./bank.js";
import { salesReadTools } from "./sales.js";
import { importsReadTools } from "./imports.js";
import { historyReadTools } from "./history.js";
import { filesReadTools } from "./files.js";
import { reviewReadTools } from "./review.js";

/**
 * Every v2 read tool, in the order `tools/list` shows them. The order of the
 * domains is fixed here once; a tool task fills only its own domain file, so
 * parallel tasks never edit this one. Reads are listed before writes.
 */
export const READ_TOOLS: readonly ToolDefinition[] = [
  ...overviewReadTools,
  ...recordsReadTools,
  ...accountsReadTools,
  ...contactsReadTools,
  ...reportsReadTools,
  ...bankReadTools,
  ...salesReadTools,
  ...importsReadTools,
  ...historyReadTools,
  ...filesReadTools,
  ...reviewReadTools,
];
