import { z } from "zod";
import {
  autoMatchMovements,
  createTransferForLine,
  ReconciliationError,
  replaceMovementAllocations,
} from "../services/reconciliation.js";
import { getLine } from "../queries/reconciliation.js";
import { getMovementCandidate } from "../queries/reconciliation.js";
import { requirePermissions, type AppContext } from "./context.js";
import {
  fail,
  missing,
  ok,
  type AppErrorCode,
  type AppResult,
} from "./result.js";
import { positiveId } from "./records.js";
import {
  checkVersion,
  movementMatchesVersion,
  recordVersion,
  statementLineVersion,
} from "./version.js";

/**
 * Reconciliation as authorized operations.
 *
 * The service already checks the `reconciliation` ability itself, from
 * `locals`, and refuses by throwing a `ReconciliationError` with a status.
 * This only turns that into an `AppResult` and adds the version check; the
 * rules — a line matches only its own statement's account, never more than it
 * holds, and a transfer from a line also needs `records:add` — stay in the
 * service, where the REST routes get them too.
 */

const STATUS_CODE: Record<number, AppErrorCode> = {
  400: "INVALID_INPUT",
  401: "FORBIDDEN",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "REFUSED",
};

function run<T>(write: () => T): AppResult<T> {
  try {
    return ok(write());
  } catch (error) {
    if (error instanceof ReconciliationError)
      return fail(
        STATUS_CODE[error.status] ?? "REFUSED",
        // The bare "Forbidden" of a missing ability says nothing; a 403 that
        // explains itself (an account that needs Adjustments) is passed on.
        error.status === 401 ||
          (error.status === 403 && error.message === "Forbidden")
          ? "You do not have permission to do that."
          : error.message,
      );
    throw error;
  }
}

export const allocationsShape = z
  .array(
    z.object({
      lineId: positiveId,
      /** Positive decimal, as on the statement line. */
      amount: z.number().positive(),
    }),
  )
  .max(200);

/** Replaces every bank line matched to one movement. An empty list clears them. */
export function setMovementMatches(
  ctx: AppContext,
  movementId: number,
  allocations: z.output<typeof allocationsShape>,
  expectedVersion?: string,
) {
  // Asked before anything is looked up, so a caller without the ability
  // cannot learn which ids exist. The service asks again.
  const refused = requirePermissions(ctx, ["reconciliation.match"]);
  if (refused) return refused;
  if (!getMovementCandidate(ctx.db, movementId))
    return missing("Reconciliation record not found");
  const stale = checkVersion(
    movementMatchesVersion(ctx.db, movementId),
    expectedVersion,
  );
  if (stale) return stale;
  return run(() => ({
    ...replaceMovementAllocations(ctx.db, ctx.locals, movementId, allocations),
    version: movementMatchesVersion(ctx.db, movementId),
  }));
}

/** Matches each untouched movement to the bank lines that fit it exactly; never overwrites a match. */
export function autoMatch(
  ctx: AppContext,
  movementIds: number[],
  statementId?: number,
) {
  return run(() =>
    autoMatchMovements(ctx.db, ctx.locals, movementIds, statementId),
  );
}

/**
 * Records an unmatched line as a transfer between two of the user's own
 * accounts, and matches it, in one transaction (FR-023).
 */
export function recordTransferFromLine(
  ctx: AppContext,
  lineId: number,
  input: { otherAccountId: number; description?: string },
  expectedVersion?: string,
) {
  // Asked before anything is looked up, so a caller without the ability
  // cannot learn which ids exist. The service asks again.
  const refused = requirePermissions(ctx, [
    "reconciliation.create",
    "records.create",
  ]);
  if (refused) return refused;
  if (!getLine(ctx.db, lineId)) return missing("Statement line not found");
  const stale = checkVersion(
    statementLineVersion(ctx.db, lineId),
    expectedVersion,
  );
  if (stale) return stale;
  const result = run(() =>
    createTransferForLine(ctx.db, ctx.locals, lineId, input),
  );
  if (!result.ok) return result;
  return ok({
    ...result.value,
    recordVersion: recordVersion(ctx.db, result.value.record.id),
    lineVersion: statementLineVersion(ctx.db, lineId),
  });
}
