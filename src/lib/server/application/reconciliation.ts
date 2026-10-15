import { z } from "zod";
import { StatementDirection } from "$lib/enums.js";
import {
  autoMatchMovements,
  createTransferForLine,
  editLine,
  ReconciliationError,
  removeLine,
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
import { isoDate, positiveId } from "./records.js";
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
        error.status === 403 || error.status === 401
          ? "You do not have permission to do that."
          : error.message,
      );
    throw error;
  }
}

export const lineDirection = z
  .enum(["in", "out"])
  .describe("in: money into the account; out: money out of it.");

export const updateLineShape = {
  date: isoDate.optional(),
  description: z.string().max(500).optional(),
  /** Positive decimal in the statement's currency. */
  amount: z.number().positive().optional(),
  direction: lineDirection.optional(),
  note: z.string().max(500).optional(),
};

export function updateStatementLine(
  ctx: AppContext,
  lineId: number,
  input: z.output<z.ZodObject<typeof updateLineShape>>,
  expectedVersion?: string,
) {
  // Asked before anything is looked up, so a caller without the ability
  // cannot learn which ids exist. The service asks again.
  const refused = requirePermissions(ctx, [["reconciliation", "change"]]);
  if (refused) return refused;
  if (!getLine(ctx.db, lineId)) return missing("Statement line not found");
  const stale = checkVersion(
    statementLineVersion(ctx.db, lineId),
    expectedVersion,
  );
  if (stale) return stale;
  const { direction, ...rest } = input;
  return run(() => ({
    line: editLine(ctx.db, ctx.locals, lineId, {
      ...rest,
      ...(direction
        ? {
            direction:
              direction === "in"
                ? StatementDirection.In
                : StatementDirection.Out,
          }
        : {}),
    }),
    version: statementLineVersion(ctx.db, lineId),
  }));
}

export function deleteStatementLine(
  ctx: AppContext,
  lineId: number,
  expectedVersion?: string,
) {
  // Asked before anything is looked up, so a caller without the ability
  // cannot learn which ids exist. The service asks again.
  const refused = requirePermissions(ctx, [["reconciliation", "delete"]]);
  if (refused) return refused;
  if (!getLine(ctx.db, lineId)) return missing("Statement line not found");
  const stale = checkVersion(
    statementLineVersion(ctx.db, lineId),
    expectedVersion,
  );
  if (stale) return stale;
  return run(() => {
    removeLine(ctx.db, ctx.locals, lineId);
    return { id: lineId };
  });
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
  const refused = requirePermissions(ctx, [["reconciliation", "change"]]);
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
export function autoMatch(ctx: AppContext, movementIds: number[]) {
  return run(() => autoMatchMovements(ctx.db, ctx.locals, movementIds));
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
    ["reconciliation", "add"],
    ["records", "add"],
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
