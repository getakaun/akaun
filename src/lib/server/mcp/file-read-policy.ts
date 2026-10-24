import { hit } from "../rate-limit.js";
import { McpToolError } from "./common.js";

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const FILE_READ_LIMIT = { max: 60, windowMs: 10 * 60_000 };

/** One budget for attachment and bank statement file reads by a user. */
export function checkFileReadLimit(userId: number) {
  const limit = hit(
    `mcp-attachment:${userId}`,
    FILE_READ_LIMIT.max,
    FILE_READ_LIMIT.windowMs,
  );
  if (limit.limited)
    throw new McpToolError(
      "RATE_LIMITED",
      `Too many files read. Try again in ${limit.retryAfterSeconds} seconds.`,
    );
}
