import { createHash } from "node:crypto";
import { and, eq, inArray, or } from "drizzle-orm";
import { z } from "zod";
import { DefaultAccountPurpose, LedgerRecordKind } from "$lib/enums.js";
import {
  ledgerMovements,
  reimbursementEntries,
  reimbursements,
  settlements,
} from "../db/schema.js";
import { recordAudit } from "../audit.js";
import { mainCurrencyCode } from "../currency/form.js";
import { isMoneyPotAccount } from "../ledger/account-type.js";
import { buildMovements } from "../ledger/entry-builder.js";
import { fromMinor, toMinor } from "../ledger/money.js";
import { accountRefs, getAccount } from "../queries/accounts.js";
import { activeAllocation } from "../queries/allocation-state.js";
import { getRecord, updateRecord } from "../queries/ledger.js";
import { getSide } from "../queries/settlements.js";
import { accountDefaultId } from "../services/account-defaults.js";
import { emitRecordUpdate, type DeferredEmits } from "../services/ledger.js";
import { createSettlements, undoSettlement } from "../services/settlements.js";
import { actor, requirePermissions, type AppContext } from "./context.js";
import { fail, invalid, ok, Rollback } from "./result.js";
import { checkVersion, recordVersion } from "./version.js";

const minor = z.number().int().safe().nonnegative();
export const reimbursementAmountCorrectionSchema = z
  .object({
    amountMinor: minor.positive(),
    allocations: z.array(
      z
        .object({
          owedMovementId: z.number().int().safe().positive(),
          amountMinor: minor,
        })
        .strict(),
    ),
    reason: z.string().trim().min(10).max(2000),
    expectedVersion: z.string().min(1),
  })
  .strict();

function authorization(ctx: AppContext) {
  if (ctx.locals.credential || ctx.locals.oauth)
    return fail(
      "FORBIDDEN",
      "Reimbursement amount corrections require a signed-in browser session.",
    );
  return requirePermissions(ctx, [
    "records.read",
    "records.update",
    "records.correctReimbursementAmount",
  ]);
}

