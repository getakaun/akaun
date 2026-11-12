import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { DefaultAccountPurpose, LedgerRecordKind } from "$lib/enums.js";
import { settlements } from "../db/schema.js";
import { requireAccountDefault } from "../services/account-defaults.js";
import { recordAudit } from "../audit.js";
import { getRecord } from "../queries/ledger.js";
import { activeAllocation } from "../queries/allocation-state.js";
import {
  getSide,
  getSettlement,
  settlementIdsForPayment,
  recordIdsForSettlement,
  settlementsForRecord,
  type SettlementLink,
} from "../queries/settlements.js";
import {
  activeGroupOfRecipientMovement,
  correctionMovementFor,
  groupAllocationsForPayment,
  inspectGroup,
  NO_PAYEE_REASON,
  type GroupAllocation,
} from "../queries/reimbursement-groups.js";
import { linkTo } from "../queries/reimbursements.js";
import { money } from "../ledger/settlement-rules.js";
import { createSettlements, undoSettlement } from "../services/settlements.js";
import {
  groupDateRefusal,
  removeGroupExpenses,
} from "../services/reimbursement-groups.js";
import type { DeferredEmits } from "../services/ledger.js";
import {
  actor,
  requirePermissions,
  requireAnyPermissions,
  type AppContext,
} from "./context.js";
import { withClosingRefusal } from "./closing-refusal.js";
import { reverseReimbursementInTransaction } from "./reimbursement-reversal.js";
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

