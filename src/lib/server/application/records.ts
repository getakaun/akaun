import { z } from "zod";
import { DefaultAccountPurpose } from "$lib/enums.js";
import { hasPermission } from "../permissions.js";
import { isValidDate } from "../date.js";
import { getRecord } from "../queries/ledger.js";
import { getAccount } from "../queries/accounts.js";
import {
  needsAdjustments,
  sidesFromAccounts,
  type SidesContext,
} from "../ledger/sides-from-accounts.js";
import { toMinor } from "../ledger/money.js";
import { isMoneyPotAccount } from "../ledger/account-type.js";
import { isReadOnlyKind } from "../ledger/record-permissions.js";
import {
  createRecord as createRecordService,
  patchRecord,
  removeRecord,
  type DeferredEmits,
} from "../services/ledger.js";
import { createSettlements, undoSettlement } from "../services/settlements.js";
import { requireAccountDefault } from "../services/account-defaults.js";
import { mainCurrencyCode } from "../currency/form.js";
import { setUserPreference, USER_PREF_KEYS } from "../userPreferences.js";
import { LedgerRecordKind } from "$lib/enums.js";
import type {
  LedgerDb,
  RecordCreate,
  RecordPatch,
  RecordView,
} from "../ledger/types.js";
import { actor, requirePermissions, type AppContext } from "./context.js";
import {
  fail,
  fromRefusable,
  missing,
  ok,
  Rollback,
  type AppFailure,
  type AppResult,
} from "./result.js";
import { checkVersion, recordVersion } from "./version.js";

/**
 * Records, as one set of authorized operations.
 *
 * `POST/PATCH/DELETE /api/records`, `/api/settlements` and the MCP record
 * tools all call these, so a rule — a permission, the adjustments gate, the
 * read-only invoice posting — is written once and asked the same way whichever
 * door a write came through. The services underneath stay the only place a
 * movement is built (`entry-builder.ts`) and a record is stored.
 */

export const positiveId = z.number().int().positive();
export const isoDate = z.string().refine(isValidDate, {
  message: "The date must be in YYYY-MM-DD form.",
});

const sideShape = z.object({
  accountId: positiveId,
  amountMinor: z.number().int(),
  /** This line's own name. Absent or null falls back to the record's description. */
  label: z.string().trim().max(200).nullable().optional(),
});

/** What every record states about itself, whichever kind it is. */
export const recordFieldsShape = {
  date: isoDate,
  description: z.string().trim().max(500).default(""),
  amount: z.number().finite(),
  currency: z.string().trim().length(3).toUpperCase(),
  exchangeRate: z.number().positive().default(1),
  reference: z.string().trim().max(200).optional(),
  remark: z.string().trim().max(2000).optional(),
  contactId: positiveId.nullable().optional(),
};

/**
 * What the one form sends: two accounts and no kind. The kind is derived from
 * them (D-01), and the adjustments gate is applied after the derivation,
 * because whether a record needs it is a fact about the accounts it names
 * (FR-031c).
 */
export const createFromSidesShape = {
  ...recordFieldsShape,
  fromAccountId: positiveId,
  toAccountId: positiveId,
  /** Third and later sides. Requires `adjustments` unless they are all categories. */
  extraSides: z.array(sideShape).optional(),
  /** The named category's own typed amount, alongside `extraSides`. */
  categoryAmountMinor: z.number().int().positive().optional(),
  /** The named category's own name, alongside `extraSides`. */
  categoryLabel: z.string().trim().max(200).nullable().optional(),
};
export const createFromSidesSchema = z.object(createFromSidesShape);

export const allocationShape = z.object({
  owedMovementId: positiveId,
  amountMinor: z.number().int().positive(),
});

/**
 * A payment that settles what is owed. Null `contactId` names no single
 * contact — a batch payment whose settlements carry that attribution instead
 * (FR-008); `entry-builder.ts`'s `validate()` refuses one with no settlements.
 */
export const paymentShape = {
  ...recordFieldsShape,
  paidFromAccountId: positiveId,
  contactId: positiveId.nullable(),
  direction: z.enum(["we-pay", "we-receive"]),
  settlements: z.array(allocationShape).default([]),
};

