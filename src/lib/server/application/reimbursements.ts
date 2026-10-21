import { z } from "zod";
import { eq, inArray } from "drizzle-orm";
import {
  AccountType,
  AccountSubType,
  DefaultAccountPurpose,
  LedgerRecordKind,
} from "$lib/enums.js";
import {
  accounts,
  contacts,
  ledgerMovements,
  reimbursementEntries,
  reimbursementItems,
  reimbursements,
} from "../db/schema.js";
import { getRecord } from "../queries/ledger.js";
import {
  getSide,
  listOutstanding,
  recordIdsForSettlement,
} from "../queries/settlements.js";
import {
  createRecord as post,
  type DeferredEmits,
} from "../services/ledger.js";
import { createSettlements } from "../services/settlements.js";
import { createAccount } from "../services/accounts.js";
import { requireAccountDefault } from "../services/account-defaults.js";
import { getSetting, setSetting } from "../settings.js";
import { mainCurrencyCode } from "../currency/form.js";
import { isMoneyPotAccount } from "../ledger/account-type.js";
import { getAccount } from "../queries/accounts.js";
import { actor, requirePermissions, type AppContext } from "./context.js";
import { allocationShape, isoDate, positiveId } from "./records.js";
import { fail, ok, Rollback } from "./result.js";
import type {
  AllocationRequest,
  RecordView,
  Refusable,
} from "../ledger/types.js";

export const reimbursementShape = {
  contactId: positiveId,
  date: isoDate,
  description: z.string().trim().min(1).max(500),
  reference: z.string().trim().max(200).default(""),
  remark: z.string().trim().max(2000).default(""),
  personallyPaid: z.literal(true),
  items: z.array(allocationShape).min(1),
  cashMinor: z.number().int().nonnegative(),
  paidFromAccountId: positiveId.nullable().default(null),
  credits: z
    .array(
      z.object({
        paymentMovementId: positiveId,
        amountMinor: z.number().int().positive(),
      }),
    )
    .default([]),
};
export const reimbursementSchema = z.object(reimbursementShape).strict();
export type ReimbursementInput = z.output<typeof reimbursementSchema>;

function must<T>(result: Refusable<T>): T {
  if (!result.ok) throw new Rollback(fail("REFUSED", result.reason));
  return result.value;
}

