import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import type { CallToolResult } from "@modelcontextprotocol/server";
import {
  DefaultAccountPurpose,
  EntityType,
  LedgerRecordKind,
  LedgerRecordKindLabels,
  Role,
  RoleLabels,
} from "$lib/enums.js";
import { TAX_TREATMENTS, type TaxTreatment } from "$lib/expense-tax.js";
import { localToday } from "$lib/local-date.js";
import { accounts, ledgerRecords, reimbursements } from "../../../db/schema.js";
import type { LedgerDb, RecordView } from "../../../ledger/types.js";
import {
  formatMinor,
  fromMinor,
  parseMinor,
  toMinor,
} from "../../../ledger/money.js";
import {
  isCategoryAccount,
  isMoneyPotAccount,
} from "../../../ledger/account-type.js";
import { getRecord } from "../../../queries/ledger.js";
import {
  findDuplicateRecords,
  type DuplicateSignal,
} from "../../../queries/duplicate-records.js";
import { accountDefaultId } from "../../../services/account-defaults.js";
import { getExchangeRate } from "../../../currency/rates.js";
import { mainCurrencyCode } from "../../../currency/form.js";
import type { AppContext } from "../../../application/context.js";
import {
  fail,
  ok,
  type AppErrorCode,
  type AppFailure,
  type AppResult,
} from "../../../application/result.js";
import { checkVersion, recordVersion } from "../../../application/version.js";
import {
  createRecord,
  deleteRecord,
  prepareVoidRecord,
  voidRecord,
  type CreateInput,
  type VoidRelease,
  type VoidReleasePlan,
} from "../../../application/records.js";
import {
  changeRecord,
  routeRecordChange,
  type ChangeRecordFailure,
  type ChangeRecordStep,
  type RecordChange,
  type RoutePath,
} from "../../../application/record-routing.js";
import {
  prepareReimbursementReversal,
  reverseReimbursement,
} from "../../../application/reimbursement-reversal.js";
import { createContact } from "../../../application/contacts.js";
import {
  attachFile,
  attachFileShape,
} from "../../../application/attachments.js";
import {
  lineRef,
  resolveAccount,
  resolveContact,
  resolveRecord,
  type AccountRefOptions,
  type Resolved,
} from "../../../application/refs.js";
import {
  hashInput,
  runBatch,
  type BatchItem,
} from "../../../application/batch.js";
import {
  batchToolResult,
  type ItemFailure,
  type ItemFailureDetails,
} from "../../batch-result.js";
import {
  envelopePayload,
  toolError,
  toolResult,
  type ToolIssue,
} from "../../envelope.js";
import { dateInput, enumCodec, money, moneyInput } from "../../format.js";
import { resolveError, topCandidates } from "../../resolve.js";
import {
  actionRefusal,
  actionsInArguments,
  ATTACH_FILE,
  CHANGE_RECORDS,
  CREATE_RECORDS,
  missingForActions,
} from "../../requirements/index.js";
import {
  defineWriteTool,
  type ToolCallMeta,
  type ToolDefinition,
} from "../../registry.js";

/**
 * The records write tools: `create_records`, `change_records` and
 * `attach_file` (v1's contract, renamed only).
 *
 * The two batch tools only parse, resolve references and format. Every rule
 * lives in the `application/` operation an item calls — `createRecord`,
 * `changeRecord` (which picks the edit or correction path), `voidRecord`,
 * `reverseReimbursement`, `deleteRecord` — and each item runs inside
 * `runBatch`, so a call is saved whole or not at all.
 *
 * References are resolved inside each item's `run`, so they see what earlier
 * items in the same call wrote (a contact `new_contact` just created) and
 * every miss is reported together with every other failure. A miss carries
 * its candidates, a routing refusal its `blocked[]`, a refused void the
 * release that would allow it: they ride on the failure as
 * `ItemFailureDetails` (`batch-result.ts`), which keeps them in the item's
 * error.
 *
 * Amounts, split lines included, are in the record's currency on both
 * `create_records` and `change_records.update`. A split in another currency
 * is converted by sharing the record's main-currency total out over its lines
 * (`splitByLargestRemainder`), so the lines always cancel the money side.
 */

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

const MAX_ITEMS = 50;
const SPLIT = `At most ${MAX_ITEMS} items per call. Split the batch into several calls.`;

/** An id (number), or a string the resolver reads: a number, a code, a name. */
const refInput = z
  .union([z.number().int(), z.string().trim().min(1).max(300)])
  .describe("An id (number), or a name, code or record number (string).");

const rateInput = z
  .union([z.number(), z.string()])
  .transform((value, ctx) => {
    const rate = typeof value === "number" ? value : Number(value.trim());
    if (!Number.isFinite(rate) || rate <= 0) {
      ctx.addIssue({
        code: "custom",
        message: "The exchange rate must be a number above zero.",
      });
      return z.NEVER;
    }
    return rate;
  })
  .describe("Main-currency units per 1 unit of currency, e.g. 4.42.");

/** A percentage as a decimal, e.g. "50" or "33.33", to basis points. */
const percentInput = z
  .union([z.string(), z.number()])
  .transform((value, ctx) => {
    const parsed = parseMinor(value, 2);
    if (!parsed.ok || parsed.minor < 0 || parsed.minor > 10_000) {
      ctx.addIssue({
        code: "custom",
        message: 'The percent must be between 0 and 100, e.g. "50".',
      });
      return z.NEVER;
    }
    return parsed.minor;
  })
  .describe('Deductible share, 0 to 100, e.g. "50".');

const treatmentInput = z.enum(TAX_TREATMENTS);

const reasonInput = z.string().trim().min(10).max(2000);

const currencyInput = z
  .string()
  .trim()
  .length(3)
  .toUpperCase()
  .describe("ISO code, e.g. USD. Default: the main currency.");

/** An item's refusal, with what its error should say beyond the sentence. */
function failWith(
  code: AppErrorCode,
  reason: string,
  details: ItemFailureDetails = {},
): ItemFailure {
  return { ...fail(code, reason), ...details };
}

/** What an item refused for blocked fields says to do. */
const BLOCKED_FIX =
  "Change only the fields that are not blocked, or do what each blocked field's fix says first.";

/**
 * The application layer's argument names, as an agent sends them here. Its
 * sentences name `releaseBankMatches`; this tool's field is
 * `release_bank_matches`.
 */
function toolWords(text: string): string {
  return text
    .replaceAll("releaseBankMatches", "release_bank_matches")
    .replaceAll("acknowledgePeriodChange", "acknowledge_period_change")
    .replaceAll("expectedVersion", "expected_version")
    .replaceAll("percentageBps", "percent");
}

/** A failure from `application/`, with its sentence in this tool's words. */
function reworded<T>(failure: AppFailure & T): AppFailure & T {
  return { ...failure, reason: toolWords(failure.reason) };
}

/** A reference miss as the item's failure, with its candidates kept. */
function refMiss(
  miss: Extract<Resolved<unknown>, { ok: false }>,
  opts: { what: string; ref: string | number; path: string; lookup: string },
): ItemFailure {
  const body = resolveError(miss, opts);
  return failWith(
    body.code === "NOT_FOUND" ? "NOT_FOUND" : "INVALID_INPUT",
    body.message,
    {
      toolCode: body.code,
      path: body.path,
      fix: body.fix,
      candidates: body.candidates,
    },
  );
}

/** `batchToolResult`'s answer; a success gains a top-level `currency`, the book's main currency. */
function withMainCurrency(db: LedgerDb, out: CallToolResult): CallToolResult {
  if (out.isError) return out;
  const payload = envelopePayload(out);
  return payload
    ? toolResult({ ...payload, currency: mainCurrencyCode(db) })
    : out;
}

/**
 * `totalMinor` shared out over `weights` in proportion, in whole minor units
 * that add up to exactly `totalMinor` (the largest-remainder method): each
 * part is its exact share rounded down, and the units left over go one each
 * to the parts that lost the most in rounding down, ties to the larger
 * weight, then the earlier part. Integer arithmetic throughout (BigInt, so a
 * product never loses a digit): no float touches a figure.
 *
 * `weights` are positive whole numbers and `totalMinor` a whole number of at
 * least zero. Equal to `weights` itself when `totalMinor` is their sum.
 */
