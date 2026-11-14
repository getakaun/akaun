import { z } from "zod";
import { and, eq } from "drizzle-orm";
import {
  percentageToBps,
  TAX_TREATMENTS,
  type TaxOverride,
} from "$lib/expense-tax.js";
import { ledgerMovements } from "../../../db/schema.js";
import { runBatch, storedReplay } from "../../../application/batch.js";
import type { AppContext } from "../../../application/context.js";
import {
  autoMatchTolerant,
  createRecordFromLines,
  recordFromLinesKinds,
  setMovementMatches,
  type PaymentDirection,
  type PaymentDirectionFailure,
} from "../../../application/reconciliation.js";
import {
  lineRef,
  resolveRecord,
  type AccountBrief,
  type BankLineBrief,
  type ContactBrief,
  type ControlLine,
  type RecordBrief,
} from "../../../application/refs.js";
import { fail, ok, type AppResult } from "../../../application/result.js";
import {
  checkVersion,
  movementMatchesVersion,
  statementLineVersion,
} from "../../../application/version.js";
import {
  isCategoryAccount,
  isMoneyPotAccount,
} from "../../../ledger/account-type.js";
import { fromMinor, toMinor } from "../../../ledger/money.js";
import type { LedgerDb } from "../../../ledger/types.js";
import {
  getMovementCandidate,
  listLineAllocations,
  listMovementAllocations,
} from "../../../queries/reconciliation.js";
import {
  mainCurrency,
  money,
  moneyInput,
  parsePeriod,
  dateInput,
} from "../../format.js";
import type { ItemFailure } from "../../batch-result.js";
import { defineWriteTool, type ToolDefinition } from "../../registry.js";
import {
  MATCH_BANK_LINES,
  UNMATCH_BANK_LINES,
} from "../../requirements/index.js";
import {
  batchCall,
  batchControls,
  batchReply,
  lineAccountInput,
  needAmount,
  nothingToDo,
  outstandingNow,
  recordNo,
  redactBalances,
  refInput,
  refuseActions,
  Refs,
  showsBalances,
  SPLIT_CALL,
} from "./payments.js";

/**
 * The bank write tools: `match_bank_lines` and `unmatch_bank_lines`.
 *
 * A bank line is `L123`; a record its id or number. The server finds the
 * record's side on the line's account, so an agent never sees a movement id.
 * Matching and unmatching only ever change which lines cover which records:
 * a bank line itself is the bank's evidence and is never edited.
 *
 * - `match[]` adds to a record's existing matches: the item reads the matches
 *   and their version inside the batch, then calls `setMovementMatches` with
 *   the merged list.
 * - `create_from_lines[]` → `createRecordFromLines`.
 * - `auto_match` → `autoMatchTolerant`, at most 7 days apart.
 * - `unmatch[]` checks the line's version, then calls `setMovementMatches`
 *   with each record's list without the line.
 */

type BankValue = Record<string, unknown>;

/** The widest gap auto_match offers, in days. The domain allows 31; a wider gap pairs strangers. */
export const AUTO_MATCH_MAX_DAYS = 7;
const AUTO_MATCH_DEFAULT_DAYS = 3;

const lineInput = refInput.describe('A bank line, e.g. "L123".');

/** A record's sides on one account. */
function sidesOn(db: LedgerDb, recordId: number, accountId: number) {
  return db
    .select({
      id: ledgerMovements.id,
      amountMinor: ledgerMovements.amountMinor,
    })
    .from(ledgerMovements)
    .where(
      and(
        eq(ledgerMovements.recordId, recordId),
        eq(ledgerMovements.accountId, accountId),
      ),
    )
    .all();
}

const sumMinor = (allocations: { amount: number }[]) =>
  allocations.reduce((sum, a) => sum + toMinor(a.amount, 1), 0);

/** What is still unmatched on a bank line, in whole cents. */
function lineLeft(db: LedgerDb, line: BankLineBrief): number {
  return toMinor(line.amount, 1) - sumMinor(listLineAllocations(db, line.id));
}

/** The record's output name, read inside the batch. */
function recordOf(ctx: AppContext, recordId: number) {
  const found = resolveRecord(ctx, recordId);
  return found.ok
    ? { id: recordId, no: recordNo(found.value) }
    : { id: recordId, no: `#${recordId}` };
}

