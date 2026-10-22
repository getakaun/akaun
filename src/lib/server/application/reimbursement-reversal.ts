import { activeAllocation } from "../queries/allocation-state.js";
import {
  reimbursementEntryDescription,
  originalReimbursementDescription,
} from "$lib/reimbursement-labels.js";
import { createHash } from "node:crypto";
import { and, eq, inArray, or } from "drizzle-orm";
import { z } from "zod";
import { DefaultAccountPurpose } from "$lib/enums.js";
import {
  reimbursementEntries,
  reimbursementItems,
  reimbursements,
  ledgerMovements,
  ledgerRecords,
  settlements,
} from "../db/schema.js";
import { getRecord } from "../queries/ledger.js";
import { getSide } from "../queries/settlements.js";
import { createRecord, type DeferredEmits } from "../services/ledger.js";
import { createSettlements, undoSettlement } from "../services/settlements.js";
import { requireAccountDefault } from "../services/account-defaults.js";
import { recordAudit } from "../audit.js";
import { actor, requirePermissions, type AppContext } from "./context.js";
import { isoDate, positiveId } from "./records.js";
import { checkVersion, recordVersion } from "./version.js";
import { fail, ok, Rollback } from "./result.js";
import type { Refusable } from "../ledger/types.js";

export const reimbursementReversalShape = {
  groupId: positiveId,
  date: isoDate,
  reason: z.string().trim().min(10).max(2000),
  expectedVersion: z.string().min(1),
};

export interface ReimbursementReversalSummary {
  amountMinor: number;
  items: { recordId: number; description: string; amountMinor: number }[];
  funding: {
    recordId: number;
    description: string;
    amountMinor: number;
    releasedMinor: number;
    availableCreditBeforeMinor: number;
    availableCreditAfterMinor: number;
  }[];
  unfundedMinor: number;
}

function must<T>(result: Refusable<T>) {
  if (!result.ok) throw new Rollback(fail("REFUSED", result.reason));
  return result.value;
}

function snapshot(ctx: AppContext, id: number) {
  const group = ctx.db
    .select()
    .from(reimbursements)
    .where(eq(reimbursements.id, id))
    .get();
  if (!group) return null;
  const entries = ctx.db
    .select()
    .from(reimbursementEntries)
    .where(eq(reimbursementEntries.groupId, id))
    .all();
  const records = entries.map((e) => ({
    ...e,
    record: getRecord(ctx.db, e.recordId)!,
  }));
  const movementIds = records.flatMap((e) =>
    e.record.movements.map((m) => m.id),
  );
  const allocations = movementIds.length
    ? ctx.db
        .select()
        .from(settlements)
        .where(
          and(
            activeAllocation(),
            or(
              inArray(settlements.paymentMovementId, movementIds),
              inArray(settlements.owedMovementId, movementIds),
            ),
          ),
        )
        .all()
    : [];
  const items = ctx.db
    .select({
      recordId: ledgerRecords.id,
      description: ledgerRecords.description,
      amountMinor: reimbursementItems.amountMinor,
    })
    .from(reimbursementItems)
    .innerJoin(
      ledgerMovements,
      eq(ledgerMovements.id, reimbursementItems.sourceMovementId),
    )
    .innerJoin(ledgerRecords, eq(ledgerRecords.id, ledgerMovements.recordId))
    .where(eq(reimbursementItems.groupId, id))
    .all();
  const recipient = records.find((entry) => entry.role === "recipient");
  const recipientMovementIds = new Set(
    recipient?.record.movements.map((m) => m.id) ?? [],
  );
  const fundingAllocations = allocations.filter((a) =>
    recipientMovementIds.has(a.owedMovementId),
  );
  const funding = new Map<
    number,
    ReimbursementReversalSummary["funding"][number]
  >();
  const fundingState: unknown[] = [];
  for (const allocation of fundingAllocations) {
    const movement = ctx.db
      .select()
      .from(ledgerMovements)
      .where(eq(ledgerMovements.id, allocation.paymentMovementId))
      .get();
    if (
      !movement ||
      ctx.db
        .select()
        .from(reimbursementEntries)
        .where(eq(reimbursementEntries.recordId, movement.recordId))
        .get()
    )
      continue;
    const record = getRecord(ctx.db, movement.recordId);
    const side = getSide(ctx.db, movement.id);
    if (!record || !side || side.amountMinor <= 0) continue;
    const beforeMinor = Math.max(0, side.amountMinor - side.settledMinor);
    const existing = funding.get(record.id);
    if (existing) {
      existing.releasedMinor += allocation.amountMinor;
      existing.availableCreditAfterMinor += allocation.amountMinor;
    } else {
      funding.set(record.id, {
        recordId: record.id,
        description: record.description,
        amountMinor: side.amountMinor,
        releasedMinor: allocation.amountMinor,
        availableCreditBeforeMinor: beforeMinor,
        availableCreditAfterMinor: beforeMinor + allocation.amountMinor,
      });
    }
    fundingState.push([recordVersion(ctx.db, record.id), side]);
  }
  const amountMinor = items.reduce((sum, item) => sum + item.amountMinor, 0);
  const summary: ReimbursementReversalSummary = {
    amountMinor,
    items,
    funding: [...funding.values()],
    unfundedMinor: Math.max(
      0,
      amountMinor -
        fundingAllocations.reduce(
          (sum, allocation) => sum + allocation.amountMinor,
          0,
        ),
    ),
  };
  const version = createHash("sha256")
    .update(JSON.stringify([group, records, allocations, items, fundingState]))
    .digest("hex")
    .slice(0, 16);
  return { group, entries: records, allocations, summary, version };
}
export function prepareReimbursementReversal(ctx: AppContext, id: number) {
  const denied = requirePermissions(ctx, ["records.read"]);
  if (denied) return denied;
  const preview = snapshot(ctx, id);
  return preview
    ? ok(preview)
    : fail("NOT_FOUND", "That reimbursement no longer exists.");
}