export function splitByLargestRemainder(
  totalMinor: number,
  weights: readonly number[],
): number[] {
  const whole = weights.reduce((sum, weight) => sum + BigInt(weight), 0n);
  if (whole <= 0n) return weights.map(() => 0);
  const total = BigInt(totalMinor);
  const shares = weights.map((weight, index) => {
    const exact = total * BigInt(weight);
    return { index, weight, part: exact / whole, cut: exact % whole };
  });
  let left = total - shares.reduce((sum, share) => sum + share.part, 0n);
  const byCut = [...shares].sort((a, b) =>
    a.cut === b.cut
      ? b.weight - a.weight || a.index - b.index
      : a.cut < b.cut
        ? 1
        : -1,
  );
  for (const share of byCut) {
    if (left <= 0n) break;
    share.part += 1n;
    left -= 1n;
  }
  return shares.map((share) => Number(share.part));
}

/**
 * Split lines in another currency (`linesMinor`, adding up to the record's
 * amount) as main-currency cents: `totalMain`, what the money side holds in
 * the main currency, shared out over them by largest remainder, so they
 * cancel it exactly. A line too small to come to one cent is refused by index.
 */
function linesInMain(
  linesMinor: readonly number[],
  totalMain: number,
): { ok: true; parts: number[] } | { ok: false; index: number } {
  const parts = splitByLargestRemainder(totalMain, linesMinor);
  const index = parts.findIndex((part) => part <= 0);
  return index < 0 ? { ok: true, parts } : { ok: false, index };
}

/** The refusal for a line `linesInMain` could not convert. */
function lineTooSmall(
  path: string,
  lineMinor: number,
  currency: string,
  main: string,
  rate: number,
): ItemFailure {
  return failWith(
    "INVALID_INPUT",
    `${path}: ${money_(lineMinor)} ${currency} is less than 0.01 ${main} at the rate ${rate}.`,
    {
      path,
      fix: "Add it to another line; the lines must still add up to the amount.",
    },
  );
}

/** `INVALID_INPUT` for problems the schema cannot see, all at once. */
function inputProblems(issues: ToolIssue[]): CallToolResult {
  return toolError({
    code: "INVALID_INPUT",
    message:
      issues.length === 1
        ? `The input is not valid: ${issues[0].path}: ${issues[0].message}`
        : `The input has ${issues.length} problems; see issues.`,
    fix: "Correct the fields named in issues and call again. Nothing was done.",
    issues,
  });
}

/** Accounts as an agent reads them: `"5100 Advertising"`. Loaded once per call. */
function accountNamer(db: LedgerDb): (id: number) => string {
  let names: Map<number, string> | undefined;
  return (id) => {
    names ??= new Map(
      db
        .select({ id: accounts.id, code: accounts.code, name: accounts.name })
        .from(accounts)
        .all()
        .map((a) => [a.id, `${a.code ?? a.id} ${a.name}`]),
    );
    return names.get(id) ?? `#${id}`;
  };
}

/** A record as messages name it: its number, or `#id`. */
function recordNo(db: LedgerDb, id: number): string {
  const row = db
    .select({ no: ledgerRecords.recordNumber })
    .from(ledgerRecords)
    .where(eq(ledgerRecords.id, id))
    .get();
  return row?.no ?? `#${id}`;
}

/** A decimal as stored on a record or statement line, as an exact string. */
function decimal(value: number): string {
  const parsed = parseMinor(value);
  return parsed.ok ? money(parsed.minor) : value.toFixed(2);
}

/** The lines that say what a record was for: categories and equipment. */
function categoryLines(record: RecordView) {
  return record.movements.filter((m) =>
    isCategoryAccount({ type: m.accountType, subType: m.accountSubType }),
  );
}

/** The percent text for basis points: 5000 → "50.00". */
const percentOf = (bps: number | null | undefined) =>
  bps == null ? undefined : formatMinor(bps, 2);

