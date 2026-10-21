import { createHash } from "node:crypto";
import {
  prepareRecipientCorrection,
  correctPaymentRecipient,
} from "./payment-recipient.js";
import { getSetting, setSetting } from "../settings.js";
import { requirePermissions, type AppContext } from "./context.js";
import { fail, ok, Rollback } from "./result.js";
import type { DeferredEmits } from "../services/ledger.js";

export type RecipientRepairManifest = {
  recipientId: number;
  payments: { recordId: number; expectedVersion: string }[];
};

/** Explicit operator operation; never run at startup or exposed through a route. */
export function repairPaymentRecipients(
  ctx: AppContext,
  manifest: RecipientRepairManifest,
  deferredEmits?: DeferredEmits,
) {
  const denied = requirePermissions(ctx, [
    "records.read",
    "records.create",
    "records.update",
    "records.delete",
  ]);
  if (denied) return denied;
  if (
    !manifest.payments.length ||
    new Set(manifest.payments.map((p) => p.recordId)).size !==
      manifest.payments.length
  )
    return fail(
      "INVALID_INPUT",
      "Provide a nonempty, unique allowlist with preview versions.",
    );
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(manifest))
    .digest("hex");
  const key = `reimbursements.recipientRepair.${fingerprint}`;
  if (getSetting(ctx.db, key))
    return ok({ alreadyApplied: true, correctedIds: [] as number[] });
  const emits: DeferredEmits = [];
  try {
    const result = ctx.db.transaction(() => {
      // Validate the entire snapshot before changing any records.
      for (const row of manifest.payments) {
        const preview = prepareRecipientCorrection(ctx, row.recordId);
        if (!preview.ok) throw new Rollback(preview);
        if (preview.value.version !== row.expectedVersion)
          throw new Rollback(
            fail(
              "CONFLICT",
              `Payment #${row.recordId} changed since approval. Rebuild and review the manifest.`,
            ),
          );
        if (preview.value.dependencies.length)
          throw new Rollback(
            fail(
              "REFUSED",
              `Payment #${row.recordId} has dependent credits or refunds. Review these first.`,
            ),
          );
      }
      const correctedIds: number[] = [];
      for (const row of manifest.payments) {
        // Earlier corrections can change the shared snapshot. Re-read inside
        // the same locked transaction after validating all initial versions.
        const preview = prepareRecipientCorrection(ctx, row.recordId);
        if (!preview.ok) throw new Rollback(preview);
        const corrected = correctPaymentRecipient(
          ctx,
          {
            recordId: row.recordId,
            contactId: manifest.recipientId,
            expectedVersion: preview.value.version,
            reason:
              "Approved one-time reimbursement recipient repair; preserve original expense suppliers and bank transactions.",
          },
          emits,
        );
        if (!corrected.ok) throw new Rollback(corrected);
        correctedIds.push(row.recordId);
      }
      setSetting(ctx.db, key, new Date().toISOString());
      return { alreadyApplied: false, correctedIds };
    });
    if (deferredEmits) deferredEmits.push(...emits);
    else emits.forEach((emit) => emit());
    return ok(result);
  } catch (error) {
    if (error instanceof Rollback) return error.failure;
    throw error;
  }
}
