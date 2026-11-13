import { eq } from "drizzle-orm";
import { z } from "zod";
import { LedgerRecordKind } from "$lib/enums.js";
import {
  basisPointsSchema,
  taxOverrideSchema,
  taxTreatmentSchema,
  type TaxOverride,
  type TaxTreatment,
} from "$lib/expense-tax.js";
import type { LeafPermission } from "$lib/permissions/catalog.js";
import { reimbursementEntries } from "../db/schema.js";
import { isCategoryAccount } from "../ledger/account-type.js";
import { fromMinor, parseMinor, toMinor } from "../ledger/money.js";
import { isReadOnlyKind } from "../ledger/record-permissions.js";
import type {
  LockState,
  MovementView,
  RecordPatch,
  RecordView,
} from "../ledger/types.js";
import { can } from "../permissions.js";
import { depreciationRecordReason } from "../queries/depreciation.js";
import { getRecord, lockStateFor } from "../queries/ledger.js";
import { VOIDED_RECORD_REASON } from "../queries/void-state.js";
import {
  releaseBankMatchesInTransaction,
  voidReleasePlan,
} from "../services/ledger.js";
import { currentUnitOfWork, runUnitOfWork } from "../unit-of-work.js";
import { withClosingRefusal } from "./closing-refusal.js";
import { actor, requirePermissions, type AppContext } from "./context.js";
import {
  correctExpenseContact,
  prepareExpenseContactCorrection,
} from "./expense-contact-correction.js";
import {
  correctPaymentRecipient,
  prepareRecipientCorrection,
} from "./payment-recipient.js";
import {
  correctSettledAmount,
  prepareSettledAmountCorrection,
} from "./record-amount-correction.js";
import {
  correctRecordDate,
  prepareRecordDateCorrection,
} from "./record-date-correction.js";
import { isoDate, patchSchema, positiveId, updateRecord } from "./records.js";
import { setMovementMatches } from "./reconciliation.js";
import {
  correctReimbursementAmount,
  prepareReimbursementAmountCorrection,
} from "./reimbursement-amount-correction.js";
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
 * The record change router: the caller says what a record should end up
 * saying, and this picks the edit or the correction that gets it there.
 *
 * A record that money has moved against locks its amount, date and money side
 * (`ledger/locking.ts`). Each locked field has its own narrow correction, with
 * its own permission and its own eligibility rules. This file holds none of
 * those rules: it asks each correction's own `prepare*` whether it would run,
 * and the lock rules whether a plain update would, and only decides which of
 * them a field goes to. The table it follows is the plan's "Smart routing in
 * change_records.update[]".
 *
 * | Field                          | Record                    | Path                           |
 * |--------------------------------|---------------------------|--------------------------------|
 * | description, reference, remark | any changeable record     | update                         |
 * | category, split at same total  | any expense or income     | update (locked ones too)       |
 * | tax                            | any changeable record     | update, after any correction   |
 * | date                           | unlocked                  | update                         |
 * | date                           | settled expense or income | correct_date                   |
 * | date                           | bank-matched              | blocked unless releaseBankMatches: unmatch, change, rematch |
 * | contact                        | unlocked, not a payment   | update                         |
 * | contact                        | settled/matched expense   | correct_expense_contact        |
 * | contact                        | outgoing payment          | correct_payment_recipient      |
 * | amount, split, currency, rate  | unlocked                  | update                         |
 * | amount, split, currency, rate  | settled expense or income | correct_settled_amount         |
 * | amount                         | direct reimbursement pay  | correct_reimbursement_amount   |
 * | anything else locked           | —                         | blocked, naming what to undo   |
 *
 * `recordEditability` is the same decision asked one field at a time, so the
 * editable map a reader is shown can never disagree with what `changeRecord`
 * does.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RecordChangeLine = {
  /** The category (or equipment) account. */
  accountId: number;
  /** Positive whole cents of the main currency. */
  amountMinor: number;
  label?: string;
};

export type RecordChangeTax = {
  /**
   * Zero-based index into the record's category lines, in movement order
   * (after the change, when it changes the lines). Absent means the record's
   * only category line.
   */
  line?: number;
  treatment: TaxTreatment;
  /** Required for `partial`; otherwise implied by the treatment. */
  percentageBps?: number;
  /** Absent falls back to the change's `reason`. */
  reason?: string;
};

export type RecordChange = {
  description?: string;
  reference?: string | null;
  remark?: string | null;
  contactId?: number | null;
  date?: string;
  /** Single-category records. */
  categoryAccountId?: number;
  /** The category split, positive main-currency cents. */
  lines?: RecordChangeLine[];
  /** A decimal in the record's currency, e.g. "1285.00". */
  amount?: string | number;
  currency?: string;
  exchangeRate?: number;
  tax?: RecordChangeTax[];
};

export type RecordChangeField = keyof RecordChange;

export type RoutePath =
  | "update"
  | "correct_date"
  | "correct_expense_contact"
  | "correct_payment_recipient"
  | "correct_settled_amount"
  | "correct_reimbursement_amount";

