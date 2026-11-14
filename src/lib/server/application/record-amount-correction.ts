import { asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { DefaultAccountPurpose, LedgerRecordKind } from "$lib/enums.js";
import {
  bankStatementLines,
  bankStatements,
  ledgerMovements,
  reimbursementEntries,
} from "../db/schema.js";
import { diffRecords, recordAudit } from "../audit.js";
import { mainCurrencyCode } from "../currency/form.js";
import { isMoneyPotAccount } from "../ledger/account-type.js";
import { buildMovements } from "../ledger/entry-builder.js";
import { fromMinor, toMinor } from "../ledger/money.js";
import { money, outstandingOf } from "../ledger/settlement-rules.js";
import {
  everydayKindFor,
  type SidesAccount,
  type SidesContext,
} from "../ledger/sides-from-accounts.js";
import type {
  BuildInput,
  LedgerDb,
  MovementDraft,
  RecordView,
} from "../ledger/types.js";
import { accountRefs } from "../queries/accounts.js";
import { ALLOCATION_HISTORY_EDIT_REASON } from "../queries/allocation-state.js";
import { depreciationRecordReason } from "../queries/depreciation.js";
import { assetRecordDeletionReason } from "../queries/fixed-assets.js";
import {
  getRecord,
  getRecordRow,
  snapshotForAudit,
  updateRecord as writeRecord,
  wouldRemoveAllocationHistory,
} from "../queries/ledger.js";
import {
  listLineAllocations,
  replaceMovementAllocations,
} from "../queries/reconciliation.js";
import { activeGroupOfRecipientMovement } from "../queries/reimbursement-groups.js";
import { getSettlement, getSide } from "../queries/settlements.js";
import { VOIDED_RECORD_REASON } from "../queries/void-state.js";
import { reconciliationEvents } from "../reconciliation/events.js";
import { directionFor } from "../reconciliation/suggestions.js";
import { accountDefaultId } from "../services/account-defaults.js";
import { touchAccounts } from "../services/accounts.js";
import {
  emitRecordUpdate,
  inActiveReimbursementGroup,
  releaseBankMatchesInTransaction,
  voidReleasePlan,
  type DeferredEmits,
} from "../services/ledger.js";
import { createSettlements, undoSettlement } from "../services/settlements.js";
import { loadSidesContext } from "../services/sides-context.js";
import { withClosingRefusal } from "./closing-refusal.js";
import {
  actor,
  requireAnyPermissions,
  requirePermissions,
  type AppContext,
} from "./context.js";
import { positiveId } from "./records.js";
import {
  fail,
  invalid,
  missing,
  ok,
  Rollback,
  type AppFailure,
  type AppResult,
} from "./result.js";
import { checkVersion, recordVersion } from "./version.js";

/**
 * Correcting the amount of an expense or income a payment has already settled
 * (the freight case: a bill entered at 1,200.00 that was really 1,285.00).
 *
 * A settled record's amount is locked, because changing it would silently make
 * a settlement wrong (`ledger/locking.ts`). The correction does by hand what a
 * person would otherwise do in four steps, in one transaction so it is all or
 * nothing:
 *
 * 1. reverse every active allocation on the record's owed side — the rows are
 *    kept, with the reason, as Correct allocation keeps them;
 * 2. with `releaseBankMatches`, remove its bank matches;
 * 3. rebuild its sides at the new amount through `entry-builder.ts`, keeping
 *    the owed movement's id, so the reversed rows and the reapplied ones point
 *    at the same side;
 * 4. reapply the same payments, oldest first, each up to what it has free and
 *    what the record still owes; what a payment cannot apply any more stays as
 *    that payment's credit;
 * 5. rematch the released bank lines, up to what each still has free.
 *
 * Generalises `reimbursement-amount-correction.ts`, which corrects the payment
 * side the same way. No payment, bank movement or contact changes.
 */

const NOT_FOUND = "That record no longer exists.";
const NOT_SETTLED =
  "This record has no active payment allocations, so its amount is not locked by one. Change it with an ordinary update instead.";
const NOT_EVERYDAY_KIND =
  "Only a settled expense or income can have its amount corrected here.";
const NOT_EVERYDAY_SHAPE =
  "This record is not one ordinary purchase or sale: it needs exactly one side that holds or owes money and every other side a category. Correct its allocations, then change it on the record.";
const MIXED_DIRECTIONS =
  "This record has a line that runs the other way (a discount or credit line). Reverse its allocations with Correct allocation, then change it on the record.";
const PAYS_OTHERS =
  "This record is also the paying side of an allocation. Reverse those allocations with Correct allocation before correcting its amount.";
const BATCH_PAYMENT =
  "This record is settled by a payment that covers several contacts, which must stay fully allocated. Correct that payment's allocations first.";
const REIMBURSEMENT =
  "This record is part of a reimbursement. Correct the reimbursement instead.";
const MATCHED =
  "This record is matched to bank statement lines. Ask again with releaseBankMatches to unmatch them, correct the amount and rematch the same lines, or unmatch them first.";

export const settledAmountLineShape = z
  .object({
    /** The category (or equipment) account this line is for. */
    accountId: positiveId,
    /** Positive whole cents of the main currency, as a movement holds them. */
    amountMinor: z.number().int().safe().positive(),
    /** The line's own name. Absent keeps an existing line's name on the same account. */
    label: z.string().trim().max(200).nullable().optional(),
  })
  .strict();

export const settledAmountCorrectionSchema = z
  .object({
    recordId: positiveId,
    expectedVersion: z.string().min(1),
    /** The corrected figure in the record's currency, as `updateRecord` takes it. */
    amount: z.number().finite().positive().optional(),
    currency: z.string().trim().length(3).toUpperCase().optional(),
    exchangeRate: z.number().finite().positive().optional(),
    /**
     * The category split after the correction, adding up to the corrected
     * amount in main-currency cents. May be left out when the record has one
     * category line: that line takes the whole corrected amount.
     */
    lines: z.array(settledAmountLineShape).min(1).max(50).optional(),
    reason: z.string().trim().min(10).max(2000),
    /** Unmatch the record's bank lines first, and rematch them afterwards. */
    releaseBankMatches: z.boolean().optional(),
  })
  .strict();

export type SettledAmountCorrectionInput = z.input<
  typeof settledAmountCorrectionSchema
>;

/** The payment on the other side of an allocation. */
export type PaymentRef = {
  recordId: number;
  recordNumber: string | null;
  date: string;
  contactId: number | null;
  /** The payment's owed-account movement. Internal; MCP never shows it. */
  movementId: number;
};

export type BankLineRef = {
  lineId: number;
  statementId: number;
  date: string;
  /** The record movement the line is matched to. Internal. */
  movementId: number;
};

export type SettledAmountCorrectionPreview = {
  record: RecordView;
  /** `recordVersion` — the token `expectedVersion` is checked against. */
  version: string;
  amount: number;
  currency: string;
  exchangeRate: number;
  amountMinor: number;
  /** The side a payment settles: the payable or receivable movement. */
  moneySide: {
    movementId: number;
    accountId: number;
    amountMinor: number;
  } | null;
  /** The category split, as positive main-currency cents. */
  lines: {
    movementId: number;
    accountId: number;
    accountName: string;
    amountMinor: number;
    label: string | null;
  }[];
  /** Active allocations on the owed side, oldest first. */
  settlements: {
    settlementId: number;
    payment: PaymentRef;
    amountMinor: number;
    /** What the payment has free besides this allocation. */
    paymentUnallocatedMinor: number;
  }[];
  bankMatches: { line: BankLineRef; amountMinor: number }[];
  /** Why the correction cannot run now. Empty means it can. */
  blockers: string[];
};

export type SettledAmountCorrected = {
  record: RecordView;
  version: string;
  reversed: { payment: PaymentRef; amountMinor: number }[];
  reapplied: { payment: PaymentRef; amountMinor: number }[];
  leftoverCredit: { payment: PaymentRef; amountMinor: number }[];
  rematched?: { line: BankLineRef; amountMinor: number }[];
};

type Inspection = SettledAmountCorrectionPreview & {
  rows: {
    id: number;
    accountId: number;
    amountMinor: number;
    sortOrder: number;
    label: string | null;
  }[];
};

/** Everything the correction reads, and every reason it would refuse. */
function inspect(
  ctx: AppContext,
  id: number,
  releaseBankMatches: boolean,
): Inspection | null {
  const { db } = ctx;
  const record = getRecord(db, id);
  if (!record) return null;
  const blockers: string[] = [];
  const rows = db
    .select({
      id: ledgerMovements.id,
      accountId: ledgerMovements.accountId,
      amountMinor: ledgerMovements.amountMinor,
      sortOrder: ledgerMovements.sortOrder,
      label: ledgerMovements.label,
    })
    .from(ledgerMovements)
    .where(eq(ledgerMovements.recordId, id))
    .orderBy(asc(ledgerMovements.sortOrder), asc(ledgerMovements.id))
    .all();

  const everyday =
    record.kind === LedgerRecordKind.Expense ||
    record.kind === LedgerRecordKind.Income;
  if (!everyday) blockers.push(NOT_EVERYDAY_KIND);
  if (record.voidedByRecordId !== null || record.reversesRecordId !== null)
    blockers.push(VOIDED_RECORD_REASON);
  const depreciation = depreciationRecordReason(db, id);
  if (depreciation) blockers.push(depreciation);
  if (
    db
      .select({ id: reimbursementEntries.recordId })
      .from(reimbursementEntries)
      .where(eq(reimbursementEntries.recordId, id))
      .get() ||
    inActiveReimbursementGroup(db, id)
  )
    blockers.push(REIMBURSEMENT);
  if (assetRecordDeletionReason(db, id))
    blockers.push(
      "The fixed asset register uses this record as purchase evidence. Correct the asset before its source record.",
    );
  if (record.periodClosedThrough)
    blockers.push(
      `This record is in a closed month (closed through ${record.periodClosedThrough}). A person must reopen the month in Akaun before it can be corrected.`,
    );

  // Which side a payment settles, and which sides say what it was for.
  let moneySide: Inspection["moneySide"] = null;
  const lines: Inspection["lines"] = [];
  const sides = loadSidesContext(db, false);
  if (!sides.ok) blockers.push(sides.reason);
  else if (everyday) {
    const accounts = rows.map((r) => sides.value.accountById(r.accountId));
    const holdsMoney = (account: SidesAccount | null) =>
      !!account &&
      (isMoneyPotAccount(account) || isOwedAccount(account.id, sides.value));
    const moneyRows = rows.filter((_, i) => holdsMoney(accounts[i]));
    if (
      moneyRows.length !== 1 ||
      accounts.some((a) => !a) ||
      everydayKindFor(accounts as SidesAccount[], sides.value) !== record.kind
    )
      blockers.push(NOT_EVERYDAY_SHAPE);
    else {
      const sign = record.kind === LedgerRecordKind.Expense ? -1 : 1;
      const moneyRow = moneyRows[0];
      moneySide = {
        movementId: moneyRow.id,
        accountId: moneyRow.accountId,
        amountMinor: moneyRow.amountMinor,
      };
      if (
        Math.sign(moneyRow.amountMinor) !== sign ||
        rows.some((r) => r !== moneyRow && Math.sign(r.amountMinor) !== -sign)
      )
        blockers.push(MIXED_DIRECTIONS);
      for (const row of rows) {
        if (row === moneyRow) continue;
        lines.push({
          movementId: row.id,
          accountId: row.accountId,
          accountName:
            record.movements.find((m) => m.id === row.id)?.accountName ?? "",
          amountMinor: Math.abs(row.amountMinor),
          label: row.label,
        });
      }
    }
  }

  // The allocations on either side of it.
  const plan = voidReleasePlan(db, id);
  if (plan.allocations.some((a) => a.side === "payment"))
    blockers.push(PAYS_OTHERS);
  const owed = plan.allocations.filter((a) => a.side === "owed");
  if (!owed.length) blockers.push(NOT_SETTLED);
  if (moneySide && owed.some((a) => a.owedMovementId !== moneySide!.movementId))
    blockers.push(NOT_EVERYDAY_SHAPE);
  const settlements: Inspection["settlements"] = [];
  for (const allocation of owed) {
    const payment = paymentRef(db, allocation.paymentMovementId);
    const side = getSide(db, allocation.paymentMovementId);
    if (!payment || !side) {
      blockers.push(NOT_EVERYDAY_SHAPE);
      continue;
    }
    if (payment.contactId === null) blockers.push(BATCH_PAYMENT);
    if (
      db
        .select({ id: reimbursementEntries.recordId })
        .from(reimbursementEntries)
        .where(eq(reimbursementEntries.recordId, payment.recordId))
        .get() ||
      activeGroupOfRecipientMovement(db, allocation.paymentMovementId) !==
        null ||
      inActiveReimbursementGroup(db, payment.recordId)
    )
      blockers.push(REIMBURSEMENT);
    settlements.push({
      settlementId: allocation.settlementId,
      payment,
      amountMinor: allocation.amountMinor,
      paymentUnallocatedMinor: outstandingOf(side),
    });
  }

  const bankMatches: Inspection["bankMatches"] = [];
  const lineRows = plan.bankMatches.length
    ? db
        .select()
        .from(bankStatementLines)
        .where(
          inArray(
            bankStatementLines.id,
            plan.bankMatches.map((m) => m.lineId),
          ),
        )
        .all()
    : [];
  for (const match of plan.bankMatches) {
    const line = lineRows.find((l) => l.id === match.lineId)!;
    bankMatches.push({
      line: {
        lineId: line.id,
        statementId: line.statementId,
        date: line.date,
        movementId: match.movementId,
      },
      amountMinor: toMinor(match.amount, 1),
    });
  }
  if (bankMatches.length && !releaseBankMatches) blockers.push(MATCHED);

  return {
    record,
    version: recordVersion(db, id),
    amount: record.amount,
    currency: record.currency,
    exchangeRate: record.exchangeRate,
    amountMinor: record.amountMinor,
    moneySide,
    lines,
    settlements,
    bankMatches,
    blockers: [...new Set(blockers)],
    rows,
  };
}

function isOwedAccount(id: number, ctx: SidesContext): boolean {
  return (
    id === ctx.payableAccountId ||
    id === ctx.receivableAccountId ||
    id === ctx.reimbursementPayableAccountId
  );
}

/**
 * How much each payment is reapplied to the corrected record, once its old
 * allocations are undone. Payments go in payment-date order, then by id.
 *
 * 1. Each takes back up to what it had on this record before, while the record
 *    still owes.
 * 2. If the record still owes (its amount went up), the rest is spread over
 *    the payments' free credit, in the same order.
 *
 * So a lower amount gives back the later payments' share, and credit a payment
 * already had free is used only when the record grew. One figure per payment,
 * so each is reapplied as one allocation.
 */
function reapplyPlan(
  settlements: Inspection["settlements"],
  owedMinor: number,
  freeMinor: (payment: PaymentRef) => number,
): { payment: PaymentRef; previousMinor: number; amountMinor: number }[] {
  const byPayment = new Map<
    number,
    { payment: PaymentRef; previousMinor: number; amountMinor: number }
  >();
  for (const { payment, amountMinor } of settlements) {
    const entry = byPayment.get(payment.movementId);
    if (entry) entry.previousMinor += amountMinor;
    else
      byPayment.set(payment.movementId, {
        payment,
        previousMinor: amountMinor,
        amountMinor: 0,
      });
  }
  const plan = [...byPayment.values()].sort(
    (a, b) =>
      a.payment.date.localeCompare(b.payment.date) ||
      a.payment.recordId - b.payment.recordId ||
      a.payment.movementId - b.payment.movementId,
  );
  let owed = owedMinor;
  const free = new Map(plan.map((p) => [p, freeMinor(p.payment)]));
  for (const p of plan) {
    const take = Math.max(0, Math.min(p.previousMinor, free.get(p)!, owed));
    p.amountMinor += take;
    owed -= take;
  }
  for (const p of plan) {
    const take = Math.max(0, Math.min(free.get(p)! - p.amountMinor, owed));
    p.amountMinor += take;
    owed -= take;
  }
  return plan;
}

function paymentRef(db: LedgerDb, movementId: number): PaymentRef | null {
  const movement = db
    .select({ recordId: ledgerMovements.recordId })
    .from(ledgerMovements)
    .where(eq(ledgerMovements.id, movementId))
    .get();
  const row = movement ? getRecordRow(db, movement.recordId) : null;
  return row
    ? {
        recordId: row.id,
        recordNumber: row.recordNumber,
        date: row.date,
        contactId: row.contactId,
        movementId,
      }
    : null;
}

function basePermissions(ctx: AppContext): AppFailure | null {
  return (
    requirePermissions(ctx, ["records.update", "records.create"]) ??
    requireAnyPermissions(ctx, [
      ["records.correctAllocations"],
      ["records.delete"],
    ])
  );
}

/**
 * Read-only: what a correction of this record would start from, and why it
 * would be refused. Asks the same permissions the correction does, before
 * looking anything up.
 */
export function prepareSettledAmountCorrection(
  ctx: AppContext,
  recordId: number,
  opts: { releaseBankMatches?: boolean } = {},
): AppResult<SettledAmountCorrectionPreview> {
  const denied =
    requirePermissions(ctx, ["records.read"]) ?? basePermissions(ctx);
  if (denied) return denied;
  const state = inspect(ctx, recordId, opts.releaseBankMatches ?? false);
  if (!state) return missing(NOT_FOUND);
  const { rows: _rows, ...preview } = state;
  void _rows;
  return ok(preview);
}

/** Carries a dry run's result out of the transaction it rolls back. */
class DryRun extends Error {
  constructor(public result: SettledAmountCorrected) {
    super("dry run");
  }
}

/**
 * Corrects a settled expense's or income's amount, currency, rate or category
 * split. `dryRun` runs every step and rolls them all back, returning what a
 * real correction would have done.
 */
export function correctSettledAmount(
  ctx: AppContext,
  input: SettledAmountCorrectionInput,
  opts: { dryRun?: boolean } = {},
): AppResult<SettledAmountCorrected> {
  return withClosingRefusal(() => correctOperation(ctx, input, opts));
}

function correctOperation(
  ctx: AppContext,
  raw: SettledAmountCorrectionInput,
  opts: { dryRun?: boolean },
): AppResult<SettledAmountCorrected> {
  // Asked before anything is looked up, so a refusal reveals nothing.
  const denied = basePermissions(ctx);
  if (denied) return denied;
  const parsed = settledAmountCorrectionSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);
  const input = parsed.data;
  if (input.releaseBankMatches) {
    const deniedMatch = requirePermissions(ctx, ["reconciliation.match"]);
    if (deniedMatch) return deniedMatch;
  }
  const id = input.recordId;
  const reason = input.reason.trim();
  const release = input.releaseBankMatches ?? false;
  const userId = actor(ctx);
  const emits: DeferredEmits = [];
  try {
    const result = ctx.db.transaction(
      () => {
        const before = inspect(ctx, id, release);
        if (!before) throw new Rollback(missing(NOT_FOUND));
        const stale = checkVersion(before.version, input.expectedVersion);
        if (stale) throw new Rollback(stale);
        if (before.blockers.length)
          throw new Rollback(fail("REFUSED", before.blockers[0]));
        const moneySide = before.moneySide!;

        const target = targetFigures(ctx.db, before, input);
        if (!target.ok) throw new Rollback(target);
        const { amount, currency, exchangeRate, totalMinor, lines } =
          target.value;

        // 1. Reverse the active allocations; the rows stay, with the reason.
        const reversed: SettledAmountCorrected["reversed"] = [];
        for (const settlement of before.settlements) {
          if (!getSettlement(ctx.db, settlement.settlementId))
            throw new Rollback(
              fail(
                "CONFLICT",
                "An allocation on this record changed while it was being corrected. Read it again and retry.",
              ),
            );
          const undone = undoSettlement(
            ctx.db,
            settlement.settlementId,
            userId,
            emits,
            reason,
          );
          if (!undone.ok) throw new Rollback(fail("REFUSED", undone.reason));
          reversed.push({
            payment: settlement.payment,
            amountMinor: settlement.amountMinor,
          });
        }

        // 2. Unmatch the bank lines, when asked.
        const releasedMatches = release
          ? releaseBankMatchesInTransaction(ctx.db, id, userId, emits)
          : [];

        // 3. Rebuild the sides. The builder makes them; the owed movement
        //    keeps its slot, so its id — and every allocation row on it —
        //    survives.
        const sign = before.record.kind === LedgerRecordKind.Expense ? -1 : 1;
        const moneyRow = before.rows.find(
          (r) => r.id === moneySide.movementId,
        )!;
        const drafts = [
          {
            accountId: moneySide.accountId,
            amountMinor: sign * totalMinor,
            label: moneyRow.label,
          },
          ...lines.map((line) => ({
            accountId: line.accountId,
            amountMinor: -sign * line.amountMinor,
            label: line.label,
          })),
        ];
        const accountIds = drafts.map((d) => d.accountId);
        const built = buildMovements(
          {
            kind: "journal",
            movements: drafts,
            storedKind: before.record.kind,
            amountMinor: totalMinor,
            contactId: before.record.contactId,
          } as BuildInput,
          {
            accounts: accountRefs(ctx.db, accountIds),
            payableAccountId:
              accountDefaultId(ctx.db, DefaultAccountPurpose.Payable) ?? -1,
            receivableAccountId:
              accountDefaultId(ctx.db, DefaultAccountPurpose.Receivable) ?? -1,
            reimbursementPayableAccountId:
              accountDefaultId(
                ctx.db,
                DefaultAccountPurpose.ReimbursementsPayable,
              ) ?? undefined,
            openingBalancesAccountId:
              accountDefaultId(ctx.db, DefaultAccountPurpose.OpeningBalances) ??
              -1,
          },
        );
        if (!built.ok) throw new Rollback(fail("REFUSED", built.reason));
        const movements = keepSlots(built.value, before.rows, moneyRow.id);
        if (wouldRemoveAllocationHistory(ctx.db, id, movements))
          throw new Rollback(fail("REFUSED", ALLOCATION_HISTORY_EDIT_REASON));
        const auditBefore = snapshotForAudit(ctx.db, id);
        writeRecord(
          ctx.db,
          id,
          userId,
          {
            ...(amount !== before.amount ? { amount } : {}),
            ...(currency !== before.currency ? { currency } : {}),
            ...(exchangeRate !== before.exchangeRate ? { exchangeRate } : {}),
          },
          movements,
        );

        // 4. Reapply the same payments, oldest payment first: each takes
        //    back what it had on this record, up to what is owed now, and
        //    only then does an increase draw on the payments' free credit.
        //    Credit a payment had free before stays free, and no payment's
        //    allocation moves to another.
        const plan = reapplyPlan(
          before.settlements,
          outstandingOf(getSide(ctx.db, moneyRow.id)!),
          (payment) => outstandingOf(getSide(ctx.db, payment.movementId)!),
        );
        const reapplied: SettledAmountCorrected["reapplied"] = [];
        const leftoverCredit: SettledAmountCorrected["leftoverCredit"] = [];
        for (const { payment, previousMinor, amountMinor } of plan) {
          if (amountMinor > 0) {
            const added = createSettlements(
              ctx.db,
              userId,
              payment.movementId,
              [{ owedMovementId: moneyRow.id, amountMinor }],
              emits,
            );
            if (!added.ok) throw new Rollback(fail("REFUSED", added.reason));
            reapplied.push({ payment, amountMinor });
          }
          // Only what this correction freed; credit already free is not news.
          if (previousMinor > amountMinor)
            leftoverCredit.push({
              payment,
              amountMinor: previousMinor - amountMinor,
            });
        }

        // 5. Rematch what was released, up to what each line has free.
        const rematched = release
          ? rematch(ctx.db, id, userId, releasedMatches, before, emits)
          : undefined;

        const after = getRecord(ctx.db, id)!;
        recordAudit(ctx.db, {
          recordType: "record",
          recordId: id,
          userId,
          action: "update",
          changes: [
            ...diffRecords(auditBefore, snapshotForAudit(ctx.db, id)),
            {
              field: "allocations",
              before: before.settlements.map((s) => ({
                settlementId: s.settlementId,
                paymentRecordId: s.payment.recordId,
                amountMinor: s.amountMinor,
              })),
              after: reapplied.map((r) => ({
                paymentRecordId: r.payment.recordId,
                amountMinor: r.amountMinor,
              })),
            },
            ...(release
              ? [
                  {
                    field: "bankMatches",
                    before: releasedMatches,
                    after: (rematched ?? []).map((m) => ({
                      movementId: m.line.movementId,
                      lineId: m.line.lineId,
                      amount: fromMinor(m.amountMinor),
                    })),
                  },
                ]
              : []),
            {
              field: "settledAmountCorrectionReason",
              before: null,
              after: reason,
            },
          ],
          deferredEmits: emits,
        });
        const previousAccounts = before.rows.map((r) => r.accountId);
        emits.push(() => {
          emitRecordUpdate(ctx.db, id);
          // A category the record no longer uses needs its balance refreshed.
          touchAccounts(ctx.db, previousAccounts);
        });

        const result: SettledAmountCorrected = {
          record: after,
          version: recordVersion(ctx.db, id),
          reversed,
          reapplied,
          leftoverCredit,
          ...(rematched ? { rematched } : {}),
        };
        if (opts.dryRun) throw new DryRun(result);
        return result;
      },
      { behavior: "immediate" },
    );
    for (const emit of emits) emit();
    return ok(result);
  } catch (error) {
    if (error instanceof Rollback) return error.failure;
    if (error instanceof DryRun) return ok(error.result);
    throw error;
  }
}

