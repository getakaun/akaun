import { eq } from "drizzle-orm";
import { reimbursementEntries } from "../db/schema.js";
import { z } from "zod";
import { LedgerRecordKind } from "$lib/enums.js";
import { recordAudit } from "../audit.js";
import {
  getRecord,
  lockStateFor,
  updateRecord as writeRecord,
} from "../queries/ledger.js";
import { emitRecordUpdate } from "../services/ledger.js";
import { actor, requirePermissions, type AppContext } from "./context.js";
import {
  fail,
  invalid,
  missing,
  ok,
  type AppFailure,
  type AppResult,
} from "./result.js";
import { isoDate, type RecordWritten } from "./records.js";
import { checkVersion, recordVersion } from "./version.js";

export const dateCorrectionSchema = z
  .object({
    date: isoDate,
    reason: z.string().trim().min(10).max(500),
    expectedVersion: z.string().min(1),
    acknowledgePeriodChange: z.boolean(),
  })
  .strict();

function authorization(ctx: AppContext): AppFailure | null {
  if (ctx.locals.credential || ctx.locals.oauth) {
    return fail(
      "FORBIDDEN",
      "Date corrections require a signed-in browser session.",
    );
  }
  return requirePermissions(ctx, [
    "records.read",
    "records.update",
    "records.correctDate",
  ]);
}

/** Read afresh when opening the review; the POST checks these live facts again. */
export function prepareRecordDateCorrection(
  ctx: AppContext,
  id: number,
): AppResult<RecordWritten> {
  const denied = authorization(ctx);
  if (denied) return denied;
  if (
    ctx.db
      .select()
      .from(reimbursementEntries)
      .where(eq(reimbursementEntries.recordId, id))
      .get()
  )
    return fail("REFUSED", "Reimbursement transfer dates are read-only.");
  const record = getRecord(ctx.db, id);
  if (!record) return missing("That record no longer exists.");
  if (
    record.kind !== LedgerRecordKind.Expense &&
    record.kind !== LedgerRecordKind.Income
  ) {
    return fail(
      "REFUSED",
      "Only settled expense and income dates can be corrected here.",
    );
  }
  const lock = lockStateFor(ctx.db, id);
  if (lock.reconciled) {
    return fail(
      "REFUSED",
      "Unmatch this record from its bank statement lines before correcting its date.",
    );
  }
  if (!lock.settled) {
    return fail(
      "REFUSED",
      "This record is not settled. Change its date using the ordinary record form.",
    );
  }
  return ok({ record, version: recordVersion(ctx.db, id) });
}

/**
 * A narrow exception to the normal date lock. No movements are rebuilt and no
 * allocations are undone. Eligibility, version, mutation and audit are atomic.
 */
export function correctRecordDate(
  ctx: AppContext,
  id: number,
  input: unknown,
): AppResult<RecordWritten> {
  const denied = authorization(ctx);
  if (denied) return denied;
  if (
    ctx.db
      .select()
      .from(reimbursementEntries)
      .where(eq(reimbursementEntries.recordId, id))
      .get()
  )
    return fail("REFUSED", "Reimbursement transfer dates are read-only.");
  const parsed = dateCorrectionSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { date, reason, expectedVersion, acknowledgePeriodChange } =
    parsed.data;
  const result = ctx.db.transaction((): AppResult<RecordWritten> => {
    // recordVersion does not include bank matches or settlements. Never use
    // a matching version as a substitute for rechecking their live state.
    const current = prepareRecordDateCorrection(ctx, id);
    if (!current.ok) return current;
    const stale = checkVersion(current.value.version, expectedVersion);
    if (stale) return stale;
    if (date === current.value.record.date) {
      return fail(
        "INVALID_INPUT",
        "Choose a different date for this correction.",
      );
    }
    if (
      date.slice(0, 7) !== current.value.record.date.slice(0, 7) &&
      !acknowledgePeriodChange
    ) {
      return fail(
        "INVALID_INPUT",
        "Acknowledge that this correction changes reports for different accounting periods.",
      );
    }
    writeRecord(ctx.db, id, actor(ctx), { date });
    recordAudit(ctx.db, {
      recordType: "record",
      recordId: id,
      userId: actor(ctx),
      action: "update",
      changes: [
        { field: "date", before: current.value.record.date, after: date },
        { field: "dateCorrectionReason", before: null, after: reason },
      ],
    });
    return ok({
      record: getRecord(ctx.db, id)!,
      version: recordVersion(ctx.db, id),
    });
  });
  if (result.ok) emitRecordUpdate(ctx.db, id);
  return result;
}