// --- match_bank_lines ---------------------------------------------------------

const TAX_CHOICES = TAX_TREATMENTS.filter((t) => t !== "unclassified") as [
  Exclude<(typeof TAX_TREATMENTS)[number], "unclassified">,
  ...Exclude<(typeof TAX_TREATMENTS)[number], "unclassified">[],
];

const FROM_LINES_DIRECTIONS = [
  "we_receive",
  "we_pay",
  "refund_received",
  "refund_paid",
] as const;
const toAppDirection = (d: (typeof FROM_LINES_DIRECTIONS)[number]) =>
  d.replaceAll("_", "-") as PaymentDirection;

const matchBankLinesInput = z.object({
  match: z
    .array(
      z.object({
        line: lineInput,
        records: z
          .array(
            z.object({
              record: refInput.describe(
                "The record the line covers: id or number.",
              ),
              amount: moneyInput
                .optional()
                .describe(
                  "How much of the line covers this record. Omitted: as much as both still have unmatched.",
                ),
            }),
          )
          .min(1)
          .max(50),
      }),
    )
    .max(50, SPLIT_CALL)
    .optional(),
  create_from_lines: z
    .array(
      z.object({
        lines: z
          .array(lineInput)
          .min(1)
          .max(200)
          .describe("Lines of one account, all money in or all money out."),
        kind: z.enum(recordFromLinesKinds),
        category: refInput
          .optional()
          .describe("expense / income only: what the money was for."),
        other_account: refInput
          .optional()
          .describe(
            "transfer only: your other account the money moved to or from.",
          ),
        contact: refInput
          .optional()
          .describe(
            "Who: required for a payment, optional for expense and income.",
          ),
        description: z
          .string()
          .trim()
          .max(500)
          .optional()
          .describe("Omitted: the lines' own text."),
        date: dateInput
          .optional()
          .describe("Omitted: the earliest line's date."),
        tax: z
          .object({
            treatment: z.enum(TAX_CHOICES),
            percent: z
              .string()
              .optional()
              .describe(
                'The deductible percentage, e.g. "50"; required for partial.',
              ),
            reason: z.string().trim().min(1).max(500),
          })
          .optional()
          .describe("expense only: the tax treatment of its category line."),
        allocate: z
          .array(
            z.object({
              record: refInput,
              amount: moneyInput.optional(),
              line_account: lineAccountInput.optional(),
            }),
          )
          .max(200)
          .optional()
          .describe(
            "payment only: the contact's open records it settles. An omitted amount takes what is outstanding (without records.read, send every amount).",
          ),
        direction: z
          .enum(FROM_LINES_DIRECTIONS)
          .optional()
          .describe(
            "payment only. Money in: we_receive or refund_received (a supplier returning an overpayment). Money out: we_pay or refund_paid (returning a customer's overpayment). Omitted: worked out from allocate, settlement_account or the contact's open balance.",
          ),
        settlement_account: refInput
          .optional()
          .describe(
            "payment only: the receivable, payable or reimbursements payable account it settles. Omitted: the one the direction implies.",
          ),
      }),
    )
    .max(50, SPLIT_CALL)
    .optional(),
  auto_match: z
    .object({
      account: refInput.describe("The bank, cash or card account."),
      period: z
        .string()
        .optional()
        .describe(
          'Only lines dated in it: "2026-03", "2026-Q1", "2026" or "2026-03-01..2026-03-15".',
        ),
      max_days: z
        .number()
        .int()
        .min(0)
        .max(
          AUTO_MATCH_MAX_DAYS,
          `max_days is at most ${AUTO_MATCH_MAX_DAYS}: a wider window pairs a line with the wrong record. Match the rest one by one with match.`,
        )
        .optional()
        .describe(
          `How many days apart a line and its record may be, 0 to ${AUTO_MATCH_MAX_DAYS}. Default ${AUTO_MATCH_DEFAULT_DAYS}.`,
        ),
    })
    .optional(),
  ...batchControls,
});
type MatchArgs = z.output<typeof matchBankLinesInput>;