export type RouteNeeds = {
  /** A top-level `reason` must be given. */
  reason: boolean;
  /**
   * The date moves to another month. When a field is asked about on its own
   * (`recordEditability`), true means "needed if the new date is in another
   * month".
   */
  acknowledgePeriodChange?: boolean;
  /** The step unmatches the record's bank lines and rematches them. */
  releaseBankMatches?: boolean;
};

export type RouteStep = {
  path: RoutePath;
  fields: RecordChangeField[];
  needs: RouteNeeds;
  /** The leaves this step will check. */
  permissions: string[];
};

export type RouteBlock = { field: RecordChangeField; why: string; fix: string };

export type RecordRoute = { steps: RouteStep[]; blocked: RouteBlock[] };

export type FieldEditability =
  | { mode: "edit"; needs?: RouteNeeds }
  | {
      mode: "correction";
      path: Exclude<RoutePath, "update">;
      needs: RouteNeeds;
    }
  | { mode: "blocked"; why: string; fix: string };

export type RecordEditability = {
  version: string;
  fields: Record<RecordChangeField, FieldEditability>;
};

/** Every field a change may name, in the order the editable map lists them. */
export const RECORD_CHANGE_FIELDS = [
  "description",
  "reference",
  "remark",
  "contactId",
  "date",
  "categoryAccountId",
  "lines",
  "amount",
  "currency",
  "exchangeRate",
  "tax",
] as const satisfies readonly RecordChangeField[];

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

const lineSchema = z
  .object({
    accountId: positiveId,
    amountMinor: z.number().int().safe().positive(),
    label: z.string().trim().max(200).optional(),
  })
  .strict();