export const patchShape = {
  date: isoDate.optional(),
  description: z.string().trim().max(500).optional(),
  amount: z.number().finite().optional(),
  currency: z.string().trim().length(3).toUpperCase().optional(),
  exchangeRate: z.number().positive().optional(),
  reference: z.string().trim().max(200).optional(),
  remark: z.string().trim().max(2000).optional(),
  contactId: positiveId.nullable().optional(),
  categoryAccountId: positiveId.optional(),
  paidFromAccountId: positiveId.nullable().optional(),
  receivedIntoAccountId: positiveId.optional(),
  fromAccountId: positiveId.optional(),
  toAccountId: positiveId.optional(),
  extraSides: z.array(sideShape).optional(),
  categoryAmountMinor: z.number().int().positive().optional(),
  categoryLabel: z.string().trim().max(200).nullable().optional(),
};
export const patchSchema = z.object(patchShape).strict();

export type CreateFromSides = z.output<typeof createFromSidesSchema>;
export type CreateInput = RecordCreate | CreateFromSides;

export type RecordWritten = { record: RecordView; version: string };

const NOT_FOUND = "That record no longer exists.";

/** The three saved accounts every derivation needs, and the account lookup. */
function sidesContext(
  db: LedgerDb,
  canAdjust: boolean,
): AppResult<SidesContext> {
  const receivable = requireAccountDefault(
    db,
    DefaultAccountPurpose.Receivable,
  );
  if (!receivable.ok) return fail("REFUSED", receivable.reason);
  const payable = requireAccountDefault(db, DefaultAccountPurpose.Payable);
  if (!payable.ok) return fail("REFUSED", payable.reason);
  const opening = requireAccountDefault(
    db,
    DefaultAccountPurpose.OpeningBalances,
  );
  if (!opening.ok) return fail("REFUSED", opening.reason);
  return ok({
    accountById: (id) => {
      const account = getAccount(db, id);
      return account
        ? {
            id: account.id,
            type: account.type,
            role: account.role,
            subType: account.subType,
            archived: account.archivedAt !== null,
          }
        : null;
    },
    canAdjust,
    receivableAccountId: receivable.value,
    payableAccountId: payable.value,
    openingBalancesAccountId: opening.value,
  });
}

const NEEDS_ADJUSTMENTS =
  "These accounts need the Adjustments ability. Ask an administrator for it, or choose an everyday account on each side.";
const ARCHIVED =
  "That account is no longer in use. Choose one that is still open.";

/**
 * The adjustments gate for a record described by its kind rather than by two
 * accounts: an explicit-kind create, or a patch that names one account at a
 * time. `entry-builder.ts` checks only that the accounts exist and the sides
 * cancel, so without this an "expense" paid from Owner's Equity, or a
 * "payment" out of a revenue category, passed on `records:add` alone while the
 * same accounts sent through the form needed `adjustments` (FR-031c).
 *
 * The test is the form's: one side that holds or owes money and every other
 * side a category (`needsAdjustments`) for an expense or income; for a
 * transfer, what `sidesFromAccounts` derives from its two accounts; for a
 * payment, that it is paid from somewhere money sits.
 */
function gateByKind(
  context: SidesContext,
  shape:
    | { kind: "everyday"; accountIds: number[] }
    | {
        kind: "transfer";
        fromAccountId: number;
        toAccountId: number;
        contactId: number | null;
      }
    | { kind: "payment"; paidFromAccountId: number },
  newlyNamed: number[],
): AppFailure | null {
  for (const id of newlyNamed) {
    const account = context.accountById(id);
    if (!account)
      return fail("REFUSED", `Account ${id} is not one of your accounts.`);
    if (account.archived) return fail("REFUSED", ARCHIVED);
  }
  if (context.canAdjust) return null;
  switch (shape.kind) {
    case "everyday":
      return needsAdjustments(shape.accountIds, context)
        ? fail("FORBIDDEN", NEEDS_ADJUSTMENTS)
        : null;
    case "transfer": {
      const derived = sidesFromAccounts(
        {
          fromAccountId: shape.fromAccountId,
          toAccountId: shape.toAccountId,
          amountMinor: 0,
          contactId: shape.contactId,
        },
        context,
      );
      return derived.ok ? null : fail("FORBIDDEN", derived.reason);
    }
    case "payment": {
      const account = context.accountById(shape.paidFromAccountId);
      return account && isMoneyPotAccount(account)
        ? null
        : fail("FORBIDDEN", NEEDS_ADJUSTMENTS);
    }
  }
}

