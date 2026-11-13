import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import {
  AccountType,
  ExpenseSubType,
  ImportState,
  InvoiceStatus,
  LedgerRecordKind,
  LedgerRecordKindLabels,
  StatementDirection,
} from "$lib/enums.js";
import { addDaysISO, localToday } from "$lib/local-date.js";
import {
  monthEndFor,
  previousMonthEnd,
  type ClosingItem,
  type ClosingItemRef,
} from "$lib/closing.js";
import type {
  AttentionItem,
  PipelineSection,
  PositionSection,
} from "$lib/components/dashboard/types.js";
import {
  accounts,
  contacts,
  depreciationRuns,
  ledgerMovements,
  ledgerRecords,
} from "../db/schema.js";
import { can } from "../permissions.js";
import { isValidDate } from "../date.js";
import { DESCRIPTION_POLICY } from "../description-policy.js";
import { closedThrough } from "../closing/policy.js";
import { mainCurrencyCode } from "../currency/form.js";
import { formatMinor, toMinor } from "../ledger/money.js";
import type { LedgerDb, OutstandingItem, RecordView } from "../ledger/types.js";
import { closingReview } from "../application/closing.js";
import { CONTENT_CHAR_LIMIT } from "../import/duplicate-detector.js";
import { EPSILON, round2 } from "../reconciliation/types.js";
import { unmatchedLinesByAccount } from "../services/reconciliation.js";
import { findDuplicates, normalizeName } from "./contacts.js";
import {
  DUPLICATE_RECORD_LIMITS,
  findDuplicateRecords,
  type DuplicateFileSource,
  type DuplicateGroup,
  type DuplicateMember,
} from "./duplicate-records.js";
import { fixedAssetRegister } from "./fixed-assets.js";
import { listImportJobs } from "./import.js";
import { deriveOverdue, listInvoices } from "./invoices.js";
import { listRecords } from "./ledger.js";
import {
  listAllocations,
  listLines,
  listStatements,
} from "./reconciliation.js";
import { listOutstanding } from "./settlements.js";
import { unresolvedTaxLines } from "./tax-review.js";
import { notVoided } from "./void-state.js";

/**
 * The books review: the books turned into findings, each with what it found,
 * how serious it is, and the call to make next (`review_books`, and the month
 * end preparation the plan describes).
 *
 * A pure read. Every check reads through the queries the screens use, inside
 * one read transaction, so the findings describe one moment of the book; a
 * file with no saved hash is hashed in memory only, never written back.
 *
 * **Who sees what.** Each check reads one or more areas (`BOOKS_REVIEW_AREAS`)
 * and runs only when `can` allows all of them. A check that does not run is
 * listed under `skipped` with the areas it needed, never under `clean`.
 *
 * **Period.** `period` selects what is dated in it: records, bank lines, bills
 * and invoices (by issue date). Ages and overdue states are measured against
 * `today`. Without a period a review covers everything through today. A check
 * whose fix edits the record itself looks only after the closed-through date
 * (`OPEN_MONTHS_ONLY`), and says so in its note.
 *
 * **Next steps.** `next` is a read whose arguments the named tool accepts as
 * they are: the full list behind a finding, or the first item in detail.
 * `fixWith` names the write tool that resolves the items once the user
 * agrees. Both are base names (`search_records`); the MCP layer adds the
 * prefix.
 */

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

/** Every check, in the order a review runs and lists them. */
export const BOOKS_REVIEW_CHECKS = [
  "uncategorised",
  "missing_evidence",
  "duplicate_records",
  "duplicate_contacts",
  "tax_unresolved",
  "unmatched_bank",
  "unpaid_bills",
  "overdue_invoices",
  "unallocated_credits",
  "descriptions",
  "capitalisation",
  "depreciation_due",
  "month_end",
] as const;
export type BooksReviewCheck = (typeof BOOKS_REVIEW_CHECKS)[number];

/** The screens a caller may read, as `can` is asked about them. */
export type BooksReviewArea =
  | "records"
  | "accounts"
  | "contacts"
  | "reconciliation"
  | "invoices"
  | "import"
  | "reports";

/** What each check reads. It runs only when `can` allows every one of them. */
export const BOOKS_REVIEW_AREAS: Readonly<
  Record<BooksReviewCheck, readonly BooksReviewArea[]>
> = {
  uncategorised: ["records"],
  missing_evidence: ["records"],
  duplicate_records: ["records"],
  duplicate_contacts: ["contacts"],
  tax_unresolved: ["records"],
  unmatched_bank: ["reconciliation"],
  unpaid_bills: ["records"],
  overdue_invoices: ["invoices"],
  unallocated_credits: ["records"],
  descriptions: ["records"],
  capitalisation: ["records"],
  // The asset register's own read permission (`ASSET_READ_PERMISSIONS`).
  depreciation_due: ["accounts", "records"],
  // What `previewClosing` asks for.
  month_end: ["reports"],
};

/** The defaults and limits a review uses. Money is main-currency cents. */
export const BOOKS_REVIEW_LIMITS = {
  /** Items per finding when the caller names none, and the most it may ask for. */
  defaultPerCheck: 10,
  maxPerCheck: 50,
  /** `missing_evidence`: a record below this needs no file. */
  evidenceMinMinor: 1_000,
  /** `capitalisation`: an expense line at or above this may be equipment. */
  capitalisationMinMinor: 200_000,
  /** `unpaid_bills`, and `unmatched_bank`'s severity: older than this many days. */
  staleDays: 30,
} as const;

export type BooksReviewSeverity = "high" | "medium" | "low";

/** What an item points at. A bank line is `line`; an import job's id is text. */
export type BooksReviewRef =
  | {
      type: "record" | "contact" | "line" | "account" | "invoice" | "asset";
      id: number;
    }
  | { type: "job"; id: string };

export type BooksReviewItem = {
  /** Absent only on a `month_end` line that sums up another check. */
  ref?: BooksReviewRef;
  /** One line a person can read. Dates are ISO; amounts carry the currency code. */
  summary: string;
  /** The other members of a duplicate group. */
  related?: BooksReviewRef[];
};

/** A tool call by base name, e.g. `search_records`. */
export type BooksReviewCall = {
  tool: string;
  args: Record<string, unknown>;
};

export type BooksReviewFinding = {
  check: BooksReviewCheck;
  severity: BooksReviewSeverity;
  /** Everything the check found; `items` lists at most `perCheck` of them. */
  count: number;
  items: BooksReviewItem[];
  /** The read to make next, with arguments the tool accepts as they are. */
  next?: BooksReviewCall;
  /** The write tool, by base name, that fixes these once the user agrees. */
  fixWith?: string;
  /** What the check looked for, with any threshold it used. */
  note: string;
  /** `month_end` only: each other check's count over the same dates. */
  counts?: Partial<Record<BooksReviewCheck, number>>;
};

export type BooksReviewSkip = {
  check: BooksReviewCheck;
  /** The areas the caller may not read; empty when skipped for another reason. */
  needs: BooksReviewArea[];
  reason: string;
};

