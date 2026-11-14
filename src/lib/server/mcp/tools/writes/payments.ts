import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { DefaultAccountPurpose } from "$lib/enums.js";
import type { LeafPermission } from "$lib/permissions/catalog.js";
import { can } from "../../../permissions.js";
import {
  hashInput,
  runBatch,
  storedReplay,
  type BatchResult,
  type ReplayLookup,
} from "../../../application/batch.js";
import { createRecord, settlePayment } from "../../../application/records.js";
import { createReimbursement } from "../../../application/reimbursements.js";
import {
  correctPaymentAllocations,
  preparePaymentCorrection,
} from "../../../application/payment-corrections.js";
import {
  resolveAccount,
  resolveBankLine,
  resolveContact,
  resolveOpenItem,
  resolvePaymentMovement,
  resolveRecord,
  resolveSettlement,
  type AccountBrief,
  type AccountRefOptions,
  type BankLineBrief,
  type ContactBrief,
  type ControlLine,
  type RecordBrief,
  type Resolved,
  type SettlementBrief,
} from "../../../application/refs.js";
import type { AppContext } from "../../../application/context.js";
import { fail, ok, type AppResult } from "../../../application/result.js";
import { recordVersion } from "../../../application/version.js";
import { accountDefaultId } from "../../../services/account-defaults.js";
import { isMoneyPotAccount } from "../../../ledger/account-type.js";
import { fromMinor } from "../../../ledger/money.js";
import { outstandingOf } from "../../../ledger/settlement-rules.js";
import type { LedgerDb } from "../../../ledger/types.js";
import { getSide } from "../../../queries/settlements.js";
import { batchToolResult } from "../../batch-result.js";
import { toolError, type ToolErrorBody } from "../../envelope.js";
import { dateInput, mainCurrency, money, moneyInput } from "../../format.js";
import { resolveError } from "../../resolve.js";
import {
  defineWriteTool,
  type ToolCallMeta,
  type ToolContext,
  type ToolDefinition,
} from "../../registry.js";
import {
  actionRefusal,
  actionsInArguments,
  CHANGE_ALLOCATIONS,
  missingForActions,
  RECORD_PAYMENTS,
} from "../../requirements/index.js";

/**
 * The payment write tools: `record_payments` and `change_allocations`.
 *
 * An agent names records by id or number and never sees a movement or a
 * settlement id. Every reference is resolved before the batch opens (A4's
 * `refs.ts`), so a miss comes back as `NOT_FOUND` / `AMBIGUOUS` with
 * candidates and nothing runs. A retry with the same idempotency_key is
 * answered before that (`storedReplay`), because what it changed may no
 * longer resolve. Each item then calls exactly one operation in
 * `application/`, which keeps every rule: a payment is in the main currency, a
 * refund must use up the overpayment in full, a correction keeps its reversed
 * allocation rows.
 *
 * The shared reference helpers at the bottom are used by `bank.ts` too.
 */

// --- shared input pieces ------------------------------------------------------

/** A record, an account or a contact: a number is an id, a string a number, code or name. */
export const refInput = z
  .union([z.number().int().positive(), z.string().trim().min(1).max(200)])
  .describe(
    'An id (a number), or a record number / account code or name / contact name (a string), e.g. "EXP-2026-0042".',
  );

/** Picks one of a record's owed lines when it has several (the `accountId` an AMBIGUOUS answer offers). */
export const lineAccountInput = refInput.describe(
  "Only when the record has several owed lines: the account of the line meant, from an AMBIGUOUS answer's candidates.",
);

export const SPLIT_CALL =
  "At most 50 items per call. Split the work into several calls.";

export const batchControls = {
  dry_run: z
    .boolean()
    .optional()
    .describe("true: run every rule and report the result, saving nothing."),
  idempotency_key: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Any unique string. A retry with the same key and input returns the first result instead of saving twice.",
    ),
};

// --- record_payments ----------------------------------------------------------

const DIRECTIONS = [
  "we_pay",
  "we_receive",
  "refund_received",
  "refund_paid",
] as const;
type Direction = (typeof DIRECTIONS)[number];
type AppDirection = "we-pay" | "we-receive" | "refund-received" | "refund-paid";
const toApp = (d: Direction) => d.replaceAll("_", "-") as AppDirection;
const fromApp = (d: AppDirection) => d.replaceAll("-", "_") as Direction;

const allocationInput = z.object({
  record: refInput.describe("The record being settled: id or number."),
  amount: moneyInput
    .optional()
    .describe(
      'Decimal string in the main currency, e.g. "120.00". Omitted: what is still outstanding on it.',
    ),
  line_account: lineAccountInput.optional(),
});

const payInput = z.object({
  direction: z
    .enum(DIRECTIONS)
    .optional()
    .describe(
      "we_pay settles what we owe; we_receive what is owed to us; refund_received / refund_paid return an overpayment. Omitted: worked out from the records.",
    ),
  contact: refInput.describe("Who was paid, or who paid: id or exact name."),
  account: refInput.describe(
    "The money account the payment left or arrived in (bank, cash, card).",
  ),
  date: dateInput,
  amount: moneyInput.describe(
    'Decimal string in the main currency, e.g. "1285.50". "0" with use_credit applies credit only.',
  ),
  allocate: z.array(allocationInput).max(200).optional(),
  use_credit: z
    .array(
      z.object({
        record: refInput.describe(
          "The earlier payment or credit of this contact: id or number.",
        ),
        to: refInput
          .optional()
          .describe(
            "The record the credit settles. Omitted: the one record in allocate.",
          ),
        amount: moneyInput,
        line_account: lineAccountInput.optional(),
      }),
    )
    .max(200)
    .optional(),
  reference: z.string().trim().max(200).optional(),
  description: z.string().trim().max(500).optional(),
});

