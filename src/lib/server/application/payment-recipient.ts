import { createHash } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { LedgerRecordKind, DefaultAccountPurpose } from "$lib/enums.js";
import {
  contacts,
  reimbursements,
  reimbursementEntries,
  settlements,
} from "../db/schema.js";
import { getRecord, updateRecord } from "../queries/ledger.js";
import { getSide, recordIdsForSettlement } from "../queries/settlements.js";
import { paymentAllocationSnapshot } from "./payment-corrections.js";
import { requireAccountDefault } from "../services/account-defaults.js";
import { createSettlements, undoSettlement } from "../services/settlements.js";
import { emitRecordUpdate, type DeferredEmits } from "../services/ledger.js";
import { recordAudit } from "../audit.js";
import { transferClaim } from "./reimbursements.js";
import { actor, requirePermissions, type AppContext } from "./context.js";
import { positiveId } from "./records.js";
import { checkVersion, recordVersion } from "./version.js";
import { fail, ok, Rollback } from "./result.js";

export const recipientCorrectionShape = {
  recordId: positiveId,
  contactId: positiveId,
  reason: z.string().trim().min(10).max(2000),
  expectedVersion: z.string().min(1),
};

function snapshot(ctx: AppContext, id: number) {
  const record = getRecord(ctx.db, id);
  const payable = requireAccountDefault(ctx.db, DefaultAccountPurpose.Payable);
  const reimbursementPayable = requireAccountDefault(
    ctx.db,
    DefaultAccountPurpose.ReimbursementsPayable,
  );
  const side = record?.movements.find(
    (m) =>
      ((payable.ok && m.accountId === payable.value) ||
        (reimbursementPayable.ok &&
          m.accountId === reimbursementPayable.value)) &&
      m.amountMinor > 0,
  );
  if (!record || record.kind !== LedgerRecordKind.Payment || !side) return null;
  const payment = paymentAllocationSnapshot(ctx, side.id)!;
  const groups = ctx.db
    .select()
    .from(reimbursements)
    .where(eq(reimbursements.paymentRecordId, id))
    .all()
    .filter((g) => !g.reversedAt);
  const groupRecordIds = groups.map((g) => g.payableRecordId);
  const ownOwedIds = groupRecordIds.flatMap((id) =>
    getRecord(ctx.db, id)!
      .movements.filter(
        (m) => payable.ok && m.accountId === payable.value && m.amountMinor < 0,
      )
      .map((m) => m.id),
  );
  const funding = ownOwedIds.length
    ? ctx.db
        .select()
        .from(settlements)
        .where(inArray(settlements.owedMovementId, ownOwedIds))
        .all()
    : [];
  const incoming = ctx.db
    .select()
    .from(settlements)
    .where(eq(settlements.owedMovementId, side.id))
    .all();
  const dependencies: {
    settlementId: number;
    recordId: number;
    reason: string;
  }[] = [];
  for (const a of payment.allocations) {
    const targetId = recordIdsForSettlement(
      ctx.db,
      a.owedMovementId,
      a.owedMovementId,
    )[0];
    const generated = ctx.db
      .select()
      .from(reimbursementEntries)
      .where(eq(reimbursementEntries.recordId, targetId))
      .get();
    if (generated && !groupRecordIds.includes(targetId))
      dependencies.push({
        settlementId: a.id,
        recordId: targetId,
        reason: "This credit funded another reimbursement.",
      });
  }
  for (const a of incoming)
    dependencies.push({
      settlementId: a.id,
      recordId: recordIdsForSettlement(
        ctx.db,
        a.paymentMovementId,
        a.paymentMovementId,
      )[0],
      reason: "This overpayment has been refunded or offset.",
    });
  for (const a of funding.filter((a) => a.paymentMovementId !== side.id))
    dependencies.push({
      settlementId: a.id,
      recordId: recordIdsForSettlement(
        ctx.db,
        a.paymentMovementId,
        a.paymentMovementId,
      )[0],
      reason: "Another payment or credit also funds this reimbursement.",
    });
  const version = createHash("sha256")
    .update(
      JSON.stringify([
        payment.version,
        groups,
        funding,
        incoming,
        groupRecordIds.map((id) => recordVersion(ctx.db, id)),
      ]),
    )
    .digest("hex")
    .slice(0, 16);
  return {
    record,
    payment,
    groups,
    dependencies,
    version,
    preserves: [
      "Bank movements and matches",
      "Payment amount, date, number and attachments",
      "Original expense suppliers",
    ],
  };
}

export function prepareRecipientCorrection(ctx: AppContext, recordId: number) {
  const denied = requirePermissions(ctx, ["records.read"]);
  if (denied) return denied;
  const data = snapshot(ctx, recordId);
  return data
    ? ok(data)
    : fail("NOT_FOUND", "Select an outgoing payment to correct its recipient.");
}