/** A fresh snapshot includes allocations on both sides and other payments on each expense. */
function snapshot(ctx: AppContext, id: number) {
  const record = getRecord(ctx.db, id);
  if (
    !record ||
    record.kind !== LedgerRecordKind.Payment ||
    record.contactId === null
  )
    return null;
  const payableId = accountDefaultId(ctx.db, DefaultAccountPurpose.Payable);
  const legacyId = accountDefaultId(
    ctx.db,
    DefaultAccountPurpose.ReimbursementsPayable,
  );
  const payment = record.movements.find(
    (m) =>
      m.amountMinor > 0 &&
      (m.accountId === payableId || m.accountId === legacyId),
  );
  if (!payment) return null;
  const outgoing = record.movements.find((m) => m.amountMinor < 0);
  const bank = outgoing ? getAccount(ctx.db, outgoing.accountId) : null;
  const rows = ctx.db
    .select()
    .from(settlements)
    .where(
      and(
        activeAllocation(),
        or(
          eq(settlements.paymentMovementId, payment.id),
          eq(settlements.owedMovementId, payment.id),
        ),
      ),
    )
    .all()
    .sort((a, b) => a.id - b.id);
  const allocations = rows.filter((a) => a.paymentMovementId === payment.id);
  const items = allocations.map((allocation) => {
    const movement = ctx.db
      .select()
      .from(ledgerMovements)
      .where(eq(ledgerMovements.id, allocation.owedMovementId))
      .get();
    const expense = movement ? getRecord(ctx.db, movement.recordId) : null;
    const side = getSide(ctx.db, allocation.owedMovementId);
    return { allocation, movement, expense, side };
  });
  const relatedIds = [
    id,
    ...items.flatMap((i) => (i.expense ? [i.expense.id] : [])),
  ];
  const entries = ctx.db
    .select()
    .from(reimbursementEntries)
    .where(inArray(reimbursementEntries.recordId, relatedIds))
    .all();
  const groups = ctx.db
    .select()
    .from(reimbursements)
    .where(
      or(
        eq(reimbursements.paymentRecordId, id),
        inArray(reimbursements.payableRecordId, relatedIds),
      ),
    )
    .all();
  let blockedReason: string | null = null;
  if (entries.length || groups.length || payment.accountId !== payableId)
    blockedReason =
      "This older reimbursement has linked payable or clearing entries. Use its existing correction flow.";
  else if (
    record.movements.length !== 2 ||
    !outgoing ||
    !bank ||
    !isMoneyPotAccount(bank) ||
    payment.amountMinor !== record.amountMinor ||
    outgoing.amountMinor !== -record.amountMinor ||
    record.currency !== mainCurrencyCode(ctx.db) ||
    record.exchangeRate !== 1 ||
    record.amountMinor <= 0
  )
    blockedReason =
      "Only direct reimbursement payments in the main currency with one payment account can be corrected here.";
  else if (rows.some((a) => a.owedMovementId === payment.id))
    blockedReason =
      "This reimbursement has a refund or offset. Reverse those allocations before correcting its amount.";
  else if (
    items.some(
      (i) =>
        !i.expense ||
        i.expense.kind !== LedgerRecordKind.Expense ||
        !i.side ||
        i.side.amountMinor >= 0 ||
        i.side.accountId !== payableId ||
        i.side.contactId === null,
    )
  )
    blockedReason =
      "This payment covers entries other than direct expenses. Use its existing allocation correction flow.";
  else if (record.reconciled)
    blockedReason =
      "Remove this payment's bank statement matches before correcting its amount.";

  const expenses = items.flatMap(({ allocation, expense, side }) =>
    expense && side
      ? [
          {
            recordId: expense.id,
            recordNumber: expense.recordNumber,
            description: expense.description,
            owedMovementId: allocation.owedMovementId,
            amountMinor: Math.abs(side.amountMinor),
            allocatedMinor: allocation.amountMinor,
            // Other payments remain untouched, including when a correction increases this one.
            otherPaidMinor: side.settledMinor - allocation.amountMinor,
            availableMinor:
              Math.abs(side.amountMinor) -
              side.settledMinor +
              allocation.amountMinor,
          },
        ]
      : [],
  );
  const expenseMovementIds = items.flatMap((i) =>
    i.movement ? [i.movement.id] : [],
  );
  const otherSettlements = expenseMovementIds.length
    ? ctx.db
        .select()
        .from(settlements)
        .where(
          and(
            activeAllocation(),
            or(
              inArray(settlements.owedMovementId, expenseMovementIds),
              inArray(settlements.paymentMovementId, expenseMovementIds),
            ),
          ),
        )
        .all()
        .sort((a, b) => a.id - b.id)
    : [];
  const version = createHash("sha256")
    .update(
      JSON.stringify([
        recordVersion(ctx.db, id),
        rows,
        otherSettlements,
        items.map((i) =>
          i.expense ? recordVersion(ctx.db, i.expense.id) : null,
        ),
        entries,
        groups,
        record.reconciled,
        payableId,
        legacyId,
        bank,
        mainCurrencyCode(ctx.db),
      ]),
    )
    .digest("hex")
    .slice(0, 16);
  return {
    record,
    payment,
    outgoing,
    allocations,
    expenses,
    blockedReason,
    version,
    availableCreditMinor:
      record.amountMinor -
      allocations.reduce((sum, a) => sum + a.amountMinor, 0),
  };
}

/** Loader metadata only; the operation repeats authorization and eligibility at confirmation. */
export function reimbursementAmountCorrectionAvailability(
  ctx: AppContext,
  id: number,
) {
  if (authorization(ctx)) return null;
  const state = snapshot(ctx, id);
  return state ? { blockedReason: state.blockedReason } : null;
}

export function prepareReimbursementAmountCorrection(
  ctx: AppContext,
  id: number,
) {
  const denied = authorization(ctx);
  if (denied) return denied;
  const state = snapshot(ctx, id);
  if (!state)
    return fail(
      "REFUSED",
      "Select a direct reimbursement payment to correct its amount.",
    );
  if (state.blockedReason) return fail("REFUSED", state.blockedReason);
  return ok(state);
}

export type ReimbursementAmountCorrectionSnapshot = NonNullable<
  ReturnType<typeof snapshot>
>;