const taxSchema = z
  .object({
    line: z.number().int().min(0).optional(),
    treatment: taxTreatmentSchema,
    percentageBps: basisPointsSchema.optional(),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export const recordChangeSchema = z
  .object({
    description: z.string().trim().max(500).optional(),
    reference: z.string().trim().max(200).nullable().optional(),
    remark: z.string().trim().max(2000).nullable().optional(),
    contactId: positiveId.nullable().optional(),
    date: isoDate.optional(),
    categoryAccountId: positiveId.optional(),
    lines: z.array(lineSchema).min(1).max(50).optional(),
    amount: z.union([z.string(), z.number()]).optional(),
    currency: z.string().trim().length(3).toUpperCase().optional(),
    exchangeRate: z.number().finite().positive().optional(),
    tax: z.array(taxSchema).min(1).max(50).optional(),
  })
  .strict();

export const changeRecordSchema = z
  .object({
    recordId: positiveId,
    expectedVersion: z.string().min(1),
    change: recordChangeSchema,
    /** Required whenever a step is a correction, or a tax line has no reason of its own. */
    reason: z.string().trim().min(10).max(2000).optional(),
    acknowledgePeriodChange: z.boolean().optional(),
    releaseBankMatches: z.boolean().optional(),
  })
  .strict();

export type ChangeRecordInput = z.input<typeof changeRecordSchema>;

type Parsed = z.output<typeof recordChangeSchema>;

/** A change with its amount turned into a decimal, and no-op fields dropped. */
type Wanted = Omit<Parsed, "amount"> & { amount?: number };

/**
 * Parses the amount exactly, and drops each field that already says what the
 * change asks for, so asking for the current value never sends a locked
 * record to a correction that would refuse "nothing would change".
 */
function wantedOf(record: RecordView, change: Parsed): AppResult<Wanted> {
  const { amount: rawAmount, ...rest } = change;
  const wanted: Wanted = { ...rest };
  if (rawAmount !== undefined) {
    const parsed = parseMinor(rawAmount);
    if (!parsed.ok) return fail("INVALID_INPUT", parsed.message);
    wanted.amount = fromMinor(parsed.minor);
  }
  const same = <K extends keyof Wanted>(key: K, current: Wanted[K]) => {
    if (wanted[key] !== undefined && wanted[key] === current)
      delete wanted[key];
  };
  same("description", record.description);
  if (wanted.reference === null) wanted.reference = "";
  if (wanted.remark === null) wanted.remark = "";
  same("reference", record.reference);
  same("remark", record.remark);
  same("contactId", record.contactId);
  same("date", record.date);
  same("amount", record.amount);
  same("currency", record.currency);
  same("exchangeRate", record.exchangeRate);
  const lines = categoryLines(record);
  if (
    wanted.categoryAccountId !== undefined &&
    wanted.lines === undefined &&
    lines.length === 1 &&
    lines[0].accountId === wanted.categoryAccountId
  )
    delete wanted.categoryAccountId;
  return ok(wanted);
}

// ---------------------------------------------------------------------------
// What the record is
// ---------------------------------------------------------------------------

/** The sides that say what the money was for: categories and equipment. */
function categoryLines(record: RecordView): MovementView[] {
  return record.movements.filter((m) =>
    isCategoryAccount({ type: m.accountType, subType: m.accountSubType }),
  );
}

function isEveryday(record: RecordView): boolean {
  return (
    record.kind === LedgerRecordKind.Expense ||
    record.kind === LedgerRecordKind.Income
  );
}

type State = {
  record: RecordView;
  lock: LockState;
  version: string;
  release: boolean;
  /** Why nothing on this record can change, whatever path; null if something can. */
  frozen: { why: string; fix: string } | null;
};

function loadState(
  ctx: AppContext,
  id: number,
  release: boolean,
): State | null {
  const record = getRecord(ctx.db, id);
  if (!record) return null;
  return {
    record,
    lock: lockStateFor(ctx.db, id),
    version: recordVersion(ctx.db, id),
    release,
    frozen: frozenReason(ctx, record),
  };
}

/**
 * The refusals every path shares. Each is a predicate the operations
 * themselves ask (`isReadOnlyKind`, the void links, `depreciationRecordReason`,
 * the generated reimbursement entries, the closed period that
 * `queries/ledger.ts`'s `updateRecord` backstops for every write); this only
 * collects them so a field can say why, rather than every correction
 * refusing in turn. The operations still ask them again when they run.
 */
function frozenReason(
  ctx: AppContext,
  record: RecordView,
): { why: string; fix: string } | null {
  if (!can(ctx.locals, "records.update"))
    return {
      why: "You do not have permission to change records.",
      fix: "Ask an administrator for permission to update records.",
    };
  if (isReadOnlyKind(record.kind))
    return {
      why: "This record was created by issuing an invoice.",
      fix: "Change the invoice instead, or void the invoice and issue a corrected one.",
    };
  if (record.voidedByRecordId !== null || record.reversesRecordId !== null)
    return {
      why: VOIDED_RECORD_REASON,
      fix: "Leave the pair as it is. Record a new entry if the books still need one.",
    };
  const depreciation = depreciationRecordReason(ctx.db, record.id);
  if (depreciation)
    return {
      why: depreciation,
      fix: "Change the asset's depreciation instead of this journal.",
    };
  if (
    ctx.db
      .select({ id: reimbursementEntries.recordId })
      .from(reimbursementEntries)
      .where(eq(reimbursementEntries.recordId, record.id))
      .get()
  )
    return {
      why: "This entry was generated by a reimbursement and is read-only.",
      fix: "Correct the reimbursement payment instead.",
    };
  if (record.periodClosedThrough)
    return {
      why: `This record is in a closed month (closed through ${record.periodClosedThrough}).`,
      fix: "A person must reopen that month in Akaun before it can change.",
    };
  return null;
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/**
 * The leaves each path checks. Read off the operations' own checks; the
 * operations ask them again when they run, so this is what a caller is told,
 * never what is enforced.
 */
const PATH_PERMISSIONS: Record<RoutePath, LeafPermission[]> = {
  update: ["records.update"],
  correct_date: ["records.read", "records.update", "records.correctDate"],
  correct_expense_contact: [
    "records.read",
    "records.update",
    "records.correctContact",
  ],
  // `records.delete` is accepted in place of the correction leaf.
  correct_payment_recipient: [
    "records.create",
    "records.update",
    "records.correctPaymentRecipient",
  ],
  // `records.delete` is accepted in place of `records.correctAllocations`.
  correct_settled_amount: [
    "records.read",
    "records.update",
    "records.create",
    "records.correctAllocations",
  ],
  correct_reimbursement_amount: [
    "records.read",
    "records.update",
    "records.correctReimbursementAmount",
  ],
};

type Decision =
  | { path: RoutePath; needs: RouteNeeds }
  | { why: string; fix: string };

const isBlock = (d: Decision): d is { why: string; fix: string } => "why" in d;

const update = (needs: Partial<RouteNeeds> = {}): Decision => ({
  path: "update",
  needs: { reason: false, ...needs },
});

const SETTLED_FIX =
  "Reverse the payment allocations on it first, then change it.";
const MATCHED_FIX =
  "Ask again with releaseBankMatches to unmatch its bank statement lines, change it and rematch them, or unmatch them first.";

/** A plain update would refuse this field because the record is locked. */
function lockedBlock(s: State): Decision {
  return {
    why: s.record.lockedReason ?? "This record is locked.",
    fix: s.lock.settled ? SETTLED_FIX : MATCHED_FIX,
  };
}

function refused(failure: AppFailure, fix: string): Decision {
  return { why: failure.reason, fix };
}

/**
 * What a correction would say once this record's bank matches were released.
 * Run in a savepoint that is always rolled back, with its events discarded, so
 * nothing it wrote survives; the correction's own rules answer, not a copy.
 */
function afterReleasing<T>(ctx: AppContext, id: number, read: () => T): T {
  class Probe extends Error {
    constructor(public value: T) {
      super("probe");
    }
  }
  try {
    ctx.db.transaction(() => {
      releaseBankMatchesInTransaction(ctx.db, id, actor(ctx), []);
      throw new Probe(read());
    });
  } catch (error) {
    if (error instanceof Probe) return error.value;
    throw error;
  }
  throw new Error("unreachable");
}

function decideDate(
  ctx: AppContext,
  s: State,
  wanted: Wanted | null,
): Decision {
  const { lock, record } = s;
  if (!lock.settled && !lock.reconciled) return update();
  if (lock.reconciled && !s.release)
    return {
      why: "This record is matched to a bank statement line, which fixes its date.",
      fix: MATCHED_FIX,
    };
  const monthChanges =
    wanted === null
      ? true
      : wanted.date !== undefined &&
        wanted.date.slice(0, 7) !== record.date.slice(0, 7);
  const release = lock.reconciled ? { releaseBankMatches: true } : {};
  if (!lock.settled) return update(release);
  const prepared = lock.reconciled
    ? afterReleasing(ctx, record.id, () =>
        prepareRecordDateCorrection(ctx, record.id),
      )
    : prepareRecordDateCorrection(ctx, record.id);
  if (!prepared.ok) return refused(prepared, SETTLED_FIX);
  return {
    path: "correct_date",
    needs: {
      reason: true,
      acknowledgePeriodChange: monthChanges,
      ...release,
    },
  };
}

function decideContact(
  ctx: AppContext,
  s: State,
  wanted: Wanted | null,
): Decision {
  const { record, lock } = s;
  if (record.kind === LedgerRecordKind.Payment) {
    // An ordinary edit never changes who a payment names (services/ledger.ts).
    const prepared = prepareRecipientCorrection(ctx, record.id);
    if (!prepared.ok)
      return refused(
        prepared,
        "Void the payment and record it again with the right contact.",
      );
    if (prepared.value.dependencies.length)
      return {
        why:
          "Other records depend on this payment's allocations: " +
          prepared.value.dependencies
            .map((d) => `record #${d.recordId} (${d.reason})`)
            .join("; "),
        fix: "Reverse those allocations first, then correct the recipient.",
      };
    return { path: "correct_payment_recipient", needs: { reason: true } };
  }
  if (!lock.settled && !lock.reconciled) return update();
  if (record.kind === LedgerRecordKind.Expense) {
    if (wanted !== null && wanted.contactId === null)
      return {
        why: "A paid or reconciled expense keeps a contact.",
        fix: "Name the contact it should have instead of clearing it.",
      };
    const prepared = prepareExpenseContactCorrection(ctx, record.id);
    if (!prepared.ok) return refused(prepared, SETTLED_FIX);
    const field = prepared.value.fields.find(
      (f) => f.field === (prepared.value.personal ? "paidBy" : "supplier"),
    );
    if (field?.blockedReason)
      return {
        why: field.blockedReason,
        fix: "Reverse the linked reimbursement first.",
      };
    return { path: "correct_expense_contact", needs: { reason: true } };
  }
  if (lock.settled)
    return {
      why: "This record is settled by a payment, which fixes its contact.",
      fix: SETTLED_FIX,
    };
  return update();
}

/** amount, currency and exchangeRate move together. */
function decideMoney(
  ctx: AppContext,
  s: State,
  wanted: Wanted | null,
): Decision {
  const { record, lock } = s;
  if (!lock.settled && !lock.reconciled) {
    if (!isEveryday(record) && record.kind !== LedgerRecordKind.Transfer)
      return {
        why: "This kind of record cannot have its amount changed after it is created.",
        fix: "Void it and record it again with the right amount.",
      };
    if (
      wanted !== null &&
      isEveryday(record) &&
      wanted.lines === undefined &&
      categoryLines(record).length > 1 &&
      totalChanges(record, wanted)
    )
      return {
        why: `This record is split over ${categoryLines(record).length} categories.`,
        fix: "Send the lines of the new split with the new amount.",
      };
    return update();
  }
  if (!lock.settled) return lockedBlock(s);
  if (isEveryday(record)) {
    const prepared = prepareSettledAmountCorrection(ctx, record.id, {
      releaseBankMatches: s.release,
    });
    if (!prepared.ok) return refused(prepared, SETTLED_FIX);
    const blockers = prepared.value.blockers;
    if (blockers.length)
      return {
        why: blockers.join(" "),
        fix:
          !s.release && prepared.value.bankMatches.length
            ? MATCHED_FIX
            : SETTLED_FIX,
      };
    return {
      path: "correct_settled_amount",
      needs: {
        reason: true,
        ...(lock.reconciled ? { releaseBankMatches: true } : {}),
      },
    };
  }
  if (record.kind === LedgerRecordKind.Payment) {
    const prepared = prepareReimbursementAmountCorrection(ctx, record.id);
    if (!prepared.ok)
      return refused(
        prepared,
        "Correct the payment's allocations, or void it and record it again.",
      );
    return { path: "correct_reimbursement_amount", needs: { reason: true } };
  }
  return lockedBlock(s);
}

/** Whether the change moves the record's main-currency total. */
function totalChanges(record: RecordView, wanted: Wanted): boolean {
  if (
    wanted.amount === undefined &&
    wanted.currency === undefined &&
    wanted.exchangeRate === undefined
  )
    return false;
  return (
    toMinor(
      wanted.amount ?? record.amount,
      wanted.exchangeRate ?? record.exchangeRate,
    ) !== record.amountMinor
  );
}

const MONEY_FIELDS = ["amount", "currency", "exchangeRate"] as const;

function decideField(
  ctx: AppContext,
  s: State,
  field: RecordChangeField,
  wanted: Wanted | null,
  money: () => Decision,
): Decision {
  if (s.frozen) return s.frozen;
  const { record } = s;
  switch (field) {
    case "description":
    case "reference":
    case "remark":
      return update();
    case "tax":
      return update({
        reason: wanted === null || (wanted.tax ?? []).some((t) => !t.reason),
      });
    case "date":
      return decideDate(ctx, s, wanted);
    case "contactId":
      return decideContact(ctx, s, wanted);
    case "categoryAccountId":
      if (!isEveryday(record))
        return {
          why: "Only an expense or an income has a category.",
          fix: "Void it and record it again, or record an adjusting journal.",
        };
      if (wanted?.lines !== undefined)
        return {
          why: "The lines already name the categories.",
          fix: "Send the category as the first line, without categoryAccountId.",
        };
      return update();
    case "lines": {
      if (!isEveryday(record))
        return {
          why: "Only an expense or an income is split over categories.",
          fix: "Void it and record it again, or record an adjusting journal.",
        };
      if (wanted === null) return update();
      if (MONEY_FIELDS.some((f) => wanted[f] !== undefined)) return money();
      const sum = wanted.lines!.reduce((t, l) => t + l.amountMinor, 0);
      if (sum !== record.amountMinor)
        return {
          why: `The lines add up to ${fromMinor(sum).toFixed(2)}, but the record's amount is ${fromMinor(record.amountMinor).toFixed(2)}.`,
          fix: "Send the new amount with the lines, or make the lines add up to the amount.",
        };
      // A re-split at the same total: the money side keeps its movement, so a
      // settled or matched record allows it (ledger/locking.ts).
      return update();
    }
    case "amount":
      return money();
    case "currency":
    case "exchangeRate": {
      const decision = money();
      if (
        !isBlock(decision) &&
        decision.path === "correct_reimbursement_amount"
      )
        return {
          why: "A reimbursement payment stays in the main currency.",
          fix: "Change only its amount.",
        };
      return decision;
    }
  }
}

/** One decision for every field a change names. */
function decide(
  ctx: AppContext,
  s: State,
  fields: RecordChangeField[],
  wanted: Wanted | null,
): RecordRoute {
  let moneyDecision: Decision | undefined;
  const money = () => (moneyDecision ??= decideMoney(ctx, s, wanted));
  const blocked: RouteBlock[] = [];
  const byPath = new Map<RoutePath, RouteStep>();
  let taxStep: RouteStep | null = null;
  for (const field of fields) {
    const decision = decideField(ctx, s, field, wanted, money);
    if (isBlock(decision)) {
      blocked.push({ field, why: decision.why, fix: decision.fix });
      continue;
    }
    if (field === "tax") {
      // Classified against the lines the record ends up with, so after any
      // correction that rebuilds them.
      taxStep = {
        path: "update",
        fields: ["tax"],
        needs: decision.needs,
        permissions: [...PATH_PERMISSIONS.update],
      };
      continue;
    }
    const step = byPath.get(decision.path);
    if (step) {
      step.fields.push(field);
      step.needs = mergeNeeds(step.needs, decision.needs);
    } else
      byPath.set(decision.path, {
        path: decision.path,
        fields: [field],
        needs: decision.needs,
        permissions: [...PATH_PERMISSIONS[decision.path]],
      });
  }
  const steps = STEP_ORDER.flatMap((path) => {
    const step = byPath.get(path);
    return step ? [step] : [];
  });
  if (taxStep) {
    const only = steps.length === 1 && steps[0].path === "update";
    if (only) {
      steps[0].fields.push("tax");
      steps[0].needs = mergeNeeds(steps[0].needs, taxStep.needs);
    } else steps.push(taxStep);
  }
  for (const step of steps)
    if (step.needs.releaseBankMatches)
      step.permissions.push("reconciliation.match");
  return { steps, blocked };
}

/** Plain update first, then the corrections, safest first. */
const STEP_ORDER: RoutePath[] = [
  "update",
  "correct_expense_contact",
  "correct_payment_recipient",
  "correct_date",
  "correct_settled_amount",
  "correct_reimbursement_amount",
];

function mergeNeeds(a: RouteNeeds, b: RouteNeeds): RouteNeeds {
  const out: RouteNeeds = { reason: a.reason || b.reason };
  if (a.acknowledgePeriodChange || b.acknowledgePeriodChange)
    out.acknowledgePeriodChange = true;
  else if (
    a.acknowledgePeriodChange !== undefined ||
    b.acknowledgePeriodChange !== undefined
  )
    out.acknowledgePeriodChange = false;
  if (a.releaseBankMatches || b.releaseBankMatches)
    out.releaseBankMatches = true;
  return out;
}

function fieldsOf(wanted: Wanted): RecordChangeField[] {
  return RECORD_CHANGE_FIELDS.filter((f) => wanted[f] !== undefined);
}

// ---------------------------------------------------------------------------
// Public: route, editability
// ---------------------------------------------------------------------------

/**
 * Which steps would make this record say what `change` asks, and which fields
 * cannot change and why. Read-only: it decides and writes nothing. A field
 * that already says what is asked is left out of both lists.
 */
export function routeRecordChange(
  ctx: AppContext,
  recordId: number,
  change: RecordChange,
  opts: { releaseBankMatches?: boolean } = {},
): AppResult<RecordRoute> {
  const denied = requirePermissions(ctx, ["records.read"]);
  if (denied) return denied;
  const parsed = recordChangeSchema.safeParse(change);
  if (!parsed.success) return invalid(parsed.error);
  const s = loadState(ctx, recordId, opts.releaseBankMatches ?? false);
  if (!s) return missing("That record no longer exists.");
  const wanted = wantedOf(s.record, parsed.data);
  if (!wanted.ok) return wanted;
  return ok(decide(ctx, s, fieldsOf(wanted.value), wanted.value));
}

/**
 * For each field, whether it changes by an ordinary edit, by which correction,
 * or not at all and what to undo first. The routing decision asked one field
 * at a time, with bank matches allowed to be released: a field that needs
 * them released says so in `needs.releaseBankMatches`.
 */
export function recordEditability(
  ctx: AppContext,
  recordId: number,
): AppResult<RecordEditability> {
  const denied = requirePermissions(ctx, ["records.read"]);
  if (denied) return denied;
  const s = loadState(ctx, recordId, true);
  if (!s) return missing("That record no longer exists.");
  const fields = {} as Record<RecordChangeField, FieldEditability>;
  for (const field of RECORD_CHANGE_FIELDS) {
    const route = decide(ctx, s, [field], null);
    const step = route.steps[0];
    if (!step) {
      const block = route.blocked[0];
      fields[field] = { mode: "blocked", why: block.why, fix: block.fix };
    } else if (step.path === "update") {
      const needed =
        step.needs.reason ||
        step.needs.releaseBankMatches ||
        step.needs.acknowledgePeriodChange;
      fields[field] = needed
        ? { mode: "edit", needs: step.needs }
        : { mode: "edit" };
    } else
      fields[field] = {
        mode: "correction",
        path: step.path,
        needs: step.needs,
      };
  }
  return ok({ version: s.version, fields });
}

// ---------------------------------------------------------------------------
// Public: change
// ---------------------------------------------------------------------------

export type ChangeRecordStep = {
  path: RoutePath;
  fields: RecordChangeField[];
  /** What the step's operation returned. */
  result: unknown;
};

export type ChangeRecordValue = {
  record: RecordView;
  version: string;
  steps: ChangeRecordStep[];
};

/** A refusal from routing carries every blocked field. */
export type ChangeRecordFailure = AppFailure & { blocked?: RouteBlock[] };

/** Carries a dry run's result out of the transaction it rolls back. */
class DryRun extends Error {
  constructor(public result: ChangeRecordValue) {
    super("dry run");
  }
}

/**
 * Routes the change, then runs every step in ONE transaction — plain update
 * first, then the corrections — or none of them. The version each step returns
 * is the next step's expected version. `dryRun` runs every step and rolls them
 * all back, returning what a real change would have done.
 *
 * Each step's operation asks its own permissions; this asks records.read and
 * records.update before routing.
 */
export function changeRecord(
  ctx: AppContext,
  input: ChangeRecordInput,
  opts: { dryRun?: boolean } = {},
): AppResult<ChangeRecordValue> {
  return withClosingRefusal(() => changeOperation(ctx, input, opts));
}

function changeOperation(
  ctx: AppContext,
  raw: ChangeRecordInput,
  opts: { dryRun?: boolean },
): AppResult<ChangeRecordValue> | ChangeRecordFailure {
  const denied = requirePermissions(ctx, ["records.read", "records.update"]);
  if (denied) return denied;
  const parsed = changeRecordSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);
  const input = parsed.data;
  const outer = currentUnitOfWork();
  if (opts.dryRun && outer?.state === "open" && outer.mode === "write")
    return fail(
      "INVALID_INPUT",
      "A dry run cannot run inside a change that writes. Ask for the dry run on its own.",
    );
  try {
    const value = runUnitOfWork(opts.dryRun ? "dry_run" : "write", () =>
      ctx.db.transaction(
        () => {
          const result = runSteps(ctx, input);
          if (opts.dryRun) throw new DryRun(result);
          return result;
        },
        { behavior: "immediate" },
      ),
    );
    return ok(value);
  } catch (error) {
    if (error instanceof Rollback) return error.failure;
    if (error instanceof DryRun) return ok(error.result);
    throw error;
  }
}

function refuse(failure: AppFailure): never {
  throw new Rollback(failure);
}

function runSteps(
  ctx: AppContext,
  input: z.output<typeof changeRecordSchema>,
): ChangeRecordValue {
  const id = input.recordId;
  const s = loadState(ctx, id, input.releaseBankMatches ?? false);
  if (!s) refuse(missing("That record no longer exists."));
  const stale = checkVersion(s.version, input.expectedVersion);
  if (stale) refuse(stale);
  const wantedResult = wantedOf(s.record, input.change);
  if (!wantedResult.ok) refuse(wantedResult);
  const wanted = wantedResult.value;
  const route = decide(ctx, s, fieldsOf(wanted), wanted);

  // Everything that would refuse is refused here, before any write.
  if (route.blocked.length) {
    const failure: ChangeRecordFailure = {
      ...fail(
        "REFUSED",
        route.blocked.map((b) => `${b.field}: ${b.why} ${b.fix}`).join(" "),
      ),
      blocked: route.blocked,
    };
    refuse(failure);
  }
  if (route.steps.some((step) => step.needs.reason) && !input.reason) {
    const paths = route.steps
      .filter((step) => step.needs.reason)
      .map((step) => step.path);
    refuse(
      fail(
        "INVALID_INPUT",
        `This change runs ${paths.join(", ")}, which needs a reason. Say why the record is being changed, in 10 to 2000 characters.`,
      ),
    );
  }
  if (
    route.steps.some((step) => step.needs.acknowledgePeriodChange) &&
    !input.acknowledgePeriodChange
  )
    refuse(
      fail(
        "INVALID_INPUT",
        "The new date is in a different month, so reports for both months change. Ask again with acknowledgePeriodChange.",
      ),
    );

  const done: ChangeRecordStep[] = [];
  let version = s.version;
  for (const step of route.steps) {
    const result = runStep(ctx, id, step, wanted, input, version);
    if (!result.ok) refuse(result);
    version = recordVersion(ctx.db, id);
    done.push({ path: step.path, fields: step.fields, result: result.value });
  }
  return { record: getRecord(ctx.db, id)!, version, steps: done };
}

function runStep(
  ctx: AppContext,
  id: number,
  step: RouteStep,
  wanted: Wanted,
  input: z.output<typeof changeRecordSchema>,
  version: string,
): AppResult<unknown> {
  const reason = input.reason ?? "";
  const run = (): AppResult<unknown> => {
    switch (step.path) {
      case "update": {
        const patch = patchFor(ctx, id, step.fields, wanted, reason);
        if (!patch.ok) return patch;
        return updateRecord(ctx, id, patch.value, version);
      }
      case "correct_date":
        return correctRecordDate(ctx, id, {
          date: wanted.date,
          reason,
          expectedVersion: version,
          acknowledgePeriodChange: input.acknowledgePeriodChange ?? false,
        });
      case "correct_expense_contact": {
        const prepared = prepareExpenseContactCorrection(ctx, id);
        if (!prepared.ok) return prepared;
        return correctExpenseContact(ctx, id, {
          field: prepared.value.personal ? "paidBy" : "supplier",
          contactId: wanted.contactId,
          reason,
          expectedVersion: prepared.value.version,
        });
      }
      case "correct_payment_recipient": {
        const prepared = prepareRecipientCorrection(ctx, id);
        if (!prepared.ok) return prepared;
        return correctPaymentRecipient(ctx, {
          recordId: id,
          contactId: wanted.contactId!,
          reason,
          expectedVersion: prepared.value.version,
        });
      }
      case "correct_settled_amount":
        return correctSettledAmount(ctx, {
          recordId: id,
          expectedVersion: version,
          ...(wanted.amount !== undefined ? { amount: wanted.amount } : {}),
          ...(wanted.currency !== undefined
            ? { currency: wanted.currency }
            : {}),
          ...(wanted.exchangeRate !== undefined
            ? { exchangeRate: wanted.exchangeRate }
            : {}),
          ...(wanted.lines ? { lines: wanted.lines } : {}),
          reason,
          ...(step.needs.releaseBankMatches
            ? { releaseBankMatches: true }
            : {}),
        });
      case "correct_reimbursement_amount": {
        const prepared = prepareReimbursementAmountCorrection(ctx, id);
        if (!prepared.ok) return prepared;
        const amountMinor = toMinor(wanted.amount!, 1);
        // The same expenses, oldest first, each up to what it still owes.
        let left = amountMinor;
        const allocations = prepared.value.expenses.map((e) => {
          const amount = Math.min(e.availableMinor, left);
          left -= amount;
          return { owedMovementId: e.owedMovementId, amountMinor: amount };
        });
        return correctReimbursementAmount(ctx, id, {
          amountMinor,
          allocations,
          reason,
          expectedVersion: prepared.value.version,
        });
      }
    }
  };
  // The date of a bank-matched record: unmatch, change, rematch the same
  // lines. The settled-amount correction releases and rematches by itself.
  if (step.needs.releaseBankMatches && step.path !== "correct_settled_amount")
    return withMatchesReleased(ctx, id, run);
  return run();
}

/**
 * Unmatches every bank line on the record, runs `change`, then matches the
 * same lines to the same movements for the same amounts. Only a date changes
 * inside, so every movement keeps its id, account and amount, and the
 * reconciliation service's own rules (the line's account, its direction, what
 * it has free) accept the rematch exactly as they accepted the match.
 */
function withMatchesReleased(
  ctx: AppContext,
  id: number,
  change: () => AppResult<unknown>,
): AppResult<unknown> {
  const denied = requirePermissions(ctx, ["reconciliation.match"]);
  if (denied) return denied;
  const byMovement = new Map<number, { lineId: number; amount: number }[]>();
  for (const match of voidReleasePlan(ctx.db, id).bankMatches) {
    const list = byMovement.get(match.movementId) ?? [];
    list.push({ lineId: match.lineId, amount: match.amount });
    byMovement.set(match.movementId, list);
  }
  for (const movementId of byMovement.keys()) {
    const cleared = setMovementMatches(ctx, movementId, []);
    if (!cleared.ok) return cleared;
  }
  const changed = change();
  if (!changed.ok) return changed;
  const rematched: { movementId: number; lineId: number; amount: number }[] =
    [];
  for (const [movementId, allocations] of byMovement) {
    const saved = setMovementMatches(ctx, movementId, allocations);
    if (!saved.ok) return saved;
    rematched.push(...allocations.map((a) => ({ movementId, ...a })));
  }
  return ok({ change: changed.value, rematched });
}

/** The `updateRecord` patch for the fields routed to it, as the record form would send it. */
function patchFor(
  ctx: AppContext,
  id: number,
  fields: RecordChangeField[],
  wanted: Wanted,
  reason: string,
): AppResult<RecordPatch> {
  const record = getRecord(ctx.db, id)!;
  const has = (f: RecordChangeField) => fields.includes(f);
  const patch: Record<string, unknown> = {};
  if (has("description")) patch.description = wanted.description;
  if (has("reference")) patch.reference = wanted.reference;
  if (has("remark")) patch.remark = wanted.remark;
  if (has("contactId")) patch.contactId = wanted.contactId;
  if (has("date")) patch.date = wanted.date;
  if (has("amount")) patch.amount = wanted.amount;
  if (has("currency")) patch.currency = wanted.currency;
  if (has("exchangeRate")) patch.exchangeRate = wanted.exchangeRate;
  if (has("categoryAccountId"))
    patch.categoryAccountId = wanted.categoryAccountId;
  if (has("lines")) Object.assign(patch, splitPatch(record, wanted));
  if (has("tax")) {
    const overrides = taxOverridesFor(record, wanted.tax!, reason);
    if (!overrides.ok) return overrides;
    patch.taxOverrides = overrides.value;
  }
  const parsed = patchSchema.safeParse(patch);
  if (!parsed.success) return invalid(parsed.error);
  return ok(parsed.data as RecordPatch);
}

/**
 * The category split as the record form sends it. A re-split at the same
 * total names the category lines only, the way the form edits a locked
 * record. A split with a new total names both accounts, the way the form
 * edits an unlocked one, because only that shape keeps every line when the
 * amount changes (`services/ledger.ts`'s `sidesFor`).
 */
function splitPatch(
  record: RecordView,
  wanted: Wanted,
): Record<string, unknown> {
  const lines = wanted.lines!;
  const [first, ...rest] = lines;
  const sign = record.kind === LedgerRecordKind.Expense ? 1 : -1;
  const extraSides = rest.map((line) => ({
    accountId: line.accountId,
    amountMinor: sign * line.amountMinor,
    label: line.label ?? null,
  }));
  const split =
    rest.length > 0
      ? {
          extraSides,
          categoryAmountMinor: first.amountMinor,
          ...(first.label !== undefined ? { categoryLabel: first.label } : {}),
        }
      : { extraSides: [] };
  const moneyChanges = MONEY_FIELDS.some((f) => wanted[f] !== undefined);
  if (!moneyChanges || rest.length === 0)
    return { categoryAccountId: first.accountId, ...split };
  const moneySide = record.movements.find(
    (m) => !categoryLines(record).includes(m),
  );
  return record.kind === LedgerRecordKind.Expense
    ? {
        fromAccountId: moneySide?.accountId,
        toAccountId: first.accountId,
        ...split,
      }
    : {
        fromAccountId: first.accountId,
        toAccountId: moneySide?.accountId,
        ...split,
      };
}

/** The percentage a treatment implies, where it implies one. */
function impliedBps(treatment: TaxTreatment): number | null | undefined {
  switch (treatment) {
    case "ordinary_deductible":
      return 10000;
    case "non_deductible":
    case "capital_expenditure":
      return 0;
    case "unclassified":
    case "requires_review":
      return null;
    case "partial":
      return undefined;
  }
}

function taxOverridesFor(
  record: RecordView,
  tax: NonNullable<Wanted["tax"]>,
  reason: string,
): AppResult<TaxOverride[]> {
  const lines = categoryLines(record);
  const out: unknown[] = [];
  for (const [i, entry] of tax.entries()) {
    const index = entry.line ?? (lines.length === 1 ? 0 : -1);
    if (index < 0)
      return fail(
        "INVALID_INPUT",
        `This record has ${lines.length} category lines. Say which one tax[${i}] is for with line (0 to ${lines.length - 1}).`,
      );
    if (index >= lines.length)
      return fail(
        "INVALID_INPUT",
        `tax[${i}] names line ${index}, but this record has ${lines.length} category line${lines.length === 1 ? "" : "s"}.`,
      );
    const line = lines[index];
    const percentageBps = entry.percentageBps ?? impliedBps(entry.treatment);
    if (percentageBps === undefined)
      return fail(
        "INVALID_INPUT",
        `Give percentageBps for the partial treatment in tax[${i}].`,
      );
    const lineReason = entry.reason ?? reason;
    if (!lineReason)
      return fail(
        "INVALID_INPUT",
        `Give a reason for tax[${i}], on the line or for the whole change.`,
      );
    out.push({
      accountId: line.accountId,
      occurrence: record.movements
        .filter((m) => m.accountId === line.accountId)
        .indexOf(line),
      treatment: entry.treatment,
      percentageBps,
      reason: lineReason,
    });
  }
  const parsed = z.array(taxOverrideSchema).safeParse(out);
  if (!parsed.success) return invalid(parsed.error);
  return ok(parsed.data);
}
