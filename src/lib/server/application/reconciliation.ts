import { withClosingRefusal } from "./closing-refusal.js";
import { z } from "zod";
import { DefaultAccountPurpose, StatementDirection } from "$lib/enums.js";
import { taxOverrideSchema } from "$lib/expense-tax.js";
import type { LeafPermission } from "$lib/permissions/catalog.js";
import {
  assertTransferAccounts,
  autoMatchMovements,
  linesToRecord,
  matchLinesToNewMovement,
  planTolerantMatches,
  ReconciliationError,
  replaceMovementAllocations,
  saveTolerantMatches,
  type LineToRecord,
  type TolerantSkipReason,
} from "../services/reconciliation.js";
import type { DeferredEmits } from "../services/ledger.js";
import { getLine, getMovementCandidate } from "../queries/reconciliation.js";
import { getRecord } from "../queries/ledger.js";
import { listOutstanding } from "../queries/settlements.js";
import { accountDefaultId } from "../services/account-defaults.js";
import { canonicalAccountId } from "../queries/accounts.js";
import { mainCurrencyCode } from "../currency/form.js";
import { fromMinor } from "../ledger/money.js";
import type { RecordView } from "../ledger/types.js";
import type { ReconciliationAllocation } from "../reconciliation/types.js";
import { runUnitOfWork } from "../unit-of-work.js";
import { actor, requirePermissions, type AppContext } from "./context.js";
import {
  fail,
  invalid,
  missing,
  ok,
  Rollback,
  type AppErrorCode,
  type AppFailure,
  type AppResult,
} from "./result.js";
import {
  allocationShape,
  createRecord,
  isoDate,
  positiveId,
  type CreateInput,
} from "./records.js";
import {
  inferPaymentDirection,
  PAYMENT_DIRECTIONS,
  settlesReceivable,
  type PaymentDirection,
  type PaymentDirectionFailure,
} from "./payment-direction.js";
import {
  checkVersion,
  movementMatchesVersion,
  recordVersion,
  statementLineVersion,
} from "./version.js";

/**
 * Reconciliation as authorized operations.
 *
 * The service already checks the `reconciliation` ability itself, from
 * `locals`, and refuses by throwing a `ReconciliationError` with a status.
 * This turns that into an `AppResult` and adds the version check; the rules —
 * a line matches only its own statement's account, never more than it holds,
 * and a transfer from a line also needs `records:add` — stay in the service,
 * where the REST routes get them too.
 *
 * Recording bank lines as a new record (`createRecordFromLines`) and tolerant
 * automatic matching (`autoMatchTolerant`) are compound writes, so each runs as
 * one transaction in a unit of work: inside a batch they join it, and alone
 * they still deliver no event and keep no audit row unless everything holds.
 * Neither ever changes a bank line: the lines are the bank's evidence, and only
 * records and matches are written.
 */

const STATUS_CODE: Record<number, AppErrorCode> = {
  400: "INVALID_INPUT",
  401: "FORBIDDEN",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "REFUSED",
};

/** A service's `ReconciliationError` as an `AppFailure`; null for anything else. */
function reconciliationFailure(error: unknown): AppFailure | null {
  if (!(error instanceof ReconciliationError)) return null;
  return fail(
    STATUS_CODE[error.status] ?? "REFUSED",
    // The bare "Forbidden" of a missing ability says nothing; a 403 that
    // explains itself (an account that needs Adjustments) is passed on.
    error.status === 401 ||
      (error.status === 403 && error.message === "Forbidden")
      ? "You do not have permission to do that."
      : error.message,
  );
}

function run<T>(write: () => T): AppResult<T> {
  try {
    return ok(write());
  } catch (error) {
    const failure = reconciliationFailure(error);
    if (failure) return failure;
    throw error;
  }
}

/** Carries a dry run's result out of the transaction it rolls back. */
class DryRun extends Error {
  constructor(public readonly result: unknown) {
    super("dry run");
  }
}

/**
 * Runs `write` as one transaction inside a unit of work, and answers what it
 * returned.
 *
 * The unit is what keeps a compound write all-or-nothing outside the database
 * too: `createRecord` announces its record as soon as its own savepoint is
 * released, and with no unit open that event would reach every tab even when
 * the match after it then refused. Inside the unit it waits for the outermost
 * commit and is dropped on any rollback. Inside a batch this joins the batch's
 * unit, and the transaction becomes one more savepoint.
 *
 * `write` refuses by throwing `Rollback` or a `ReconciliationError`, so all it
 * wrote rolls back with it. A dry run does every write, then rolls back and
 * answers what a save would have stored.
 */