/** Turns a body with or without a `kind` into the shape the builder takes. */
function resolveCreate(
  ctx: AppContext,
  input: CreateInput,
): AppResult<RecordCreate> {
  if ("kind" in input) {
    // A journal names its own sides, so it is the one shape that is always an
    // adjustment. It used to pass on `records:add` alone when sent with an
    // explicit kind, while the same sides sent through the form were gated.
    if (
      input.kind === "journal" &&
      !hasPermission(ctx.locals, "adjustments", "add")
    ) {
      return fail(
        "FORBIDDEN",
        "A journal entry needs the Adjustments ability. Ask an administrator for it.",
      );
    }
    // Never through this door: the opening balance is set on its account, and
    // an invoice posting exists only by issuing its invoice (FR-013).
    if (input.kind === "opening-balance" || input.kind === "invoice-issue") {
      return fail("REFUSED", "That kind of record cannot be created here.");
    }
    if (input.kind !== "journal") {
      const context = sidesContext(
        ctx.db,
        hasPermission(ctx.locals, "adjustments", "add"),
      );
      if (!context.ok) return context;
      const gate =
        input.kind === "expense"
          ? gateByKind(
              context.value,
              {
                kind: "everyday",
                accountIds: [
                  input.paidFromAccountId ?? context.value.payableAccountId,
                  input.categoryAccountId,
                ],
              },
              [input.paidFromAccountId, input.categoryAccountId].filter(
                (id): id is number => id !== null,
              ),
            )
          : input.kind === "income"
            ? gateByKind(
                context.value,
                {
                  kind: "everyday",
                  accountIds: [
                    input.receivedIntoAccountId,
                    input.categoryAccountId,
                  ],
                },
                [input.receivedIntoAccountId, input.categoryAccountId],
              )
            : input.kind === "transfer"
              ? gateByKind(
                  context.value,
                  {
                    kind: "transfer",
                    fromAccountId: input.fromAccountId,
                    toAccountId: input.toAccountId,
                    contactId: input.contactId ?? null,
                  },
                  [input.fromAccountId, input.toAccountId],
                )
              : gateByKind(
                  context.value,
                  {
                    kind: "payment",
                    paidFromAccountId: input.paidFromAccountId,
                  },
                  [input.paidFromAccountId],
                );
      if (gate) return gate;
    }
    return ok(input);
  }

  const context = sidesContext(
    ctx.db,
    hasPermission(ctx.locals, "adjustments", "add"),
  );
  if (!context.ok) return context;
  const sides = sidesFromAccounts(
    {
      fromAccountId: input.fromAccountId,
      toAccountId: input.toAccountId,
      amountMinor: toMinor(input.amount, input.exchangeRate),
      contactId: input.contactId ?? null,
      extraSides: input.extraSides,
      categoryAmountMinor: input.categoryAmountMinor,
      categoryLabel: input.categoryLabel,
    },
    context.value,
  );
  if (!sides.ok) return fail("REFUSED", sides.reason);
  // Handed to the builder unchanged. `entry-builder.ts` stays the only place
  // movements are constructed (FR-009).
  // The two accounts and the extra lines stay on the body as the route always
  // sent them; the builder reads only the fields its kind names.
  return ok({ ...input, ...sides.value } as RecordCreate);
}

/**
 * Records something that happened.
 *
 * A payment that says what it covers is one action, so its settlements are
 * written in the same transaction: either both are kept or neither is, and no
 * tab hears about the payment until both are final (FR-015).
 *
 * `dryRun` runs every rule and builds every side, then rolls the whole thing
 * back — so what it reports is exactly what a real save would have stored.
 */