const allocateInput = z.object({
  payment: refInput.describe(
    "The existing payment, receipt or credit record: id or number.",
  ),
  to: z.array(allocationInput).min(1).max(200),
});

const reimburseInput = z.object({
  contact: refInput.describe("The person being repaid: id or exact name."),
  date: dateInput,
  description: z.string().trim().min(1).max(500),
  items: z
    .array(refInput)
    .min(1)
    .max(200)
    .describe(
      "The expense records they paid personally; each is repaid in full.",
    ),
  cash: moneyInput
    .optional()
    .describe('Money paid to them now, e.g. "86.40". Omitted: none.'),
  paid_from: refInput
    .optional()
    .describe("The money account the cash left. Required with cash."),
  credits: z
    .array(
      z.object({
        record: refInput.describe("Their earlier payment or credit record."),
        amount: moneyInput,
      }),
    )
    .max(200)
    .optional(),
  reference: z.string().trim().max(200).optional(),
});

const recordPaymentsInput = z.object({
  pay: z.array(payInput).max(50, SPLIT_CALL).optional(),
  allocate: z.array(allocateInput).max(50, SPLIT_CALL).optional(),
  reimburse: z.array(reimburseInput).max(50, SPLIT_CALL).optional(),
  ...batchControls,
});
type RecordPaymentsArgs = z.output<typeof recordPaymentsInput>;

const RECORD_PAYMENTS_DESCRIPTION = `Record money paid or received against what is owed, and apply payments or credits that already exist. Use it, not a plain record, when a bill, invoice or claim is paid: name records by id or number (e.g. "EXP-2026-0042") and the server finds the line each one owes.

- pay[]: a new payment or receipt in the main currency, out of or into a money account (bank, cash, card). allocate lists what it settles. use_credit first applies an earlier payment or credit of the same contact (to = the record it settles). direction is worked out from the records when omitted. A refund must use up the overpayment in full. amount "0" with use_credit applies credit only.
- allocate[]: apply an existing payment or credit to open records of the same contact.
- reimburse[]: repay one person for expenses they paid personally: items are the expense records; cash with paid_from is paid now; credits are their earlier credit.

Amounts are decimal strings in the main currency ("1285.50"); an omitted allocation amount takes what is outstanding (without records.read, send every amount). A record with two owed lines answers AMBIGUOUS: resend with line_account from the candidates.

The result gives each record's outstanding before and after (with records.read), and each payment's v and allocations_v (to change its allocations later). Up to 50 items per call, saved all or nothing. dry_run: true saves nothing; idempotency_key makes a retried call return the first result. Bookkeeping only: no money is sent.`;

/** Readable figures for one owed record, before and after the item ran. */
type Settled = {
  id: number;
  no: string;
  amount?: string;
  /** Only for a caller who may read records (`showsBalances`). */
  outstanding_before?: string;
  outstanding_after?: string;
};

type PaymentValue = Record<string, unknown>;

/** The record's own name in output: its number, or `#id`. */
export function recordNo(record: Pick<RecordBrief, "id" | "recordNumber">) {
  return record.recordNumber ?? `#${record.id}`;
}

/** What is still owed (or, on a payment's line, unapplied) on a movement now. */
export function outstandingNow(db: LedgerDb, movementId: number): number {
  const side = getSide(db, movementId);
  return side ? outstandingOf(side) : 0;
}

/**
 * Whether the caller may see balances: what is still outstanding on a record,
 * unapplied on a payment, or left on a credit. Each is a fact about records
 * the caller names, so it needs `records.read`; a create-only caller (the
 * seeded Data Entry group) gets only the figures it sent, and must send every
 * allocation amount, since filling one in from the balance would show it.
 */
export function showsBalances(ctx: { locals: App.Locals }): boolean {
  return can(ctx.locals, "records.read");
}

/** A path's refusal for an omitted amount that would be filled in from a balance. */
function needAmount(refs: Refs, path: string): void {
  refs.invalid(
    path,
    "Without permission to read records, an allocation amount is not filled in from what is outstanding.",
    "Send amount for this record: the sum this payment settles on it.",
  );
}

/** The saved receivable / payable / reimbursements-payable accounts, by role. */
function controlAccounts(db: LedgerDb) {
  const payable = [
    accountDefaultId(db, DefaultAccountPurpose.Payable),
    accountDefaultId(db, DefaultAccountPurpose.ReimbursementsPayable),
  ].filter((id): id is number => id !== null);
  const receivable = accountDefaultId(db, DefaultAccountPurpose.Receivable);
  return { payable, receivable };
}

/** The direction a payment settling this owed line takes. */
function directionFor(db: LedgerDb, line: ControlLine): AppDirection | null {
  const { payable, receivable } = controlAccounts(db);
  if (payable.includes(line.accountId))
    return line.amountMinor < 0 ? "we-pay" : "refund-received";
  if (line.accountId === receivable)
    return line.amountMinor > 0 ? "we-receive" : "refund-paid";
  return null;
}

/** The new payment's version and its allocation version, for a later change. */
function versionsOf(ctx: AppContext, recordId: number, movementId?: number) {
  const out: { v: string; allocations_v?: string } = {
    v: recordVersion(ctx.db, recordId),
  };
  if (movementId !== undefined) {
    const prepared = preparePaymentCorrection(ctx, movementId);
    if (prepared.ok) out.allocations_v = prepared.value.version;
  }
  return out;
}