/** Reverse the complete transfer, preserving every real cash record and bank match. */
export function reverseReimbursement(
  ctx: AppContext,
  raw: z.output<z.ZodObject<typeof reimbursementReversalShape>>,
) {
  const denied = requirePermissions(ctx, ["records.create", "records.delete"]);
  if (denied) return denied;
  const parsed = z.object(reimbursementReversalShape).strict().safeParse(raw);
  if (!parsed.success)
    return fail(
      "INVALID_INPUT",
      "Provide the reversal date, a reason and the current review version.",
    );
  const input = parsed.data;
  const emits: DeferredEmits = [];
  try {
    const value = ctx.db.transaction(() => {
      const before = snapshot(ctx, input.groupId);
      if (!before)
        throw new Rollback(
          fail("NOT_FOUND", "That reimbursement no longer exists."),
        );
      const stale = checkVersion(before.version, input.expectedVersion);
      if (stale) throw new Rollback(stale);
      if (before.group.reversedAt)
        throw new Rollback(
          fail("REFUSED", "This reimbursement has already been reversed."),
        );
      const payable = must(
        requireAccountDefault(ctx.db, DefaultAccountPurpose.Payable),
      );
      for (const allocation of before.allocations) {
        must(
          undoSettlement(
            ctx.db,
            allocation.id,
            actor(ctx),
            emits,
            input.reason,
            true,
          ),
        );
      }
      const originalDescription = originalReimbursementDescription(
        before.entries.find((entry) => entry.role === "recipient")!.record
          .description,
      );
      const reversalIds: number[] = [];
      for (const entry of before.entries) {
        const owed = entry.record.movements.find(
          (m) => m.accountId === payable,
        )!;
        const clearing = entry.record.movements.find(
          (m) => m.accountId !== payable,
        )!;
        const reverse = must(
          createRecord(
            ctx.db,
            actor(ctx),
            {
              kind: "reimbursement-transfer",
              leg:
                entry.role === "supplier"
                  ? "supplier-reversal"
                  : "recipient-reversal",
              clearingAccountId: clearing.accountId,
              date: input.date,
              description: reimbursementEntryDescription(
                "recipient-reversal",
                originalDescription,
              ),
              amount: Math.abs(owed.amountMinor) / 100,
              currency: entry.record.currency,
              exchangeRate: 1,
              contactId: entry.record.contactId,
              reference: entry.record.reference,
              remark: input.reason,
            },
            emits,
          ),
        );
        ctx.db
          .insert(reimbursementEntries)
          .values({
            recordId: reverse.id,
            groupId: before.group.id,
            role:
              entry.role === "supplier"
                ? "supplier-reversal"
                : "recipient-reversal",
          })
          .run();
        const reverseOwed = reverse.movements.find(
          (m) => m.accountId === payable,
        )!;
        must(
          createSettlements(
            ctx.db,
            actor(ctx),
            owed.amountMinor > 0 ? owed.id : reverseOwed.id,
            [
              {
                owedMovementId: owed.amountMinor > 0 ? reverseOwed.id : owed.id,
                amountMinor: Math.abs(owed.amountMinor),
              },
            ],
            emits,
          ),
        );
        reversalIds.push(reverse.id);
      }
      ctx.db
        .update(reimbursements)
        .set({ reversedAt: new Date().toISOString() })
        .where(eq(reimbursements.id, input.groupId))
        .run();
      recordAudit(ctx.db, {
        recordType: "record",
        recordId: before.group.payableRecordId,
        userId: actor(ctx),
        action: "update",
        changes: [
          {
            field: "reimbursementReversal",
            before: before.group,
            after: { date: input.date, reversalIds },
          },
          { field: "correctionReason", before: null, after: input.reason },
        ],
      });
      return {
        groupId: input.groupId,
        reversalIds,
        paymentRecordId: before.group.paymentRecordId,
      };
    });
    emits.forEach((emit) => emit());
    return ok(value);
  } catch (error) {
    if (error instanceof Rollback) return error.failure;
    throw error;
  }
}