/** The corrected figures, and the category split they must add up to. */
function targetFigures(
  db: LedgerDb,
  before: Inspection,
  input: z.output<typeof settledAmountCorrectionSchema>,
): AppResult<{
  amount: number;
  currency: string;
  exchangeRate: number;
  totalMinor: number;
  lines: { accountId: number; amountMinor: number; label: string | null }[];
}> {
  const main = mainCurrencyCode(db);
  const currency = input.currency ?? before.currency;
  const exchangeRate =
    input.exchangeRate ??
    (currency === main
      ? 1
      : currency === before.currency
        ? before.exchangeRate
        : undefined);
  if (exchangeRate === undefined)
    return fail(
      "INVALID_INPUT",
      `Give the exchange rate from ${currency} to ${main} for the corrected amount.`,
    );
  if (currency === main && exchangeRate !== 1)
    return fail(
      "INVALID_INPUT",
      `An amount in ${main}, the main currency, is always at rate 1.`,
    );
  const amount = input.amount ?? before.amount;
  const totalMinor = toMinor(amount, exchangeRate);
  if (!Number.isSafeInteger(totalMinor) || totalMinor <= 0)
    return fail(
      "INVALID_INPUT",
      "The corrected amount must be more than zero and small enough to store accurately.",
    );

  let lines: { accountId: number; amountMinor: number; label: string | null }[];
  if (input.lines) {
    const unused = [...before.lines];
    lines = input.lines.map((line) => {
      let label = line.label;
      if (label === undefined) {
        // Keep the name an existing line on the same account already has.
        const index = unused.findIndex((l) => l.accountId === line.accountId);
        label = index >= 0 ? unused.splice(index, 1)[0].label : null;
      }
      return {
        accountId: line.accountId,
        amountMinor: line.amountMinor,
        label,
      };
    });
  } else if (before.lines.length === 1) {
    lines = [{ ...before.lines[0], amountMinor: totalMinor }];
  } else if (totalMinor === before.amountMinor) {
    lines = before.lines.map((l) => ({
      accountId: l.accountId,
      amountMinor: l.amountMinor,
      label: l.label,
    }));
  } else
    return fail(
      "INVALID_INPUT",
      `This record is split over ${before.lines.length} categories. Give the lines of the corrected split; they must add up to ${money(totalMinor)}.`,
    );

  const sum = lines.reduce((total, line) => total + line.amountMinor, 0);
  if (sum !== totalMinor)
    return fail(
      "INVALID_INPUT",
      `The lines add up to ${money(sum)}, but the corrected amount is ${money(totalMinor)}. Make them equal.`,
    );

  // The record stays the everyday purchase or sale it was: its money side
  // and categories only. A category already on it may be retired; a new one
  // may not.
  const sides = loadSidesContext(db, false);
  if (!sides.ok) return fail("REFUSED", sides.reason);
  const existing = new Set(before.lines.map((l) => l.accountId));
  const named: SidesAccount[] = [];
  for (const accountId of [
    before.moneySide!.accountId,
    ...lines.map((l) => l.accountId),
  ]) {
    const account = sides.value.accountById(accountId);
    if (!account)
      return fail(
        "REFUSED",
        `Account ${accountId} is not one of your accounts.`,
      );
    if (account.archived && !existing.has(accountId))
      return fail(
        "REFUSED",
        "That account is no longer in use. Choose one that is still open.",
      );
    named.push(account);
  }
  if (everydayKindFor(named, sides.value) !== before.record.kind)
    return fail(
      "REFUSED",
      before.record.kind === LedgerRecordKind.Expense
        ? "Every line of a corrected expense must be a spending category or equipment."
        : "Every line of a corrected income must be an income category.",
    );

  const unchanged =
    totalMinor === before.amountMinor &&
    amount === before.amount &&
    currency === before.currency &&
    exchangeRate === before.exchangeRate &&
    lines.length === before.lines.length &&
    lines.every(
      (line, i) =>
        line.accountId === before.lines[i].accountId &&
        line.amountMinor === before.lines[i].amountMinor &&
        line.label === before.lines[i].label,
    );
  if (unchanged)
    return fail(
      "INVALID_INPUT",
      "Nothing would change. Give a different amount, currency, rate or split.",
    );
  return ok({ amount, currency, exchangeRate, totalMinor, lines });
}