function inUnitOfWork<T>(
  ctx: AppContext,
  dryRun: boolean | undefined,
  write: (emits: DeferredEmits) => T,
): AppResult<T> {
  const emits: DeferredEmits = [];
  try {
    return ok(
      runUnitOfWork(dryRun ? "dry_run" : "write", () => {
        const value = ctx.db.transaction(
          () => {
            const result = write(emits);
            if (dryRun) throw new DryRun(result);
            return result;
          },
          { behavior: "immediate" },
        );
        // Still inside the unit: delivered once its outermost commit lands.
        for (const emit of emits) emit();
        return value;
      }),
    );
  } catch (error) {
    if (error instanceof DryRun) return ok(error.result as T);
    if (error instanceof Rollback) return error.failure;
    const refused = reconciliationFailure(error);
    if (refused) return refused;
    throw error;
  }
}

export const allocationsShape = z
  .array(
    z.object({
      lineId: positiveId,
      /** Positive decimal, as on the statement line. */
      amount: z.number().positive(),
    }),
  )
  .max(200);

/** Replaces every bank line matched to one movement. An empty list clears them. */
export function setMovementMatches(
  ctx: AppContext,
  movementId: number,
  allocations: z.output<typeof allocationsShape>,
  expectedVersion?: string,
) {
  // Asked before anything is looked up, so a caller without the ability
  // cannot learn which ids exist. The service asks again.
  const refused = requirePermissions(ctx, ["reconciliation.match"]);
  if (refused) return refused;
  if (!getMovementCandidate(ctx.db, movementId))
    return missing("Reconciliation record not found");
  const stale = checkVersion(
    movementMatchesVersion(ctx.db, movementId),
    expectedVersion,
  );
  if (stale) return stale;
  return run(() => ({
    ...replaceMovementAllocations(ctx.db, ctx.locals, movementId, allocations),
    version: movementMatchesVersion(ctx.db, movementId),
  }));
}

/** Matches each untouched movement to the bank lines that fit it exactly; never overwrites a match. */
export function autoMatch(
  ctx: AppContext,
  movementIds: number[],
  statementId?: number,
) {
  return run(() =>
    autoMatchMovements(ctx.db, ctx.locals, movementIds, statementId),
  );
}

// ---------------------------------------------------------------------------
// A new record from bank lines
// ---------------------------------------------------------------------------

/** How many bank lines one record may stand for. */
export const MAX_LINES_PER_RECORD = 200;

export const recordFromLinesKinds = [
  "expense",
  "income",
  "transfer",
  "payment",
] as const;
export type RecordFromLinesKind = (typeof recordFromLinesKinds)[number];

// The direction rule lives in `payment-direction.ts`; these stay importable
// from here for the callers that already do.
export {
  PAYMENT_DIRECTIONS,
  type PaymentDirection,
  type PaymentDirectionFailure,
};

export const recordFromLinesShape = {
  /** Lines on one account's statements, all moving money the same way. */
  lineIds: z.array(positiveId).min(1).max(MAX_LINES_PER_RECORD),
  kind: z.enum(recordFromLinesKinds),
  /** Expense and income only, and required there: what the money was for. */
  categoryAccountId: positiveId.optional(),
  /** Transfer only, and required there: where the money went or came from. */
  otherAccountId: positiveId.optional(),
  /** Required for a payment (who was paid, or who paid); optional for expense and income. */
  contactId: positiveId.optional(),
  /** Default: the lines' own descriptions. */
  description: z.string().trim().max(500).optional(),
  /** Default: the earliest line's date. */
  date: isoDate.optional(),
  taxOverrides: z.array(taxOverrideSchema).optional(),
  /** Payment only: the open items it settles, as `createRecord`'s settlements. */
  allocations: z.array(allocationShape).max(200).optional(),
  /**
   * Payment only. Money in is `we-receive` or `refund-received`; money out is
   * `we-pay` or `refund-paid`. Absent: worked out from the allocations, the
   * settlement account, or where the contact's open balance sits
   * (`paymentRoute`), and refused when that cannot be told.
   */
  direction: z.enum(PAYMENT_DIRECTIONS).optional(),
  /**
   * Payment only: the control account it settles — the Receivable, Payable or
   * ReimbursementsPayable account. Absent: the one the direction implies.
   */
  settlementAccountId: positiveId.optional(),
};
export const recordFromLinesSchema = z.object(recordFromLinesShape).strict();
export type RecordFromLinesInput = z.input<typeof recordFromLinesSchema>;
type RecordFromLinesParsed = z.output<typeof recordFromLinesSchema>;

