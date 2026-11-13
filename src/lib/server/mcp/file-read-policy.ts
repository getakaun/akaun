import { hit } from "../rate-limit.js";

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const FILE_READ_LIMIT = { max: 60, windowMs: 10 * 60_000 };

/** Why a file read was refused, in the words of the two file tools' kept contract. */
export type FileReadErrorCode =
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "OUTPUT_TOO_LARGE"
  | "UNSUPPORTED"
  | "RATE_LIMITED";

/**
 * A refused file read (`akaun_get_attachment`, `akaun_get_bank_statement_file`).
 * Thrown inside those two tools and turned into the v2 error shape there
 * (`tools/reads/files.ts`); nothing else throws it.
 */
export class McpToolError extends Error {
  constructor(
    public code: FileReadErrorCode,
    message: string,
  ) {
    super(message);
  }
}

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