const MATCH_BANK_LINES_DESCRIPTION = `Clear bank statement lines against the books. Read the reconciliation first: it lists the unmatched lines (L123) and the records each could be.

- match[]: {line, records: [{record, amount?}]} says the line covers these records. It adds to existing matches; an omitted amount takes what both still have unmatched. A line matches only records on its own account, moving money the same way.
- create_from_lines[]: for lines nothing in the books stands for yet (bank interest, a fee, a supplier paid from the bank, a move between your own accounts): one record from lines of one account, matched to them. kind expense or income needs category; transfer needs other_account; payment needs contact, may allocate to their open records, and takes direction / settlement_account (omitted: from the contact's open items or refused). tax (expense only) sets its category line's treatment.
- auto_match: {account, period?, max_days?}: matches every untouched line to the one untouched record of exactly its amount and direction at most max_days apart (0 to 7, default 3). A line or record with two possible partners is skipped with its reason, never guessed. In a dry run it lists the pairs it would match.

Records are named by id or number. Amounts are decimal strings in the main currency. Matching locks the record's amount and date. Up to 50 items per call (auto_match counts as one), saved together or not at all. dry_run: true saves nothing; idempotency_key makes a retried call return the first result.`;

type MatchPlan = {
  line: BankLineBrief;
  targets: { record: RecordBrief; movementId: number; amountMinor?: number }[];
};

type FromLinesPlan = {
  lines: BankLineBrief[];
  kind: (typeof recordFromLinesKinds)[number];
  category?: AccountBrief;
  otherAccount?: AccountBrief;
  contact?: ContactBrief;
  description?: string;
  date?: string;
  tax?: Omit<TaxOverride, "accountId" | "occurrence">;
  allocate: { record: RecordBrief; line: ControlLine; amountMinor?: number }[];
  direction?: PaymentDirection;
  settlementAccount?: AccountBrief;
  /** Where in the input, for a refusal's path. */
  path: string;
};

type AutoPlan = {
  account: AccountBrief;
  from?: string;
  to?: string;
  maxDays: number;
};

function runMatch(ctx: AppContext, plan: MatchPlan): AppResult<BankValue> {
  const lineId = plan.line.id;
  const matched: { id: number; no: string; amount: string }[] = [];
  for (const target of plan.targets) {
    const movement = getMovementCandidate(ctx.db, target.movementId);
    if (!movement) return fail("NOT_FOUND", "That record no longer exists.");
    const existing = listMovementAllocations(ctx.db, target.movementId);
    const recordLeft = Math.abs(movement.amountMinor) - sumMinor(existing);
    const left = lineLeft(ctx.db, plan.line);
    const amountMinor = target.amountMinor ?? Math.min(left, recordLeft);
    if (amountMinor <= 0)
      return fail(
        "REFUSED",
        target.amountMinor !== undefined
          ? "A match amount must be above zero."
          : left <= 0
            ? `${lineRef(lineId)} is already matched in full. Unmatch it first to match it elsewhere.`
            : `${recordNo(target.record)} is already covered by bank lines in full.`,
      );
    // Every match the record already has stays; this line's share grows.
    const merged = existing.map((a) => ({
      lineId: a.lineId,
      amount: a.amount,
    }));
    const same = merged.find((a) => a.lineId === lineId);
    if (same) same.amount = fromMinor(toMinor(same.amount, 1) + amountMinor);
    else merged.push({ lineId, amount: fromMinor(amountMinor) });
    const saved = setMovementMatches(
      ctx,
      target.movementId,
      merged,
      movementMatchesVersion(ctx.db, target.movementId),
    );
    if (!saved.ok) return saved;
    matched.push({
      id: target.record.id,
      no: recordNo(target.record),
      amount: money(amountMinor),
    });
  }
  return ok({
    line: lineRef(lineId),
    date: plan.line.date,
    amount: money(toMinor(plan.line.amount, 1)),
    currency: mainCurrency(ctx.db),
    matched,
    line_unmatched: money(lineLeft(ctx.db, plan.line)),
    v: statementLineVersion(ctx.db, lineId),
  });
}