export type RecordFromLines = {
  /** The new record, read after its lines were matched to it. */
  record: RecordView;
  /** The record's version, for a later change. */
  version: string;
  /** The record's side on the statement's account, which the lines now cover. */
  movementId: number;
  /** The record's amount: what was still unmatched on the lines, in whole cents. Positive. */
  amountMinor: number;
  /** One per line, in the order the lines were given. */
  allocations: ReconciliationAllocation[];
  /** Each line's version once matched. */
  lineVersions: Record<number, string>;
};

/**
 * A record of any kind but a transfer made from statement lines and matched
 * to them: `reconciliation.create` to record from a statement,
 * `reconciliation.match` because every line is matched to the new record (as
 * matching a line to an existing record needs), and `records.create` for the
 * record itself. The MCP requirements table (`create_from_lines`) asks the
 * same.
 */
const FROM_LINES_PERMISSIONS: readonly LeafPermission[] = [
  "reconciliation.create",
  "reconciliation.match",
  "records.create",
];
/**
 * What the one-line transfer route has always asked, and so what a transfer
 * from lines asks: the catalog files it under `reconciliation.create` ("bank
 * statements, and transfers from their lines"), as v1 and REST always have.
 */
const TRANSFER_FROM_LINE_PERMISSIONS: readonly LeafPermission[] = [
  "reconciliation.create",
  "records.create",
];

/** Finishes "Give this statement an account before recording …". */
const RECORD_NAME: Record<RecordFromLinesKind, string> = {
  expense: "an expense",
  income: "income",
  transfer: "a transfer",
  payment: "a payment",
};

/** The description when neither the caller nor the lines give one. */
const KIND_LABEL: Record<RecordFromLinesKind, string> = {
  expense: "Expense",
  income: "Income",
  transfer: "Transfer",
  payment: "Payment",
};

/** What each kind needs, and what it would ignore, before anything is looked up. */
function fieldsRefusal(input: RecordFromLinesParsed): AppFailure | null {
  if (new Set(input.lineIds).size !== input.lineIds.length)
    return fail("INVALID_INPUT", "A statement line can only appear once.");
  const everyday = input.kind === "expense" || input.kind === "income";
  if (everyday && input.categoryAccountId === undefined)
    return fail(
      "INVALID_INPUT",
      input.kind === "expense"
        ? "An expense needs the category the money was spent on."
        : "Income needs the category it was earned under.",
    );
  if (!everyday && input.categoryAccountId !== undefined)
    return fail("INVALID_INPUT", "Only an expense or income takes a category.");
  if (input.kind === "transfer" && input.otherAccountId === undefined)
    return fail(
      "INVALID_INPUT",
      "A transfer needs the other account the money moved to or from.",
    );
  if (input.kind !== "transfer" && input.otherAccountId !== undefined)
    return fail("INVALID_INPUT", "Only a transfer takes another account.");
  if (input.kind === "payment" && input.contactId === undefined)
    return fail(
      "INVALID_INPUT",
      "A payment needs the contact who was paid, or who paid.",
    );
  if (input.kind === "transfer" && input.contactId !== undefined)
    return fail(
      "INVALID_INPUT",
      "A transfer moves money between your own accounts, so it names no contact.",
    );
  if (input.kind !== "payment" && (input.allocations?.length ?? 0) > 0)
    return fail("INVALID_INPUT", "Only a payment settles open items.");
  if (
    input.kind !== "payment" &&
    (input.direction !== undefined || input.settlementAccountId !== undefined)
  )
    return fail(
      "INVALID_INPUT",
      "Only a payment takes a direction or a settlement account.",
    );
  return null;
}

/**
 * What the kind asks of the lines once their account and direction are known.
 * A transfer keeps every rule the Transfer sheet has (`assertTransferAccounts`,
 * which throws); an expense and income are the everyday kinds, so each moves
 * money one way only.
 */