export function createRecord(
  ctx: AppContext,
  input: CreateInput,
  opts: { dryRun?: boolean } = {},
): AppResult<RecordWritten> {
  const refused = requirePermissions(ctx, [["records", "add"]]);
  if (refused) return refused;

  const body = resolveCreate(ctx, input);
  if (!body.ok) return body;
  const data = body.value;
  const userId = actor(ctx);
  const emits: DeferredEmits = [];

  let written: RecordWritten;
  try {
    written = ctx.db.transaction(() => {
      const created = createRecordService(ctx.db, userId, data, emits);
      if (!created.ok) throw new Rollback(fail("REFUSED", created.reason));

      if (data.kind === "payment" && (data.settlements?.length ?? 0) > 0) {
        // The settling side is the one on the shared owed account — the side
        // that clears the debt, whichever direction the money went.
        const owed = requireAccountDefault(
          ctx.db,
          data.direction === "we-pay"
            ? DefaultAccountPurpose.Payable
            : DefaultAccountPurpose.Receivable,
        );
        const paymentMovement = owed.ok
          ? created.value.movements.find((m) => m.accountId === owed.value)
          : undefined;
        if (!paymentMovement) {
          throw new Rollback(
            fail(
              "REFUSED",
              "This payment does not touch anything that is owed.",
            ),
          );
        }
        const settled = createSettlements(
          ctx.db,
          userId,
          paymentMovement.id,
          data.settlements ?? [],
          emits,
        );
        if (!settled.ok) throw new Rollback(fail("REFUSED", settled.reason));
      }

      const result = {
        record: getRecord(ctx.db, created.value.id) ?? created.value,
        version: recordVersion(ctx.db, created.value.id),
      };
      if (opts.dryRun) throw new DryRun(result);
      return result;
    });
  } catch (error) {
    if (error instanceof Rollback) return error.failure;
    if (error instanceof DryRun) return ok(error.result);
    throw error;
  }

  for (const emit of emits) emit();

  // Remember the foreign currency, so someone buying from the same supplier
  // every month does not re-pick it each time. Per screen, because what a
  // business buys abroad and what it sells abroad are rarely the same.
  if (data.currency !== mainCurrencyCode(ctx.db)) {
    setUserPreference(
      ctx.db,
      userId,
      data.kind === "income"
        ? USER_PREF_KEYS.lastForeignCurrencyIncome
        : USER_PREF_KEYS.lastForeignCurrencyExpense,
      data.currency,
    );
  }
  return ok(written);
}

/** Carries a dry run's result out of the transaction it rolls back. */
class DryRun extends Error {
  constructor(public result: RecordWritten) {
    super("dry run");
  }
}

/**
 * Changes a record. A settled or reconciled record refuses its amount, date
 * and money side with a sentence naming what to undo first — the service
 * enforces that (FR-017a); this adds who may, and whether the change would make
 * it an adjustment.
 */
