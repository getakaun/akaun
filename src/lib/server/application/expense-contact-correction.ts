import { createHash } from "node:crypto";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import { z } from "zod";
import {
  AccountSubType,
  DefaultAccountPurpose,
  LedgerRecordKind,
} from "$lib/enums.js";
import {
  contacts,
  reimbursementEntries,
  reimbursementItems,
  reimbursements,
  settlements,
} from "../db/schema.js";
import { recordAudit } from "../audit.js";
import { activeAllocation } from "../queries/allocation-state.js";
import { getRecord, updateRecord as writeRecord } from "../queries/ledger.js";
import { getSide, recordIdsForSettlement } from "../queries/settlements.js";
import { accountDefaultId } from "../services/account-defaults.js";
import { emitRecordUpdate } from "../services/ledger.js";
import { actor, requirePermissions, type AppContext } from "./context.js";
import { fail, invalid, missing, ok } from "./result.js";
import { positiveId } from "./records.js";
import { checkVersion, recordVersion } from "./version.js";

export const expenseContactCorrectionSchema = z
  .object({
    field: z.enum(["supplier", "paidBy"]),
    contactId: positiveId,
    reason: z.string().trim().min(10).max(2000),
    expectedVersion: z.string().min(1),
  })
  .strict();

function snapshot(ctx: AppContext, id: number) {
  const denied = requirePermissions(ctx, [
    "records.read",
    "records.update",
    "records.correctContact",
  ]);
  if (denied) return denied;
  const record = getRecord(ctx.db, id);
  if (!record) return missing("That expense no longer exists.");
  if (
    record.kind !== LedgerRecordKind.Expense ||
    ctx.db
      .select()
      .from(reimbursementEntries)
      .where(eq(reimbursementEntries.recordId, id))
      .get()
  )
    return fail(
      "REFUSED",
      "Only original expense contacts can be corrected here.",
    );

  const payable = accountDefaultId(ctx.db, DefaultAccountPurpose.Payable);
  const reimbursementPayable = accountDefaultId(
    ctx.db,
    DefaultAccountPurpose.ReimbursementsPayable,
  );
  // Older personally paid expenses may predate expensePaymentSource. Inspect
  // the actual control account too; never infer ownership from paid status.
  const personal =
    record.expensePaymentSource === "personal" ||
    (reimbursementPayable !== null &&
      record.movements.some(
        (m) => m.accountId === reimbursementPayable && m.amountMinor < 0,
      ));
  const movementIds = record.movements.map((m) => m.id);
  const allocations = ctx.db
    .select()
    .from(settlements)
    .where(
      and(
        activeAllocation(),
        or(
          inArray(settlements.owedMovementId, movementIds),
          inArray(settlements.paymentMovementId, movementIds),
        ),
      ),
    )
    .orderBy(asc(settlements.id))
    .all();
  const relatedIds = [
    ...new Set(
      allocations.flatMap((a) =>
        recordIdsForSettlement(ctx.db, a.paymentMovementId, a.owedMovementId),
      ),
    ),
  ].sort((a, b) => a - b);
  const claims = ctx.db
    .select({ item: reimbursementItems, group: reimbursements })
    .from(reimbursementItems)
    .innerJoin(
      reimbursements,
      eq(reimbursements.id, reimbursementItems.groupId),
    )
    .where(inArray(reimbursementItems.sourceMovementId, movementIds))
    .orderBy(asc(reimbursementItems.id))
    .all();
  const generatedLinks = relatedIds.filter(
    (other) =>
      other !== id &&
      ctx.db
        .select()
        .from(reimbursementEntries)
        .where(eq(reimbursementEntries.recordId, other))
        .get(),
  );
  const ownerBlockedReason =
    claims.some((c) => !c.group.reversedAt) || generatedLinks.length
      ? "Reverse the linked reimbursement before changing who this expense is owed to. Its generated entries retain the original contact."
      : null;
  const fields = personal
    ? [
        {
          field: "supplier" as const,
          label: "Supplier",
          contactId: record.supplierContactId ?? null,
          blockedReason: null,
        },
        {
          field: "paidBy" as const,
          label: "Person who paid",
          contactId: record.contactId,
          blockedReason: ownerBlockedReason,
        },
      ]
    : [
        {
          field: "supplier" as const,
          label: "Supplier",
          contactId: record.contactId,
          blockedReason: ownerBlockedReason,
        },
      ];
  const version = createHash("sha256")
    .update(
      JSON.stringify([
        recordVersion(ctx.db, id),
        allocations,
        claims,
        generatedLinks,
        relatedIds.map((other) => recordVersion(ctx.db, other)),
        payable,
        reimbursementPayable,
      ]),
    )
    .digest("hex")
    .slice(0, 16);
  return ok({
    record,
    version,
    fields,
    personal,
    allocations,
    relatedIds,
    payableAccountId: payable,
    reimbursementAccountId: reimbursementPayable,
  });
}