function kindRefusal(
  ctx: AppContext,
  input: RecordFromLinesParsed,
  statementAccountId: number,
  movesIn: boolean,
): AppFailure | null {
  if (input.kind === "transfer") {
    assertTransferAccounts(
      ctx.db,
      ctx.locals,
      statementAccountId,
      input.otherAccountId!,
    );
    return null;
  }
  if (input.kind === "expense" && movesIn)
    return fail(
      "REFUSED",
      "An expense is money out, and these lines are money in. Record them as income, a payment or a transfer instead.",
    );
  if (input.kind === "income" && !movesIn)
    return fail(
      "REFUSED",
      "Income is money in, and these lines are money out. Record them as an expense, a payment or a transfer instead.",
    );
  if (input.categoryAccountId === statementAccountId)
    return fail(
      "REFUSED",
      "The category cannot be the statement's own account. Choose what the money was for.",
    );
  return null;
}

/** The lines' own descriptions, each once, or the kind's name when they have none. */
function defaultDescription(
  lines: readonly LineToRecord[],
  kind: RecordFromLinesKind,
): string {
  const descriptions = new Set(
    lines.map(({ line }) => line.description.trim()).filter(Boolean),
  );
  return [...descriptions].join("; ").slice(0, 500) || KIND_LABEL[kind];
}

/**
 * The record these lines are, described by its kind, for `createRecord` to
 * build: the money side is always the statement's account, and the amount is
 * what is still unmatched on the lines, in the main currency at rate 1 — a bank
 * line has no other currency.
 */
function recordFor(
  ctx: AppContext,
  input: RecordFromLinesParsed,
  at: {
    accountId: number;
    movesIn: boolean;
    totalMinor: number;
    lines: readonly LineToRecord[];
    /** Payment only. */
    payment?: PaymentRoute;
  },
): CreateInput {
  const common = {
    date: input.date ?? at.lines.map(({ line }) => line.date).sort()[0],
    description: input.description || defaultDescription(at.lines, input.kind),
    amount: fromMinor(at.totalMinor),
    currency: mainCurrencyCode(ctx.db),
    exchangeRate: 1,
    ...(input.taxOverrides ? { taxOverrides: input.taxOverrides } : {}),
  };
  const contact =
    input.contactId === undefined ? {} : { contactId: input.contactId };
  switch (input.kind) {
    case "expense":
      return {
        ...common,
        ...contact,
        kind: "expense",
        categoryAccountId: input.categoryAccountId!,
        paidFromAccountId: at.accountId,
      };
    case "income":
      return {
        ...common,
        ...contact,
        kind: "income",
        categoryAccountId: input.categoryAccountId!,
        receivedIntoAccountId: at.accountId,
      };
    // Money into the statement's account came out of the other one, and the
    // other way round for money out: the lines' direction settles both sides.
    case "transfer":
      return {
        ...common,
        kind: "transfer",
        fromAccountId: at.movesIn ? input.otherAccountId! : at.accountId,
        toAccountId: at.movesIn ? at.accountId : input.otherAccountId!,
      };
    case "payment":
      return {
        ...common,
        kind: "payment",
        contactId: input.contactId!,
        paidFromAccountId: at.accountId,
        direction: at.payment!.direction,
        ...(at.payment!.settlementAccountId !== undefined
          ? { settlementAccountId: at.payment!.settlementAccountId }
          : {}),
        settlements: at.payment!.settlements,
      };
  }
}

/** Which way a payment from bank lines settles, and what it settles. */
type PaymentRoute = {
  direction: PaymentDirection;
  /** Set only when it is not the account the direction implies. */
  settlementAccountId?: number;
  settlements: { owedMovementId: number; amountMinor: number }[];
};

/**
 * Which way a payment made from bank lines settles, and what it settles. The
 * lines say whether the money came in or went out; `inferPaymentDirection`
 * says which control account it clears, from the caller's direction or
 * settlement account, the allocations, or where the contact's open balance
 * sits, and refuses with the choices when that cannot be told.
 *
 * A refund given no allocations is applied to the contact's overpayments on
 * that account, oldest first, up to the lines' amount.
 */