export type BooksReviewInput = {
  /** Which checks to run. Default: all of them. */
  checks?: readonly BooksReviewCheck[];
  /** Inclusive ISO dates; a null `from` is the start of the books. Default: through today. */
  period?: { from: string | null; to: string };
  /** Items per finding: default 10, at most 50, 0 for counts alone. */
  perCheck?: number;
  /** Whether the caller may read an area. */
  can: (area: BooksReviewArea) => boolean;
  /** The day ages are measured against. Default: the server's local day. */
  today?: string;
};

export type BooksReview = {
  /** The dates the review covered. */
  period: { from: string | null; to: string };
  today: string;
  /** Most severe first, then the largest count. */
  findings: BooksReviewFinding[];
  /** The checks that ran and found nothing. */
  clean: BooksReviewCheck[];
  /** The checks that did not run, and why. */
  skipped: BooksReviewSkip[];
};

// ---------------------------------------------------------------------------
// The review
// ---------------------------------------------------------------------------

type Scope = { from: string | null; to: string };

type Env = {
  db: LedgerDb;
  today: string;
  currency: string;
  closedThrough: string | null;
  files?: DuplicateFileSource;
};

type Outcome = Omit<BooksReviewFinding, "check">;

/** One check over `scope`, listing at most `limit` items. */
type Check = (
  env: Env,
  scope: Scope,
  limit: number,
  /** The period as the tool in `next` takes it, or nothing. */
  period: Record<string, unknown>,
) => Outcome;

const SEVERITY_RANK: Readonly<Record<BooksReviewSeverity, number>> = {
  high: 0,
  medium: 1,
  low: 2,
};

/**
 * Checks whose fix changes the record itself, which a closed month refuses.
 * They look only after the closed-through date, so that nothing they list
 * needs a person to reopen a month first.
 */
const OPEN_MONTHS_ONLY: ReadonlySet<BooksReviewCheck> = new Set([
  "uncategorised",
  "missing_evidence",
  "duplicate_records",
  "tax_unresolved",
  "descriptions",
  "capitalisation",
]);

/**
 * Reviews the books. `deps.files` reads stored files for the duplicate check
 * (`storageFiles(ctx.storageRoot)`); without it, only saved hashes compare.
 * Throws a RangeError on a malformed period or day: callers validate first.
 */
export function reviewBooks(
  db: LedgerDb,
  input: BooksReviewInput,
  deps: { files?: DuplicateFileSource } = {},
): BooksReview {
  const today = input.today ?? localToday();
  if (!isValidDate(today))
    throw new RangeError(`today must be a YYYY-MM-DD date, not ${today}.`);
  const scope: Scope = input.period ?? { from: null, to: today };
  if (
    !isValidDate(scope.to) ||
    (scope.from !== null && !isValidDate(scope.from))
  )
    throw new RangeError("The period must run between YYYY-MM-DD dates.");
  if (scope.from !== null && scope.from > scope.to)
    throw new RangeError(
      `The period ends (${scope.to}) before it starts (${scope.from}).`,
    );
  const limit = perCheckLimit(input.perCheck);
  const wanted = new Set(input.checks ?? BOOKS_REVIEW_CHECKS);
  const given = input.period !== undefined;
  const missing = (check: BooksReviewCheck) =>
    BOOKS_REVIEW_AREAS[check].filter((area) => !input.can(area));

  // One snapshot, so every finding and the month-end checks agree.
  return db.transaction(() => {
    const env: Env = {
      db,
      today,
      currency: mainCurrencyCode(db),
      closedThrough: closedThrough(db),
      files: deps.files,
    };
    const findings: BooksReviewFinding[] = [];
    const clean: BooksReviewCheck[] = [];
    const skipped: BooksReviewSkip[] = [];
    for (const check of BOOKS_REVIEW_CHECKS) {
      if (!wanted.has(check)) continue;
      const needs = missing(check);
      if (needs.length) {
        skipped.push({
          check,
          needs,
          reason: `Needs read access to ${list(needs)}.`,
        });
        continue;
      }
      const outcome =
        check === "month_end"
          ? monthEnd(
              env,
              scope,
              given,
              limit,
              (other) => missing(other).length === 0,
            )
          : runCheck(env, check, scope, given, limit);
      if ("skip" in outcome) {
        skipped.push({ check, needs: [], reason: outcome.skip });
        continue;
      }
      if (outcome.count === 0) clean.push(check);
      else findings.push({ check, ...outcome });
    }
    const order = (check: BooksReviewCheck) =>
      BOOKS_REVIEW_CHECKS.indexOf(check);
    findings.sort(
      (a, b) =>
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
        b.count - a.count ||
        order(a.check) - order(b.check),
    );
    return { period: scope, today, findings, clean, skipped };
  });
}

/** One check other than month_end, kept to open months where its fix needs one. */
function runCheck(
  env: Env,
  check: Exclude<BooksReviewCheck, "month_end">,
  scope: Scope,
  given: boolean,
  limit: number,
): Outcome | { skip: string } {
  const closed = env.closedThrough;
  if (
    !OPEN_MONTHS_ONLY.has(check) ||
    closed === null ||
    (scope.from !== null && scope.from > closed)
  )
    return CHECKS[check](env, scope, limit, periodArgs(scope, given));
  const open: Scope = { from: addDaysISO(closed, 1), to: scope.to };
  if (open.from! > open.to)
    return {
      skip: `The whole period is closed (closed through ${closed}): its records cannot change until a person reopens the month.`,
    };
  const outcome = CHECKS[check](env, open, limit, periodArgs(open, true));
  return {
    ...outcome,
    note: `${outcome.note} Records dated on or before ${closed}, the closed-through date, are left out: they cannot change until a person reopens their month.`,
  };
}

function perCheckLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value))
    return BOOKS_REVIEW_LIMITS.defaultPerCheck;
  return Math.min(
    BOOKS_REVIEW_LIMITS.maxPerCheck,
    Math.max(0, Math.trunc(value)),
  );
}