export function updateRecord(
  ctx: AppContext,
  id: number,
  patch: RecordPatch,
  expectedVersion?: string,
): AppResult<RecordWritten> {
  const refused = requirePermissions(ctx, [["records", "change"]]);
  if (refused) return refused;
  const existing = getRecord(ctx.db, id);
  if (!existing) return missing(NOT_FOUND);
  if (isReadOnlyKind(existing.kind)) {
    return fail(
      "REFUSED",
      "This record was created by issuing an invoice. Change it on the invoice instead.",
    );
  }
  const stale = checkVersion(recordVersion(ctx.db, id), expectedVersion);
  if (stale) return stale;

  const canAdjust = hasPermission(ctx.locals, "adjustments", "change");
  if (patch.fromAccountId !== undefined && patch.toAccountId !== undefined) {
    // Both accounts named means the kind is re-derived, so the create path's
    // gate is applied here too. The derivation is pure, so the service asking
    // it again gets the same answer.
    const context = sidesContext(ctx.db, canAdjust);
    if (!context.ok) return context;
    const derived = sidesFromAccounts(
      {
        fromAccountId: patch.fromAccountId,
        toAccountId: patch.toAccountId,
        amountMinor: toMinor(
          patch.amount ?? existing.amount,
          patch.exchangeRate ?? existing.exchangeRate,
        ),
        contactId:
          patch.contactId !== undefined ? patch.contactId : existing.contactId,
        extraSides: patch.extraSides,
        categoryAmountMinor: patch.categoryAmountMinor,
        categoryLabel: patch.categoryLabel,
      },
      context.value,
    );
    if (!derived.ok) return fail("REFUSED", derived.reason);
  } else if (
    patch.categoryAccountId !== undefined ||
    patch.paidFromAccountId !== undefined ||
    patch.receivedIntoAccountId !== undefined ||
    patch.fromAccountId !== undefined ||
    patch.toAccountId !== undefined ||
    (patch.extraSides !== undefined && patch.extraSides.length > 0)
  ) {
    // Some of the accounts change without both being re-answered, so
    // `services/ledger.ts`'s `sidesFor` rebuilds the record around the ones
    // the patch names and the ones it already has. Ask the gate of the set it
    // will end up with — built the same way `sidesFor` builds it — not only of
    // what the patch sent.
    const context = sidesContext(ctx.db, canAdjust);
    if (!context.ok) return context;
    const into = existing.movements.find((m) => m.amountMinor > 0);
    const outOf = existing.movements.find((m) => m.amountMinor < 0);
    const extras =
      patch.extraSides?.map((side) => side.accountId) ??
      existing.movements
        .filter((m) => m !== into && m !== outOf)
        .map((m) => m.accountId);
    const newlyNamed = [
      patch.categoryAccountId,
      patch.paidFromAccountId,
      patch.receivedIntoAccountId,
      patch.fromAccountId,
      patch.toAccountId,
      ...(patch.extraSides?.map((side) => side.accountId) ?? []),
    ].filter((id): id is number => typeof id === "number");
    let gate: AppFailure | null = null;
    if (existing.kind === LedgerRecordKind.Expense && into && outOf) {
      const money =
        patch.paidFromAccountId === null
          ? context.value.payableAccountId
          : (patch.paidFromAccountId ?? outOf.accountId);
      gate = gateByKind(
        context.value,
        {
          kind: "everyday",
          accountIds: [
            money,
            patch.categoryAccountId ?? into.accountId,
            ...extras,
          ],
        },
        newlyNamed,
      );
    } else if (existing.kind === LedgerRecordKind.Income && into && outOf) {
      gate = gateByKind(
        context.value,
        {
          kind: "everyday",
          accountIds: [
            patch.receivedIntoAccountId ?? into.accountId,
            patch.categoryAccountId ?? outOf.accountId,
            ...extras,
          ],
        },
        newlyNamed,
      );
    } else if (existing.kind === LedgerRecordKind.Transfer && into && outOf) {
      gate = gateByKind(
        context.value,
        {
          kind: "transfer",
          fromAccountId: patch.fromAccountId ?? outOf.accountId,
          toAccountId: patch.toAccountId ?? into.accountId,
          contactId:
            patch.contactId !== undefined
              ? patch.contactId
              : existing.contactId,
        },
        newlyNamed,
      );
    }
    // Any other kind: `sidesFor` refuses to rebuild it from single accounts.
    if (gate) return gate;
  }

  const result = patchRecord(ctx.db, id, actor(ctx), patch);
  if (!result.ok) return fail("REFUSED", result.reason);
  return ok({ record: result.value, version: recordVersion(ctx.db, id) });
}

export function deleteRecord(
  ctx: AppContext,
  id: number,
  expectedVersion?: string,
): AppResult<{ id: number }> {
  const refused = requirePermissions(ctx, [["records", "delete"]]);
  if (refused) return refused;
  const existing = getRecord(ctx.db, id);
  if (!existing) return missing(NOT_FOUND);
  if (isReadOnlyKind(existing.kind)) {
    return fail(
      "REFUSED",
      "This record was created by issuing an invoice. Cancel the invoice instead.",
    );
  }
  const stale = checkVersion(recordVersion(ctx.db, id), expectedVersion);
  if (stale) return stale;
  const result = removeRecord(ctx.db, id, actor(ctx));
  if (!result.ok) return fail("REFUSED", result.reason);
  return ok({ id });
}

export const settleShape = {
  paymentMovementId: positiveId,
  allocations: z.array(allocationShape).min(1),
};

/** Says that a payment covered these owed items. */
export function settlePayment(
  ctx: AppContext,
  input: z.output<z.ZodObject<typeof settleShape>>,
): AppResult<{ settlementIds: number[] }> {
  const refused = requirePermissions(ctx, [["records", "add"]]);
  if (refused) return refused;
  const result = fromRefusable(
    createSettlements(
      ctx.db,
      actor(ctx),
      input.paymentMovementId,
      input.allocations,
    ),
  );
  return result.ok ? ok({ settlementIds: result.value }) : result;
}

/** Takes one allocation back. Both sides return to outstanding (FR-017). */
export function removeSettlement(
  ctx: AppContext,
  id: number,
): AppResult<{ id: number }> {
  const refused = requirePermissions(ctx, [["records", "delete"]]);
  if (refused) return refused;
  const result = undoSettlement(ctx.db, id, actor(ctx));
  return result.ok ? ok({ id }) : fail("REFUSED", result.reason);
}