function paymentRoute(
  ctx: AppContext,
  input: RecordFromLinesParsed,
  movesIn: boolean,
  totalMinor: number,
): AppResult<PaymentRoute> | PaymentDirectionFailure {
  const allocations = input.allocations ?? [];
  const routed = inferPaymentDirection(ctx, {
    contactId: input.contactId!,
    moneyIn: movesIn,
    allocateTo: allocations,
    ...(input.direction !== undefined ? { direction: input.direction } : {}),
    ...(input.settlementAccountId !== undefined
      ? { settlementAccountId: input.settlementAccountId }
      : {}),
  });
  if (!routed.ok) return routed;
  const { direction, settlementAccountId } = routed.value;

  let settlements = allocations;
  if (
    settlements.length === 0 &&
    (direction === "refund-received" || direction === "refund-paid")
  )
    settlements = overpaymentsFor(ctx, {
      contactId: input.contactId!,
      accountId:
        settlementAccountId ??
        accountDefaultId(
          ctx.db,
          direction === "refund-paid"
            ? DefaultAccountPurpose.Receivable
            : DefaultAccountPurpose.Payable,
        ),
      receiving: settlesReceivable(direction),
      totalMinor,
    });
  return ok({
    direction,
    ...(settlementAccountId !== undefined ? { settlementAccountId } : {}),
    settlements,
  });
}

/**
 * A refund given no allocations: the contact's overpayments on the account,
 * oldest first, up to the refund. When they cover less than the refund,
 * `createRecord`'s own rule (a refund is applied in full) refuses it.
 */
function overpaymentsFor(
  ctx: AppContext,
  at: {
    contactId: number;
    accountId: number | null;
    receiving: boolean;
    totalMinor: number;
  },
): { owedMovementId: number; amountMinor: number }[] {
  if (at.accountId === null) return [];
  let left = at.totalMinor;
  const out: { owedMovementId: number; amountMinor: number }[] = [];
  for (const item of listOutstanding(ctx.db, {
    direction: at.receiving ? "owed-to-us" : "we-owe",
    accountId: at.accountId,
    contactId: at.contactId,
  }).items) {
    if (left <= 0) break;
    if (item.position !== "credit") continue;
    const amountMinor = Math.min(item.outstandingMinor, left);
    out.push({ owedMovementId: item.movementId, amountMinor });
    left -= amountMinor;
  }
  return out;
}

/**
 * Records bank lines as one new record of any everyday kind, and matches every
 * line to it, in one transaction.
 *
 * This is the answer to a line nothing in the books stands for yet — bank
 * interest, a service charge, a supplier paid straight from the bank, money
 * moved between two of the user's own accounts. The lines must all be on one
 * account's statements and move money the same way; the record's money side is
 * that account, and its amount is what is still unmatched on the lines, so a
 * line partly matched already contributes only its remainder. A line matched in
 * full is refused.
 *
 * - `expense` (money out) and `income` (money in) need `categoryAccountId`.
 * - `transfer` needs `otherAccountId`, under every rule of the Transfer sheet:
 *   into equity or a category needs the Adjustments ability.
 * - `payment` needs `contactId`; its `allocations` settle that contact's open
 *   items exactly as `createRecord` settles a payment's.
 *
 * The record is built by `createRecord`, so `entry-builder.ts` makes its sides
 * and every rule of an ordinary create applies, the Adjustments gate included.
 * The matches and their audit row are written in the same transaction; a
 * refusal anywhere leaves nothing behind, and no tab hears of it.
 *
 * Needs `reconciliation.create`, `reconciliation.match` and `records.create`;
 * a `transfer` needs only `reconciliation.create` and `records.create`, as the
 * one-line transfer route always has. The kind is read from the raw input, so
 * the permission is asked before anything is parsed or looked up; a kind that
 * is not a transfer, valid or not, asks the full set. `dryRun` does all of it,
 * then rolls back and answers what a save would have stored.
 */
export function createRecordFromLines(
  ctx: AppContext,
  input: RecordFromLinesInput,
  opts: { dryRun?: boolean } = {},
): AppResult<RecordFromLines> {
  const transfer =
    (input as { kind?: unknown } | null | undefined)?.kind === "transfer";
  return withClosingRefusal(() =>
    recordFromLines(ctx, input, {
      dryRun: opts.dryRun,
      permissions: transfer
        ? TRANSFER_FROM_LINE_PERMISSIONS
        : FROM_LINES_PERMISSIONS,
    }),
  );
}