/**
 * Gives each rebuilt side a slot, so `replaceMovements` updates rows in place
 * rather than replacing them. The owed side keeps its own slot, whatever order
 * the builder returned; a category line takes the slot of an existing line on
 * the same account, then any spare one, then a new one.
 */
function keepSlots(
  built: MovementDraft[],
  existing: Inspection["rows"],
  moneyMovementId: number,
): MovementDraft[] {
  const moneyRow = existing.find((r) => r.id === moneyMovementId)!;
  const spare = existing.filter((r) => r.id !== moneyMovementId);
  const taken = new Set<number>();
  let next = Math.max(...existing.map((r) => r.sortOrder)) + 1;
  const [moneyDraft, ...lineDrafts] = built;
  const slots = lineDrafts.map((draft) => {
    const same = spare.find(
      (r) => !taken.has(r.sortOrder) && r.accountId === draft.accountId,
    );
    if (!same) return null;
    taken.add(same.sortOrder);
    return same.sortOrder;
  });
  const out: MovementDraft[] = [
    { ...moneyDraft, sortOrder: moneyRow.sortOrder },
  ];
  lineDrafts.forEach((draft, i) => {
    let slot = slots[i];
    if (slot === null) {
      const free = spare.find((r) => !taken.has(r.sortOrder));
      if (free) {
        taken.add(free.sortOrder);
        slot = free.sortOrder;
      } else slot = next++;
    }
    out.push({ ...draft, sortOrder: slot });
  });
  return out.sort((a, b) => a.sortOrder - b.sortOrder);
}