function runFromLines(
  ctx: AppContext,
  plan: FromLinesPlan,
): AppResult<BankValue> {
  const before = new Map(
    plan.allocate.map((a) => [
      a.line.movementId,
      outstandingNow(ctx.db, a.line.movementId),
    ]),
  );
  const used = new Map<number, number>();
  const allocations: { owedMovementId: number; amountMinor: number }[] = [];
  for (const a of plan.allocate) {
    const amountMinor =
      a.amountMinor ??
      (before.get(a.line.movementId) ?? 0) - (used.get(a.line.movementId) ?? 0);
    if (amountMinor <= 0)
      return fail(
        "REFUSED",
        a.amountMinor !== undefined
          ? "Allocation amounts must be above zero."
          : `${recordNo(a.record)} has nothing outstanding. Leave it out.`,
      );
    used.set(
      a.line.movementId,
      (used.get(a.line.movementId) ?? 0) + amountMinor,
    );
    allocations.push({ owedMovementId: a.line.movementId, amountMinor });
  }
  const created = createRecordFromLines(ctx, {
    lineIds: plan.lines.map((line) => line.id),
    kind: plan.kind,
    ...(plan.category ? { categoryAccountId: plan.category.id } : {}),
    ...(plan.otherAccount ? { otherAccountId: plan.otherAccount.id } : {}),
    ...(plan.contact ? { contactId: plan.contact.id } : {}),
    ...(plan.description ? { description: plan.description } : {}),
    ...(plan.date ? { date: plan.date } : {}),
    ...(plan.tax && plan.category
      ? {
          taxOverrides: [
            { ...plan.tax, accountId: plan.category.id, occurrence: 0 },
          ],
        }
      : {}),
    ...(allocations.length ? { allocations } : {}),
    ...(plan.direction ? { direction: plan.direction } : {}),
    ...(plan.settlementAccount
      ? { settlementAccountId: plan.settlementAccount.id }
      : {}),
  });
  if (!created.ok) {
    const choices = (created as PaymentDirectionFailure).paymentDirections;
    if (!choices) return created;
    const failure: ItemFailure = {
      ...created,
      path: `${plan.path}.direction`,
      fix: `Send direction (${choices.map((d) => d.replaceAll("-", "_")).join(" or ")}), or settlement_account, then call again.`,
    };
    return failure;
  }
  const { record, version, amountMinor, lineVersions } = created.value;
  const value: BankValue = {
    record: {
      id: record.id,
      no: recordNo(record),
      kind: plan.kind,
      date: record.date,
      description: record.description,
      amount: money(amountMinor),
      v: version,
    },
    currency: mainCurrency(ctx.db),
    lines: plan.lines.map((line) => ({
      line: lineRef(line.id),
      v: lineVersions[line.id],
    })),
  };
  // What a record still owes is shown only to a caller who may read records
  // (`showsBalances`), as in record_payments.
  const shown = showsBalances(ctx);
  if (plan.allocate.length)
    value.allocated = plan.allocate.map((a, i) => ({
      id: a.record.id,
      no: recordNo(a.record),
      amount: money(allocations[i].amountMinor),
      ...(shown
        ? {
            outstanding_before: money(before.get(a.line.movementId) ?? 0),
            outstanding_after: money(outstandingNow(ctx.db, a.line.movementId)),
          }
        : {}),
    }));
  return ok(value);
}

function runAutoMatch(ctx: AppContext, plan: AutoPlan): AppResult<BankValue> {
  const result = autoMatchTolerant(ctx, {
    accountId: plan.account.id,
    ...(plan.from ? { from: plan.from } : {}),
    ...(plan.to ? { to: plan.to } : {}),
    maxDays: plan.maxDays,
  });
  if (!result.ok) return result;
  return ok({
    account: `${plan.account.code} ${plan.account.name}`,
    max_days: plan.maxDays,
    currency: mainCurrency(ctx.db),
    matched: result.value.matched.map((pair) => ({
      line: lineRef(pair.lineId),
      record: recordOf(ctx, pair.recordId),
      amount: money(Math.abs(pair.amountMinor)),
      direction: pair.amountMinor < 0 ? "out" : "in",
      days: pair.days,
    })),
    skipped: result.value.skipped.map((s) => ({
      line: lineRef(s.lineId),
      reason: s.reason,
    })),
  });
}