type PayPlan = {
  path: string;
  contact: ContactBrief;
  account: AccountBrief;
  date: string;
  amountMinor: number;
  direction: AppDirection;
  settlementAccountId?: number;
  reference?: string;
  description: string;
  allocate: { record: RecordBrief; line: ControlLine; amountMinor?: number }[];
  credits: {
    credit: RecordBrief;
    creditLine: ControlLine;
    /** The record the credit settles. */
    record: RecordBrief;
    line: ControlLine;
    amountMinor: number;
  }[];
};

type AllocatePlan = {
  payment: RecordBrief;
  paymentLine: ControlLine;
  to: { record: RecordBrief; line: ControlLine; amountMinor?: number }[];
};

type ReimbursePlan = {
  contact: ContactBrief;
  date: string;
  description: string;
  reference?: string;
  items: { record: RecordBrief; line: ControlLine }[];
  cashMinor: number;
  paidFrom?: AccountBrief;
  credits: {
    credit: RecordBrief;
    creditLine: ControlLine;
    amountMinor: number;
  }[];
};

const DESCRIPTION_WORD: Record<AppDirection, string> = {
  "we-pay": "Payment",
  "we-receive": "Receipt",
  "refund-received": "Refund received",
  "refund-paid": "Refund paid",
};

/** `pay[i]` with every reference resolved, or nothing when one missed (the miss is in `refs`). */
function planPay(
  refs: Refs,
  pay: RecordPaymentsArgs["pay"] & object,
): PayPlan[] {
  const plans: PayPlan[] = [];
  pay.forEach((item, i) => {
    const path = `pay[${i}]`;
    const contact = refs.contact(item.contact, `${path}.contact`);
    const account = refs.account(item.account, `${path}.account`, {
      where: isMoneyPotAccount,
      wanted: "a money account (bank, cash or card)",
    });
    const allocate = (item.allocate ?? []).flatMap((a, j) => {
      const at = `${path}.allocate[${j}]`;
      if (a.amount === undefined && !showsBalances(refs.ctx))
        needAmount(refs, `${at}.amount`);
      const found = refs.openItem(a.record, at, a.line_account);
      return found ? [{ ...found, amountMinor: a.amount }] : [];
    });
    const credits = (item.use_credit ?? []).flatMap((c, j) => {
      const at = `${path}.use_credit[${j}]`;
      const credit = refs.record(c.record, `${at}.record`);
      const creditLine = credit && refs.paymentLine(credit, `${at}.record`);
      let target: { record: RecordBrief; line: ControlLine } | undefined;
      if (c.to !== undefined)
        target = refs.openItem(c.to, at, c.line_account, "to");
      else if (allocate.length === 1) target = allocate[0];
      else
        refs.invalid(
          `${at}.to`,
          "Say which record this credit settles.",
          "Add to: the record's id or number.",
        );
      return credit && creditLine && target
        ? [{ credit, creditLine, ...target, amountMinor: c.amount }]
        : [];
    });
    if (!contact || !account) return;
    if (
      allocate.length !== (item.allocate ?? []).length ||
      credits.length !== (item.use_credit ?? []).length
    )
      return;

    let direction = item.direction ? toApp(item.direction) : undefined;
    const lines = [...allocate, ...credits].map((a) => a.line);
    if (!direction) {
      const found = new Set(
        lines.map((line) => directionFor(refs.ctx.db, line)),
      );
      if (found.size === 1 && !found.has(null)) direction = [...found][0]!;
      else {
        refs.invalid(
          `${path}.direction`,
          found.size === 0
            ? "The direction cannot be worked out: this payment settles no record."
            : "The records it settles are owed in different directions.",
          found.size === 0
            ? "Send direction: we_pay, we_receive, refund_received or refund_paid."
            : "Split them into separate payments, or send direction.",
        );
        return;
      }
    }
    // A payable line on another saved payable account (a reimbursement
    // claim) is settled from that account, as the screen does.
    const accounts = new Set(lines.map((line) => line.accountId));
    const payableId = accountDefaultId(
      refs.ctx.db,
      DefaultAccountPurpose.Payable,
    );
    const shared = accounts.size === 1 ? [...accounts][0] : undefined;
    const settlementAccountId =
      (direction === "we-pay" || direction === "refund-received") &&
      shared !== undefined &&
      shared !== payableId
        ? shared
        : undefined;
    const numbers = [...allocate, ...credits].map((a) => recordNo(a.record));
    plans.push({
      path,
      contact,
      account,
      date: item.date,
      amountMinor: item.amount,
      direction,
      settlementAccountId,
      reference: item.reference,
      description:
        item.description ||
        `${DESCRIPTION_WORD[direction]}${numbers.length ? ` ${[...new Set(numbers)].join(", ")}` : ""}`,
      allocate,
      credits,
    });
  });
  return plans;
}

function planAllocate(
  refs: Refs,
  allocate: RecordPaymentsArgs["allocate"] & object,
): AllocatePlan[] {
  return allocate.flatMap((item, i) => {
    const path = `allocate[${i}]`;
    const payment = refs.record(item.payment, `${path}.payment`);
    const paymentLine = payment && refs.paymentLine(payment, `${path}.payment`);
    const to = item.to.flatMap((a, j) => {
      if (a.amount === undefined && !showsBalances(refs.ctx))
        needAmount(refs, `${path}.to[${j}].amount`);
      const found = refs.openItem(a.record, `${path}.to[${j}]`, a.line_account);
      return found ? [{ ...found, amountMinor: a.amount }] : [];
    });
    return payment && paymentLine && to.length === item.to.length
      ? [{ payment, paymentLine, to }]
      : [];
  });
}