/**
 * Includes child allocations and the contacts/amounts they currently refer to.
 *
 * `allocations` are the raw settlement rows: the payee correction and the
 * "release the whole funding" path read them. `groupAllocations` are the same
 * payment's legacy group reimbursements seen per expense; the correction
 * screens show those instead of the one funding row (`presentedAllocations`).
 */
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
  const groupAllocations = groupAllocationsForPayment(
    ctx.db,
    paymentMovementId,
  );
  const related = [
    ...new Set(
      allocations.flatMap((a) =>
        recordIdsForSettlement(ctx.db, a.paymentMovementId, a.owedMovementId),
      ),
    ),
  ];
  const versioned: unknown[] = [
    recordVersion(ctx.db, record.id),
    payment,
    allocations,
    related.map((id) => recordVersion(ctx.db, id)),
  ];
  // A group's items can change without this payment's own rows changing.
  if (groupAllocations.length)
    versioned.push(
      groupAllocations.map((a) => [
        a.reimbursementGroupId,
        a.expenseRecordId,
        a.itemSettlementIds,
        a.amountMinor,
      ]),
    );
  const version = createHash("sha256")
    .update(JSON.stringify(versioned))
    .digest("hex")
    .slice(0, 16);
  return {
    record,
    payment,
    direction,
    allocations,
    groupAllocations,
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

type PaymentSnapshot = NonNullable<
  ReturnType<typeof paymentAllocationSnapshot>
>;

/** What the correction screens list: each group's expenses replace its funding row. */
function presented(ctx: AppContext, snapshot: PaymentSnapshot) {
  if (!snapshot.groupAllocations.length) return snapshot;
  const replaced = new Set(
    snapshot.groupAllocations.map((a) => a.fundingSettlementId),
  );
  const allocations: (
    | PaymentSnapshot["allocations"][number]
    | GroupAllocation
  )[] = [
    ...snapshot.allocations.filter((a) => !replaced.has(a.id)),
    ...snapshot.groupAllocations,
  ].sort((a, b) => a.id - b.id);
  const links: SettlementLink[] = [
    ...snapshot.links.filter((l) => !replaced.has(l.settlementId)),
    ...snapshot.groupAllocations.map((a) => ({
      ...linkTo(
        getRecord(ctx.db, a.expenseRecordId)!,
        a.amountMinor,
        a.id,
        a.createdAt,
      ),
      canUndo: true,
    })),
  ];
  return { ...snapshot, allocations, links };
}

export function preparePaymentCorrection(
  ctx: AppContext,
  paymentMovementId: number,
) {
  const denied = requirePermissions(ctx, ["records.read"]);
  if (denied) return denied;
  const target = correctionMovementFor(ctx.db, paymentMovementId);
  if (!target.ok) return fail("REFUSED", target.reason);
  const snapshot = paymentAllocationSnapshot(ctx, target.movementId);
  return snapshot
    ? ok(presented(ctx, snapshot))
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
  // Taking an expense out of a group posts dated entries, so a closed month
  // is a refusal rather than an error.
  return withClosingRefusal(() =>
    correctPaymentAllocationsOperation(ctx, input),
  );
}

function correctPaymentAllocationsOperation(
  ctx: AppContext,
  input: z.output<z.ZodObject<typeof correctionShape>>,
): AppResult<{
  undoneIds: number[];
  settlementIds: number[];
  version: string;
}> {
  const denied =
    requireAnyPermissions(ctx, [
      ["records.correctAllocations"],
      ["records.delete"],
    ]) ??
    requirePermissions(ctx, input.allocations.length ? ["records.create"] : []);
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
  const reason = input.reason.trim();
  const emits: DeferredEmits = [];
  try {
    const result = ctx.db.transaction(() => {
      const target = correctionMovementFor(ctx.db, input.paymentMovementId);
      if (!target.ok) throw new Rollback(fail("REFUSED", target.reason));
      const movementId = target.movementId;
      const before = paymentAllocationSnapshot(ctx, movementId);
      if (!before)
        throw new Rollback(fail("NOT_FOUND", "That payment no longer exists."));
      const stale = checkVersion(before.version, input.expectedVersion);
      if (stale) throw new Rollback(stale);
      const selected = new Set(input.removeSettlementIds);
      if (selected.size !== input.removeSettlementIds.length)
        throw new Rollback(
          fail(
            "REFUSED",
            "One of those allocations does not belong to this payment. Reload and review it.",
          ),
        );

      // Sort the selection: an expense inside a group (any of its item
      // settlements selects the whole expense), or an ordinary allocation.
      const plain: number[] = [];
      const groups = new Map<number, Map<number, GroupAllocation>>();
      for (const id of selected) {
        const row = before.groupAllocations.find((a) =>
          a.itemSettlementIds.includes(id),
        );
        if (row) {
          const expenses = groups.get(row.reimbursementGroupId) ?? new Map();
          expenses.set(row.expenseRecordId, row);
          groups.set(row.reimbursementGroupId, expenses);
        } else if (before.allocations.some((a) => a.id === id)) plain.push(id);
        else
          throw new Rollback(
            fail(
              "REFUSED",
              "One of those allocations does not belong to this payment. Reload and review it.",
            ),
          );
      }
      const fundingIds = new Set(
        [...groups.keys()].map(
          (groupId) =>
            before.groupAllocations.find(
              (a) => a.reimbursementGroupId === groupId,
            )!.fundingSettlementId,
        ),
      );
      if (plain.some((id) => fundingIds.has(id)))
        throw new Rollback(
          fail(
            "REFUSED",
            "Choose either the reimbursement's whole funding or individual expenses, not both.",
          ),
        );
      // A payment naming nobody undoes all its allocations together; that
      // would silently unfund a reimbursement group it pays for.
      if (
        before.batch &&
        plain.length &&
        before.allocations.some(
          (a) =>
            activeGroupOfRecipientMovement(ctx.db, a.owedMovementId) !== null,
        )
      )
        throw new Rollback(fail("REFUSED", NO_PAYEE_REASON));

      if (groups.size) {
        const extra = requirePermissions(ctx, ["records.create"]);
        if (extra) throw new Rollback(extra);
      }
      const whole = [...groups].filter(([groupId, expenses]) => {
        const state = inspectGroup(ctx.db, groupId)!;
        return state.items.every((item) => expenses.has(item.recordId));
      });
      if (whole.length) {
        const extra = requirePermissions(ctx, [
          "records.create",
          "records.delete",
        ]);
        if (extra) throw new Rollback(extra);
      }

      const undoneIds: number[] = [];
      const removedExpenses: { recordId: number; amountMinor: number }[] = [];
      for (const [groupId, expenses] of groups) {
        if (whole.some(([id]) => id === groupId)) {
          // Taking out every remaining expense is the whole reversal.
          const state = inspectGroup(ctx.db, groupId)!;
          const date = state.recipient?.date;
          if (!date)
            throw new Rollback(
              fail("REFUSED", "That reimbursement no longer exists."),
            );
          const closed = groupDateRefusal(ctx.db, date);
          if (closed) throw new Rollback(fail("REFUSED", closed));
          reverseReimbursementInTransaction(
            ctx,
            groupId,
            { date, reason },
            emits,
          );
          undoneIds.push(
            ...[...expenses.values()].flatMap((a) => a.itemSettlementIds),
          );
        } else {
          const removed = removeGroupExpenses(
            ctx.db,
            actor(ctx),
            { groupId, expenseRecordIds: [...expenses.keys()], reason },
            emits,
          );
          if (!removed.ok) throw new Rollback(fail("REFUSED", removed.reason));
          undoneIds.push(...removed.value.undoneSettlementIds);
        }
        for (const row of expenses.values())
          removedExpenses.push({
            recordId: row.expenseRecordId,
            amountMinor: row.amountMinor,
          });
      }

      for (const id of plain) {
        if (undoneIds.includes(id)) continue;
        const undone = undoSettlement(ctx.db, id, actor(ctx), emits, reason);
        if (!undone.ok) throw new Rollback(fail("REFUSED", undone.reason));
        undoneIds.push(...undone.value);
      }

      let settlementIds: number[] = [];
      if (input.allocations.length) {
        for (const allocation of input.allocations) {
          const active = ctx.db
            .select({ id: settlements.id })
            .from(settlements)
            .where(
              and(
                activeAllocation(),
                eq(settlements.paymentMovementId, movementId),
                eq(settlements.owedMovementId, allocation.owedMovementId),
              ),
            )
            .get();
          if (active)
            throw new Rollback(
              fail(
                "REFUSED",
                "This payment already covers part of that item. Remove that allocation as well and add the full amount again.",
              ),
            );
        }
        const added = createSettlements(
          ctx.db,
          actor(ctx),
          movementId,
          input.allocations,
          emits,
        );
        if (!added.ok) throw new Rollback(fail("REFUSED", added.reason));
        settlementIds = added.value;
      }
      const after = paymentAllocationSnapshot(ctx, movementId)!;
      recordAudit(ctx.db, {
        recordType: "record",
        recordId: before.record.id,
        userId: actor(ctx),
        action: "update",
        changes: [
          {
            field: "allocations",
            before: presented(ctx, before).allocations,
            after: presented(ctx, after).allocations,
          },
          {
            field: "correctionReason",
            before: null,
            after: reason,
          },
        ],
      });
      // The expense's own Activity says why it is no longer reimbursed.
      const paymentLabel = before.record.recordNumber ?? `#${before.record.id}`;
      for (const expense of removedExpenses)
        recordAudit(ctx.db, {
          recordType: "record",
          recordId: expense.recordId,
          userId: actor(ctx),
          action: "update",
          changes: [
            {
              field: "reimbursementRemoval",
              before: `Reimbursed by ${paymentLabel} (${money(expense.amountMinor)})`,
              after: "Taken out of that reimbursement",
            },
            { field: "correctionReason", before: null, after: reason },
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