/** The record's one side on the line's account; a miss is recorded in `refs`. */
function sideFor(
  refs: Refs,
  line: BankLineBrief,
  record: RecordBrief,
  path: string,
): number | undefined {
  const sides = sidesOn(refs.ctx.db, record.id, line.accountId);
  if (sides.length === 1) return sides[0].id;
  refs.errors.push(
    sides.length === 0
      ? {
          code: "NOT_FOUND",
          path,
          message: `${path}: ${recordNo(record)} moved no money through the account ${lineRef(line.id)} is on, so the line cannot cover it.`,
          fix: `Choose a record on that account (the reconciliation lists candidates), or book the line with create_from_lines.`,
        }
      : {
          code: "REFUSED",
          path,
          message: `${path}: ${recordNo(record)} has ${sides.length} lines on the account ${lineRef(line.id)} is on, so which one the line covers cannot be told.`,
          fix: "Match this line in Akaun, where each side can be chosen.",
        },
  );
  return undefined;
}

function taxOf(
  refs: Refs,
  tax: NonNullable<NonNullable<MatchArgs["create_from_lines"]>[number]["tax"]>,
  path: string,
): FromLinesPlan["tax"] | undefined {
  let percentageBps: number | null;
  if (tax.percent !== undefined) {
    percentageBps = percentageToBps(tax.percent);
    if (percentageBps === null) {
      refs.invalid(
        `${path}.percent`,
        `"${tax.percent}" is not a percentage from 0 to 100.`,
        'Send it as a decimal string, e.g. "50" or "33.33".',
      );
      return undefined;
    }
  } else if (tax.treatment === "ordinary_deductible") percentageBps = 10000;
  else if (
    tax.treatment === "non_deductible" ||
    tax.treatment === "capital_expenditure"
  )
    percentageBps = 0;
  else if (tax.treatment === "requires_review") percentageBps = null;
  else {
    refs.invalid(
      `${path}.percent`,
      "A partial treatment needs the deductible percentage.",
      'Add percent, e.g. "50".',
    );
    return undefined;
  }
  return { treatment: tax.treatment, percentageBps, reason: tax.reason };
}