function planReimburse(
  refs: Refs,
  reimburse: RecordPaymentsArgs["reimburse"] & object,
): ReimbursePlan[] {
  return reimburse.flatMap((item, i) => {
    const path = `reimburse[${i}]`;
    const contact = refs.contact(item.contact, `${path}.contact`);
    const items = item.items.flatMap((ref, j) => {
      const found = refs.openItem(ref, path, undefined, `items[${j}]`);
      return found ? [found] : [];
    });
    const paidFrom =
      item.paid_from === undefined
        ? undefined
        : refs.account(item.paid_from, `${path}.paid_from`, {
            where: isMoneyPotAccount,
            wanted: "a money account (bank, cash or card)",
          });
    const cashMinor = item.cash ?? 0;
    if (cashMinor > 0 && item.paid_from === undefined)
      refs.invalid(
        `${path}.paid_from`,
        "Cash paid now needs the account it left.",
        "Add paid_from: the bank, cash or card account.",
      );
    const credits = (item.credits ?? []).flatMap((c, j) => {
      const at = `${path}.credits[${j}].record`;
      const credit = refs.record(c.record, at);
      const creditLine = credit && refs.paymentLine(credit, at);
      return credit && creditLine
        ? [{ credit, creditLine, amountMinor: c.amount }]
        : [];
    });
    if (
      !contact ||
      items.length !== item.items.length ||
      credits.length !== (item.credits ?? []).length ||
      (item.paid_from !== undefined && !paidFrom)
    )
      return [];
    return [
      {
        contact,
        date: item.date,
        description: item.description,
        reference: item.reference,
        items,
        cashMinor,
        paidFrom,
        credits,
      },
    ];
  });
}

/** Outstanding on each movement now, keyed by movement. */
function snapshot(db: LedgerDb, movementIds: number[]) {
  return new Map(movementIds.map((id) => [id, outstandingNow(db, id)]));
}

function settledRows(
  ctx: AppContext,
  rows: { record: RecordBrief; line: ControlLine; amountMinor: number }[],
  before: Map<number, number>,
): Settled[] {
  const shown = showsBalances(ctx);
  return rows.map(({ record, line, amountMinor }) => ({
    id: record.id,
    no: recordNo(record),
    amount: money(amountMinor),
    ...(shown
      ? {
          outstanding_before: money(before.get(line.movementId) ?? 0),
          outstanding_after: money(outstandingNow(ctx.db, line.movementId)),
        }
      : {}),
  }));
}

/** An allocation's amount: as sent, or what is left on the line after the earlier rows of this item. */
function amountsFor<T extends { line: ControlLine; amountMinor?: number }>(
  rows: T[],
  before: Map<number, number>,
  alreadyUsed: Map<number, number> = new Map(),
): AppResult<(T & { amountMinor: number })[]> {
  const used = new Map(alreadyUsed);
  const out: (T & { amountMinor: number })[] = [];
  for (const row of rows) {
    const left =
      (before.get(row.line.movementId) ?? 0) -
      (used.get(row.line.movementId) ?? 0);
    const amountMinor = row.amountMinor ?? left;
    if (amountMinor <= 0)
      return fail(
        "REFUSED",
        row.amountMinor === undefined
          ? "A record in this item has nothing outstanding, so there is nothing to settle. Leave it out."
          : "Allocation amounts must be above zero.",
      );
    used.set(
      row.line.movementId,
      (used.get(row.line.movementId) ?? 0) + amountMinor,
    );
    out.push({ ...row, amountMinor });
  }
  return ok(out);
}

function runPay(ctx: AppContext, plan: PayPlan): AppResult<PaymentValue> {
  const touched = [
    ...plan.allocate.map((a) => a.line.movementId),
    ...plan.credits.flatMap((c) => [
      c.line.movementId,
      c.creditLine.movementId,
    ]),
  ];
  const before = snapshot(ctx.db, touched);
  const creditUse = new Map<number, number>();
  for (const c of plan.credits)
    creditUse.set(
      c.line.movementId,
      (creditUse.get(c.line.movementId) ?? 0) + c.amountMinor,
    );
  const allocations = amountsFor(plan.allocate, before, creditUse);
  if (!allocations.ok) return allocations;

  const created = createRecord(ctx, {
    kind: "payment",
    date: plan.date,
    description: plan.description,
    amount: fromMinor(plan.amountMinor),
    currency: mainCurrency(ctx.db),
    exchangeRate: 1,
    ...(plan.reference ? { reference: plan.reference } : {}),
    contactId: plan.contact.id,
    paidFromAccountId: plan.account.id,
    direction: plan.direction,
    ...(plan.settlementAccountId !== undefined
      ? { settlementAccountId: plan.settlementAccountId }
      : {}),
    settlements: allocations.value.map((a) => ({
      owedMovementId: a.line.movementId,
      amountMinor: a.amountMinor,
    })),
    creditApplications: plan.credits.map((c) => ({
      paymentMovementId: c.creditLine.movementId,
      owedMovementId: c.line.movementId,
      amountMinor: c.amountMinor,
    })),
  });
  if (!created.ok) return created;

  // Credit alone writes no new record: the operation answers with the record
  // it settled instead.
  const creditOnly = plan.amountMinor === 0 && plan.credits.length > 0;
  const value: PaymentValue = { direction: fromApp(plan.direction) };
  if (!creditOnly) {
    const record = created.value.record;
    const { payable, receivable } = controlAccounts(ctx.db);
    const own = record.movements.find(
      (m) => payable.includes(m.accountId) || m.accountId === receivable,
    );
    value.payment = {
      id: record.id,
      no: recordNo(record),
      date: record.date,
      amount: money(record.amountMinor),
      ...versionsOf(ctx, record.id, own?.id),
    };
    if (own && showsBalances(ctx))
      value.unapplied = money(outstandingNow(ctx.db, own.id));
  }
  value.currency = mainCurrency(ctx.db);
  value.allocated = settledRows(ctx, allocations.value, before);
  if (plan.credits.length)
    value.credit_used = plan.credits.map((c) => ({
      credit: recordNo(c.credit),
      ...(showsBalances(ctx)
        ? {
            credit_left: money(outstandingNow(ctx.db, c.creditLine.movementId)),
          }
        : {}),
      ...settledRows(ctx, [c], before)[0],
    }));
  return ok(value);
}