/** Internal, fixed posting operation. All callers own a transaction and deferred emits. */
export function transferClaim(
  ctx: AppContext,
  input: Pick<
    ReimbursementInput,
    "contactId" | "date" | "description" | "reference" | "remark" | "items"
  >,
  emits: DeferredEmits,
  paymentRecordId: number | null = null,
) {
  if (
    !ctx.db
      .select()
      .from(contacts)
      .where(eq(contacts.id, input.contactId))
      .get()
  )
    throw new Rollback(
      fail("REFUSED", "Select an existing reimbursement recipient."),
    );
  if (
    !input.items.length ||
    new Set(input.items.map((i) => i.owedMovementId)).size !==
      input.items.length
  )
    throw new Rollback(fail("REFUSED", "Select each expense once."));
  const payable = must(
    requireAccountDefault(ctx.db, DefaultAccountPurpose.Payable),
  );
  const bySupplier = new Map<number, AllocationRequest[]>();
  let total = 0;
  for (const item of input.items) {
    const side = getSide(ctx.db, item.owedMovementId);
    const recordId = recordIdsForSettlement(
      ctx.db,
      item.owedMovementId,
      item.owedMovementId,
    )[0];
    const source = getRecord(ctx.db, recordId);
    if (
      !Number.isSafeInteger(item.amountMinor) ||
      item.amountMinor <= 0 ||
      !side ||
      !source ||
      source.kind !== LedgerRecordKind.Expense ||
      !side.contactId ||
      side.accountId !== payable ||
      side.amountMinor >= 0 ||
      item.amountMinor > -side.amountMinor - side.settledMinor
    )
      throw new Rollback(
        fail(
          "REFUSED",
          "An expense is no longer available for that claim amount. Reload and review it.",
        ),
      );
    const list = bySupplier.get(side.contactId) ?? [];
    list.push(item);
    bySupplier.set(side.contactId, list);
    total += item.amountMinor;
  }
  if (!Number.isSafeInteger(total))
    throw new Rollback(fail("REFUSED", "The claim amount is too large."));
  const key = "reimbursements.clearingAccountId";
  let clearingId = Number(getSetting(ctx.db, key));
  if (!clearingId) {
    const account = must(
      createAccount(
        ctx.db,
        actor(ctx),
        {
          name: "Reimbursement clearing",
          type: AccountType.Asset,
          subType: AccountSubType.Clearing,
        },
        emits,
      ),
    );
    clearingId = account.id;
    setSetting(ctx.db, key, String(clearingId));
  }
  const clearing = ctx.db
    .select()
    .from(accounts)
    .where(eq(accounts.id, clearingId))
    .get();
  if (
    !clearing ||
    clearing.archivedAt ||
    clearing.subType !== AccountSubType.Clearing
  )
    throw new Rollback(
      fail("REFUSED", "The reimbursement clearing account must be active."),
    );
  const common = {
    date: input.date,
    currency: mainCurrencyCode(ctx.db),
    exchangeRate: 1,
    description: input.description,
    reference: input.reference,
    remark: input.remark,
  };
  const recipient = must(
    post(
      ctx.db,
      actor(ctx),
      {
        ...common,
        kind: "reimbursement-transfer",
        leg: "recipient",
        clearingAccountId: clearingId,
        contactId: input.contactId,
        amount: total / 100,
      },
      emits,
    ),
  );
  const group = ctx.db
    .insert(reimbursements)
    .values({ payableRecordId: recipient.id, paymentRecordId })
    .returning()
    .get()!;
  ctx.db
    .insert(reimbursementEntries)
    .values({ recordId: recipient.id, groupId: group.id, role: "recipient" })
    .run();
  for (const [supplierId, items] of bySupplier) {
    const transfer = must(
      post(
        ctx.db,
        actor(ctx),
        {
          ...common,
          kind: "reimbursement-transfer",
          leg: "supplier",
          clearingAccountId: clearingId,
          contactId: supplierId,
          amount: items.reduce((n, i) => n + i.amountMinor, 0) / 100,
        },
        emits,
      ),
    );
    ctx.db
      .insert(reimbursementEntries)
      .values({ recordId: transfer.id, groupId: group.id, role: "supplier" })
      .run();
    const side = transfer.movements.find(
      (m) => m.accountId === payable && m.amountMinor > 0,
    )!;
    must(createSettlements(ctx.db, actor(ctx), side.id, items, emits));
    ctx.db
      .insert(reimbursementItems)
      .values(
        items.map((i) => ({
          groupId: group.id,
          sourceMovementId: i.owedMovementId,
          amountMinor: i.amountMinor,
        })),
      )
      .run();
  }
  // Verify the actual postings, rather than trusting the declared amounts.
  const entryIds = ctx.db
    .select()
    .from(reimbursementEntries)
    .where(eq(reimbursementEntries.groupId, group.id))
    .all()
    .map((e) => e.recordId);
  const clearingTotal = ctx.db
    .select()
    .from(ledgerMovements)
    .where(inArray(ledgerMovements.recordId, entryIds))
    .all()
    .filter((m) => m.accountId === clearingId)
    .reduce((n, m) => n + m.amountMinor, 0);
  if (clearingTotal !== 0)
    throw new Rollback(
      fail("REFUSED", "The reimbursement transfers do not balance."),
    );
  return {
    groupId: group.id,
    payable: recipient,
    owedMovementId: recipient.movements.find(
      (m) => m.accountId === payable && m.amountMinor < 0,
    )!.id,
    totalMinor: total,
  };
}

