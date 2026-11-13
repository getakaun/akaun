import type { ToolDefinition } from "../../registry.js";
import { recordsWriteTools } from "./records.js";
import { paymentsWriteTools } from "./payments.js";
import { bankWriteTools } from "./bank.js";
import { contactsWriteTools } from "./contacts.js";
import { accountsWriteTools } from "./accounts.js";
import { assetsWriteTools } from "./assets.js";
import { salesWriteTools } from "./sales.js";
import { importsWriteTools } from "./imports.js";

/**
 * Every v2 write tool, in the order `tools/list` shows them. The order of the
 * domains is fixed here once; a tool task fills only its own domain file, so
 * parallel tasks never edit this one. Writes are listed after every read.
 */
export const WRITE_TOOLS: readonly ToolDefinition[] = [
  ...recordsWriteTools,
  ...paymentsWriteTools,
  ...bankWriteTools,
  ...contactsWriteTools,
  ...accountsWriteTools,
  ...assetsWriteTools,
  ...salesWriteTools,
  ...importsWriteTools,
];