export function prepareExpenseContactCorrection(ctx: AppContext, id: number) {
  const result = snapshot(ctx, id);
  if (!result.ok) return result;
  const { record, version, fields, personal } = result.value;
  return ok({ record, version, fields, personal });
}

/** A narrow contact-only write: movements, matches and allocation history survive. */
export function correctExpenseContact(
  ctx: AppContext,
  id: number,
  raw: unknown,
) {
  const denied = requirePermissions(ctx, [
    "records.read",
    "records.update",
    "records.correctContact",
  ]);
  if (denied) return denied;
  const parsed = expenseContactCorrectionSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);
  const input = parsed.data;
  const result = ctx.db.transaction(() => {
    const current = snapshot(ctx, id);
    if (!current.ok) return current;
    const before = current.value;
    const stale = checkVersion(before.version, input.expectedVersion);
    if (stale) return stale;
    const field = before.fields.find((f) => f.field === input.field);
    if (!field)
      return fail(
        "INVALID_INPUT",
        "This expense has no personal payer to correct.",
      );
    if (field.blockedReason) return fail("REFUSED", field.blockedReason);
    if (field.contactId === input.contactId)
      return fail(
        "INVALID_INPUT",
        "Choose a different contact for this correction.",
      );
    if (
      !ctx.db
        .select()
        .from(contacts)
        .where(eq(contacts.id, input.contactId))
        .get()
    )
      return fail("REFUSED", "Select an existing contact.");

    const changesOwner = input.field === "paidBy" || !before.personal;
    if (changesOwner) {
      // Validate every live relationship against its actual control account.
      // Accounts Payable explicitly permits payments across expense suppliers;
      // a personal payer correction must still agree with who was reimbursed.
      for (const allocation of before.allocations) {
        const owed = getSide(ctx.db, allocation.owedMovementId);
        const payment = getSide(ctx.db, allocation.paymentMovementId);
        if (!owed || !payment)
          return fail(
            "REFUSED",
            "A linked allocation is no longer available. Reload and review it.",
          );
        const ownsOwed = before.record.movements.some(
          (m) => m.id === allocation.owedMovementId,
        );
        const other = ownsOwed ? payment : owed;
        const crossSupplier =
          !before.personal &&
          ownsOwed &&
          owed.accountId === before.payableAccountId &&
          payment.amountMinor > 0;
        const compatible =
          other.accountId === (ownsOwed ? owed.accountId : payment.accountId) &&
          (other.contactId === input.contactId ||
            (ownsOwed && other.contactId === null) ||
            crossSupplier);
        if (!compatible)
          return fail(
            "REFUSED",
            `Reverse allocation #${allocation.id} before changing this contact. It belongs to a different person.`,
          );
      }
      // Unknown control accounts are not a safe supplier-label exception.
      if (
        before.record.movements.some(
          (m) =>
            m.accountSubType === AccountSubType.AccountsPayable &&
            m.amountMinor < 0 &&
            m.accountId !== before.payableAccountId &&
            m.accountId !== before.reimbursementAccountId,
        )
      )
        return fail(
          "REFUSED",
          "This expense uses an unsupported payable account. Resolve its payment links before correcting its contact.",
        );
    }
    const patch =
      input.field === "paidBy"
        ? { contactId: input.contactId }
        : before.personal
          ? { supplierContactId: input.contactId }
          : { contactId: input.contactId, supplierContactId: input.contactId };
    writeRecord(ctx.db, id, actor(ctx), patch);
    recordAudit(ctx.db, {
      recordType: "record",
      recordId: id,
      userId: actor(ctx),
      action: "update",
      changes: [
        ...Object.entries(patch)
          .filter(
            ([key, value]) =>
              before.record[key as keyof typeof patch] !== value,
          )
          .map(([field, after]) => ({
            field,
            before: before.record[field as keyof typeof patch] ?? null,
            after,
          })),
        { field: "contactCorrectionReason", before: null, after: input.reason },
      ],
    });
    return ok({
      record: getRecord(ctx.db, id)!,
      relatedIds: before.relatedIds,
    });
  });
  if (!result.ok) return result;
  // Contact labels appear on both ends of allocation links. Notify those pages too.
  for (const recordId of new Set([id, ...result.value.relatedIds]))
    emitRecordUpdate(ctx.db, recordId);
  return prepareExpenseContactCorrection(ctx, id);
}
