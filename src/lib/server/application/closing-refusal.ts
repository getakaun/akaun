import { closedPeriodReason } from "../closing/policy.js";
import { fail, type AppFailure } from "./result.js";

function writeFailure(error: unknown): AppFailure | null {
  const reason = closedPeriodReason(error);
  if (reason) return fail("REFUSED", reason);
  const visited = new Set<unknown>();
  let current = error;
  while (current && typeof current === "object" && !visited.has(current)) {
    if (
      "code" in current &&
      typeof current.code === "string" &&
      /^SQLITE_(BUSY|LOCKED)(_|$)/.test(current.code)
    )
      return fail(
        "CONFLICT",
        "The book is busy or changed during this action. Refresh the current state before trying again.",
      );
    visited.add(current);
    current = "cause" in current ? current.cause : null;
  }
  return null;
}

/**
 * Convert only a known accounting-lock refusal, after the operation's write
 * transaction has unwound. Catching inside a transaction would commit any
 * earlier changes made by a compound operation.
 */
export function withClosingRefusal<T>(write: () => T): T | AppFailure {
  try {
    return write();
  } catch (error) {
    const failure = writeFailure(error);
    if (failure) return failure;
    throw error;
  }
}

/** Imports may await extraction/rates before entering their write transaction. */
export async function withAsyncClosingRefusal<T>(
  write: () => Promise<T>,
): Promise<T | AppFailure> {
  try {
    return await write();
  } catch (error) {
    const failure = writeFailure(error);
    if (failure) return failure;
    throw error;
  }
}
