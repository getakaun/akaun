import { createHash } from "node:crypto";
/** Shared canonical snapshot/retry hashing; retained object key order is intentional. */
export const evidenceHash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