/** What `treatment` implies for the percent, where it implies one. */
function impliedBps(treatment: TaxTreatment): number | null | undefined {
  switch (treatment) {
    case "ordinary_deductible":
      return 10_000;
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

/** The release a void would need, beyond `asked`, and what it would undo. */
function voidSuggestion(
  ctx: AppContext,
  id: number,
  from: VoidRelease = "none",
): { release: VoidRelease; preview?: Record<string, unknown> } | null {
  const order: VoidRelease[] = ["none", "allocations", "all"];
  for (const release of order.slice(order.indexOf(from))) {
    const prepared = prepareVoidRecord(ctx, id, { release });
    if (!prepared.ok) return null;
    if (prepared.value.blockedReason === null)
      return {
        release,
        ...(prepared.value.release
          ? { preview: releasedView(ctx.db, prepared.value.release) }
          : {}),
      };
  }
  return null;
}

/** A release plan without its movement and settlement ids. */
function releasedView(
  db: LedgerDb,
  plan: VoidReleasePlan,
): Record<string, unknown> {
  return {
    allocations: plan.allocations.map((a) => ({
      record: recordNo(db, a.otherRecordId),
      side: a.side,
      amount: money(a.amountMinor),
    })),
    bank_lines: [...new Set(plan.bankMatches.map((m) => lineRef(m.lineId)))],
  };
}

// ---------------------------------------------------------------------------
// create_records
// ---------------------------------------------------------------------------

const taxInput = z
  .object({
    treatment: treatmentInput,
    percent: percentInput.optional(),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .describe("Deduction treatment; percent only for partial.");

const createLineInput = z
  .object({
    category: refInput.describe(
      "The category (any account, for a journal line).",
    ),
    amount: moneyInput.describe(
      'Decimal, e.g. "85.00", in the record\'s currency. A journal line is signed: + into the account, - out of it.',
    ),
    label: z.string().trim().max(200).optional(),
    tax: taxInput.optional(),
  })
  .strict();

const roleCodec = enumCodec(RoleLabels);

const newContactInput = z
  .object({
    name: z.string().trim().min(1).max(200),
    roles: z.array(z.enum(roleCodec.labels)).max(4).optional(),
    force_new: z
      .boolean()
      .optional()
      .describe("Create it even though a contact with a similar name exists."),
  })
  .strict();

const KINDS = ["expense", "income", "transfer", "payment", "journal"] as const;

const createItemInput = z
  .object({
    type: z.enum(["expense", "income", "transfer", "journal"]),
    date: dateInput,
    description: z.string().trim().min(1).max(500),
    amount: moneyInput
      .optional()
      .describe(
        'Decimal in currency, e.g. "1285.50". Optional for a journal (its debits).',
      ),
    currency: currencyInput.optional(),
    exchange_rate: rateInput.optional(),
    main_amount: moneyInput
      .optional()
      .describe("The amount in the main currency, instead of exchange_rate."),
    contact: refInput.optional(),
    new_contact: newContactInput.optional(),
    paid_from: refInput
      .optional()
      .describe("The bank, cash or card account the money left."),
    received_into: refInput
      .optional()
      .describe("The bank, cash or card account the money went to."),
    owed: z
      .boolean()
      .optional()
      .describe("Not paid yet: owed to the contact, or by them for income."),
    personally_paid_by: refInput
      .optional()
      .describe("The person who paid it themselves and is owed it."),
    category: refInput.optional(),
    lines: z.array(createLineInput).min(1).max(MAX_ITEMS).optional(),
    tax: taxInput.optional(),
    reference: z.string().trim().max(200).optional(),
    remark: z.string().trim().max(2000).optional(),
    expected_kind: z
      .enum(KINDS)
      .optional()
      .describe("Refuse the item unless the accounts derive this kind."),
  })
  .strict();

type CreateItem = z.output<typeof createItemInput>;

const createRecordsInput = z.object({
  records: z.array(createItemInput).min(1).max(MAX_ITEMS, SPLIT),
  dry_run: z.boolean().optional(),
  idempotency_key: z.string().trim().min(1).max(200).optional(),
  detail: z.enum(["concise", "full"]).optional(),
});

/** What one created record reports. JSON only: a replay returns the stored copy. */
type Created = {
  record: number;
  no: string | null;
  kind: string | undefined;
  date: string;
  amount: string;
  currency?: string;
  rate?: number;
  amount_main?: string;
  rate_looked_up?: { rate: number; source: string };
  contact?: string | null;
  contact_created?: { id: number; name: string };
  v: string;
  sides: { account: string; amount: string; label?: string | null }[];
  /** Records that look like this one entered before. Empty is dropped. */
  duplicate_suspects: DuplicateSuspect[];
};

/** A record that may be the one just created, entered before. `amount` is in the main currency. */
type DuplicateSuspect = {
  record: number;
  no: string | null;
  date: string;
  amount: string;
  signals: DuplicateSignal[];
};

/** The most suspects one created record lists. */
const MAX_SUSPECTS = 3;

/**
 * The records the duplicate finder groups with `id`, strongest group first:
 * the same amount and contact within 3 days, the same reference, the same
 * file. Run inside the item, so it sees the new record (and earlier items of
 * the same call) in a dry run too. No file source: a new record has no files
 * yet, and nothing is hashed inside a write.
 */
function duplicateSuspects(db: LedgerDb, id: number): DuplicateSuspect[] {
  const { groups } = findDuplicateRecords(db, { recordIds: [id], maxDays: 3 });
  const seen = new Set([id]);
  const suspects: DuplicateSuspect[] = [];
  for (const group of groups)
    for (const member of group.records) {
      if (seen.has(member.id)) continue;
      seen.add(member.id);
      suspects.push({
        record: member.id,
        no: member.recordNumber,
        date: member.date,
        amount: money(member.amountMinor),
        signals: group.signals,
      });
      if (suspects.length === MAX_SUSPECTS) return suspects;
    }
  return suspects;
}

/** Structural problems with one item, located. The resolver and the operation check the rest. */
function createItemProblems(item: CreateItem, at: string): ToolIssue[] {
  const issues: ToolIssue[] = [];
  const add = (field: string, message: string) =>
    issues.push({ path: `${at}.${field}`, message });
  const moneyFields = [
    item.paid_from !== undefined && "paid_from",
    item.received_into !== undefined && "received_into",
    item.owed === true && "owed",
    item.personally_paid_by !== undefined && "personally_paid_by",
  ].filter((x): x is string => typeof x === "string");
  const named = (allowed: string[]) =>
    moneyFields.filter((field) => !allowed.includes(field));
  if (item.contact !== undefined && item.new_contact !== undefined)
    add("new_contact", "Send contact or new_contact, not both.");
  if (item.category !== undefined && item.lines !== undefined)
    add("lines", "Send category or lines, not both.");
  if (item.exchange_rate !== undefined && item.main_amount !== undefined)
    add("main_amount", "Send exchange_rate or main_amount, not both.");

  if (item.type === "journal") {
    for (const field of moneyFields)
      add(field, "A journal names its accounts in lines only.");
    if (item.category !== undefined)
      add("category", "A journal names its accounts in lines.");
    if (!item.lines || item.lines.length < 2)
      add("lines", "A journal needs at least two lines.");
    if (
      item.currency !== undefined ||
      item.exchange_rate !== undefined ||
      item.main_amount !== undefined
    )
      add("currency", "A journal is in the main currency.");
    if (item.tax !== undefined)
      add("tax", "Set tax on the lines of a journal, not the whole entry.");
    if (item.lines) {
      const total = item.lines.reduce((sum, line) => sum + line.amount, 0);
      if (total !== 0)
        add(
          "lines",
          `The lines add up to ${money_(total)}; a journal's lines must add up to 0.00.`,
        );
      item.lines.forEach((line, i) => {
        if (line.amount === 0)
          add(`lines[${i}].amount`, "A line cannot be 0.00.");
      });
      const debits = item.lines
        .filter((line) => line.amount > 0)
        .reduce((sum, line) => sum + line.amount, 0);
      if (item.amount !== undefined && item.amount !== debits)
        add(
          "amount",
          `A journal's amount is its debits, ${money_(debits)}; leave it out or send that.`,
        );
    }
    return issues;
  }

  if (item.amount === undefined) add("amount", "Required.");
  else if (item.amount <= 0)
    add(
      "amount",
      "The amount must be above zero; the type gives the direction.",
    );
  if (item.main_amount !== undefined && item.main_amount <= 0)
    add("main_amount", "The amount must be above zero.");

  if (item.type === "transfer") {
    if (item.paid_from === undefined)
      add("paid_from", "A transfer names the account the money left.");
    if (item.received_into === undefined)
      add("received_into", "A transfer names the account the money went to.");
    for (const field of named(["paid_from", "received_into"]))
      add(field, "A transfer moves money between two of your accounts only.");
    if (item.category !== undefined || item.lines !== undefined)
      add("category", "A transfer has no category.");
    if (item.tax !== undefined) add("tax", "A transfer has no tax treatment.");
    return issues;
  }

  const allowed =
    item.type === "expense"
      ? ["paid_from", "owed", "personally_paid_by"]
      : ["received_into", "owed"];
  for (const field of named(allowed))
    add(
      field,
      item.type === "expense"
        ? "An expense uses paid_from, owed or personally_paid_by."
        : "Income uses received_into or owed.",
    );
  const sides = moneyFields.filter((field) => allowed.includes(field));
  if (sides.length === 0)
    add(
      allowed[0],
      item.type === "expense"
        ? "Say where the money came from: paid_from, owed: true, or personally_paid_by."
        : "Say where the money went: received_into, or owed: true.",
    );
  else if (sides.length > 1)
    add(sides[1], `Send one of ${allowed.join(", ")}.`);
  if (
    item.owed === true &&
    item.contact === undefined &&
    item.new_contact === undefined
  )
    add("contact", "Owed money needs the contact it is owed to or by.");
  if (item.category === undefined && item.lines === undefined)
    add("category", "Say what it was for: category, or lines to split it.");
  if (item.lines && item.amount !== undefined) {
    item.lines.forEach((line, i) => {
      if (line.amount <= 0)
        add(`lines[${i}].amount`, "A line's amount must be above zero.");
    });
    const total = item.lines.reduce((sum, line) => sum + line.amount, 0);
    if (total !== item.amount)
      add(
        "lines",
        `The lines add up to ${money_(total)}, but the amount is ${money_(item.amount)}.`,
      );
  }
  if (item.tax?.treatment === "partial" && item.tax.percent === undefined)
    add("tax.percent", "A partial treatment needs its percent.");
  item.lines?.forEach((line, i) => {
    if (line.tax?.treatment === "partial" && line.tax.percent === undefined)
      add(`lines[${i}].tax.percent`, "A partial treatment needs its percent.");
  });
  return issues;
}

/** `money` that never throws on a sum an agent sent. */
function money_(minor: number): string {
  return Number.isSafeInteger(minor) ? money(minor) : String(minor / 100);
}

type CreatePrepared = { rate: number; source: string } | undefined;

/** Resolving references and building `createRecord`'s input, inside the item. */
class CreateBuilder {
  constructor(
    private readonly ctx: AppContext,
    private readonly item: CreateItem,
    private readonly at: string,
    private readonly meta: ToolCallMeta,
  ) {}

  account(
    ref: string | number,
    field: string,
    opts: AccountRefOptions = {},
  ): number | ItemFailure {
    const found = resolveAccount(this.ctx, ref, opts);
    return found.ok
      ? found.id
      : refMiss(found, {
          what: "account",
          ref,
          path: `${this.at}.${field}`,
          lookup: this.meta.nameOf("list_accounts"),
        });
  }

  contact(ref: string | number, field: string): number | ItemFailure {
    const found = resolveContact(this.ctx, ref);
    return found.ok
      ? found.id
      : refMiss(found, {
          what: "contact",
          ref,
          path: `${this.at}.${field}`,
          lookup: this.meta.nameOf("find_contacts"),
        });
  }

  /** `new_contact`: refused when a contact by that name or a similar one exists, unless `force_new`. */
  newContact(): { id: number; name: string } | ItemFailure {
    const wanted = this.item.new_contact!;
    if (!wanted.force_new) {
      const existing = resolveContact(this.ctx, wanted.name);
      const candidates = existing.ok
        ? [{ id: existing.id, name: existing.value.legalName }]
        : existing.candidates;
      if (candidates.length)
        return failWith(
          "INVALID_INPUT",
          existing.ok
            ? `A contact named "${existing.value.legalName}" already exists.`
            : `Contacts with names like "${wanted.name}" already exist.`,
          {
            toolCode: "AMBIGUOUS",
            path: `${this.at}.new_contact`,
            fix: "To use one of candidates, send contact with its id instead of new_contact. If it really is a different contact, send new_contact again with force_new: true.",
            candidates: topCandidates(candidates),
          },
        );
    }
    const roles = (
      wanted.roles ?? [this.item.type === "income" ? "customer" : "supplier"]
    ).map((label) => roleCodec.code(label)!);
    const person = roles.some(
      (role) => role === Role.Employee || role === Role.Partner,
    );
    const created = createContact(this.ctx, {
      entityType: person ? EntityType.Individual : EntityType.Business,
      legalName: wanted.name,
      roles,
    });
    if (!created.ok) return created;
    return {
      id: created.value.contact.id,
      name: created.value.contact.legalName,
    };
  }

  /** The tax overrides for the category lines, in line order. */
  taxOverrides(lineAccounts: number[]): CreateInput["taxOverrides"] {
    const { item } = this;
    const taxes = item.lines
      ? item.lines.map((line) => line.tax ?? item.tax)
      : [item.tax];
    const seen = new Map<number, number>();
    const out: NonNullable<CreateInput["taxOverrides"]> = [];
    lineAccounts.forEach((accountId, i) => {
      const occurrence = seen.get(accountId) ?? 0;
      seen.set(accountId, occurrence + 1);
      const tax = taxes[i];
      if (!tax) return;
      const percentageBps = tax.percent ?? impliedBps(tax.treatment) ?? null;
      out.push({
        accountId,
        occurrence,
        treatment: tax.treatment,
        percentageBps,
        reason: tax.reason ?? "Classified when the record was created.",
      });
    });
    return out.length ? out : undefined;
  }

  build(prepared: CreatePrepared):
    | {
        input: CreateInput;
        rate: number;
        contactCreated?: { id: number; name: string };
      }
    | ItemFailure {
    const { ctx, item } = this;
    const main = mainCurrencyCode(ctx.db);
    const currency = item.currency ?? main;
    const amountMinor =
      item.amount ??
      (item.lines ?? [])
        .filter((line) => line.amount > 0)
        .reduce((sum, line) => sum + line.amount, 0);

    let rate = 1;
    if (currency !== main) {
      if (item.exchange_rate !== undefined) rate = item.exchange_rate;
      else if (item.main_amount !== undefined) {
        rate = item.main_amount / amountMinor;
        if (toMinor(fromMinor(amountMinor), rate) !== item.main_amount)
          return failWith(
            "INVALID_INPUT",
            `No exchange rate turns ${money(amountMinor)} ${currency} into exactly ${money(item.main_amount)} ${main}.`,
            {
              path: `${this.at}.main_amount`,
              fix: "Send exchange_rate instead of main_amount.",
            },
          );
      } else if (prepared) rate = prepared.rate;
    }

    let contactId: number | undefined;
    let contactCreated: { id: number; name: string } | undefined;
    if (item.contact !== undefined) {
      const found = this.contact(item.contact, "contact");
      if (typeof found !== "number") return found;
      contactId = found;
    } else if (item.new_contact !== undefined) {
      const made = this.newContact();
      if ("ok" in made) return made;
      contactCreated = made;
      contactId = made.id;
    }

    const common = {
      date: item.date,
      description: item.description,
      amount: fromMinor(amountMinor),
      currency,
      exchangeRate: rate,
      ...(item.reference !== undefined ? { reference: item.reference } : {}),
      ...(item.remark !== undefined ? { remark: item.remark } : {}),
    };

    if (item.type === "journal") {
      const lines = item.lines!;
      const movements: {
        accountId: number;
        amountMinor: number;
        label?: string | null;
      }[] = [];
      for (const [i, line] of lines.entries()) {
        const id = this.account(line.category, `lines[${i}].category`);
        if (typeof id !== "number") return id;
        movements.push({
          accountId: id,
          amountMinor: line.amount,
          ...(line.label !== undefined ? { label: line.label } : {}),
        });
      }
      const taxOverrides = this.taxOverridesForJournal(movements);
      return {
        input: {
          ...common,
          kind: "journal",
          movements,
          ...(contactId !== undefined ? { contactId } : {}),
          ...(taxOverrides ? { taxOverrides } : {}),
          ...(item.expected_kind ? { expectedKind: item.expected_kind } : {}),
        },
        rate,
        contactCreated,
      };
    }

    const moneyAccount = (field: "paid_from" | "received_into") => {
      const ref = item[field]!;
      return this.account(ref, field, {
        where: isMoneyPotAccount,
        wanted: "a bank, cash or card account",
      });
    };

    if (item.type === "transfer") {
      const from = moneyAccount("paid_from");
      if (typeof from !== "number") return from;
      const to = moneyAccount("received_into");
      if (typeof to !== "number") return to;
      return {
        input: {
          ...common,
          fromAccountId: from,
          toAccountId: to,
          ...(contactId !== undefined ? { contactId } : {}),
          expectedKind: item.expected_kind ?? "transfer",
        },
        rate,
        contactCreated,
      };
    }

    // Expense or income: one money side, one or more category lines.
    const categoryRefs = item.lines
      ? item.lines.map((line, i) => ({
          ref: line.category,
          field: `lines[${i}].category`,
        }))
      : [{ ref: item.category!, field: "category" }];
    const lineAccounts: number[] = [];
    for (const { ref, field } of categoryRefs) {
      const id = this.account(ref, field, {
        where: isCategoryAccount,
        wanted: "a category",
      });
      if (typeof id !== "number") return id;
      lineAccounts.push(id);
    }

    let moneySide: number;
    let payer:
      | {
          expensePaymentSource: "personal";
          paidByContactId: number;
          supplierContactId?: number;
        }
      | undefined;
    if (item.paid_from !== undefined || item.received_into !== undefined) {
      const id = moneyAccount(
        item.paid_from !== undefined ? "paid_from" : "received_into",
      );
      if (typeof id !== "number") return id;
      moneySide = id;
    } else if (item.owed === true) {
      const purpose =
        item.type === "expense"
          ? DefaultAccountPurpose.Payable
          : DefaultAccountPurpose.Receivable;
      const id = accountDefaultId(ctx.db, purpose);
      if (id === null)
        return failWith(
          "REFUSED",
          `No ${item.type === "expense" ? "payable" : "receivable"} account is set for this book. A person must set it in Akaun's settings.`,
        );
      moneySide = id;
    } else {
      const person = this.contact(
        item.personally_paid_by!,
        "personally_paid_by",
      );
      if (typeof person !== "number") return person;
      const owedTo =
        accountDefaultId(ctx.db, DefaultAccountPurpose.ReimbursementsPayable) ??
        accountDefaultId(ctx.db, DefaultAccountPurpose.Payable);
      if (owedTo === null)
        return failWith(
          "REFUSED",
          "No payable account is set for this book. A person must set it in Akaun's settings.",
        );
      moneySide = owedTo;
      payer = {
        expensePaymentSource: "personal",
        paidByContactId: person,
        ...(contactId !== undefined ? { supplierContactId: contactId } : {}),
      };
    }

    // The lines in the main currency, adding up to exactly the total the
    // money side gets (`createRecord`'s `toMinor(amount, rate)`); the first is
    // what the others leave of it. At rate 1 they already are.
    let mainLines = item.lines?.map((line) => line.amount) ?? [];
    if (item.lines && rate !== 1) {
      const converted = linesInMain(
        mainLines,
        toMinor(fromMinor(amountMinor), rate),
      );
      if (!converted.ok)
        return lineTooSmall(
          `${this.at}.lines[${converted.index}].amount`,
          item.lines[converted.index].amount,
          currency,
          main,
          rate,
        );
      mainLines = converted.parts;
    }
    const sign = item.type === "expense" ? 1 : -1;
    const [first, ...rest] = lineAccounts;
    const extraSides = rest.map((accountId, i) => ({
      accountId,
      amountMinor: sign * mainLines[i + 1],
      label: item.lines![i + 1].label ?? null,
    }));
    const split =
      extraSides.length > 0
        ? {
            extraSides,
            ...(item.lines![0].label !== undefined
              ? { categoryLabel: item.lines![0].label }
              : {}),
          }
        : {};
    const taxOverrides = this.taxOverrides(lineAccounts);
    const sides =
      item.type === "expense"
        ? { fromAccountId: moneySide, toAccountId: first }
        : { fromAccountId: first, toAccountId: moneySide };
    return {
      input: {
        ...common,
        ...sides,
        ...split,
        ...(payer
          ? { ...payer, contactId: payer.paidByContactId }
          : contactId !== undefined
            ? { contactId }
            : {}),
        ...(taxOverrides ? { taxOverrides } : {}),
        expectedKind: item.expected_kind ?? item.type,
      },
      rate,
      contactCreated,
    };
  }

  private taxOverridesForJournal(
    movements: { accountId: number }[],
  ): CreateInput["taxOverrides"] {
    return this.item.lines!.some((line) => line.tax)
      ? this.taxOverrides(movements.map((m) => m.accountId))
      : undefined;
  }
}

function createdValue(
  record: RecordView,
  version: string,
  main: string,
  name: (id: number) => string,
  extra: {
    rate: number;
    lookedUp?: CreatePrepared;
    contactCreated?: { id: number; name: string };
    suspects: DuplicateSuspect[];
  },
): Created {
  const foreign = record.currency !== main;
  return {
    record: record.id,
    no: record.recordNumber,
    kind: LedgerRecordKindLabels[record.kind],
    date: record.date,
    amount: decimal(record.amount),
    ...(foreign
      ? {
          currency: record.currency,
          rate: record.exchangeRate,
          amount_main: money(record.amountMinor),
        }
      : {}),
    ...(foreign && extra.lookedUp
      ? {
          rate_looked_up: {
            rate: extra.lookedUp.rate,
            source: extra.lookedUp.source,
          },
        }
      : {}),
    contact: record.contactName,
    ...(extra.contactCreated ? { contact_created: extra.contactCreated } : {}),
    v: version,
    sides: record.movements.map((m) => ({
      account: name(m.accountId),
      amount: money(m.amountMinor),
      ...(m.label ? { label: m.label } : {}),
    })),
    duplicate_suspects: extra.suspects,
  };
}

const CREATE_DESCRIPTION = `Records new expenses, income, transfers between the business's own money accounts, and journals. Change, void or delete records with akaun_change_records; pay bills with akaun_record_payments; attach receipts afterwards with akaun_attach_file.

Each item in records[] is one record:
- expense: paid_from (a bank, cash or card account), owed: true (an unpaid bill; needs contact) or personally_paid_by (who paid it themselves); plus category, or lines to split it.
- income: received_into or owed: true, plus category or lines.
- transfer: paid_from and received_into.
- journal: lines with signed amounts (+ into the account, - out of it) adding up to zero. Needs the Adjustments ability.
Accounts are an id, code ("5100"), name or "5100 Name"; contacts an id or exact name. Anything else returns NOT_FOUND or AMBIGUOUS with candidates: pick one or ask, never guess. new_contact also creates the contact; a similar existing name returns AMBIGUOUS unless force_new.

Amounts and lines are decimal strings ("1285.50") in the record's currency (default: main); lines add up to amount. For another currency send exchange_rate or main_amount, or the day's rate is looked up, frozen and reported.

A call saves at once, all or nothing (at most 50 items); dry_run: true saves nothing. Send an idempotency_key if you may retry. Each result gives the record id, number, derived kind and v; detail: "full" adds its sides. duplicate_suspects: records that look entered before; check them with the user.`;

export const createRecordsTool = defineWriteTool({
  base: "create_records",
  title: "Create records",
  description: CREATE_DESCRIPTION,
  input: createRecordsInput,
  annotations: {
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  requirements: CREATE_RECORDS.requirements,
  actions: CREATE_RECORDS.actions,
  handler: async (ctx, args, meta) => {
    const base = "create_records";
    const shortfalls = missingForActions(ctx.locals, base, [
      ...actionsInArguments(base, args),
      ...(args.records.some((r) => r.type === "journal")
        ? ["records_adjust"]
        : []),
    ]);
    if (shortfalls.length)
      return toolError(actionRefusal(meta.name, shortfalls));

    const issues = args.records.flatMap((item, i) =>
      createItemProblems(item, `records[${i}]`),
    );
    if (issues.length) return inputProblems(issues);

    const main = mainCurrencyCode(ctx.db);
    const name = accountNamer(ctx.db);
    const items: BatchItem<Created>[] = args.records.map((item, i) => {
      const at = `records[${i}]`;
      const currency = item.currency ?? main;
      const needsRate =
        currency !== main &&
        item.exchange_rate === undefined &&
        item.main_amount === undefined;
      return {
        action: "records",
        label: at,
        ...(needsRate
          ? {
              prepare: async (c: AppContext): Promise<AppResult<unknown>> => {
                // Before the transaction: a cached daily rate, else the
                // provider. Frozen on the record by `run`.
                const found = await getExchangeRate(c.db, {
                  from: currency,
                  to: main,
                  date: item.date,
                });
                return found.rate === null
                  ? fail(
                      "RATE_UNAVAILABLE",
                      `${at}: no ${currency} to ${main} rate is available for ${item.date}.`,
                    )
                  : ok({ rate: found.rate, source: found.source });
              },
            }
          : {}),
        run: (c, prepared) => {
          const built = new CreateBuilder(c, item, at, meta).build(
            prepared as CreatePrepared,
          );
          if ("ok" in built) return built;
          const created = createRecord(c, built.input);
          if (!created.ok) return reworded(created);
          const record = created.value.record;
          return ok(
            createdValue(record, created.value.version, main, name, {
              rate: built.rate,
              lookedUp: prepared as CreatePrepared,
              contactCreated: built.contactCreated,
              suspects: duplicateSuspects(c.db, record.id),
            }),
          );
        },
      };
    });

    const result = await runBatch(ctx, {
      tool: meta.name,
      dryRun: args.dry_run ?? false,
      items,
      idempotency: args.idempotency_key
        ? {
            key: args.idempotency_key,
            inputHash: hashInput({ records: args.records }),
          }
        : undefined,
    });
    const full = args.detail === "full";
    return withMainCurrency(
      ctx.db,
      batchToolResult(result, {
        requestId: meta.requestId,
        formatValue: (value) => {
          const { sides, ...rest } = value;
          return full ? { ...rest, sides } : rest;
        },
      }),
    );
  },
});

// ---------------------------------------------------------------------------
// change_records
// ---------------------------------------------------------------------------

const changeLineInput = z
  .object({
    category: refInput,
    amount: moneyInput.describe(
      'Decimal in the record\'s currency (the new one, when set changes it), e.g. "85.00". The lines add up to the amount.',
    ),
    label: z.string().trim().max(200).optional(),
  })
  .strict();

const changeTaxInput = z
  .object({
    line: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Zero-based category line; omit when there is one."),
    treatment: treatmentInput,
    percent: percentInput.optional(),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

const updateItemInput = z
  .object({
    record: refInput.describe('Record id, or its number ("EXP-2026-0042").'),
    expected_version: z
      .string()
      .min(1)
      .describe("The record's v, as last read."),
    set: z
      .object({
        description: z.string().trim().max(500).optional(),
        reference: z.string().trim().max(200).nullable().optional(),
        remark: z.string().trim().max(2000).nullable().optional(),
        contact: refInput.nullable().optional(),
        date: dateInput.optional(),
        category: refInput.optional(),
        lines: z.array(changeLineInput).min(1).max(MAX_ITEMS).optional(),
        amount: moneyInput.optional(),
        currency: currencyInput.optional(),
        exchange_rate: rateInput.optional(),
        tax: z.array(changeTaxInput).min(1).max(MAX_ITEMS).optional(),
      })
      .strict()
      .describe(
        "What the record should end up saying. Only these fields change.",
      ),
    reason: reasonInput
      .optional()
      .describe("Why, 10 to 2000 characters. Required when a correction runs."),
    acknowledge_period_change: z.boolean().optional(),
    release_bank_matches: z.boolean().optional(),
  })
  .strict();

const voidItemInput = z
  .object({
    record: refInput,
    expected_version: z.string().min(1),
    reason: reasonInput,
    release: z
      .enum(["none", "allocations", "all"])
      .optional()
      .describe(
        "allocations: reverse payments applied to it first; all: also unmatch its bank lines.",
      ),
  })
  .strict();

const deleteItemInput = z
  .object({
    record: refInput,
    expected_version: z.string().min(1),
  })
  .strict();

const changeRecordsInput = z.object({
  update: z.array(updateItemInput).max(MAX_ITEMS, SPLIT).optional(),
  void: z.array(voidItemInput).max(MAX_ITEMS, SPLIT).optional(),
  delete: z.array(deleteItemInput).max(MAX_ITEMS, SPLIT).optional(),
  dry_run: z.boolean().optional(),
  idempotency_key: z.string().trim().min(1).max(200).optional(),
});

type ChangeArgs = z.output<typeof changeRecordsInput>;
type UpdateItem = z.output<typeof updateItemInput>;

type Changed = Record<string, unknown> & { record: number; v?: string };

/** The check `missingForActions` knows each correction path by. */
const PATH_CHECKS: Partial<Record<RoutePath, string>> = {
  correct_date: "correct_record_date",
  correct_expense_contact: "correct_expense_contact",
  correct_payment_recipient: "correct_payment_recipient",
  correct_settled_amount: "correct_settled_amount",
  correct_reimbursement_amount: "correct_reimbursement_amount",
};

function updateItemProblems(item: UpdateItem, at: string): ToolIssue[] {
  const issues: ToolIssue[] = [];
  const set = item.set;
  if (Object.values(set).every((value) => value === undefined))
    issues.push({
      path: `${at}.set`,
      message: "Name at least one field to change.",
    });
  if (set.category !== undefined && set.lines !== undefined)
    issues.push({
      path: `${at}.set.lines`,
      message: "Send category or lines, not both.",
    });
  if (set.amount !== undefined && set.amount <= 0)
    issues.push({
      path: `${at}.set.amount`,
      message: "The amount must be above zero.",
    });
  set.lines?.forEach((line, i) => {
    if (line.amount <= 0)
      issues.push({
        path: `${at}.set.lines[${i}].amount`,
        message: "A line's amount must be above zero.",
      });
  });
  if (set.lines && set.amount !== undefined) {
    // Both in the record's currency, as on create.
    const total = set.lines.reduce((sum, line) => sum + line.amount, 0);
    if (total !== set.amount)
      issues.push({
        path: `${at}.set.lines`,
        message: `The lines add up to ${money_(total)}, but the amount is ${money_(set.amount)}.`,
      });
  }
  set.tax?.forEach((tax, i) => {
    if (tax.treatment === "partial" && tax.percent === undefined)
      issues.push({
        path: `${at}.set.tax[${i}].percent`,
        message: "A partial treatment needs its percent.",
      });
  });
  return issues;
}

/** The friendly fields a change can touch, read off a record, for before → after. */
function recordFacts(
  record: RecordView,
  main: string,
  name: (id: number) => string,
): Record<string, unknown> {
  const lines = categoryLines(record);
  // A line's own figure is kept in the main currency only.
  const lineAmount = record.currency === main ? "amount" : "amount_main";
  return {
    description: record.description,
    reference: record.reference ?? "",
    remark: record.remark ?? "",
    contact: record.contactName ?? null,
    date: record.date,
    amount: decimal(record.amount),
    currency: record.currency,
    exchange_rate: record.exchangeRate,
    amount_main:
      record.currency === main ? undefined : money(record.amountMinor),
    lines: lines.map((m) => ({
      category: name(m.accountId),
      [lineAmount]: money(Math.abs(m.amountMinor)),
      ...(m.label ? { label: m.label } : {}),
    })),
    tax: lines.map((m, i) => ({
      line: i,
      treatment: m.taxClassification?.treatment ?? "unclassified",
      percent: percentOf(m.taxClassification?.percentageBps),
    })),
  };
}

function changes(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, { before: unknown; after: unknown }> {
  const out: Record<string, { before: unknown; after: unknown }> = {};
  for (const key of Object.keys(after))
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key]))
      out[key] = { before: before[key] ?? null, after: after[key] ?? null };
  return out;
}

const paymentNo = (p: { recordId: number; recordNumber: string | null }) =>
  p.recordNumber ?? `#${p.recordId}`;

/** What each step undid and redid, without movement or settlement ids. */
function stepEffects(steps: ChangeRecordStep[]): Record<string, unknown> {
  const out: Record<string, unknown[]> = {};
  const push = (key: string, values: unknown[]) => {
    if (values.length) (out[key] ??= []).push(...values);
  };
  type PaymentRow = {
    payment: { recordId: number; recordNumber: string | null };
    amountMinor: number;
  };
  const payments = (rows: unknown): { payment: string; amount: string }[] =>
    Array.isArray(rows)
      ? (rows as PaymentRow[]).map((row) => ({
          payment: paymentNo(row.payment),
          amount: money(row.amountMinor),
        }))
      : [];
  for (const step of steps) {
    const result = (step.result ?? {}) as Record<string, unknown>;
    if (step.path === "correct_settled_amount") {
      push("reversed", payments(result.reversed));
      push("reapplied", payments(result.reapplied));
      push("leftover_credit", payments(result.leftoverCredit));
      if (Array.isArray(result.rematched))
        push(
          "rematched",
          (result.rematched as { line: { lineId: number } }[]).map((r) =>
            lineRef(r.line.lineId),
          ),
        );
    } else if (Array.isArray(result.rematched)) {
      // A date moved on a bank-matched record: unmatched, changed, rematched.
      push("rematched", [
        ...new Set(
          (result.rematched as { lineId: number }[]).map((r) =>
            lineRef(r.lineId),
          ),
        ),
      ]);
    }
  }
  return out;
}

/**
 * An update's `set.lines`, sent in the record's currency (the new one when the
 * update sets one), as the main-currency cents `changeRecord` takes: at the
 * update's new rate, else 1 for the main currency, else the record's rate, and
 * adding up to exactly what the money side will hold — its figure now when
 * the amount, currency and rate stay, else `toMinor(amount, rate)`, as
 * `updateRecord` and the settled-amount correction compute it.
 *
 * Lines that do not add up to the record's amount are refused here, in its own
 * currency, as the router would refuse them in main-currency figures. A record
 * that is not an expense or income has no split: its lines go on as sent, for
 * the router to refuse.
 */
function updateLinesInMain(
  record: RecordView,
  set: UpdateItem["set"],
  at: string,
  main: string,
): number[] | ItemFailure {
  const lines = set.lines!.map((line) => line.amount);
  const currency = set.currency ?? record.currency;
  const rate =
    set.exchange_rate ?? (currency === main ? 1 : record.exchangeRate);
  const everyday =
    record.kind === LedgerRecordKind.Expense ||
    record.kind === LedgerRecordKind.Income;
  if (!everyday || rate === 1) return lines;
  const sum = lines.reduce((total, line) => total + line, 0);
  // With a new amount the input check has already compared the two.
  const amountMinor = set.amount ?? toMinor(record.amount, 1);
  if (sum !== amountMinor) {
    const why = `The lines add up to ${money_(sum)} ${currency}, but the record's amount is ${money_(amountMinor)} ${record.currency}.`;
    const fix =
      "Send the new amount with the lines, or make the lines add up to the amount.";
    return failWith("REFUSED", `lines: ${why} ${fix}`, {
      blocked: [{ field: "lines", why, fix }],
      fix: BLOCKED_FIX,
    });
  }
  const amount =
    set.amount !== undefined ? fromMinor(set.amount) : record.amount;
  const moneyStays =
    amount === record.amount &&
    currency === record.currency &&
    rate === record.exchangeRate;
  const converted = linesInMain(
    lines,
    moneyStays ? record.amountMinor : toMinor(amount, rate),
  );
  return converted.ok
    ? converted.parts
    : lineTooSmall(
        `${at}.set.lines[${converted.index}].amount`,
        lines[converted.index],
        currency,
        main,
        rate,
      );
}

function updateItem(
  item: UpdateItem,
  at: string,
  meta: ToolCallMeta,
  main: string,
  name: (id: number) => string,
): BatchItem<Changed> {
  return {
    action: "update",
    label: at,
    run: (c) => {
      const found = resolveRecord(c, item.record);
      if (!found.ok)
        return refMiss(found, {
          what: "record",
          ref: item.record,
          path: `${at}.record`,
          lookup: meta.nameOf("search_records"),
        });
      const id = found.id;
      const set = item.set;
      const before = getRecord(c.db, id);
      const change: RecordChange = {};
      if (set.description !== undefined) change.description = set.description;
      if (set.reference !== undefined) change.reference = set.reference;
      if (set.remark !== undefined) change.remark = set.remark;
      if (set.date !== undefined) change.date = set.date;
      if (set.currency !== undefined) change.currency = set.currency;
      if (set.exchange_rate !== undefined)
        change.exchangeRate = set.exchange_rate;
      if (set.amount !== undefined) change.amount = money(set.amount);
      if (set.contact !== undefined) {
        if (set.contact === null) change.contactId = null;
        else {
          const contact = resolveContact(c, set.contact);
          if (!contact.ok)
            return refMiss(contact, {
              what: "contact",
              ref: set.contact,
              path: `${at}.set.contact`,
              lookup: meta.nameOf("find_contacts"),
            });
          change.contactId = contact.id;
        }
      }
      const category = (ref: string | number, field: string) => {
        const account = resolveAccount(c, ref, {
          where: isCategoryAccount,
          wanted: "a category",
        });
        return account.ok
          ? account.id
          : refMiss(account, {
              what: "account",
              ref,
              path: `${at}.set.${field}`,
              lookup: meta.nameOf("list_accounts"),
            });
      };
      if (set.category !== undefined) {
        const accountId = category(set.category, "category");
        if (typeof accountId !== "number") return accountId;
        change.categoryAccountId = accountId;
      }
      if (set.lines !== undefined) {
        const accountIds: number[] = [];
        for (const [i, line] of set.lines.entries()) {
          const accountId = category(line.category, `lines[${i}].category`);
          if (typeof accountId !== "number") return accountId;
          accountIds.push(accountId);
        }
        const amounts = before
          ? updateLinesInMain(before, set, at, main)
          : set.lines.map((line) => line.amount);
        if (!Array.isArray(amounts)) return amounts;
        change.lines = set.lines.map((line, i) => ({
          accountId: accountIds[i],
          amountMinor: amounts[i],
          ...(line.label !== undefined ? { label: line.label } : {}),
        }));
      }
      if (set.tax !== undefined)
        change.tax = set.tax.map((tax) => ({
          ...(tax.line !== undefined ? { line: tax.line } : {}),
          treatment: tax.treatment,
          ...(tax.percent !== undefined ? { percentageBps: tax.percent } : {}),
          ...(tax.reason !== undefined ? { reason: tax.reason } : {}),
        }));

      // The paths decided first, so a token missing a correction's scope
      // hears which one, the way a step-up names it.
      const release = item.release_bank_matches ?? false;
      const route = routeRecordChange(c, id, change, {
        releaseBankMatches: release,
      });
      if (route.ok) {
        const checks = route.value.steps.flatMap((step) => [
          ...(PATH_CHECKS[step.path] ? [PATH_CHECKS[step.path]!] : []),
          ...(step.needs.releaseBankMatches ? ["release_bank_matches"] : []),
        ]);
        const short = missingForActions(c.locals, "change_records", checks);
        if (short.length) {
          const refusal = actionRefusal(meta.name, short);
          return failWith("FORBIDDEN", refusal.message, { fix: refusal.fix });
        }
      }

      const changed = changeRecord(c, {
        recordId: id,
        expectedVersion: item.expected_version,
        change,
        ...(item.reason !== undefined ? { reason: item.reason } : {}),
        ...(item.acknowledge_period_change !== undefined
          ? { acknowledgePeriodChange: item.acknowledge_period_change }
          : {}),
        ...(release ? { releaseBankMatches: true } : {}),
      });
      if (!changed.ok) {
        const failure = changed as ChangeRecordFailure;
        const blocked = failure.blocked?.map((b) => ({
          field: fieldName(b.field),
          why: toolWords(b.why),
          fix: toolWords(b.fix),
        }));
        // The router's own blocks name its fields; only the reworded ones go out.
        return {
          ...reworded(failure),
          blocked: blocked?.length ? blocked : undefined,
          ...(blocked?.length ? { fix: BLOCKED_FIX } : {}),
        } satisfies ItemFailure;
      }
      const value = changed.value;
      return ok({
        record: id,
        no: value.record.recordNumber,
        paths: value.steps.map((step) => step.path),
        changed: before
          ? changes(
              recordFacts(before, main, name),
              recordFacts(value.record, main, name),
            )
          : {},
        ...stepEffects(value.steps),
        v: value.version,
      });
    },
  };
}

/** `RecordChange`'s field names as this tool's `set` names them. */
function fieldName(field: string): string {
  switch (field) {
    case "contactId":
      return "contact";
    case "categoryAccountId":
      return "category";
    case "exchangeRate":
      return "exchange_rate";
    default:
      return field;
  }
}

/** The active legacy reimbursement this record is the payment of, if any. */
function reimbursementGroupPaidBy(db: LedgerDb, id: number): number | null {
  const row = db
    .select({ id: reimbursements.id })
    .from(reimbursements)
    .where(
      and(
        eq(reimbursements.paymentRecordId, id),
        isNull(reimbursements.reversedAt),
      ),
    )
    .get();
  return row?.id ?? null;
}

function voidItem(
  item: z.output<typeof voidItemInput>,
  at: string,
  meta: ToolCallMeta,
): BatchItem<Changed> {
  return {
    action: "void",
    label: at,
    run: (c) => {
      const found = resolveRecord(c, item.record);
      if (!found.ok)
        return refMiss(found, {
          what: "record",
          ref: item.record,
          path: `${at}.record`,
          lookup: meta.nameOf("search_records"),
        });
      const id = found.id;

      const group = reimbursementGroupPaidBy(c.db, id);
      if (group !== null) {
        // A reimbursement payment is undone by reversing its reimbursement:
        // the transfers are reversed on today's date, the expenses reopen and
        // the payment's amount becomes its credit again.
        const short = missingForActions(c.locals, "change_records", [
          "reverse_reimbursement",
        ]);
        if (short.length) {
          const refusal = actionRefusal(meta.name, short);
          return failWith("FORBIDDEN", refusal.message, { fix: refusal.fix });
        }
        const stale = checkVersion(
          recordVersion(c.db, id),
          item.expected_version,
        );
        if (stale) return stale;
        const prepared = prepareReimbursementReversal(c, group);
        if (!prepared.ok) return prepared;
        const reversed = reverseReimbursement(c, {
          groupId: group,
          date: localToday(),
          reason: item.reason,
          expectedVersion: prepared.value.version,
        });
        if (!reversed.ok) return reworded(reversed);
        const summary = prepared.value.summary;
        return ok({
          record: id,
          no: recordNo(c.db, id),
          path: "reverse_reimbursement",
          reopened: summary.items.map((i) => ({
            record: recordNo(c.db, i.recordId),
            amount: money(i.amountMinor),
          })),
          credit_released: summary.funding.map((f) => ({
            record: recordNo(c.db, f.recordId),
            amount: money(f.releasedMinor),
          })),
          reversals: reversed.value.reversalIds.map((r) => recordNo(c.db, r)),
          v: recordVersion(c.db, id),
        });
      }

      const release = item.release ?? "none";
      const done = voidRecord(c, id, {
        reason: item.reason,
        expectedVersion: item.expected_version,
        release,
      });
      if (!done.ok) {
        if (done.code !== "REFUSED") return reworded(done);
        const next = release === "all" ? null : voidSuggestion(c, id, release);
        return next && next.release !== release
          ? failWith("REFUSED", toolWords(done.reason), {
              fix: `Send it again with release: "${next.release}", which first undoes what release_preview lists (dry_run first to check).`,
              details: { release_preview: next.preview },
            })
          : reworded(done);
      }
      return ok({
        record: id,
        no: done.value.record.recordNumber,
        path: "void",
        reversal:
          done.value.reversal.recordNumber ?? `#${done.value.reversal.id}`,
        ...(done.value.released
          ? { released: releasedView(c.db, done.value.released) }
          : {}),
        v: done.value.version,
      });
    },
  };
}

function deleteItem(
  item: z.output<typeof deleteItemInput>,
  at: string,
  meta: ToolCallMeta,
): BatchItem<Changed> {
  return {
    action: "delete",
    label: at,
    run: (c) => {
      const found = resolveRecord(c, item.record);
      if (!found.ok)
        return refMiss(found, {
          what: "record",
          ref: item.record,
          path: `${at}.record`,
          lookup: meta.nameOf("search_records"),
        });
      const id = found.id;
      const no = recordNo(c.db, id);
      const done = deleteRecord(c, id, item.expected_version);
      if (!done.ok) {
        if (done.code !== "REFUSED") return reworded(done);
        // Payments, bank lines or allocation history keep it: a void undoes
        // it and keeps that history.
        const next = voidSuggestion(c, id);
        return next
          ? failWith("REFUSED", toolWords(done.reason), {
              fix: `Void it instead: send it in void[] with a reason${next.release === "none" ? "" : ` and release: "${next.release}"`}. A void keeps the record's history and nets it to zero.`,
              details: { release_preview: next.preview },
            })
          : reworded(done);
      }
      return ok({ record: id, no, deleted: true });
    },
  };
}

const CHANGE_DESCRIPTION = `Changes existing records. Read the record (akaun_get_record) and pass its v as expected_version; a stale one returns CONFLICT with the current version. A record is an id or number ("EXP-2026-0042").

- update[]: put in set what the record should end up saying: description, reference, remark, contact, date, category, lines (a split adding up to the amount), amount, currency, exchange_rate, tax per line. The server picks a plain edit, or a correction when payments or bank lines rely on the record. A correction needs a reason; a date in another month needs acknowledge_period_change; a bank-matched date needs release_bank_matches. A field that cannot change comes back in blocked[] with why and what to undo first.
- void[]: undo a record as if it never happened, keeping its history; needs a reason. release "allocations" first reverses payments applied to it; "all" also unmatches its bank lines. A reimbursement payment reverses its reimbursement.
- delete[]: remove a record entered by mistake that nothing relies on. When history keeps it, the error suggests a void.

A call saves at once, all or nothing (at most 50 items). For corrections, voids and deletes run dry_run: true first, show the user what would change, and save only once they agree. Each result gives the path taken, changed fields before and after, allocations reversed and reapplied, and the new v. Amounts and lines are decimal strings ("1285.50") in the record's currency. Send an idempotency_key if you may retry.`;

export const changeRecordsTool = defineWriteTool({
  base: "change_records",
  title: "Change records",
  description: CHANGE_DESCRIPTION,
  input: changeRecordsInput,
  annotations: {
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  requirements: CHANGE_RECORDS.requirements,
  actions: CHANGE_RECORDS.actions,
  handler: async (ctx, args: ChangeArgs, meta) => {
    const base = "change_records";
    const releases = new Set((args.void ?? []).map((v) => v.release ?? "none"));
    const shortfalls = missingForActions(ctx.locals, base, [
      ...actionsInArguments(base, args),
      ...(releases.has("allocations") ? ["void_release_allocations"] : []),
      ...(releases.has("all") ? ["void_release_all"] : []),
    ]);
    if (shortfalls.length)
      return toolError(actionRefusal(meta.name, shortfalls));

    const total =
      (args.update?.length ?? 0) +
      (args.void?.length ?? 0) +
      (args.delete?.length ?? 0);
    if (total === 0)
      return inputProblems([
        {
          path: "",
          message: "Send at least one item in update, void or delete.",
        },
      ]);
    const issues = (args.update ?? []).flatMap((item, i) =>
      updateItemProblems(item, `update[${i}]`),
    );
    if (issues.length) return inputProblems(issues);

    const main = mainCurrencyCode(ctx.db);
    const name = accountNamer(ctx.db);
    const items: BatchItem<Changed>[] = [
      ...(args.update ?? []).map((item, i) =>
        updateItem(item, `update[${i}]`, meta, main, name),
      ),
      ...(args.void ?? []).map((item, i) => voidItem(item, `void[${i}]`, meta)),
      ...(args.delete ?? []).map((item, i) =>
        deleteItem(item, `delete[${i}]`, meta),
      ),
    ];
    const result = await runBatch(ctx, {
      tool: meta.name,
      dryRun: args.dry_run ?? false,
      items,
      idempotency: args.idempotency_key
        ? {
            key: args.idempotency_key,
            inputHash: hashInput({
              update: args.update,
              void: args.void,
              delete: args.delete,
            }),
          }
        : undefined,
    });
    return withMainCurrency(
      ctx.db,
      batchToolResult(result, {
        requestId: meta.requestId,
        formatValue: (value) => value,
      }),
    );
  },
});

// ---------------------------------------------------------------------------
// attach_file: v1's contract, renamed only
// ---------------------------------------------------------------------------

/** v1's output schema (`mcp/common.ts`), declared again so v1 can be removed. */
const attachOutput = z.object({
  data: z.record(z.string(), z.json()),
  meta: z.object({
    observedAt: z.string(),
    mainCurrency: z.string(),
    minorUnitScale: z.literal(100),
  }),
});

/** v1's error shape, kept with v1's codes. */
function v1Error(failure: AppFailure): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error: {
            code: failure.code,
            message: failure.reason,
            ...(failure.currentVersion
              ? { currentVersion: failure.currentVersion }
              : {}),
            ...(failure.issues ? { issues: failure.issues } : {}),
          },
        }),
      },
    ],
  };
}

export const attachFileTool = defineWriteTool({
  base: "attach_file",
  title: "Attach a file to a record",
  description:
    "Attach a receipt or document to a record: `contentBase64` is the file's bytes, PDF, JPEG or PNG, up to 15 MB (the type is read from the bytes, not the name). Allowed on settled and bank-matched records. Its text is indexed for search in the background.",
  input: z.object(attachFileShape),
  annotations: {
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  requirements: ATTACH_FILE.requirements,
  legacyOutput: attachOutput,
  handler: async (ctx, args) => {
    const result = await attachFile(ctx, args);
    if (!result.ok) return v1Error(result);
    const structuredContent = {
      data: result.value,
      meta: {
        observedAt: new Date().toISOString(),
        mainCurrency: mainCurrencyCode(ctx.db),
        minorUnitScale: 100 as const,
      },
    };
    return {
      structuredContent,
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    };
  },
});

/** The records write tools, in listing order. */
export const recordsWriteTools: readonly ToolDefinition[] = [
  attachFileTool,
  createRecordsTool,
  changeRecordsTool,
];