function recordFromLines(
  ctx: AppContext,
  raw: RecordFromLinesInput,
  opts: {
    dryRun?: boolean;
    permissions: readonly LeafPermission[];
    /** The one-line transfer route's rule: a line with any match is refused. */
    untouchedOnly?: boolean;
  },
): AppResult<RecordFromLines> {
  // Asked before anything is looked up, so a caller without the ability
  // cannot learn which ids exist.
  const refused = requirePermissions(ctx, opts.permissions);
  if (refused) return refused;
  const parsed = recordFromLinesSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);
  const input = parsed.data;
  const unfit = fieldsRefusal(input);
  if (unfit) return unfit;
  const userId = actor(ctx);

  return inUnitOfWork(ctx, opts.dryRun, (emits) => {
    const { accountId, direction, lines } = linesToRecord(
      ctx.db,
      input.lineIds,
      RECORD_NAME[input.kind],
    );
    const movesIn = direction === StatementDirection.In;
    const wrongKind = kindRefusal(ctx, input, accountId, movesIn);
    if (wrongKind) throw new Rollback(wrongKind);
    for (const { line, matchCount, remainingMinor } of lines) {
      if (opts.untouchedOnly && matchCount > 0)
        throw new Rollback(
          fail(
            "REFUSED",
            "This transaction is already matched. Undo the match before recording it as a transfer.",
          ),
        );
      if (remainingMinor <= 0)
        throw new Rollback(
          fail(
            "REFUSED",
            `Statement line ${line.id} is already matched in full. Undo its match first, or leave the line out.`,
          ),
        );
    }

    const totalMinor = lines.reduce(
      (sum, { remainingMinor }) => sum + remainingMinor,
      0,
    );
    let payment: PaymentRoute | undefined;
    if (input.kind === "payment") {
      const routed = paymentRoute(ctx, input, movesIn, totalMinor);
      if (!routed.ok) throw new Rollback(routed);
      payment = routed.value;
    }
    const created = createRecord(
      ctx,
      recordFor(ctx, input, {
        accountId,
        movesIn,
        totalMinor,
        lines,
        payment,
      }),
    );
    if (!created.ok) throw new Rollback(created);

    // The side the lines will cover: exactly one, on their account, for
    // exactly their amount, the way they moved. Anything else would match the
    // lines to a figure they do not show.
    const recordId = created.value.record.id;
    const onAccount = created.value.record.movements.filter(
      (movement) => movement.accountId === accountId,
    );
    const movement = onAccount[0];
    if (
      onAccount.length !== 1 ||
      movement.amountMinor !== (movesIn ? totalMinor : -totalMinor)
    )
      throw new Rollback(
        fail(
          "REFUSED",
          `The ${KIND_LABEL[input.kind].toLowerCase()} was not built with one side on this statement's account for the lines' amount, so the lines cannot be matched to it. Nothing was saved.`,
        ),
      );

    const allocations = matchLinesToNewMovement(
      ctx.db,
      userId,
      { id: movement.id, recordId, amountMinor: movement.amountMinor },
      lines.map(({ line, remainingMinor }) => ({
        lineId: line.id,
        amountMinor: remainingMinor,
      })),
      emits,
    );
    return {
      record: getRecord(ctx.db, recordId) ?? created.value.record,
      version: recordVersion(ctx.db, recordId),
      movementId: movement.id,
      amountMinor: totalMinor,
      allocations,
      lineVersions: Object.fromEntries(
        lines.map(({ line }) => [
          line.id,
          statementLineVersion(ctx.db, line.id),
        ]),
      ),
    };
  });
}

/**
 * Records an unmatched line as a transfer between two of the user's own
 * accounts, and matches it, in one transaction (FR-023).
 *
 * The Transfer sheet's route: `createRecordFromLines` with one line and kind
 * `transfer`, keeping what this route always did — `reconciliation.create`
 * rather than `reconciliation.match`, the line's version, a refusal for a line
 * with any match at all, and the same answer.
 */
export function recordTransferFromLine(
  ctx: AppContext,
  lineId: number,
  input: { otherAccountId: number; description?: string },
  expectedVersion?: string,
) {
  return withClosingRefusal(() =>
    recordTransferFromLineOperation(ctx, lineId, input, expectedVersion),
  );
}