export function correctPaymentRecipient(
  ctx: AppContext,
  raw: z.output<z.ZodObject<typeof recipientCorrectionShape>>,
  deferredEmits?: DeferredEmits,
) {
  const denied = requirePermissions(ctx, [
    "records.create",
    "records.update",
    "records.delete",
  ]);
  if (denied) return denied;
  const parsed = z.object(recipientCorrectionShape).strict().safeParse(raw);
  if (!parsed.success)
    return fail(
      "INVALID_INPUT",
      "Select the recipient, provide the current version and explain the correction in 10 to 2000 characters.",
    );
  const input = parsed.data;
  const emits: DeferredEmits = [];
  try {
    const value = ctx.db.transaction(() => {
      const before = snapshot(ctx, input.recordId);
      if (!before)
        throw new Rollback(
          fail("NOT_FOUND", "That outgoing payment no longer exists."),
        );
      const stale = checkVersion(before.version, input.expectedVersion);
      if (stale) throw new Rollback(stale);
      if (before.dependencies.length)
        throw new Rollback(
          fail(
            "REFUSED",
            "Reverse these dependent allocations first: " +
              before.dependencies
                .map(
                  (d) =>
                    `settlement #${d.settlementId} on record #${d.recordId} (${d.reason})`,
                )
                .join("; "),
          ),
        );
      if (
        !ctx.db
          .select()
          .from(contacts)
          .where(eq(contacts.id, input.contactId))
          .get()
      )
        throw new Rollback(fail("REFUSED", "Select an existing recipient."));
      const ownPayableIds = before.groups.map((g) => g.payableRecordId);
      const accountsPayable = requireAccountDefault(
        ctx.db,
        DefaultAccountPurpose.Payable,
      );
      const cross = before.payment.allocations.filter((a) => {
        // Direct reimbursements retain supplier identity when the payee changes.
        if (
          !before.groups.length &&
          before.record.contactId !== null &&
          accountsPayable.ok &&
          before.payment.payment.accountId === accountsPayable.value
        )
          return false;
        const side = getSide(ctx.db, a.owedMovementId)!;
        const target = recordIdsForSettlement(
          ctx.db,
          a.owedMovementId,
          a.owedMovementId,
        )[0];
        return (
          side.contactId !== input.contactId && !ownPayableIds.includes(target)
        );
      });
      const reimbursementPayable = requireAccountDefault(
        ctx.db,
        DefaultAccountPurpose.ReimbursementsPayable,
      );
      if (
        cross.length &&
        reimbursementPayable.ok &&
        before.payment.payment.accountId === reimbursementPayable.value
      )
        throw new Rollback(
          fail(
            "REFUSED",
            "Remove this payment's expense allocations before changing its recipient. The original expenses remain owed to the person who paid personally.",
          ),
        );
      // A legacy contactless payment must be attributed before undoing individual
      // rows; otherwise its old batch reversal rule would remove unaffected rows.
      updateRecord(ctx.db, before.record.id, actor(ctx), {
        contactId: input.contactId,
      });
      for (const id of ownPayableIds) {
        const old = getRecord(ctx.db, id)!;
        updateRecord(ctx.db, id, actor(ctx), { contactId: input.contactId });
        recordAudit(ctx.db, {
          recordType: "record",
          recordId: id,
          userId: actor(ctx),
          action: "update",
          changes: [
            {
              field: "contactId",
              before: old.contactId,
              after: input.contactId,
            },
            { field: "correctionReason", before: null, after: input.reason },
          ],
        });
        emits.push(() => emitRecordUpdate(ctx.db, id));
      }
      for (const a of cross) {
        const undone = undoSettlement(
          ctx.db,
          a.id,
          actor(ctx),
          emits,
          input.reason,
        );
        if (!undone.ok) throw new Rollback(fail("REFUSED", undone.reason));
      }
      if (cross.length) {
        const claim = transferClaim(
          ctx,
          {
            contactId: input.contactId,
            date: before.record.date,
            description:
              before.record.description || "Reimbursement recipient correction",
            reference: before.record.reference,
            remark: input.reason,
            items: cross.map((a) => ({
              owedMovementId: a.owedMovementId,
              amountMinor: a.amountMinor,
            })),
          },
          emits,
          before.record.id,
        );
        const result = createSettlements(
          ctx.db,
          actor(ctx),
          before.payment.payment.movementId,
          [
            {
              owedMovementId: claim.owedMovementId,
              amountMinor: claim.totalMinor,
            },
          ],
          emits,
        );
        if (!result.ok) throw new Rollback(fail("REFUSED", result.reason));
      }
      recordAudit(ctx.db, {
        recordType: "record",
        recordId: before.record.id,
        userId: actor(ctx),
        action: "update",
        changes: [
          {
            field: "contactId",
            before: before.record.contactId,
            after: input.contactId,
          },
          { field: "correctionReason", before: null, after: input.reason },
          {
            field: "reimbursementAllocations",
            before: cross,
            after: snapshot(ctx, before.record.id)!.payment.allocations,
          },
        ],
      });
      emits.push(() => emitRecordUpdate(ctx.db, before.record.id));
      return snapshot(ctx, before.record.id)!;
    });
    if (deferredEmits) deferredEmits.push(...emits);
    else emits.forEach((emit) => emit());
    return ok(value);
  } catch (error) {
    if (error instanceof Rollback) return error.failure;
    throw error;
  }
}