export function createReimbursement(ctx: AppContext, raw: ReimbursementInput) {
  const denied = requirePermissions(ctx, ["records.create"]);
  if (denied) return denied;
  const parsed = reimbursementSchema.safeParse(raw);
  if (!parsed.success)
    return fail(
      "INVALID_INPUT",
      parsed.error.issues.map((i) => i.message).join(" "),
    );
  const input = parsed.data;
  const emits: DeferredEmits = [];
  try {
    const value = ctx.db.transaction(() => {
      const creditTotal = input.credits.reduce((n, c) => n + c.amountMinor, 0);
      const total = input.items.reduce((n, i) => n + i.amountMinor, 0);
      if (
        !Number.isSafeInteger(creditTotal) ||
        creditTotal + input.cashMinor > total
      )
        throw new Rollback(
          fail("REFUSED", "Cash and credit cannot exceed the claim total."),
        );
      if (
        new Set(input.credits.map((c) => c.paymentMovementId)).size !==
        input.credits.length
      )
        throw new Rollback(fail("REFUSED", "Select each credit once."));
      if (input.cashMinor > 0) {
        const bank = input.paidFromAccountId
          ? getAccount(ctx.db, input.paidFromAccountId)
          : null;
        if (!bank || bank.archivedAt || !isMoneyPotAccount(bank))
          throw new Rollback(
            fail("REFUSED", "Choose an active payment account."),
          );
      }
      const claim = transferClaim(ctx, input, emits);
      const payable = must(
        requireAccountDefault(ctx.db, DefaultAccountPurpose.Payable),
      );
      const creditSettlementIds: number[] = [];
      for (const credit of input.credits) {
        const side = getSide(ctx.db, credit.paymentMovementId);
        if (
          !side ||
          side.contactId !== input.contactId ||
          side.accountId !== payable ||
          side.amountMinor <= 0
        )
          throw new Rollback(
            fail(
              "REFUSED",
              "Only this recipient's available credit can fund the claim.",
            ),
          );
        creditSettlementIds.push(
          ...must(
            createSettlements(
              ctx.db,
              actor(ctx),
              credit.paymentMovementId,
              [
                {
                  owedMovementId: claim.owedMovementId,
                  amountMinor: credit.amountMinor,
                },
              ],
              emits,
            ),
          ),
        );
      }
      let payment: RecordView | null = null;
      if (input.cashMinor > 0) {
        payment = must(
          post(
            ctx.db,
            actor(ctx),
            {
              kind: "payment",
              direction: "we-pay",
              contactId: input.contactId,
              date: input.date,
              description: input.description,
              reference: input.reference,
              remark: input.remark,
              currency: mainCurrencyCode(ctx.db),
              exchangeRate: 1,
              amount: input.cashMinor / 100,
              paidFromAccountId: input.paidFromAccountId!,
            },
            emits,
          ),
        );
        must(
          createSettlements(
            ctx.db,
            actor(ctx),
            payment.movements.find((m) => m.accountId === payable)!.id,
            [
              {
                owedMovementId: claim.owedMovementId,
                amountMinor: input.cashMinor,
              },
            ],
            emits,
          ),
        );
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
        creditSettlementIds,
        remainingMinor: total - creditTotal - input.cashMinor,
        record: getRecord(ctx.db, payment?.id ?? claim.payable.id)!,
      };
    });
    emits.forEach((emit) => emit());
    return ok(value);
  } catch (error) {
    if (error instanceof Rollback) return error.failure;
    throw error;
  }
}

export function reimbursementCandidates(ctx: AppContext, contactId: number) {
  const denied = requirePermissions(ctx, ["records.read"]);
  if (denied) return denied;
  if (!Number.isSafeInteger(contactId) || contactId <= 0)
    return fail("INVALID_INPUT", "Select a recipient.");
  const all = listOutstanding(ctx.db, { direction: "we-owe", openOnly: true });
  const items = all.items.filter((item) =>
    item.position === "credit"
      ? item.contactId === contactId
      : getRecord(ctx.db, item.recordId)?.kind === LedgerRecordKind.Expense,
  );
  return ok({ items });
}