/** The period as `search_records` and the other reads take it; nothing when none was given. */
function periodArgs(scope: Scope, given: boolean): Record<string, unknown> {
  if (!given) return {};
  if (scope.from === null) return { as_at: scope.to };
  return {
    period: scope.from === scope.to ? scope.from : `${scope.from}..${scope.to}`,
  };
}

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "a", "a and b", "a, b and c". */
function list(words: readonly string[]): string {
  return words.length < 2
    ? (words[0] ?? "")
    : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

function money(env: Env, minor: number): string {
  return `${env.currency} ${formatMinor(minor)}`;
}

function recordLabel(id: number, recordNumber: string | null): string {
  return recordNumber ?? `#${id}`;
}

function quoted(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "(no description)";
  return `"${trimmed.length > 80 ? `${trimmed.slice(0, 79)}…` : trimmed}"`;
}

function accountLabel(code: number | null, name: string): string {
  return code === null ? name : `${code} ${name}`;
}

/** Whole days from `date` to `today`. */
function ageInDays(date: string, today: string): number {
  const ms = Date.parse(`${today}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`);
  return Number.isNaN(ms) ? 0 : Math.floor(ms / 86_400_000);
}

function inScope(date: string, scope: Scope): boolean {
  return (scope.from === null || date >= scope.from) && date <= scope.to;
}

function dateFilters(scope: Scope): { dateFrom?: string; dateTo: string } {
  return scope.from === null
    ? { dateTo: scope.to }
    : { dateFrom: scope.from, dateTo: scope.to };
}

function recordItem(env: Env, record: RecordView): BooksReviewItem {
  return {
    ref: { type: "record", id: record.id },
    summary: [
      recordLabel(record.id, record.recordNumber),
      record.date,
      record.supplierContactName ?? record.contactName ?? "no contact",
      quoted(record.description),
      money(env, record.amountMinor),
    ].join(" · "),
  };
}

function owedItem(env: Env, item: OutstandingItem, state: string) {
  return {
    ref: { type: "record" as const, id: item.recordId },
    summary: [
      recordLabel(item.recordId, item.recordNumber),
      item.date,
      item.contactName ?? item.supplierContactName ?? "no contact",
      quoted(item.description),
      state,
    ].join(" · "),
  };
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

const RECORD_KIND = {
  expense: LedgerRecordKindLabels[LedgerRecordKind.Expense],
  income: LedgerRecordKindLabels[LedgerRecordKind.Income],
};

/** Who a record is for: the supplier of a personally paid expense, else its contact. */
const party = sql<
  number | null
>`coalesce(${ledgerRecords.supplierContactId}, ${ledgerRecords.contactId})`;
const partyContact = alias(contacts, "review_party");

/** Kinds whose description a person writes. Invoice postings follow their invoice. */
const DESCRIBED_KINDS = [
  LedgerRecordKind.Expense,
  LedgerRecordKind.Income,
  LedgerRecordKind.Payment,
  LedgerRecordKind.Transfer,
  LedgerRecordKind.Journal,
];

const CHECKS: Readonly<Record<Exclude<BooksReviewCheck, "month_end">, Check>> =
  {
    uncategorised(env, scope, limit, period) {
      const { records, total } = listRecords(env.db, {
        uncategorised: true,
        ...dateFilters(scope),
        limit,
      });
      return {
        severity: "low",
        count: total,
        items: records.map((record) => recordItem(env, record)),
        next: {
          tool: "search_records",
          args: { category: "uncategorised", ...period },
        },
        fixWith: "change_records",
        note: "Records with a line on the uncategorised expense or income default account, newest first.",
      };
    },

    missing_evidence(env, scope, limit, period) {
      const min = BOOKS_REVIEW_LIMITS.evidenceMinMinor;
      const { records, total } = listRecords(env.db, {
        kind: [LedgerRecordKind.Expense, LedgerRecordKind.Income],
        hasAttachment: false,
        minMainMinor: min,
        ...dateFilters(scope),
        limit,
      });
      return {
        severity: "medium",
        count: total,
        items: records.map((record) => recordItem(env, record)),
        next: {
          tool: "search_records",
          args: {
            kinds: [RECORD_KIND.expense, RECORD_KIND.income],
            has_attachment: false,
            min: formatMinor(min),
            ...period,
          },
        },
        fixWith: "attach_file",
        note: `Expense and income records of ${money(env, min)} or more with no file attached, newest first.`,
      };
    },

    duplicate_records(env, scope, limit) {
      const found = findDuplicateRecords(
        env.db,
        {
          ...(scope.from === null ? {} : { from: scope.from }),
          to: scope.to,
          limit: Math.min(Math.max(limit, 1), DUPLICATE_RECORD_LIMITS.limit),
        },
        env.files,
      );
      const items = found.groups
        .slice(0, limit)
        .map((group) => duplicateItem(env, group));
      const first = items[0]?.ref;
      return {
        severity: "high",
        count: found.totalGroups,
        items,
        ...(first
          ? {
              next: {
                tool: "get_record",
                args: {
                  record: first.id,
                  include: ["evidence_text", "history"],
                },
              },
            }
          : {}),
        fixWith: "change_records",
        note: `Records that look entered twice, strongest first. Signals: same_file, same_reference, amount_date_contact (at most ${DUPLICATE_RECORD_LIMITS.defaultMaxDays} days apart) and similar_text. Each item names first the copy with the least applied to it; compare the evidence and ask before voiding either.`,
      };
    },

    duplicate_contacts(env, _scope, limit) {
      const groups = findDuplicateContacts(env.db);
      return {
        severity: "low",
        count: groups.length,
        items: groups.slice(0, limit).map(contactGroupItem),
        next: { tool: "find_contacts", args: { duplicates: true } },
        fixWith: "change_contacts",
        note: "Contacts that may be one supplier or customer: the same name, email, phone or registration number; the same name once a company suffix such as Sdn Bhd is dropped; or files on one contact's records that carry another contact's registration number or full name. Contacts have no date, so the period does not apply.",
      };
    },

    tax_unresolved(env, scope, limit, period) {
      const lines = unresolvedTaxLines(
        env.db,
        scope.from === null ? null : addDaysISO(scope.from, -1),
        scope.to,
      );
      // A line stops a close once its month has ended and is still open.
      const closable = previousMonthEnd(env.today.slice(0, 7));
      const blocking = lines.some(
        (line) =>
          closable !== null &&
          line.date <= closable &&
          (env.closedThrough === null || line.date > env.closedThrough),
      );
      return {
        severity: blocking ? "high" : "low",
        count: lines.length,
        items: lines.slice(0, limit).map((line) => ({
          ref: { type: "record", id: line.recordId },
          summary: [
            recordLabel(line.recordId, line.recordNumber),
            line.date,
            line.accountName,
            quoted(line.label || line.description),
            money(env, line.amountMinor),
          ].join(" · "),
        })),
        next: {
          tool: "search_records",
          args: { tax: ["unclassified", "requires_review"], ...period },
        },
        fixWith: "change_records",
        note: "Expense lines with no tax treatment, or marked for review, oldest first. A month cannot be closed while one of its lines is here.",
      };
    },

    unmatched_bank(env, scope, limit, period) {
      const allocated = new Map<number, number>();
      for (const allocation of listAllocations(env.db))
        allocated.set(
          allocation.lineId,
          (allocated.get(allocation.lineId) ?? 0) + allocation.amount,
        );
      const statements = new Map(
        listStatements(env.db).map((statement) => [statement.id, statement]),
      );
      // The remainder rule of the statement summaries (`lineRemainders` in
      // services/reconciliation.ts), both ways, as the closing check counts:
      // unmatched, partly matched or overmatched. Oldest first.
      const open = listLines(env.db)
        .filter((line) => inScope(line.date, scope))
        .map((line) => ({
          line,
          remaining: round2(line.amount - (allocated.get(line.id) ?? 0)),
          statement: statements.get(line.statementId),
        }))
        .filter((entry) => Math.abs(entry.remaining) >= EPSILON);
      const perAccount = new Map<string, number>();
      for (const { statement } of open) {
        const name = statement?.accountName ?? "no account";
        perAccount.set(name, (perAccount.get(name) ?? 0) + 1);
      }
      const account = open.find((entry) => entry.statement?.accountId != null)
        ?.statement?.accountId;
      return {
        severity: open.some(
          (entry) =>
            ageInDays(entry.line.date, env.today) >
            BOOKS_REVIEW_LIMITS.staleDays,
        )
          ? "medium"
          : "low",
        count: open.length,
        items: open.slice(0, limit).map(({ line, remaining, statement }) => {
          const lineMinor = toMinor(line.amount, 1);
          const remainingMinor = toMinor(remaining, 1);
          return {
            ref: { type: "line", id: line.id },
            summary: [
              line.date,
              statement?.accountName ?? "no account",
              `${line.direction === StatementDirection.In ? "in" : "out"} ${money(env, lineMinor)}`,
              quoted(line.description),
              remainingMinor === lineMinor
                ? "unmatched"
                : remainingMinor < 0
                  ? `matched ${money(env, -remainingMinor)} more than the line`
                  : `${money(env, remainingMinor)} still unmatched`,
              `${plural(ageInDays(line.date, env.today), "day", "days")} old`,
            ].join(" · "),
          };
        }),
        ...(account == null
          ? {}
          : {
              next: {
                tool: "get_bank_reconciliation",
                args: { account, ...period },
              },
            }),
        fixWith: "match_bank_lines",
        note: `Bank statement lines not fully matched to records, oldest first. By account: ${[
          ...perAccount,
        ]
          .map(([name, n]) => `${name} ${n}`)
          .join(", ")}.`,
      };
    },

    unpaid_bills(env, scope, limit) {
      const days = BOOKS_REVIEW_LIMITS.staleDays;
      const bills = listOutstanding(env.db, {
        direction: "we-owe",
        asOf: env.today,
      }).items.filter(
        (item) =>
          item.position !== "credit" &&
          inScope(item.date, scope) &&
          item.daysOverdue > days,
      );
      return {
        severity: "low",
        count: bills.length,
        items: bills
          .slice(0, limit)
          .map((item) =>
            owedItem(
              env,
              item,
              `${money(env, item.outstandingMinor)}${item.outstandingMinor === item.amountMinor ? "" : ` of ${money(env, item.amountMinor)}`} unpaid, ${plural(item.daysOverdue, "day", "days")} old`,
            ),
          ),
        next: { tool: "get_report", args: { report: "aged_payables" } },
        fixWith: "record_payments",
        note: `Bills and claims still owed more than ${days} days after their date, oldest first.`,
      };
    },

    overdue_invoices(env, scope, limit) {
      const overdue = listInvoices(env.db, {
        status: InvoiceStatus.Sent,
        ...dateFilters(scope),
        limit: -1,
      })
        .filter((invoice) => deriveOverdue(invoice, invoice.paid, env.today))
        .sort(
          (a, b) =>
            (a.dueDate ?? "").localeCompare(b.dueDate ?? "") || a.id - b.id,
        );
      return {
        severity: "medium",
        count: overdue.length,
        items: overdue.slice(0, limit).map((invoice) => ({
          ref: { type: "invoice", id: invoice.id },
          summary: [
            invoice.invoiceNumber,
            invoice.contactName ?? "no customer",
            `due ${invoice.dueDate}`,
            `${money(env, invoice.outstandingMinor)} unpaid`,
            `${plural(ageInDays(invoice.dueDate ?? env.today, env.today), "day", "days")} overdue`,
          ].join(" · "),
        })),
        next: {
          tool: "get_sales_documents",
          args: { kind: "invoice", overdue: true },
        },
        fixWith: "record_payments",
        note: "Sent invoices past their due date and not fully paid, most overdue first. The period selects them by issue date.",
      };
    },

    unallocated_credits(env, scope, limit) {
      const sides = (["we-owe", "owed-to-us"] as const).flatMap((direction) =>
        listOutstanding(env.db, { direction, asOf: env.today }).items.map(
          (item) => ({ item, direction }),
        ),
      );
      // What each contact still has open that a credit could settle.
      const open = new Map<string, number>();
      for (const { item, direction } of sides)
        if (item.position !== "credit" && item.contactId !== null) {
          const key = `${direction}:${item.contactId}`;
          open.set(key, (open.get(key) ?? 0) + 1);
        }
      const credits = sides
        .filter(
          ({ item }) => item.position === "credit" && inScope(item.date, scope),
        )
        .sort(
          (a, b) =>
            b.item.outstandingMinor - a.item.outstandingMinor ||
            a.item.date.localeCompare(b.item.date) ||
            a.item.recordId - b.item.recordId,
        );
      const first = credits[0]?.item;
      return {
        severity: "low",
        count: credits.length,
        items: credits.slice(0, limit).map(({ item, direction }) => {
          const settles =
            item.contactId === null
              ? 0
              : (open.get(`${direction}:${item.contactId}`) ?? 0);
          return owedItem(
            env,
            item,
            `${money(env, item.outstandingMinor)} ${direction === "we-owe" ? "paid" : "received"} and not applied; ${settles ? `${plural(settles, "open item", "open items")} it could settle` : "nothing open to apply it to"}`,
          );
        }),
        ...(first
          ? {
              next:
                first.contactId === null
                  ? { tool: "get_record", args: { record: first.recordId } }
                  : { tool: "get_contact", args: { contact: first.contactId } },
            }
          : {}),
        fixWith: "record_payments",
        note: "Payments and receipts with money left over that no bill or invoice takes up yet, largest first. Nothing open to apply it to can mean the bill itself is short.",
      };
    },

    descriptions(env, scope, limit) {
      const flagged = env.db
        .select({
          id: ledgerRecords.id,
          recordNumber: ledgerRecords.recordNumber,
          date: ledgerRecords.date,
          description: ledgerRecords.description,
          contact: partyContact.legalName,
        })
        .from(ledgerRecords)
        .leftJoin(partyContact, eq(partyContact.id, party))
        .where(
          and(
            inArray(ledgerRecords.kind, DESCRIBED_KINDS),
            notVoided(ledgerRecords.id),
            // Generated postings: a reimbursement's entries, a depreciation run.
            sql`NOT EXISTS (SELECT 1 FROM reimbursement_entries AS review_re WHERE review_re.record_id = ${ledgerRecords.id})`,
            notExists(
              env.db
                .select({ id: depreciationRuns.id })
                .from(depreciationRuns)
                .where(
                  or(
                    eq(depreciationRuns.recordId, ledgerRecords.id),
                    eq(depreciationRuns.reversalRecordId, ledgerRecords.id),
                  ),
                ),
            ),
            scope.from === null
              ? undefined
              : gte(ledgerRecords.date, scope.from),
            lte(ledgerRecords.date, scope.to),
          ),
        )
        .orderBy(desc(ledgerRecords.date), desc(ledgerRecords.id))
        .all()
        .flatMap((row) => {
          const problems = descriptionProblems(row.description);
          return problems.length ? [{ row, problems }] : [];
        });
      const first = flagged[0]?.row;
      return {
        severity: "low",
        count: flagged.length,
        items: flagged.slice(0, limit).map(({ row, problems }) => ({
          ref: { type: "record", id: row.id },
          summary: [
            recordLabel(row.id, row.recordNumber),
            row.date,
            row.contact ?? "no contact",
            quoted(row.description),
            problems.map((problem) => PROBLEM_WORDS[problem]).join(", "),
          ].join(" · "),
        })),
        ...(first
          ? {
              next: {
                tool: "get_record",
                args: { record: first.id, include: ["evidence_text"] },
              },
            }
          : {}),
        fixWith: "change_records",
        note: `Descriptions that break the description policy (v${DESCRIPTION_POLICY.version}): empty, bank feed text such as "POS 1234" or "CARD 5521", a long number, a word that names nothing, or over ${DESCRIPTION_POLICY.targetLength} characters. Rewrite each as a short noun phrase for the goods, service or purpose, from its evidence; never invent one. Newest first.`,
      };
    },

    capitalisation(env, scope, limit) {
      const min = BOOKS_REVIEW_LIMITS.capitalisationMinMinor;
      const lines = env.db
        .select({
          recordId: ledgerRecords.id,
          recordNumber: ledgerRecords.recordNumber,
          date: ledgerRecords.date,
          description: ledgerRecords.description,
          label: ledgerMovements.label,
          amountMinor: ledgerMovements.amountMinor,
          accountCode: accounts.code,
          accountName: accounts.name,
          contact: partyContact.legalName,
        })
        .from(ledgerMovements)
        .innerJoin(
          ledgerRecords,
          eq(ledgerRecords.id, ledgerMovements.recordId),
        )
        .innerJoin(accounts, eq(accounts.id, ledgerMovements.accountId))
        .leftJoin(partyContact, eq(partyContact.id, party))
        .where(
          and(
            eq(ledgerRecords.kind, LedgerRecordKind.Expense),
            eq(accounts.type, AccountType.Expense),
            // Stock bought for resale is never equipment.
            or(
              isNull(accounts.subType),
              ne(accounts.subType, ExpenseSubType.CostOfGoodsSold),
            ),
            gte(ledgerMovements.amountMinor, min),
            notVoided(ledgerRecords.id),
            scope.from === null
              ? undefined
              : gte(ledgerRecords.date, scope.from),
            lte(ledgerRecords.date, scope.to),
          ),
        )
        .orderBy(
          desc(ledgerMovements.amountMinor),
          desc(ledgerRecords.date),
          desc(ledgerMovements.id),
        )
        .all();
      const first = lines[0];
      return {
        severity: "low",
        count: lines.length,
        items: lines.slice(0, limit).map((line) => ({
          ref: { type: "record", id: line.recordId },
          summary: [
            recordLabel(line.recordId, line.recordNumber),
            line.date,
            line.contact ?? "no contact",
            quoted(line.label || line.description),
            `${money(env, line.amountMinor)} on ${accountLabel(line.accountCode, line.accountName)}`,
          ].join(" · "),
        })),
        ...(first
          ? {
              next: {
                tool: "get_record",
                args: { record: first.recordId, include: ["evidence_text"] },
              },
            }
          : {}),
        fixWith: "manage_fixed_assets",
        note: `Expense lines of ${money(env, min)} or more on an expense category (cost of sales left out), largest first: equipment among them may belong on a fixed-asset account. The business's own capitalisation rule decides.`,
      };
    },

    depreciation_due(env, scope, limit) {
      const asAt = scope.to < env.today ? scope.to : env.today;
      const register = fixedAssetRegister(env.db, asAt);
      const items: BooksReviewItem[] = [];
      for (const asset of register.assets) {
        const { dueCount, firstDueMonth, status } = asset.depreciation;
        if (dueCount > 0)
          items.push({
            ref: { type: "asset", id: asset.id },
            summary: `${asset.name} · ${plural(dueCount, "month", "months")} of depreciation due and not posted, from ${firstDueMonth}`,
          });
        else if (status === "depreciation-setup")
          items.push({
            ref: { type: "asset", id: asset.id },
            summary: `${asset.name} · no depreciation schedule · net book value ${money(env, asset.netBookValueMinor)}`,
          });
      }
      for (const line of register.unregistered)
        items.push({
          ref: { type: "record", id: line.recordId },
          summary: [
            recordLabel(line.recordId, line.recordNumber),
            line.recordDate,
            line.accountName,
            quoted(line.label || line.description),
            money(env, line.amountMinor),
            "not in the asset register, so it does not depreciate",
          ].join(" · "),
        });
      return {
        severity: "low",
        count: items.length,
        items: items.slice(0, limit),
        next: {
          tool: "get_report",
          args: { report: "fixed_assets", as_at: asAt },
        },
        fixWith: "manage_fixed_assets",
        note: `As at ${asAt}: assets with depreciation months due and not posted, assets with no depreciation schedule, and purchases on a fixed-asset account that are not in the register.`,
      };
    },
  };

// ---------------------------------------------------------------------------
// Duplicate records: one item per group
// ---------------------------------------------------------------------------

/** How much hangs on a record: the copy with least is the safer one to remove. */
function appliedWeight(member: DuplicateMember): number {
  return (
    (member.reimbursed ? 4 : 0) +
    (member.settled ? 2 : 0) +
    (member.bankMatched ? 1 : 0)
  );
}

function duplicateItem(env: Env, group: DuplicateGroup): BooksReviewItem {
  const [suspect, ...others] = [...group.records].sort(
    (a, b) =>
      appliedWeight(a) - appliedWeight(b) ||
      b.date.localeCompare(a.date) ||
      b.id - a.id,
  );
  const label = (member: DuplicateMember) =>
    recordLabel(member.id, member.recordNumber);
  const state = (member: DuplicateMember) => {
    const applied: string[] = [];
    if (member.reimbursed) applied.push("reimbursed");
    if (member.settled) applied.push("payment allocated");
    if (member.bankMatched) applied.push("matched to a bank line");
    return `${label(member)}: ${applied.length ? applied.join(", ") : "nothing allocated or matched"}`;
  };
  const amounts = [...new Set(group.records.map((m) => m.amountMinor))];
  const dates = [...new Set(group.records.map((m) => m.date))].sort();
  const parties = [
    ...new Set(group.records.map((m) => m.contact?.name ?? "no contact")),
  ];
  return {
    ref: { type: "record", id: suspect.id },
    related: others.map((member) => ({ type: "record", id: member.id })),
    summary: `${label(suspect)} looks like another copy of ${list(others.map(label))} (${group.signals.join(", ")}): ${
      amounts.length === 1
        ? `${money(env, amounts[0])} each`
        : amounts.map((minor) => money(env, minor)).join(" / ")
    }, ${dates.join(" / ")}, ${parties.join(" / ")}. ${[suspect, ...others]
      .map(state)
      .join("; ")}.`,
  };
}

// ---------------------------------------------------------------------------
// Duplicate contacts
// ---------------------------------------------------------------------------

export type DuplicateContactSignal =
  | "registration_no"
  | "email"
  | "phone"
  | "name"
  | "registration_no_in_documents"
  | "name_without_suffix"
  | "name_in_documents";

/** Strongest first: the order a group lists its signals in. */
const CONTACT_SIGNALS: readonly DuplicateContactSignal[] = [
  "registration_no",
  "email",
  "phone",
  "name",
  "registration_no_in_documents",
  "name_without_suffix",
  "name_in_documents",
];

const FIND_DUPLICATES_SIGNAL: Readonly<Record<string, DuplicateContactSignal>> =
  {
    name: "name",
    email: "email",
    phone: "phone",
    registrationNo: "registration_no",
  };

export type DuplicateContactGroup = {
  /** Strongest first. */
  signals: DuplicateContactSignal[];
  /** The contact to keep first, then the others by id. */
  contacts: {
    id: number;
    name: string;
    registrationNo: string | null;
    /** Records that are this contact's: its own, or as a personally paid expense's supplier. */
    records: number;
  }[];
  /** Why the first contact is the one to keep. */
  keepReason: string;
};

/** Words a registered company name ends with, as `normalizeName` leaves them. */
const COMPANY_SUFFIXES = new Set([
  "sdn",
  "bhd",
  "berhad",
  "pte",
  "pty",
  "ltd",
  "limited",
  "plt",
  "llp",
  "llc",
  "inc",
  "corp",
  "corporation",
  "co",
  "company",
  "plc",
  "gmbh",
]);

/**
 * A name found in the files of more than this many other contacts is one
 * every document carries, such as the business's own name as the bill-to
 * party, not who issued them.
 */
const NAME_IN_DOCUMENTS_MAX_PARTIES = 3;

function withoutSuffix(normalized: string): string {
  const words = normalized.split(" ");
  while (words.length > 1 && COMPANY_SUFFIXES.has(words.at(-1)!)) words.pop();
  return words.join(" ");
}

/** Union-find over contact ids, with the signals that joined each set. */
class ContactLinks {
  private parent = new Map<number, number>();
  private signals = new Map<number, Set<DuplicateContactSignal>>();

  private root(id: number): number {
    let root = id;
    while (this.parent.has(root) && this.parent.get(root) !== root)
      root = this.parent.get(root)!;
    return root;
  }

  link(a: number, b: number, signal: DuplicateContactSignal) {
    if (a === b) return;
    for (const id of [a, b]) if (!this.parent.has(id)) this.parent.set(id, id);
    const into = this.root(a);
    const from = this.root(b);
    const joined = this.signals.get(into) ?? new Set<DuplicateContactSignal>();
    if (from !== into) {
      this.parent.set(from, into);
      for (const s of this.signals.get(from) ?? []) joined.add(s);
      this.signals.delete(from);
    }
    joined.add(signal);
    this.signals.set(into, joined);
  }

  groups(): { ids: number[]; signals: Set<DuplicateContactSignal> }[] {
    const members = new Map<number, number[]>();
    for (const id of this.parent.keys()) {
      const root = this.root(id);
      members.set(root, [...(members.get(root) ?? []), id]);
    }
    return [...members].map(([root, ids]) => ({
      ids: ids.sort((x, y) => x - y),
      signals: this.signals.get(root)!,
    }));
  }
}

/**
 * Contacts that may be one supplier or customer, for `duplicate_contacts`.
 *
 * Builds on `findDuplicates` (the same normalised name, email, phone or
 * registration number) and adds what that misses when one supplier was typed
 * three ways:
 * - `name_without_suffix`: the same name once a trailing company suffix
 *   (Sdn Bhd, Berhad, Pte Ltd, ...) is dropped.
 * - `registration_no_in_documents`: a contact's registration number (six or
 *   more letters and digits, four of them digits) in the files of another
 *   contact's records.
 * - `name_in_documents`: a contact's full name (two or more words, eight or
 *   more characters) in the files of another contact's records, unless the
 *   name is in the files of more than three other contacts.
 *
 * Only a contact's own records count, never one whose files merely mention it:
 * a file names its issuer. Groups with the most records come first.
 */
export function findDuplicateContacts(db: LedgerDb): DuplicateContactGroup[] {
  const rows = db
    .select({
      id: contacts.id,
      name: contacts.legalName,
      registrationNo: contacts.registrationNo,
    })
    .from(contacts)
    .orderBy(asc(contacts.id))
    .all();
  const byId = new Map(rows.map((row) => [row.id, row]));
  const normal = new Map(rows.map((row) => [row.id, normalizeName(row.name)]));
  const links = new ContactLinks();

  for (const group of findDuplicates(db)) {
    const [first, ...rest] = group.contacts.map((contact) => contact.id);
    for (const id of rest)
      for (const signal of group.matchedOn)
        links.link(first, id, FIND_DUPLICATES_SIGNAL[signal] ?? "name");
  }

  const byBase = new Map<string, number[]>();
  for (const row of rows) {
    const base = withoutSuffix(normal.get(row.id)!);
    if (base) byBase.set(base, [...(byBase.get(base) ?? []), row.id]);
  }
  for (const [first, ...rest] of byBase.values())
    for (const id of rest)
      if (normal.get(id) !== normal.get(first))
        links.link(first, id, "name_without_suffix");

  // Phrases to look for in files, indexed by their first word.
  type Phrase = {
    contactId: number;
    phrase: string;
    signal: "registration_no_in_documents" | "name_in_documents";
  };
  const phrases = new Map<string, Phrase[]>();
  const add = (entry: Phrase) => {
    const first = entry.phrase.split(" ")[0];
    phrases.set(first, [...(phrases.get(first) ?? []), entry]);
  };
  for (const row of rows) {
    const registration = normalizeName(row.registrationNo ?? "");
    if (
      registration.replaceAll(" ", "").length >= 6 &&
      (registration.match(/\p{N}/gu)?.length ?? 0) >= 4
    )
      add({
        contactId: row.id,
        phrase: registration,
        signal: "registration_no_in_documents",
      });
    const name = normal.get(row.id)!;
    if (name.includes(" ") && name.length >= 8)
      add({ contactId: row.id, phrase: name, signal: "name_in_documents" });
  }
  if (phrases.size) {
    const named = new Map<number, Set<number>>();
    const files = db
      .select({
        party,
        text: sql<string>`substr(${ledgerRecords.extractedText}, 1, ${CONTENT_CHAR_LIMIT})`,
      })
      .from(ledgerRecords)
      .where(
        and(
          notVoided(ledgerRecords.id),
          sql`${party} IS NOT NULL`,
          sql`length(${ledgerRecords.extractedText}) > 0`,
        ),
      )
      .all();
    for (const file of files) {
      const owner = file.party!;
      const text = ` ${normalizeName(file.text)} `;
      for (const word of new Set(text.split(" ")))
        for (const entry of phrases.get(word) ?? []) {
          if (entry.contactId === owner || !text.includes(` ${entry.phrase} `))
            continue;
          if (entry.signal === "registration_no_in_documents")
            links.link(entry.contactId, owner, entry.signal);
          else
            named.set(
              entry.contactId,
              (named.get(entry.contactId) ?? new Set()).add(owner),
            );
        }
    }
    for (const [contactId, owners] of named)
      if (owners.size <= NAME_IN_DOCUMENTS_MAX_PARTIES)
        for (const owner of owners)
          links.link(contactId, owner, "name_in_documents");
  }

  const usage = new Map(
    db
      .select({ id: party, n: sql<number>`count(*)` })
      .from(ledgerRecords)
      .where(and(notVoided(ledgerRecords.id), sql`${party} IS NOT NULL`))
      .groupBy(party)
      .all()
      .map((row) => [row.id!, row.n]),
  );
  const registered = (id: number) =>
    withoutSuffix(normal.get(id)!) !== normal.get(id);

  return links
    .groups()
    .filter((group) => group.ids.length > 1)
    .map((group) => {
      const members = group.ids.map((id) => ({
        id,
        name: byId.get(id)!.name,
        registrationNo: byId.get(id)!.registrationNo?.trim() || null,
        records: usage.get(id) ?? 0,
      }));
      const [keep, runnerUp] = [...members].sort(
        (a, b) =>
          Number(b.registrationNo !== null) -
            Number(a.registrationNo !== null) ||
          Number(registered(b.id)) - Number(registered(a.id)) ||
          b.records - a.records ||
          a.id - b.id,
      );
      const keepReason =
        keep.registrationNo !== null
          ? "it has a registration number"
          : registered(keep.id)
            ? "its name reads as a registered company name"
            : keep.records > runnerUp.records
              ? "it has the most records"
              : "it was added first";
      return {
        signals: CONTACT_SIGNALS.filter((signal) => group.signals.has(signal)),
        contacts: [keep, ...members.filter((member) => member !== keep)],
        keepReason,
      };
    })
    .sort(
      (a, b) =>
        b.contacts.reduce((n, c) => n + c.records, 0) -
          a.contacts.reduce((n, c) => n + c.records, 0) ||
        a.contacts[0].id - b.contacts[0].id,
    );
}

function contactGroupItem(group: DuplicateContactGroup): BooksReviewItem {
  const [keep, ...others] = group.contacts;
  return {
    ref: { type: "contact", id: keep.id },
    related: others.map((contact) => ({ type: "contact", id: contact.id })),
    summary: `${list(group.contacts.map((contact) => contact.name))} may be one contact (${group.signals.join(", ")}). Keep ${keep.name}: ${group.keepReason}. Records: ${group.contacts
      .map((contact) => `${contact.name} ${contact.records}`)
      .join(", ")}.`,
  };
}

// ---------------------------------------------------------------------------
// Descriptions
// ---------------------------------------------------------------------------

export type DescriptionProblem =
  | "empty"
  | "bank_text"
  | "long_number"
  | "vague"
  | "too_long";

const PROBLEM_WORDS: Readonly<Record<DescriptionProblem, string>> = {
  empty: "empty",
  bank_text: "bank feed text",
  long_number: "long number",
  vague: "names nothing",
  too_long: `over ${DESCRIPTION_POLICY.targetLength} characters`,
};

/** A bank feed's transaction type, as banks print it: in capitals, first. */
const BANK_PREFIX =
  /^(?:DEBIT CARD|CREDIT CARD|DIRECT DEBIT|POS|CARD|IBG|IBFT|TRF|TFR|FPX|ATM|CDM|DUITNOW|GIRO|JOMPAY)\b/;
/** A card feed's merchant descriptor: `GRAB*RIDE`, `CANVA* 1029384`. */
const MERCHANT_DESCRIPTOR = /[\p{L}\p{N}]\*/u;
/** Six or more digits on their own, not inside a number such as IV20260901-001. */
const LONG_NUMBER = /(?<![\p{L}\p{N}])\p{N}{6,}(?![\p{L}\p{N}])/u;
/** Descriptions that name no goods, service or purpose, as `normalizeName` leaves them. */
const VAGUE = new Set([
  "misc",
  "miscellaneous",
  "other",
  "others",
  "sundry",
  "sundries",
  "general",
  "various",
  "payment",
  "payments",
  "pymt",
  "pmt",
  "paymt",
  "trf",
  "tfr",
  "transfer",
  "txn",
  "transaction",
  "purchase",
  "purchases",
  "expense",
  "expenses",
  "bill",
  "bills",
  "item",
  "items",
  "stuff",
  "na",
  "n a",
  "nil",
  "none",
  "unknown",
  "test",
  "tbc",
  "tbd",
]);

/**
 * How a description breaks the description policy (`description-policy.ts`),
 * by the rules a machine can check: it must exist, read as words rather than
 * a bank feed's codes or a bare number, name something, and stay within the
 * target length. Empty when it keeps all of them.
 */
export function descriptionProblems(description: string): DescriptionProblem[] {
  const text = description.trim();
  if (!text) return ["empty"];
  const problems: DescriptionProblem[] = [];
  const prefix = BANK_PREFIX.exec(text);
  if (
    MERCHANT_DESCRIPTOR.test(text) ||
    (prefix !== null &&
      (/^\s*\p{N}/u.test(text.slice(prefix[0].length)) ||
        !/\p{Ll}/u.test(text)))
  )
    problems.push("bank_text");
  if (LONG_NUMBER.test(text)) problems.push("long_number");
  if (!/\p{L}/u.test(text) || VAGUE.has(normalizeName(text)))
    problems.push("vague");
  if (text.length > DESCRIPTION_POLICY.targetLength) problems.push("too_long");
  return problems;
}

// ---------------------------------------------------------------------------
// Month end
// ---------------------------------------------------------------------------

/** What a month-end line says about another check's count. */
const COUNTED: Readonly<
  Record<
    Exclude<BooksReviewCheck, "month_end" | "duplicate_contacts">,
    [string, string]
  >
> = {
  uncategorised: ["uncategorised record", "uncategorised records"],
  missing_evidence: ["record with no file", "records with no file"],
  duplicate_records: ["possible duplicate", "possible duplicates"],
  tax_unresolved: [
    "expense line without a tax treatment",
    "expense lines without a tax treatment",
  ],
  unmatched_bank: [
    "bank line not fully matched",
    "bank lines not fully matched",
  ],
  unpaid_bills: [
    `bill unpaid after ${BOOKS_REVIEW_LIMITS.staleDays} days`,
    `bills unpaid after ${BOOKS_REVIEW_LIMITS.staleDays} days`,
  ],
  overdue_invoices: ["overdue invoice", "overdue invoices"],
  unallocated_credits: ["credit not applied", "credits not applied"],
  descriptions: ["description to tidy", "descriptions to tidy"],
  capitalisation: [
    "expense line to consider capitalising",
    "expense lines to consider capitalising",
  ],
  depreciation_due: ["depreciation item due", "depreciation items due"],
};

function refOf(ref: ClosingItemRef | null): BooksReviewRef | undefined {
  switch (ref?.kind) {
    case "record":
      return { type: "record", id: ref.id };
    case "account":
      return { type: "account", id: ref.id };
    case "invoice":
      return { type: "invoice", id: ref.id };
    case "import-group":
      return { type: "job", id: ref.id };
    case "statement":
    case "statements":
      return { type: "account", id: ref.accountId };
    default:
      return undefined;
  }
}

function firstRef(items: readonly ClosingItem[] | undefined) {
  for (const item of items ?? []) {
    const ref = refOf(item.ref);
    if (ref) return { ref };
  }
  return {};
}

function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/**
 * The closing checks for one month (`closingReview`, as the Close month screen
 * runs them), then what the other checks find over the same dates. The month
 * is the one `period` ends in; without a period, the month the Close month
 * screen offers first: the one after the closed-through date, or the last
 * month that has ended.
 */
function monthEnd(
  env: Env,
  scope: Scope,
  given: boolean,
  limit: number,
  allowed: (check: BooksReviewCheck) => boolean,
): Outcome | { skip: string } {
  const current = env.closedThrough;
  const latest = previousMonthEnd(env.today.slice(0, 7))!;
  const end = given
    ? monthEndFor(scope.to.slice(0, 7))!
    : current !== null && current < latest
      ? monthEndFor(addDaysISO(current, 1).slice(0, 7))!
      : latest;
  if (current !== null && end <= current)
    return {
      skip: `The month ending ${end} is already closed (closed through ${current}). Review a later month; only a person can reopen a closed one.`,
    };

  const preview = closingReview(env.db, end);
  const items: BooksReviewItem[] = [];
  const blocked = !preview.integrity.ok || !preview.taxReview.ok;
  if (!preview.integrity.ok)
    items.push({
      ...firstRef(preview.integrity.problems),
      summary: `Blocks the close: the ledger integrity check failed (${plural(preview.integrity.problemCount, "problem", "problems")}${preview.integrity.booksBalance ? "" : "; the books do not add up to zero"}).`,
    });
  if (!preview.taxReview.ok)
    items.push({
      ...firstRef(preview.taxReview.items),
      summary: `Blocks the close: ${plural(preview.taxReview.unresolvedLineCount, "expense line needs", "expense lines need")} a tax treatment (${money(env, preview.taxReview.unresolvedMinor)}).`,
    });
  const covered = new Set<BooksReviewCheck>();
  if (!preview.taxReview.ok) covered.add("tax_unresolved");
  for (const warning of preview.warnings) {
    // Notes that explain the close rather than ask for anything.
    if (warning.id === "first-close" || warning.id === "completeness") continue;
    if (warning.id === "bank-differences") covered.add("unmatched_bank");
    if (warning.id === "depreciation-due") covered.add("depreciation_due");
    items.push({
      ...firstRef(warning.items),
      summary: warning.hint
        ? `${sentence(warning.message)} ${warning.hint}`
        : sentence(warning.message),
    });
  }

  const range: Scope = { from: preview.dateFrom, to: end };
  const counts: Partial<Record<BooksReviewCheck, number>> = {};
  for (const check of BOOKS_REVIEW_CHECKS) {
    if (check === "month_end" || check === "duplicate_contacts") continue;
    if (!allowed(check)) continue;
    const { count } = CHECKS[check](env, range, 0, {});
    counts[check] = count;
    if (count > 0 && !covered.has(check))
      items.push({
        summary: `${plural(count, ...COUNTED[check])} dated ${range.from ?? "up"} to ${end} (the ${check} check lists them).`,
      });
  }

  const note = [
    `Closing the month ending ${end} would freeze everything from ${preview.dateFrom ?? "the start of the books"} to ${end}.`,
    ...(preview.closedThrough === null ? ["It would be the first close."] : []),
    ...(end >= env.today
      ? ["The month has not ended yet, so it cannot be closed today."]
      : []),
    blocked
      ? "The close is refused until every blocker is resolved; the rest is worth doing first."
      : "Nothing blocks the close; the items are worth doing first.",
    "Only a person can close the month, in Akaun.",
  ].join(" ");
  return {
    severity: blocked ? "high" : "low",
    count: items.length,
    items: items.slice(0, limit),
    next: {
      tool: "get_report",
      args: { report: "trial_balance", as_at: end },
    },
    note,
    counts,
  };
}

// ---------------------------------------------------------------------------
// The dashboard's "needs attention" list
// ---------------------------------------------------------------------------

/**
 * The "needs attention" list (007 FR-011). Each item asks for its own screen's
 * permission and is left out when there is nothing to report.
 *
 * Moved here from `loaders/dashboard.ts` so it reads the database it is
 * given: the dashboard passes the app's, and an MCP read can pass its own
 * without loading `db/client.ts`.
 */
export function loadAttention(
  db: LedgerDb,
  locals: App.Locals,
  today: string,
  position: PositionSection | null,
  pipeline: PipelineSection,
): AttentionItem[] {
  const items: AttentionItem[] = [];

  if (position && !position.balances) {
    items.push({
      key: "unbalanced",
      label: "Balance sheet does not balance",
      detail: "Do a check of the balance sheet before you use these figures",
      target: { screen: "balance-sheet", asAt: today },
      tone: "red",
    });
  }

  if (can(locals, "import.read")) {
    const waiting = listImportJobs(db, {
      states: [ImportState.PendingReview],
      limit: 1,
      offset: 0,
    }).total;
    if (waiting > 0) {
      items.push({
        key: "imports",
        label: plural(
          waiting,
          "imported document to review",
          "imported documents to review",
        ),
        detail: "Auto Import read these documents. Review and confirm them.",
        target: { screen: "import" },
        tone: "amber",
      });
    }
  }

  if (pipeline.invoices && pipeline.invoices.overdueCount > 0) {
    items.push({
      key: "overdue-invoices",
      label: plural(
        pipeline.invoices.overdueCount,
        "overdue invoice",
        "overdue invoices",
      ),
      detail: "The due date is past and payment is not complete",
      target: { screen: "invoices" },
      tone: "red",
    });
  }

  if (can(locals, "records.read")) {
    const unpaid = listRecords(db, {
      kind: LedgerRecordKind.Expense,
      paid: false,
      limit: 1,
    }).total;
    if (unpaid > 0) {
      items.push({
        key: "unpaid-bills",
        label: plural(unpaid, "unpaid bill", "unpaid bills"),
        detail: "Expenses recorded on credit. Payment is not complete.",
        target: { screen: "unpaid-expenses" },
        tone: "amber",
      });
    }
  }

  if (can(locals, "reconciliation.read")) {
    const byAccount = unmatchedLinesByAccount(db);
    const lines = byAccount.reduce((sum, a) => sum + a.count, 0);
    if (lines > 0) {
      items.push({
        key: "unmatched",
        label: plural(
          lines,
          "unreconciled bank line",
          "unreconciled bank lines",
        ),
        detail:
          byAccount.length === 1
            ? "On the bank statements of one account"
            : `On the bank statements of ${byAccount.length} accounts`,
        target:
          byAccount.length === 1
            ? { screen: "reconcile", accountId: byAccount[0].accountId }
            : { screen: "accounts" },
        tone: "neutral",
      });
    }
  }

  if (
    can(locals, "accounts.read") &&
    position &&
    position.needsReviewCount > 0
  ) {
    items.push({
      key: "needs-review",
      label: plural(
        position.needsReviewCount,
        "account without a sub-type",
        "accounts without a sub-type",
      ),
      detail:
        "Set a sub-type (Bank, Cash, Receivable, Loan) so that the reports classify these accounts",
      target: { screen: "accounts" },
      tone: "neutral",
    });
  }

  return items;
}
