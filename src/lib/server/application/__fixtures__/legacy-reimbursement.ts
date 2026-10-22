/** Builds the pre-direct-payment model for legacy compatibility regression tests. */
import {
  transferClaim,
  reimbursementSchema,
  type ReimbursementInput,
} from "../reimbursements.js";
import { createRecord } from "../../services/ledger.js";
import { getRecord } from "../../queries/ledger.js";
import { getSide } from "../../queries/settlements.js";
import { createSettlements } from "../../services/settlements.js";
import { requireAccountDefault } from "../../services/account-defaults.js";
import { DefaultAccountPurpose } from "$lib/enums.js";
import { actor, type AppContext } from "../context.js";
import { fail, ok, Rollback } from "../result.js";
import type { Refusable } from "../../ledger/types.js";
const must = <T>(r: Refusable<T>): T => {
  if (!r.ok) throw new Rollback(fail("REFUSED", r.reason));
  return r.value;
};
export function createLegacyReimbursement(
  ctx: AppContext,
  raw: ReimbursementInput,
) {
  const input = reimbursementSchema.safeParse(raw);
  if (!input.success) return fail("INVALID_INPUT", "Invalid legacy fixture.");
  const data = input.data;
  const total = data.items.reduce((n, i) => n + i.amountMinor, 0);
  const credit = data.credits.reduce((n, c) => n + c.amountMinor, 0);
  if (credit + data.cashMinor > total)
    return fail("REFUSED", "Funding exceeds claim.");
  const emits: (() => void)[] = [];
  try {
    const result = ctx.db.transaction(() => {
      const payable = must(
        requireAccountDefault(ctx.db, DefaultAccountPurpose.Payable),
      );
      const claim = transferClaim(ctx, data, emits);
      for (const c of data.credits) {
        const side = getSide(ctx.db, c.paymentMovementId);
        if (
          !side ||
          side.contactId !== data.contactId ||
          side.accountId !== payable ||
          side.amountMinor <= 0
        )
          throw new Rollback(fail("REFUSED", "Wrong fixture credit owner."));
        must(
          createSettlements(
            ctx.db,
            actor(ctx),
            c.paymentMovementId,
            [
              {
                owedMovementId: claim.owedMovementId,
                amountMinor: c.amountMinor,
              },
            ],
            emits,
          ),
        );
      }
      const payment = data.cashMinor
        ? must(
            createRecord(
              ctx.db,
              actor(ctx),
              {
                kind: "payment",
                direction: "we-pay",
                date: data.date,
                description: data.description,
                reference: data.reference,
                remark: data.remark,
                amount: data.cashMinor / 100,
                currency: "MYR",
                exchangeRate: 1,
                contactId: data.contactId,
                paidFromAccountId: data.paidFromAccountId!,
              },
              emits,
            ),
          )
        : null;
      if (payment) {
        must(
          createSettlements(
            ctx.db,
            actor(ctx),
            payment.movements.find((m) => m.accountId === payable)!.id,
            [
              {
                owedMovementId: claim.owedMovementId,
                amountMinor: data.cashMinor,
              },
            ],
            emits,
          ),
        );
        // Mirrors the historical group's payment relationship, not a new production write path.
        ctx.db
          .update(reimbursements)
          .set({ paymentRecordId: payment.id })
          .where(eq(reimbursements.id, claim.groupId))
          .run();
      }
      return {
        ...claim,
        payable: getRecord(ctx.db, claim.payable.id)!,
        payment: payment ? getRecord(ctx.db, payment.id)! : null,
        remainingMinor: total - credit - data.cashMinor,
      };
    });
    for (const emit of emits) emit();
    return ok(result);
  } catch (error) {
    if (error instanceof Rollback) return error.failure;
    throw error;
  }
}
import { eq } from "drizzle-orm";
import { reimbursements } from "../../db/schema.js";