export function correctReimbursementAmount(
  ctx: AppContext,
  id: number,
  raw: unknown,
) {
  const denied = authorization(ctx);
  if (denied) return denied;
  const parsed = reimbursementAmountCorrectionSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);
  const input = parsed.data;
  const emits: DeferredEmits = [];
  try {
    const result = ctx.db.transaction(() => {
      const deniedNow = authorization(ctx);
      if (deniedNow) throw new Rollback(deniedNow);
      const before = snapshot(ctx, id);
      if (!before)
        throw new Rollback(
          fail(
            "REFUSED",
            "Select a direct reimbursement payment to correct its amount.",
          ),
        );
      const stale = checkVersion(before.version, input.expectedVersion);
      if (stale) throw new Rollback(stale);
      if (before.blockedReason)
        throw new Rollback(fail("REFUSED", before.blockedReason));
      if (input.amountMinor === before.record.amountMinor)
        throw new Rollback(
          fail(
            "INVALID_INPUT",
            "Choose a different payment amount. Use allocation correction to change only what it covers.",
          ),
        );
      if (toMinor(fromMinor(input.amountMinor), 1) !== input.amountMinor)
        throw new Rollback(
          fail(
            "INVALID_INPUT",
            "The corrected amount is too large to store accurately.",
          ),
        );
      const amounts = new Map(
        input.allocations.map((a) => [a.owedMovementId, a.amountMinor]),
      );
      const total = input.allocations.reduce(
        (sum, a) => sum + a.amountMinor,
        0,
      );
      if (
        amounts.size !== input.allocations.length ||
        !Number.isSafeInteger(total) ||
        total > input.amountMinor ||
        input.allocations.some((a) => {
          const expense = before.expenses.find(
            (e) => e.owedMovementId === a.owedMovementId,
          );
          return !expense || a.amountMinor > expense.availableMinor;
        })
      )
        throw new Rollback(
          fail(
            "INVALID_INPUT",
            "Allocate only to the covered expenses, within their available balances and the corrected payment amount.",
          ),
        );

      const changed = before.allocations.filter(
        (a) => (amounts.get(a.owedMovementId) ?? 0) !== a.amountMinor,
      );
      for (const allocation of changed) {
        const undone = undoSettlement(
          ctx.db,
          allocation.id,
          actor(ctx),
          emits,
          input.reason,
        );
        if (!undone.ok) throw new Rollback(fail("REFUSED", undone.reason));
      }
      const built = buildMovements(
        {
          kind: "payment",
          direction: "we-pay",
          settlementAccountId: before.payment.accountId,
          paidFromAccountId: before.outgoing!.accountId,
          amountMinor: input.amountMinor,
          contactId: before.record.contactId,
        },
        {
          accounts: accountRefs(
            ctx.db,
            before.record.movements.map((m) => m.accountId),
          ),
          payableAccountId: before.payment.accountId,
          receivableAccountId:
            accountDefaultId(ctx.db, DefaultAccountPurpose.Receivable) ?? -1,
          openingBalancesAccountId:
            accountDefaultId(ctx.db, DefaultAccountPurpose.OpeningBalances) ??
            -1,
        },
      );
      if (!built.ok) throw new Rollback(fail("REFUSED", built.reason));
      const original = ctx.db
        .select()
        .from(ledgerMovements)
        .where(eq(ledgerMovements.recordId, id))
        .all();
      const movements = built.value.map((m) => {
        const old = original.find((o) => o.accountId === m.accountId)!;
        return { ...m, sortOrder: old.sortOrder, label: old.label };
      });
      updateRecord(
        ctx.db,
        id,
        actor(ctx),
        { amount: fromMinor(input.amountMinor) },
        movements,
      );
      const replacements = changed.flatMap((a) => {
        const amountMinor = amounts.get(a.owedMovementId) ?? 0;
        return amountMinor > 0
          ? [{ owedMovementId: a.owedMovementId, amountMinor }]
          : [];
      });
      if (replacements.length) {
        const added = createSettlements(
          ctx.db,
          actor(ctx),
          before.payment.id,
          replacements,
          emits,
        );
        if (!added.ok) throw new Rollback(fail("REFUSED", added.reason));
      }
      const after = snapshot(ctx, id)!;
      recordAudit(ctx.db, {
        recordType: "record",
        recordId: id,
        userId: actor(ctx),
        action: "update",
        changes: [
          {
            field: "amount",
            before: before.record.amount,
            after: after.record.amount,
          },
          {
            field: "movements",
            before: before.record.movements,
            after: after.record.movements,
          },
          {
            field: "allocations",
            before: before.allocations,
            after: after.allocations,
          },
          {
            field: "reimbursementBalances",
            before: {
              expenses: before.expenses,
              creditMinor: before.availableCreditMinor,
            },
            after: {
              expenses: before.expenses.map((e) => ({
                ...e,
                allocatedMinor: amounts.get(e.owedMovementId) ?? 0,
                outstandingMinor:
                  e.availableMinor - (amounts.get(e.owedMovementId) ?? 0),
              })),
              creditMinor: after.availableCreditMinor,
            },
          },
          {
            field: "reimbursementAmountCorrectionReason",
            before: null,
            after: input.reason,
          },
        ],
      });
      return { record: after.record, version: after.version };
    });
    emits.forEach((emit) => emit());
    emitRecordUpdate(ctx.db, id);
    return ok(result);
  } catch (error) {
    if (error instanceof Rollback) return error.failure;
    throw error;
  }
}
