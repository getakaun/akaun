import { createHash } from "node:crypto";
import { z } from "zod";
import { DefaultAccountPurpose, LedgerRecordKind } from "$lib/enums.js";
import { requireAccountDefault } from "../services/account-defaults.js";
import { recordAudit } from "../audit.js";
import { getRecord } from "../queries/ledger.js";
import {
  getSide,
  getSettlement,
  settlementIdsForPayment,
  recordIdsForSettlement,
  settlementsForRecord,
} from "../queries/settlements.js";
import { createSettlements, undoSettlement } from "../services/settlements.js";
import type { DeferredEmits } from "../services/ledger.js";
import { actor, requirePermissions, type AppContext } from "./context.js";
import { checkVersion, recordVersion } from "./version.js";
import { allocationShape, positiveId } from "./records.js";
import { fail, ok, Rollback, type AppResult } from "./result.js";

export const correctionShape = {
  paymentMovementId: positiveId,
  removeSettlementIds: z.array(positiveId).default([]),
  allocations: z.array(allocationShape).default([]),
  reason: z.string().trim().min(10).max(2000),
  expectedVersion: z.string().min(1),
};

/** Includes child allocations and the contacts/amounts they currently refer to. */
export function paymentAllocationSnapshot(
  ctx: AppContext,
  paymentMovementId: number,
) {
  if (!Number.isSafeInteger(paymentMovementId) || paymentMovementId <= 0)
    return null;
  const payment = getSide(ctx.db, paymentMovementId);
  if (!payment) return null;
  const recordId = recordIdsForSettlement(
    ctx.db,
    paymentMovementId,
    paymentMovementId,
  )[0];
  const record = getRecord(ctx.db, recordId);
  if (!record) return null;
  const payable = requireAccountDefault(ctx.db, DefaultAccountPurpose.Payable);
  const receivable = requireAccountDefault(
    ctx.db,
    DefaultAccountPurpose.Receivable,
  );
  const reimbursementPayable = requireAccountDefault(
    ctx.db,
    DefaultAccountPurpose.ReimbursementsPayable,
  );
  const direction =
    (payable.ok && payment.accountId === payable.value) ||
    (reimbursementPayable.ok &&
      payment.accountId === reimbursementPayable.value)
      ? ("we-owe" as const)
      : receivable.ok && payment.accountId === receivable.value
        ? ("owed-to-us" as const)
        : null;
  if (!direction) return null;
  const allocations = settlementIdsForPayment(ctx.db, paymentMovementId)
    .map((id) => getSettlement(ctx.db, id)!)
    .sort((a, b) => a.id - b.id);
  const related = [
    ...new Set(
      allocations.flatMap((a) =>
        recordIdsForSettlement(ctx.db, a.paymentMovementId, a.owedMovementId),
      ),
    ),
  ];
  const version = createHash("sha256")
    .update(
      JSON.stringify([
        recordVersion(ctx.db, record.id),
        payment,
        allocations,
        related.map((id) => recordVersion(ctx.db, id)),
      ]),
    )
    .digest("hex")
    .slice(0, 16);
  return {
    record,
    payment,
    direction,
    allocations,
    links: settlementsForRecord(ctx.db, record.id),
    version,
    batch: payment.contactId === null,
    reimbursement:
      payable.ok &&
      payment.accountId === payable.value &&
      payment.amountMinor > 0 &&
      record.kind === LedgerRecordKind.Payment &&
      payment.contactId !== null,
  };
}

export function preparePaymentCorrection(
  ctx: AppContext,
  paymentMovementId: number,
) {
  const denied = requirePermissions(ctx, ["records.read"]);
  if (denied) return denied;
  const snapshot = paymentAllocationSnapshot(ctx, paymentMovementId);
  return snapshot
    ? ok(snapshot)
    : fail("NOT_FOUND", "That payment no longer exists.");
}

/** Replace only selected allocations; legacy relationships elsewhere remain untouched. */
export function correctPaymentAllocations(
  ctx: AppContext,
  input: z.output<z.ZodObject<typeof correctionShape>>,
): AppResult<{
  undoneIds: number[];
  settlementIds: number[];
  version: string;
}> {
  const denied = requirePermissions(ctx, [
    "records.delete",
    ...(input.allocations.length ? ["records.create" as const] : []),
  ]);
  if (denied) return denied;
  if (!input.expectedVersion)
    return fail(
      "INVALID_INPUT",
      "Reload the allocations and provide their version.",
    );
  if (input.reason.trim().length < 10 || input.reason.length > 2000)
    return fail(
      "INVALID_INPUT",
      "Explain the correction in 10 to 2000 characters.",
    );
  if (!input.removeSettlementIds.length && !input.allocations.length)
    return fail(
      "REFUSED",
      "Select an allocation to remove or add a replacement.",
    );
  const emits: DeferredEmits = [];
  try {
    const result = ctx.db.transaction(() => {
      const before = paymentAllocationSnapshot(ctx, input.paymentMovementId);
      if (!before)
        throw new Rollback(fail("NOT_FOUND", "That payment no longer exists."));
      const stale = checkVersion(before.version, input.expectedVersion);
      if (stale) throw new Rollback(stale);
      const selected = new Set(input.removeSettlementIds);
      if (
        selected.size !== input.removeSettlementIds.length ||
        [...selected].some((id) => !before.allocations.some((a) => a.id === id))
      )
        throw new Rollback(
          fail(
            "REFUSED",
            "One of those allocations does not belong to this payment. Reload and review it.",
          ),
        );
      const undoneIds: number[] = [];
      for (const id of selected) {
        if (undoneIds.includes(id)) continue;
        const undone = undoSettlement(
          ctx.db,
          id,
          actor(ctx),
          emits,
          input.reason.trim(),
        );
        if (!undone.ok) throw new Rollback(fail("REFUSED", undone.reason));
        undoneIds.push(...undone.value);
      }
      let settlementIds: number[] = [];
      if (input.allocations.length) {
        const added = createSettlements(
          ctx.db,
          actor(ctx),
          input.paymentMovementId,
          input.allocations,
          emits,
        );
        if (!added.ok) throw new Rollback(fail("REFUSED", added.reason));
        settlementIds = added.value;
      }
      const after = paymentAllocationSnapshot(ctx, input.paymentMovementId)!;
      recordAudit(ctx.db, {
        recordType: "record",
        recordId: before.record.id,
        userId: actor(ctx),
        action: "update",
        changes: [
          {
            field: "allocations",
            before: before.allocations,
            after: after.allocations,
          },
          {
            field: "correctionReason",
            before: null,
            after: input.reason.trim(),
          },
        ],
      });
      return { undoneIds, settlementIds, version: after.version };
    });
    for (const emit of emits) emit();
    return ok(result);
  } catch (error) {
    if (error instanceof Rollback) return error.failure;
    throw error;
  }
}
