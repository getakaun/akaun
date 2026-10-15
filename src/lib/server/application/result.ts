import type { z } from "zod";
import type { Refusable } from "../ledger/types.js";

/**
 * What an authorized operation answers.
 *
 * A superset of `Refusable`: the services say *whether* a rule refused, and
 * this adds *which kind* of refusal it was, so the REST routes and the MCP
 * tools can each turn it into their own reply from one place (`http.ts`, and
 * `mcp/common.ts`'s `runWrite`) rather than every caller guessing a status.
 */
export type AppErrorCode =
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "INVALID_INPUT"
  | "REFUSED"
  | "CONFLICT"
  | "PAYLOAD_TOO_LARGE"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "RATE_UNAVAILABLE";

export type AppFailure = {
  ok: false;
  code: AppErrorCode;
  reason: string;
  issues?: z.ZodError["issues"];
  /** On CONFLICT: the version the caller should re-read and retry against. */
  currentVersion?: string;
};

export type AppResult<T> = { ok: true; value: T } | AppFailure;

export function ok<T>(value: T): AppResult<T> {
  return { ok: true, value };
}

export function fail(code: AppErrorCode, reason: string): AppFailure {
  return { ok: false, code, reason };
}

export function denied(): AppFailure {
  return fail("FORBIDDEN", "You do not have permission to do that.");
}

export function missing(what = "That no longer exists."): AppFailure {
  return fail("NOT_FOUND", what);
}

export function invalid(error: z.ZodError): AppFailure {
  return {
    ok: false,
    code: "INVALID_INPUT",
    reason: "Some of what was sent is not valid.",
    issues: error.issues,
  };
}

export function conflict(currentVersion: string): AppFailure {
  return {
    ok: false,
    code: "CONFLICT",
    reason:
      "This was changed by someone else since it was read. Read it again and retry.",
    currentVersion,
  };
}

/** A service's refusal, carried through with its own sentence. */
export function fromRefusable<T>(
  result: Refusable<T>,
  code: AppErrorCode = "REFUSED",
): AppResult<T> {
  return result.ok ? result : fail(code, result.reason);
}

/**
 * Thrown inside a `db.transaction` callback to roll it back with a reason.
 * Caught by `inTransaction`, never allowed to escape an operation.
 */
export class Rollback extends Error {
  constructor(public failure: AppFailure) {
    super(failure.reason);
  }
}