/**
 * Matches each released movement to the same bank lines again, in the order
 * they were matched, each up to what the line has free and what the movement
 * still needs. A movement the rebuild removed, or one whose account or
 * direction no longer fits the line, is not rematched.
 */
function rematch(
  db: LedgerDb,
  recordId: number,
  userId: number,
  released: { movementId: number; lineId: number; amount: number }[],
  before: Inspection,
  emits: DeferredEmits,
): { line: BankLineRef; amountMinor: number }[] {
  const out: { line: BankLineRef; amountMinor: number }[] = [];
  const movementIds = [...new Set(released.map((m) => m.movementId))];
  for (const movementId of movementIds) {
    const movement = db
      .select({
        accountId: ledgerMovements.accountId,
        amountMinor: ledgerMovements.amountMinor,
      })
      .from(ledgerMovements)
      .where(eq(ledgerMovements.id, movementId))
      .get();
    if (!movement) continue;
    let needed = Math.abs(movement.amountMinor);
    const values: { lineId: number; amount: number }[] = [];
    const matched: { line: BankLineRef; amountMinor: number }[] = [];
    for (const match of released.filter((m) => m.movementId === movementId)) {
      const ref = before.bankMatches.find(
        (m) =>
          m.line.lineId === match.lineId && m.line.movementId === movementId,
      )?.line;
      const line = db
        .select()
        .from(bankStatementLines)
        .where(eq(bankStatementLines.id, match.lineId))
        .get();
      const statement = line
        ? db
            .select({ accountId: bankStatements.accountId })
            .from(bankStatements)
            .where(eq(bankStatements.id, line.statementId))
            .get()
        : undefined;
      // The rules a manual match keeps: the line's own account, the same
      // direction of money.
      if (
        !ref ||
        !line ||
        statement?.accountId !== movement.accountId ||
        line.direction !== directionFor(movement.amountMinor)
      )
        continue;
      const occupied = listLineAllocations(db, line.id)
        .filter((a) => a.movementId !== movementId)
        .reduce((sum, a) => sum + toMinor(a.amount, 1), 0);
      const free = toMinor(line.amount, 1) - occupied;
      // Up to what the line has free, not what it covered before: a larger
      // corrected figure is matched as far as the same lines reach.
      const amountMinor = Math.min(free, needed);
      if (amountMinor <= 0) continue;
      needed -= amountMinor;
      values.push({ lineId: line.id, amount: fromMinor(amountMinor) });
      matched.push({ line: ref, amountMinor });
    }
    if (!values.length) continue;
    const saved = replaceMovementAllocations(
      db,
      movementId,
      fromMinor(Math.abs(movement.amountMinor)),
      values,
      userId,
    );
    recordAudit(db, {
      recordType: "record",
      recordId,
      userId,
      action: "update",
      changes: [
        {
          field: `allocations:movement:${movementId}`,
          before: [],
          after: saved,
        },
      ],
      deferredEmits: emits,
    });
    const lineIds = values.map((v) => v.lineId);
    emits.push(() =>
      reconciliationEvents.emit("allocation-update", { movementId, lineIds }),
    );
    out.push(...matched);
  }
  return out;
}