function runAllocate(
  ctx: AppContext,
  plan: AllocatePlan,
): AppResult<PaymentValue> {
  const paymentMovementId = plan.paymentLine.movementId;
  const before = snapshot(ctx.db, [
    paymentMovementId,
    ...plan.to.map((a) => a.line.movementId),
  ]);
  // An omitted amount takes what the owed line still needs, but never more
  // than the payment still has to give.
  let available = before.get(paymentMovementId) ?? 0;
  const rows: (AllocatePlan["to"][number] & { amountMinor: number })[] = [];
  for (const row of plan.to) {
    const owed = before.get(row.line.movementId) ?? 0;
    const amountMinor = row.amountMinor ?? Math.min(owed, available);
    if (amountMinor <= 0)
      return fail(
        "REFUSED",
        row.amountMinor !== undefined
          ? "Allocation amounts must be above zero."
          : owed <= 0
            ? `${recordNo(row.record)} has nothing outstanding. Leave it out.`
            : `${recordNo(plan.payment)} has nothing left to apply.`,
      );
    available -= amountMinor;
    rows.push({ ...row, amountMinor });
  }
  const settled = settlePayment(ctx, {
    paymentMovementId,
    allocations: rows.map((a) => ({
      owedMovementId: a.line.movementId,
      amountMinor: a.amountMinor,
    })),
  });
  if (!settled.ok) return settled;
  return ok({
    payment: {
      id: plan.payment.id,
      no: recordNo(plan.payment),
      ...versionsOf(ctx, plan.payment.id, paymentMovementId),
    },
    currency: mainCurrency(ctx.db),
    allocated: settledRows(ctx, rows, before),
    ...(showsBalances(ctx)
      ? {
          unapplied_before: money(before.get(paymentMovementId) ?? 0),
          unapplied: money(outstandingNow(ctx.db, paymentMovementId)),
        }
      : {}),
  });
}

function runReimburse(
  ctx: AppContext,
  plan: ReimbursePlan,
): AppResult<PaymentValue> {
  const before = snapshot(ctx.db, [
    ...plan.items.map((i) => i.line.movementId),
    ...plan.credits.map((c) => c.creditLine.movementId),
  ]);
  const items = plan.items.map((i) => ({
    ...i,
    amountMinor: before.get(i.line.movementId) ?? 0,
  }));
  const empty = items.find((i) => i.amountMinor <= 0);
  if (empty)
    return fail(
      "REFUSED",
      `${recordNo(empty.record)} has nothing outstanding to repay. Leave it out.`,
    );
  const result = createReimbursement(ctx, {
    contactId: plan.contact.id,
    date: plan.date,
    description: plan.description,
    reference: plan.reference ?? "",
    remark: "",
    personallyPaid: true,
    items: items.map((i) => ({
      owedMovementId: i.line.movementId,
      amountMinor: i.amountMinor,
    })),
    cashMinor: plan.cashMinor,
    paidFromAccountId: plan.paidFrom?.id ?? null,
    credits: plan.credits.map((c) => ({
      paymentMovementId: c.creditLine.movementId,
      amountMinor: c.amountMinor,
    })),
  });
  if (!result.ok) return result;
  const payment = result.value.payment;
  const value: PaymentValue = {};
  if (payment) {
    const own = payment.movements.find((m) =>
      controlAccounts(ctx.db).payable.includes(m.accountId),
    );
    value.payment = {
      id: payment.id,
      no: recordNo(payment),
      date: payment.date,
      amount: money(payment.amountMinor),
      ...versionsOf(ctx, payment.id, own?.id),
    };
  }
  value.currency = mainCurrency(ctx.db);
  // Each item is repaid in full, so its amount and the total are balances too.
  const shown = showsBalances(ctx);
  if (shown) {
    value.total = money(result.value.totalMinor);
    value.not_yet_repaid = money(result.value.remainingMinor);
  }
  value.items = shown
    ? settledRows(ctx, items, before)
    : items.map((i) => ({ id: i.record.id, no: recordNo(i.record) }));
  if (plan.credits.length)
    value.credit_used = plan.credits.map((c) => ({
      credit: recordNo(c.credit),
      amount: money(c.amountMinor),
      ...(shown
        ? {
            credit_left: money(outstandingNow(ctx.db, c.creditLine.movementId)),
          }
        : {}),
    }));
  return ok(value);
}