const matchBankLines = defineWriteTool({
  base: "match_bank_lines",
  title: "Match bank lines",
  description: MATCH_BANK_LINES_DESCRIPTION,
  input: matchBankLinesInput,
  annotations: {
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  requirements: MATCH_BANK_LINES.requirements,
  actions: MATCH_BANK_LINES.actions,
  handler: async (ctx, args, meta) => {
    const refused = refuseActions(ctx, meta, "match_bank_lines", args);
    if (refused) return refused;
    const call = batchCall(meta, args, {
      match: args.match,
      create_from_lines: args.create_from_lines,
      auto_match: args.auto_match,
    });
    // Before any reference is resolved: a retry replays the first answer.
    const replay = storedReplay<BankValue>(ctx, call);
    if (replay) return batchReply(redactBalances(ctx, replay), meta);
    if (
      !args.match?.length &&
      !args.create_from_lines?.length &&
      !args.auto_match
    )
      return nothingToDo("match, create_from_lines or auto_match");

    const refs = new Refs(ctx, meta);
    const matches: MatchPlan[] = (args.match ?? []).flatMap((item, i) => {
      const path = `match[${i}]`;
      const line = refs.line(item.line, `${path}.line`);
      const targets = item.records.flatMap((r, j) => {
        const at = `${path}.records[${j}].record`;
        const record = refs.record(r.record, at);
        const movementId = line && record && sideFor(refs, line, record, at);
        return record && movementId
          ? [{ record, movementId, amountMinor: r.amount }]
          : [];
      });
      return line && targets.length === item.records.length
        ? [{ line, targets }]
        : [];
    });

    const fromLines: FromLinesPlan[] = (args.create_from_lines ?? []).flatMap(
      (item, i) => {
        const path = `create_from_lines[${i}]`;
        const lines = item.lines.flatMap((ref, j) => {
          const line = refs.line(ref, `${path}.lines[${j}]`);
          return line ? [line] : [];
        });
        const category =
          item.category === undefined
            ? undefined
            : refs.account(item.category, `${path}.category`, {
                where: isCategoryAccount,
                wanted: "a category",
              });
        const otherAccount =
          item.other_account === undefined
            ? undefined
            : refs.account(item.other_account, `${path}.other_account`);
        const contact =
          item.contact === undefined
            ? undefined
            : refs.contact(item.contact, `${path}.contact`);
        if (item.tax && item.kind !== "expense")
          refs.invalid(
            `${path}.tax`,
            "Only an expense takes a tax treatment here.",
            "Leave tax out, or set it later on the record.",
          );
        const tax =
          item.tax && item.kind === "expense"
            ? taxOf(refs, item.tax, `${path}.tax`)
            : undefined;
        if (
          item.kind !== "payment" &&
          (item.direction !== undefined ||
            item.settlement_account !== undefined)
        )
          refs.invalid(
            `${path}.direction`,
            "Only a payment takes a direction or a settlement_account.",
            "Leave direction and settlement_account out.",
          );
        const settlementAccount =
          item.settlement_account === undefined
            ? undefined
            : refs.account(
                item.settlement_account,
                `${path}.settlement_account`,
              );
        const allocate = (item.allocate ?? []).flatMap((a, j) => {
          const at = `${path}.allocate[${j}]`;
          if (a.amount === undefined && !showsBalances(refs.ctx))
            needAmount(refs, `${at}.amount`);
          const found = refs.openItem(a.record, at, a.line_account);
          return found ? [{ ...found, amountMinor: a.amount }] : [];
        });
        if (
          lines.length !== item.lines.length ||
          (item.category !== undefined && !category) ||
          (item.other_account !== undefined && !otherAccount) ||
          (item.contact !== undefined && !contact) ||
          (item.tax && !tax) ||
          (item.settlement_account !== undefined && !settlementAccount) ||
          allocate.length !== (item.allocate ?? []).length
        )
          return [];
        return [
          {
            lines,
            kind: item.kind,
            category,
            otherAccount,
            contact,
            description: item.description,
            date: item.date,
            tax,
            allocate,
            ...(item.direction
              ? { direction: toAppDirection(item.direction) }
              : {}),
            settlementAccount,
            path,
          },
        ];
      },
    );

    let auto: AutoPlan | undefined;
    if (args.auto_match) {
      const account = refs.account(
        args.auto_match.account,
        "auto_match.account",
        {
          where: isMoneyPotAccount,
          wanted: "a money account (bank, cash or card)",
        },
      );
      const period = parsePeriod({ period: args.auto_match.period });
      if (!period.ok)
        refs.errors.push({ ...period.error, path: "auto_match.period" });
      if (account && period.ok)
        auto = {
          account,
          ...(period.value?.from ? { from: period.value.from } : {}),
          ...(period.value?.to ? { to: period.value.to } : {}),
          maxDays: args.auto_match.max_days ?? AUTO_MATCH_DEFAULT_DAYS,
        };
    }
    const missed = refs.failure();
    if (missed) return missed;

    const result = await runBatch<BankValue>(ctx, {
      ...call,
      items: [
        ...matches.map((plan, i) => ({
          action: "match",
          label: `match[${i}] ${lineRef(plan.line.id)}`,
          run: (c: AppContext) => runMatch(c, plan),
        })),
        ...fromLines.map((plan, i) => ({
          action: "create_from_lines",
          label: `create_from_lines[${i}]`,
          run: (c: AppContext) => runFromLines(c, plan),
        })),
        ...(auto
          ? [
              {
                action: "auto_match",
                label: "auto_match",
                run: (c: AppContext) => runAutoMatch(c, auto),
              },
            ]
          : []),
      ],
    });
    return batchReply(redactBalances(ctx, result), meta);
  },
});

// --- unmatch_bank_lines -------------------------------------------------------

const unmatchBankLinesInput = z.object({
  unmatch: z
    .array(
      z.object({
        line: lineInput,
        record: refInput
          .optional()
          .describe(
            "Only this record's match. Omitted: every match the line has.",
          ),
        expected_version: z
          .string()
          .min(1)
          .describe(
            "The line's v, from the reconciliation or an earlier match.",
          ),
      }),
    )
    .min(1)
    .max(50, SPLIT_CALL),
  ...batchControls,
});

const UNMATCH_BANK_LINES_DESCRIPTION = `Undo bank matches: the line no longer covers the record, and both read as unmatched again. Use it when a line was matched to the wrong record, before matching it to the right one, or to free a record whose amount or date must change (a match locks them).

unmatch[]: {line, record?, expected_version}. line is L123. record (id or number) removes only that record's match; omitted, every match the line has is removed. expected_version is the line's v from the reconciliation (or from the match result); a stale one answers CONFLICT with current_version, so read again.

Only the matches change. The bank line itself is never edited, and the records keep their amounts, dates and payments. The result lists each record unmatched with the amount the line had covered, what is now unmatched on the line, and its new v.

This changes the books: run it with dry_run: true first, show the user what would be unmatched, and save only after they agree. Up to 50 items per call, saved together or not at all. idempotency_key makes a retried call return the first result.`;

type UnmatchPlan = {
  line: BankLineBrief;
  record?: RecordBrief;
  expectedVersion: string;
};

function runUnmatch(ctx: AppContext, plan: UnmatchPlan): AppResult<BankValue> {
  const lineId = plan.line.id;
  const stale = checkVersion(
    statementLineVersion(ctx.db, lineId),
    plan.expectedVersion,
  );
  if (stale) return stale;
  const allocations = listLineAllocations(ctx.db, lineId).filter(
    (a): a is typeof a & { movementId: number } => a.movementId !== null,
  );
  const mine = plan.record
    ? new Set(
        sidesOn(ctx.db, plan.record.id, plan.line.accountId).map((s) => s.id),
      )
    : null;
  const targets = mine
    ? allocations.filter((a) => mine.has(a.movementId))
    : allocations;
  if (!targets.length)
    return fail(
      "REFUSED",
      allocations.length && plan.record
        ? `${lineRef(lineId)} is not matched to ${recordNo(plan.record)}. Nothing to undo.`
        : `${lineRef(lineId)} is not matched to anything. Nothing to undo.`,
    );
  const unmatched: { id: number; no: string; amount: string }[] = [];
  for (const movementId of new Set(targets.map((a) => a.movementId))) {
    const kept = listMovementAllocations(ctx.db, movementId)
      .filter((a) => a.lineId !== lineId)
      .map((a) => ({ lineId: a.lineId, amount: a.amount }));
    const covered = sumMinor(
      targets.filter((a) => a.movementId === movementId),
    );
    const recordId = getMovementCandidate(ctx.db, movementId)?.recordId;
    const saved = setMovementMatches(
      ctx,
      movementId,
      kept,
      movementMatchesVersion(ctx.db, movementId),
    );
    if (!saved.ok) return saved;
    if (recordId !== undefined)
      unmatched.push({ ...recordOf(ctx, recordId), amount: money(covered) });
  }
  return ok({
    line: lineRef(lineId),
    currency: mainCurrency(ctx.db),
    unmatched,
    line_unmatched: money(lineLeft(ctx.db, plan.line)),
    v: statementLineVersion(ctx.db, lineId),
  });
}

const unmatchBankLines = defineWriteTool({
  base: "unmatch_bank_lines",
  title: "Unmatch bank lines",
  description: UNMATCH_BANK_LINES_DESCRIPTION,
  input: unmatchBankLinesInput,
  annotations: {
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  requirements: UNMATCH_BANK_LINES.requirements,
  actions: UNMATCH_BANK_LINES.actions,
  handler: async (ctx, args, meta) => {
    const refused = refuseActions(ctx, meta, "unmatch_bank_lines", args);
    if (refused) return refused;
    const call = batchCall(meta, args, { unmatch: args.unmatch });
    // Before any reference is resolved: a retry replays the first answer.
    const replay = storedReplay<BankValue>(ctx, call);
    if (replay) return batchReply(replay, meta);

    const refs = new Refs(ctx, meta);
    const plans: UnmatchPlan[] = args.unmatch.flatMap((item, i) => {
      const path = `unmatch[${i}]`;
      const line = refs.line(item.line, `${path}.line`);
      const record =
        item.record === undefined
          ? undefined
          : refs.record(item.record, `${path}.record`);
      if (!line || (item.record !== undefined && !record)) return [];
      return [{ line, record, expectedVersion: item.expected_version }];
    });
    const missed = refs.failure();
    if (missed) return missed;

    const result = await runBatch<BankValue>(ctx, {
      ...call,
      items: plans.map((plan, i) => ({
        action: "unmatch",
        label: `unmatch[${i}] ${lineRef(plan.line.id)}`,
        run: (c: AppContext) => runUnmatch(c, plan),
      })),
    });
    return batchReply(result, meta);
  },
});

/** The bank write tools, in listing order. */
export const bankWriteTools: readonly ToolDefinition[] = [
  matchBankLines,
  unmatchBankLines,
];