function recordTransferFromLineOperation(
  ctx: AppContext,
  lineId: number,
  input: { otherAccountId: number; description?: string },
  expectedVersion?: string,
) {
  // Asked before anything is looked up, so a caller without the ability
  // cannot learn which ids exist.
  const refused = requirePermissions(ctx, TRANSFER_FROM_LINE_PERMISSIONS);
  if (refused) return refused;
  if (!getLine(ctx.db, lineId)) return missing("Statement line not found");
  const stale = checkVersion(
    statementLineVersion(ctx.db, lineId),
    expectedVersion,
  );
  if (stale) return stale;
  const result = recordFromLines(
    ctx,
    {
      lineIds: [lineId],
      kind: "transfer",
      otherAccountId: input.otherAccountId,
      description: input.description,
    },
    { permissions: TRANSFER_FROM_LINE_PERMISSIONS, untouchedOnly: true },
  );
  if (!result.ok) return result;
  const { record, movementId, allocations } = result.value;
  return ok({
    record,
    movement: getMovementCandidate(ctx.db, movementId),
    allocation: allocations[0],
    recordVersion: recordVersion(ctx.db, record.id),
    lineVersion: statementLineVersion(ctx.db, lineId),
  });
}

// ---------------------------------------------------------------------------
// Tolerant automatic matching
// ---------------------------------------------------------------------------

/**
 * The widest date window `autoMatchTolerant` takes, in days. The MCP tool
 * offers 0–7: a wider window finds more pairs, and more of them wrong, because
 * a line whose own record is missing can then pair with a stranger's.
 */
export const TOLERANT_MATCH_MAX_DAYS = 31;

export const autoMatchTolerantShape = {
  accountId: positiveId,
  /** Only lines dated in `from`..`to` (inclusive) are matched. */
  from: isoDate.optional(),
  to: isoDate.optional(),
  /** How many days apart a line and its record may be. */
  maxDays: z.number().int().min(0).max(TOLERANT_MATCH_MAX_DAYS),
};
export const autoMatchTolerantSchema = z
  .object(autoMatchTolerantShape)
  .strict();
export type AutoMatchTolerantInput = z.input<typeof autoMatchTolerantSchema>;

export type TolerantMatchResult = {
  matched: {
    lineId: number;
    recordId: number;
    movementId: number;
    /** The movement's signed whole cents on the account: negative is money out. */
    amountMinor: number;
    /** How many days apart the line and the record are. */
    days: number;
  }[];
  skipped: { lineId: number; reason: TolerantSkipReason }[];
};

/**
 * Matches an account's unmatched bank lines one to one with its uncleared
 * records: the exact amount, the same direction, dates at most `maxDays`
 * apart, and unique both ways — the line fits exactly one movement, and that
 * movement fits no other line. Every other unmatched line in the period is
 * reported as skipped with its reason; nothing is ever matched by guessing,
 * and an existing match is never touched.
 *
 * Needs `reconciliation.match`. `dryRun` saves every match, then rolls back
 * and answers what a save would have matched.
 */
export function autoMatchTolerant(
  ctx: AppContext,
  input: AutoMatchTolerantInput,
  opts: { dryRun?: boolean } = {},
): AppResult<TolerantMatchResult> {
  return withClosingRefusal(() => autoMatchTolerantOperation(ctx, input, opts));
}

function autoMatchTolerantOperation(
  ctx: AppContext,
  raw: AutoMatchTolerantInput,
  opts: { dryRun?: boolean },
): AppResult<TolerantMatchResult> {
  const refused = requirePermissions(ctx, ["reconciliation.match"]);
  if (refused) return refused;
  const parsed = autoMatchTolerantSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);
  const input = parsed.data;
  if (input.from && input.to && input.from > input.to)
    return fail("INVALID_INPUT", "The period ends before it starts.");
  if (canonicalAccountId(ctx.db, input.accountId) === null)
    return missing("That account does not exist.");
  const userId = actor(ctx);

  return inUnitOfWork(ctx, opts.dryRun, (emits) => {
    const plan = planTolerantMatches(ctx.db, input);
    saveTolerantMatches(ctx.db, userId, plan.pairs, emits);
    return {
      matched: plan.pairs.map(({ line, movement, days }) => ({
        lineId: line.id,
        recordId: movement.recordId,
        movementId: movement.movementId,
        amountMinor: movement.amountMinor,
        days,
      })),
      skipped: plan.skipped,
    };
  });
}