const recordPayments = defineWriteTool({
  base: "record_payments",
  title: "Record payments",
  description: RECORD_PAYMENTS_DESCRIPTION,
  input: recordPaymentsInput,
  annotations: {
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  requirements: RECORD_PAYMENTS.requirements,
  actions: RECORD_PAYMENTS.actions,
  handler: async (ctx, args, meta) => {
    const refused = refuseActions(ctx, meta, "record_payments", args);
    if (refused) return refused;
    const call = batchCall(meta, args, {
      pay: args.pay,
      allocate: args.allocate,
      reimburse: args.reimburse,
    });
    // Before any reference is resolved: a retry replays the first answer.
    const replay = storedReplay<PaymentValue>(ctx, call);
    if (replay) return batchReply(replay, meta);
    if (!args.pay?.length && !args.allocate?.length && !args.reimburse?.length)
      return nothingToDo("pay, allocate or reimburse");

    const refs = new Refs(ctx, meta);
    const pays = args.pay ? planPay(refs, args.pay) : [];
    const allocates = args.allocate ? planAllocate(refs, args.allocate) : [];
    const reimburses = args.reimburse
      ? planReimburse(refs, args.reimburse)
      : [];
    const missed = refs.failure();
    if (missed) return missed;

    const result = await runBatch<PaymentValue>(ctx, {
      ...call,
      items: [
        ...pays.map((plan, i) => ({
          action: "pay",
          label: `pay[${i}]`,
          run: (c: AppContext) => runPay(c, plan),
        })),
        ...allocates.map((plan, i) => ({
          action: "allocate",
          label: `allocate[${i}] ${recordNo(plan.payment)}`,
          run: (c: AppContext) => runAllocate(c, plan),
        })),
        ...reimburses.map((plan, i) => ({
          action: "reimburse",
          label: `reimburse[${i}]`,
          run: (c: AppContext) => runReimburse(c, plan),
        })),
      ],
    });
    return batchReply(result, meta);
  },
});

// --- change_allocations -------------------------------------------------------

const changeAllocationsInput = z.object({
  reallocate: z
    .array(
      z.object({
        payment: refInput.describe(
          "The payment, receipt or credit whose allocations change: id or number.",
        ),
        expected_version: z
          .string()
          .min(1)
          .describe(
            "The payment's allocations_v, from when it was recorded or read. A stale one answers CONFLICT with current_version.",
          ),
        remove: z
          .array(refInput)
          .max(200)
          .optional()
          .describe("Records whose allocation from this payment is reversed."),
        add: z.array(allocationInput).max(200).optional(),
        reason: z
          .string()
          .trim()
          .min(10)
          .max(2000)
          .describe("Why, in 10 to 2000 characters. Kept in the history."),
      }),
    )
    .min(1)
    .max(50, SPLIT_CALL),
  ...batchControls,
});

const CHANGE_ALLOCATIONS_DESCRIPTION = `Move a payment's allocations: reverse the records it was applied to wrongly and apply it to the right ones, in one step. Use it when a payment, receipt or credit settles the wrong bill or invoice, or settles it by the wrong amount. To pay something new, record a payment instead.

reallocate[]: payment (id or number), expected_version (the payment's allocations_v), remove (records whose allocation is reversed), add ({record, amount}: what to apply instead; an omitted amount takes what is outstanding) and reason (10+ characters, kept in the history). Records are named by id or number; the server finds the allocation and the owed line. A record with two owed lines answers AMBIGUOUS: resend with line_account from the candidates.

A reversal never deletes history: the reversed allocation stays on record as reversed, and the cash, the bank matches and every other allocation are untouched. Amounts are decimal strings in the main currency.

The result lists the reversed and new allocations, outstanding before and after for each record touched, what is left unapplied on the payment, and its new allocations_v.

This changes the books: run it with dry_run: true first, show the result, and save only after the user agrees. Up to 50 items per call, saved together or not at all. idempotency_key makes a retried call return the first result.`;

type ReallocatePlan = {
  payment: RecordBrief;
  paymentLine: ControlLine;
  expectedVersion: string;
  reason: string;
  remove: { record: RecordBrief; settlement: SettlementBrief }[];
  add: { record: RecordBrief; line: ControlLine; amountMinor?: number }[];
};

function runReallocate(
  ctx: AppContext,
  plan: ReallocatePlan,
): AppResult<PaymentValue> {
  const owedMovements = [
    ...plan.remove.map((r) => r.settlement.owedMovementId),
    ...plan.add.map((a) => a.line.movementId),
  ];
  const before = snapshot(ctx.db, [
    plan.paymentLine.movementId,
    ...owedMovements,
  ]);
  // What a removal gives back is available to the additions, and to the
  // owed lines it reopens.
  const freed = new Map<number, number>();
  for (const r of plan.remove)
    freed.set(
      r.settlement.owedMovementId,
      (freed.get(r.settlement.owedMovementId) ?? 0) - r.settlement.amountMinor,
    );
  const add = amountsFor(plan.add, before, freed);
  if (!add.ok) return add;
  const corrected = correctPaymentAllocations(ctx, {
    paymentMovementId: plan.paymentLine.movementId,
    removeSettlementIds: plan.remove.map((r) => r.settlement.id),
    allocations: add.value.map((a) => ({
      owedMovementId: a.line.movementId,
      amountMinor: a.amountMinor,
    })),
    reason: plan.reason,
    expectedVersion: plan.expectedVersion,
  });
  if (!corrected.ok) return corrected;

  const seen = new Set<number>();
  const records = [
    ...plan.remove.map((r) => ({
      record: r.record,
      movementId: r.settlement.owedMovementId,
    })),
    ...plan.add.map((a) => ({
      record: a.record,
      movementId: a.line.movementId,
    })),
  ].filter((r) => !seen.has(r.movementId) && seen.add(r.movementId));
  const shown = showsBalances(ctx);
  return ok({
    payment: {
      id: plan.payment.id,
      no: recordNo(plan.payment),
      v: recordVersion(ctx.db, plan.payment.id),
      allocations_v: corrected.value.version,
    },
    currency: mainCurrency(ctx.db),
    // A reversed allocation's amount was saved before; without records.read
    // it is left out with the balances.
    reversed: plan.remove.map((r) => ({
      id: r.record.id,
      no: recordNo(r.record),
      ...(shown ? { amount: money(r.settlement.amountMinor) } : {}),
    })),
    added: add.value.map((a) => ({
      id: a.record.id,
      no: recordNo(a.record),
      amount: money(a.amountMinor),
    })),
    ...(shown
      ? {
          records: records.map((r) => ({
            id: r.record.id,
            no: recordNo(r.record),
            outstanding_before: money(before.get(r.movementId) ?? 0),
            outstanding_after: money(outstandingNow(ctx.db, r.movementId)),
          })),
          unapplied_before: money(before.get(plan.paymentLine.movementId) ?? 0),
          unapplied: money(outstandingNow(ctx.db, plan.paymentLine.movementId)),
        }
      : {}),
  });
}

const changeAllocations = defineWriteTool({
  base: "change_allocations",
  title: "Change payment allocations",
  description: CHANGE_ALLOCATIONS_DESCRIPTION,
  input: changeAllocationsInput,
  annotations: {
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  requirements: CHANGE_ALLOCATIONS.requirements,
  actions: CHANGE_ALLOCATIONS.actions,
  handler: async (ctx, args, meta) => {
    const refused = refuseActions(ctx, meta, "change_allocations", args);
    if (refused) return refused;
    const call = batchCall(meta, args, { reallocate: args.reallocate });
    // Before any reference is resolved: the allocation a retry removes is
    // already reversed, so it would no longer resolve.
    const replay = storedReplay<PaymentValue>(ctx, call);
    if (replay) return batchReply(replay, meta);

    const refs = new Refs(ctx, meta);
    const plans: ReallocatePlan[] = [];
    args.reallocate.forEach((item, i) => {
      const path = `reallocate[${i}]`;
      if (!item.remove?.length && !item.add?.length) {
        refs.invalid(
          path,
          "This item neither removes nor adds an allocation.",
          "Send remove, add, or both.",
        );
        return;
      }
      const payment = refs.record(item.payment, `${path}.payment`);
      const paymentLine =
        payment && refs.paymentLine(payment, `${path}.payment`);
      const remove = (item.remove ?? []).flatMap((ref, j) => {
        const at = `${path}.remove[${j}]`;
        const owed = refs.record(ref, at);
        const settlement =
          payment && owed && refs.settlement(payment, owed, at);
        return owed && settlement ? [{ record: owed, settlement }] : [];
      });
      const add = (item.add ?? []).flatMap((a, j) => {
        if (a.amount === undefined && !showsBalances(ctx))
          needAmount(refs, `${path}.add[${j}].amount`);
        const found = refs.openItem(
          a.record,
          `${path}.add[${j}]`,
          a.line_account,
        );
        return found ? [{ ...found, amountMinor: a.amount }] : [];
      });
      if (
        payment &&
        paymentLine &&
        remove.length === (item.remove ?? []).length &&
        add.length === (item.add ?? []).length
      )
        plans.push({
          payment,
          paymentLine,
          expectedVersion: item.expected_version,
          reason: item.reason,
          remove,
          add,
        });
    });
    const missed = refs.failure();
    if (missed) return missed;

    const result = await runBatch<PaymentValue>(ctx, {
      ...call,
      items: plans.map((plan, i) => ({
        action: "reallocate",
        label: `reallocate[${i}] ${recordNo(plan.payment)}`,
        run: (c: AppContext) => runReallocate(c, plan),
      })),
    });
    return batchReply(result, meta);
  },
});

/** The payments write tools, in listing order. */
export const paymentsWriteTools: readonly ToolDefinition[] = [
  recordPayments,
  changeAllocations,
];

// --- shared helpers (also used by bank.ts) ------------------------------------

/** FORBIDDEN for the actions in this call the caller may not use, else null. */
export function refuseActions(
  ctx: ToolContext,
  meta: ToolCallMeta,
  base: string,
  args: unknown,
): CallToolResult | null {
  const shortfalls = missingForActions(
    ctx.locals,
    base,
    actionsInArguments(base, args),
  );
  return shortfalls.length
    ? toolError(actionRefusal(meta.name, shortfalls))
    : null;
}

/** INVALID_INPUT for a call that names no action at all. */
export function nothingToDo(actions: string): CallToolResult {
  return toolError({
    code: "INVALID_INPUT",
    message: `Nothing to do: send at least one of ${actions}.`,
    fix: `Add items to ${actions} and call again. Nothing was saved.`,
  });
}

/** The batch's idempotency slot for these action arrays (never `dry_run` or the key). */
export function idempotencyOf(
  args: { idempotency_key?: string },
  actions: Record<string, unknown>,
) {
  return args.idempotency_key
    ? { key: args.idempotency_key, inputHash: hashInput(actions) }
    : undefined;
}

/** What a write call's replay lookup and its batch share. */
export type BatchCall = ReplayLookup & { dryRun: boolean };

/**
 * This call's tool name, `dry_run` and the idempotency slot of these action
 * arrays. Build it once, right after the action check, and hand the same
 * object to `storedReplay` (before resolving any reference) and to `runBatch`,
 * so the two can never use a different key, input hash or tool name.
 */
export function batchCall(
  meta: ToolCallMeta,
  args: { dry_run?: boolean; idempotency_key?: string },
  actions: Record<string, unknown>,
): BatchCall {
  return {
    tool: meta.name,
    dryRun: args.dry_run ?? false,
    idempotency: idempotencyOf(args, actions),
  };
}

/**
 * A batch's outcome as the tool's answer, each item's value as it is. A replay
 * from `storedReplay` goes through here too, so it reads exactly as the first
 * call's answer did.
 */
export function batchReply<T extends Record<string, unknown>>(
  result: BatchResult<T>,
  meta: ToolCallMeta,
): CallToolResult {
  return batchToolResult(result, {
    requestId: meta.requestId,
    formatValue: (value) => value,
  });
}

type Ref = number | string;

/**
 * Resolves an agent's references for one call and collects every miss, so a
 * call with three bad references reports all three, and nothing runs.
 *
 * The resolvers ask for no permission. A miss's explanation and candidates
 * name other items, so they are shown only to a caller who may read that kind
 * of item; anyone else gets a bare NOT_FOUND. An exact reference resolves for
 * everyone, as an id always did: the operation that uses it asks its own
 * permission.
 */
export class Refs {
  readonly errors: ToolErrorBody[] = [];

  constructor(
    readonly ctx: ToolContext,
    readonly meta: ToolCallMeta,
  ) {}

  private missed<T>(
    result: Resolved<T>,
    o: {
      what: string;
      ref: Ref;
      path: string;
      leaf: LeafPermission;
      lookup?: string;
      fix?: string;
    },
  ): undefined {
    if (result.ok) return undefined;
    const readable = can(this.ctx.locals, o.leaf);
    this.errors.push(
      resolveError(readable ? result : { kind: "not_found", candidates: [] }, {
        what: o.what,
        ref: o.ref,
        path: o.path,
        lookup: o.lookup ? this.meta.nameOf(o.lookup) : undefined,
        fix: readable ? o.fix : undefined,
      }),
    );
    return undefined;
  }

  /** An INVALID_INPUT found while resolving (a missing field the input schema cannot see). */
  invalid(path: string, message: string, fix: string): void {
    this.errors.push({
      code: "INVALID_INPUT",
      path,
      message: `${path}: ${message}`,
      fix,
    });
  }

  record(ref: Ref, path: string): RecordBrief | undefined {
    const result = resolveRecord(this.ctx, ref);
    return result.ok
      ? result.value
      : this.missed(result, {
          what: "record",
          ref,
          path,
          leaf: "records.read",
          lookup: "search_records",
        });
  }

  account(
    ref: Ref,
    path: string,
    opts: AccountRefOptions = {},
  ): AccountBrief | undefined {
    const result = resolveAccount(this.ctx, ref, opts);
    return result.ok
      ? result.value
      : this.missed(result, {
          what: "account",
          ref,
          path,
          leaf: "accounts.read",
          lookup: "list_accounts",
        });
  }

  contact(ref: Ref, path: string): ContactBrief | undefined {
    const result = resolveContact(this.ctx, ref);
    return result.ok
      ? result.value
      : this.missed(result, {
          what: "contact",
          ref,
          path,
          leaf: "contacts.read",
          lookup: "find_contacts",
        });
  }

  line(ref: Ref, path: string): BankLineBrief | undefined {
    const result = resolveBankLine(this.ctx, ref);
    return result.ok
      ? result.value
      : this.missed(result, {
          what: "bank line",
          ref,
          path,
          leaf: "reconciliation.read",
          lookup: "get_bank_reconciliation",
        });
  }

  /** The account a `line_account` names: `null` when none was sent, `false` on a miss (recorded). */
  private lineAccount(
    ref: Ref | undefined,
    path: string,
  ): number | null | false {
    if (ref === undefined) return null;
    const account = this.account(ref, `${path}.line_account`, {
      includeArchived: true,
    });
    return account ? account.id : false;
  }

  /**
   * A record and the owed line a payment would settle. `field` is where the
   * record reference sits in the item (`record`, or `to` for a credit).
   */
  openItem(
    ref: Ref,
    path: string,
    lineAccount?: Ref,
    field = "record",
  ): { record: RecordBrief; line: ControlLine } | undefined {
    const record = this.record(ref, `${path}.${field}`);
    const accountId = this.lineAccount(lineAccount, path);
    if (!record || accountId === false) return undefined;
    const result = resolveOpenItem(this.ctx, record.id, {
      ...(accountId !== null ? { accountId } : {}),
    });
    return result.ok
      ? { record, line: result.value }
      : this.missed(result, {
          what: "owed line",
          ref,
          path: `${path}.${field}`,
          leaf: "records.read",
          fix:
            result.kind === "ambiguous"
              ? `Send ${path}.line_account with the id of the account whose line is meant, from candidates.`
              : undefined,
        });
  }

  /** The line a payment or credit record pays with. */
  paymentLine(record: RecordBrief, path: string): ControlLine | undefined {
    const result = resolvePaymentMovement(this.ctx, record.id);
    return result.ok
      ? result.value
      : this.missed(result, {
          what: "payment line",
          ref: recordNo(record),
          path,
          leaf: "records.read",
        });
  }

  /** The active allocation of `payment` to `owed`. */
  settlement(
    payment: RecordBrief,
    owed: RecordBrief,
    path: string,
  ): SettlementBrief | undefined {
    const result = resolveSettlement(this.ctx, payment.id, owed.id);
    return result.ok
      ? result.value
      : this.missed(result, {
          what: "allocation",
          ref: recordNo(owed),
          path,
          leaf: "records.read",
        });
  }

  /** The error to answer when anything missed; null when everything resolved. */
  failure(): CallToolResult | null {
    if (!this.errors.length) return null;
    if (this.errors.length === 1) return toolError(this.errors[0]);
    const codes = new Set(this.errors.map((e) => e.code));
    const body: ToolErrorBody & { errors: ToolErrorBody[] } = {
      code: codes.size === 1 ? this.errors[0].code : "NOT_FOUND",
      message: `${this.errors.length} parts of the input could not be used. Nothing was saved.`,
      fix: "Correct each one listed in errors, then send the whole call again.",
      errors: this.errors,
    };
    return toolError(body);
  }
}
