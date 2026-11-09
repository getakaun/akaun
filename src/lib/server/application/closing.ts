import { assetSchedule } from "../queries/depreciation.js";
import { fixedAssets } from "../db/schema.js";
import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  AccountType,
  AccountTypeDisplayLabels,
  type AccountTypeCode,
  ImportState,
  ImportStateDisplayLabels,
  InvoiceStatus,
  StatementExtractionState,
  StatementExtractionStateDisplayLabels,
} from "$lib/enums.js";
import { formatDate } from "$lib/date-format.js";
import { localToday, addDaysISO } from "$lib/local-date.js";
import {
  CLOSING_ITEM_LIMIT,
  monthEndFor,
  previousMonthEnd,
  type ClosingItem,
  type ClosingHistoryEntry,
  type ClosingPageData,
  type ClosingPreview,
  type ClosingStatus,
  type ClosingWarning,
} from "$lib/closing.js";
import {
  accounts,
  auditLog,
  bankStatementLines,
  bankStatements,
  contacts,
  importItems,
  importQueue,
  invoices,
  ledgerMovements,
  ledgerRecords,
  reconciliationAllocations,
} from "../db/schema.js";
import { can } from "../permissions.js";
import { recordAudit, parseChanges } from "../audit.js";
import { setSetting, SETTING_KEYS } from "../settings.js";
import { checkIntegrity } from "../ledger/integrity.js";
import { NEEDS_REVIEW_TYPES } from "../ledger/account-type.js";
import { integrityInputs } from "../queries/ledger.js";
import { notVoided } from "../queries/void-state.js";
import type { LedgerDb } from "../ledger/types.js";
import {
  balanceSheetReport,
  cashFlowReport,
  profitLossReport,
} from "../queries/reports.js";
import { closedThrough } from "../closing/policy.js";
import { closingEvents } from "../closing/events.js";
import { actor, requirePermissions, type AppContext } from "./context.js";
import { withClosingRefusal } from "./closing-refusal.js";
import { denied, fail, invalid, ok, type AppResult } from "./result.js";

import { unresolvedTaxLines } from "../queries/tax-review.js";

const CLOSED_THROUGH_KEY = SETTING_KEYS.accountingClosedThrough;
const previewSchema = z.object({ monthEnd: z.string() }).strict();
const closeSchema = z
  .object({
    monthEnd: z.string(),
    revision: z.string().min(1).max(100),
  })
  .strict();
const reopenSchema = z
  .object({
    fromMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    expectedClosedThrough: z.string(),
    reason: z.string().trim().min(10).max(2000),
  })
  .strict();

/** This public fact is needed even by a user who may add records but cannot read them. */
export function readClosingStatus(ctx: AppContext): AppResult<ClosingStatus> {
  if (!ctx.locals.user) return denied();
  return ok({ closedThrough: closedThrough(ctx.db) });
}

function allowedMonth(monthEnd: string, current: string | null): string | null {
  if (monthEndFor(monthEnd.slice(0, 7)) !== monthEnd)
    return "Choose the last day of a calendar month.";
  if (monthEnd >= localToday())
    return "Only completed calendar months can be closed.";
  if (current !== null && monthEnd <= current)
    return "Choose a month after the current closed-through date.";
  return null;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The first items of a check, and how many there are when that is not all. */
function capped(items: ClosingItem[]): Pick<ClosingWarning, "items" | "total"> {
  return items.length > CLOSING_ITEM_LIMIT
    ? { items: items.slice(0, CLOSING_ITEM_LIMIT), total: items.length }
    : { items };
}

/**
 * The date of the first record that happened. A voided record and its reversal
 * did not happen, so neither one starts the book's history.
 */
function earliestRecordDate(db: LedgerDb): string | null {
  return (
    db
      .select({ date: sql<string | null>`min(${ledgerRecords.date})` })
      .from(ledgerRecords)
      .where(notVoided(ledgerRecords.id))
      .get()?.date ?? null
  );
}

function review(ctx: AppContext, monthEnd: string): ClosingPreview {
  const db = ctx.db;
  const current = closedThrough(db);
  const earliest = earliestRecordDate(db);
  const dateFrom =
    current === null
      ? earliest && earliest <= monthEnd
        ? earliest
        : null
      : addDaysISO(current, 1);
  const reportFrom =
    dateFrom && dateFrom <= monthEnd ? dateFrom : `${monthEnd.slice(0, 7)}-01`;
  const integrity = checkIntegrity(integrityInputs(db));
  const unresolved = unresolvedTaxLines(db, current, monthEnd);
  const unresolvedMinor = Number(
    unresolved.reduce((sum, line) => sum + BigInt(line.amountMinor), 0n),
  );
  if (!Number.isSafeInteger(unresolvedMinor))
    throw new Error("The unresolved tax total exceeds safe integer cents.");
  const taxReview = {
    ok: unresolved.length === 0,
    unresolvedLineCount: unresolved.length,
    unresolvedMinor,
    items: unresolved.slice(0, CLOSING_ITEM_LIMIT).map((line) => ({
      key: `tax-${line.movementId}`,
      label: line.recordNumber ?? `Record #${line.recordId}`,
      detail: `${formatDate(line.date)} · ${line.accountName} · ${line.label ?? line.description}`,
      amountMinor: line.amountMinor,
      ref: { kind: "record" as const, id: line.recordId },
    })),
  };
  const warnings: ClosingWarning[] = [];
  const depreciationDue = ctx.db
    .select({ id: fixedAssets.id, name: fixedAssets.name })
    .from(fixedAssets)
    .all()
    .flatMap((asset) =>
      assetSchedule(ctx.db, asset.id)
        .rows.filter(
          (row) =>
            row.amountMinor > 0 &&
            row.status === "Unposted" &&
            monthEndFor(row.month)! <= monthEnd &&
            (!current || monthEndFor(row.month)! > current),
        )
        .map((row) => ({ asset, row })),
    );
  if (depreciationDue.length)
    warnings.push({
      id: "depreciation-due",
      message: `${depreciationDue.length} asset/month depreciation charges remain unposted.`,
      hint: "Review Assets → Depreciation before closing. This is a warning; closing will prevent later posting into those months.",
      items: depreciationDue
        .slice(0, CLOSING_ITEM_LIMIT)
        .map(({ asset, row }) => ({
          key: `depreciation-${asset.id}-${row.month}`,
          label: asset.name,
          detail: `${row.month} · Unposted depreciation`,
          amountMinor: row.amountMinor,
          ref: { kind: "depreciation", month: row.month },
        })),
      total: depreciationDue.length,
    });
  if (current === null)
    warnings.push({
      id: "first-close",
      message: `This first close protects all accounting history on or before ${formatDate(monthEnd)}, including earlier months.`,
    });
  warnings.push({
    id: "completeness",
    message:
      "Figures include the receipts and bank statements recorded in Akaun. Automatic checks cannot identify documents that have not been supplied.",
  });

  const day = formatDate(monthEnd);
  const pendingStates = [
    ImportState.Queued,
    ImportState.Extracting,
    ImportState.Processing,
    ImportState.PendingReview,
    ImportState.Failed,
  ];
  // One row per document: a document can be unfinished itself, hold items that
  // are still waiting, or both.
  const pendingJobs = db
    .select({
      id: importQueue.id,
      file: importQueue.originalFilename,
      state: importQueue.state,
      date: importQueue.date,
    })
    .from(importQueue)
    .where(
      and(
        inArray(importQueue.state, pendingStates),
        or(isNull(importQueue.date), lte(importQueue.date, monthEnd)),
      ),
    )
    .orderBy(importQueue.createdAt)
    .all();
  const pendingItems = db
    .select({
      jobId: importItems.jobId,
      file: importQueue.originalFilename,
      n: sql<number>`count(*)`,
    })
    .from(importItems)
    .innerJoin(importQueue, eq(importQueue.id, importItems.jobId))
    .where(
      and(
        eq(importItems.state, ImportState.PendingReview),
        or(isNull(importItems.date), lte(importItems.date, monthEnd)),
      ),
    )
    .groupBy(importItems.jobId)
    .all();
  const itemCount = pendingItems.reduce((sum, row) => sum + row.n, 0);
  if (pendingJobs.length + itemCount > 0) {
    const waiting = new Map(pendingItems.map((row) => [row.jobId, row]));
    const documents: ClosingItem[] = pendingJobs.map((job) => {
      const items = waiting.get(job.id)?.n ?? 0;
      waiting.delete(job.id);
      return {
        key: `import-${job.id}`,
        label: job.file,
        detail: [
          ImportStateDisplayLabels[job.state] ?? "Unfinished",
          job.date ? `dated ${formatDate(job.date)}` : "no date read yet",
          ...(items > 0 ? [plural(items, "item", "items") + " waiting"] : []),
        ].join(" · "),
        ref:
          items > 0
            ? { kind: "import-group", id: job.id }
            : { kind: "import-queue" },
      };
    });
    for (const row of waiting.values())
      documents.push({
        key: `import-${row.jobId}`,
        label: row.file,
        detail: `${plural(row.n, "item", "items")} waiting for review`,
        ref: { kind: "import-group", id: row.jobId },
      });
    warnings.push({
      id: "pending-imports",
      message: `${plural(documents.length, "import document is", "import documents are")} not finished and may belong on or before ${day}`,
      hint: "Confirm or skip each one, so its entry lands in the right month.",
      ...capped(documents),
    });
  }

  const drafts = db
    .select({
      id: invoices.id,
      number: invoices.invoiceNumber,
      issueDate: invoices.issueDate,
      contact: contacts.legalName,
    })
    .from(invoices)
    .leftJoin(contacts, eq(contacts.id, invoices.contactId))
    .where(
      and(
        eq(invoices.status, InvoiceStatus.Draft),
        lte(invoices.issueDate, monthEnd),
      ),
    )
    .orderBy(invoices.issueDate, invoices.id)
    .all();
  if (drafts.length > 0)
    warnings.push({
      id: "draft-invoices",
      message: `${plural(drafts.length, "draft invoice is", "draft invoices are")} dated on or before ${day}`,
      hint: "A draft has not posted to the books. Issue it if it belongs in this month.",
      ...capped(
        drafts.map((draft) => ({
          key: `invoice-${draft.id}`,
          label: draft.number,
          detail: [
            draft.contact ?? "No customer",
            `dated ${formatDate(draft.issueDate)}`,
          ].join(" · "),
          ref: { kind: "invoice", id: draft.id } as const,
        })),
      ),
    });

  // Grouped by statement: the reconcile screen works one statement at a time.
  const unmatchedLines = db
    .select({
      statementId: bankStatementLines.statementId,
      file: bankStatements.originalFilename,
      accountId: bankStatements.accountId,
      account: accounts.name,
      n: sql<number>`count(*)`,
    })
    .from(bankStatementLines)
    .innerJoin(
      bankStatements,
      eq(bankStatements.id, bankStatementLines.statementId),
    )
    .leftJoin(accounts, eq(accounts.id, bankStatements.accountId))
    .where(
      and(
        lte(bankStatementLines.date, monthEnd),
        sql`abs(${bankStatementLines.amount} - coalesce((select sum(${reconciliationAllocations.amount}) from ${reconciliationAllocations} where ${reconciliationAllocations.lineId} = ${bankStatementLines.id}), 0)) > 0.005`,
      ),
    )
    .groupBy(bankStatementLines.statementId)
    .orderBy(bankStatements.id)
    .all();
  const unmatched = unmatchedLines.reduce((sum, row) => sum + row.n, 0);
  if (unmatched > 0)
    warnings.push({
      id: "bank-differences",
      message: `${plural(unmatched, "bank statement line", "bank statement lines")} on or before ${day} ${unmatched === 1 ? "is" : "are"} not fully matched`,
      hint: "Match each line or record what is missing. A timing difference can stay.",
      ...capped(
        unmatchedLines.map((row) => ({
          key: `statement-${row.statementId}`,
          label: row.file,
          detail: [
            row.account ?? "No account",
            `${plural(row.n, "line", "lines")} unmatched, partly matched or overmatched`,
          ].join(" · "),
          ref:
            row.accountId === null
              ? null
              : ({
                  kind: "statement",
                  accountId: row.accountId,
                  statementId: row.statementId,
                } as const),
        })),
      ),
    });

  const unread = db
    .select({
      id: bankStatements.id,
      file: bankStatements.originalFilename,
      state: bankStatements.extractionState,
      error: bankStatements.extractionError,
      accountId: bankStatements.accountId,
      account: accounts.name,
    })
    .from(bankStatements)
    .leftJoin(accounts, eq(accounts.id, bankStatements.accountId))
    .where(
      sql`${bankStatements.extractionState} <> ${StatementExtractionState.Ready}`,
    )
    .orderBy(bankStatements.id)
    .all();
  if (unread.length > 0)
    warnings.push({
      id: "unread-statements",
      message: `${plural(unread.length, "bank statement has", "bank statements have")} not been read`,
      hint:
        unread.length === 1
          ? "Its lines and dates cannot be checked until it is read. Read it again or remove it."
          : "Their lines and dates cannot be checked until they are read. Read each again or remove it.",
      ...capped(
        unread.map((row) => ({
          key: `unread-${row.id}`,
          label: row.file,
          detail: [
            row.account ?? "No account",
            StatementExtractionStateDisplayLabels[row.state] ?? "Not read",
            ...(row.error ? [row.error] : []),
          ].join(" · "),
          ref:
            row.accountId === null
              ? null
              : ({ kind: "statements", accountId: row.accountId } as const),
        })),
      ),
    });

  const unclassified = db
    .select({
      id: accounts.id,
      code: accounts.code,
      name: accounts.name,
      type: accounts.type,
      records: sql<number>`count(distinct ${ledgerRecords.id})`,
      lastUsed: sql<string>`max(${ledgerRecords.date})`,
    })
    .from(accounts)
    .innerJoin(ledgerMovements, eq(ledgerMovements.accountId, accounts.id))
    .innerJoin(ledgerRecords, eq(ledgerRecords.id, ledgerMovements.recordId))
    .where(
      and(
        isNull(accounts.subType),
        inArray(accounts.type, [
          AccountType.Asset,
          AccountType.Liability,
          AccountType.Expense,
          AccountType.Revenue,
        ]),
        lte(ledgerRecords.date, monthEnd),
        // A void pair cancels on every account, so it needs no classification.
        notVoided(ledgerRecords.id),
      ),
    )
    .groupBy(accounts.id)
    .orderBy(accounts.code)
    .all();
  if (unclassified.length > 0)
    warnings.push({
      id: "classification",
      message: `${plural(unclassified.length, "account used on or before " + day + " has", "accounts used on or before " + day + " have")} no report classification`,
      hint: `${unclassified.length === 1 ? "Its" : "Their"} report grouping cannot be changed once this month is closed. Open each account and choose one.`,
      ...capped(
        unclassified.map((row) => ({
          key: `account-${row.id}`,
          label: row.code === null ? row.name : `${row.code} ${row.name}`,
          detail: [
            AccountTypeDisplayLabels[row.type ?? 0] ?? "Account",
            // Mirrors expenseBucket/revenueBucket vs assetBucket/liabilityBucket
            // in ledger/account-type.ts: only an asset or liability has no safe default.
            NEEDS_REVIEW_TYPES.includes(row.type as AccountTypeCode)
              ? "shown as Unclassified on reports"
              : "reported as Operating until you choose",
            `${plural(row.records, "record", "records")}, last on ${formatDate(row.lastUsed)}`,
          ].join(" · "),
          ref: { kind: "account", id: row.id } as const,
        })),
      ),
    });
  const notes = [
    ...new Set([
      ...profitLossReport(db, reportFrom, monthEnd).notes,
      ...balanceSheetReport(db, monthEnd).notes,
      ...cashFlowReport(db, reportFrom, monthEnd).notes,
    ]),
  ];
  for (const [index, message] of notes.entries())
    warnings.push({ id: `report-note-${index}`, message });
  const lastAudit =
    db
      .select({ id: sql<number>`coalesce(max(${auditLog.id}), 0)` })
      .from(auditLog)
      .get()?.id ?? 0;
  const revision = createHash("sha256")
    .update(
      JSON.stringify({
        current,
        monthEnd,
        dateFrom,
        warnings,
        integrity,
        taxReview,
        unresolvedTaxMovementIds: unresolved.map((line) => line.movementId),
        lastAudit,
      }),
    )
    .digest("hex");
  return {
    closedThrough: current,
    monthEnd,
    dateFrom,
    revision,
    warnings,
    taxReview,
    integrity: {
      ok: integrity.ok,
      recordsChecked: integrity.recordsChecked,
      problemCount:
        integrity.unbalancedRecords.length + (integrity.booksBalance ? 0 : 1),
      problems: unbalancedItems(
        db,
        integrity.unbalancedRecords.slice(0, CLOSING_ITEM_LIMIT),
      ),
      booksBalance: integrity.booksBalance,
    },
  };
}

/** Names each unbalanced record, so the failed check says which one to open. */
function unbalancedItems(
  db: AppContext["db"],
  problems: { recordId: number; differenceMinor: number; problem: string }[],
): ClosingItem[] {
  if (problems.length === 0) return [];
  const rows = db
    .select({
      id: ledgerRecords.id,
      number: ledgerRecords.recordNumber,
      date: ledgerRecords.date,
      description: ledgerRecords.description,
    })
    .from(ledgerRecords)
    .where(
      inArray(
        ledgerRecords.id,
        problems.map((problem) => problem.recordId),
      ),
    )
    .all();
  const byId = new Map(rows.map((row) => [row.id, row]));
  return problems.map((problem) => {
    const row = byId.get(problem.recordId);
    return {
      key: `record-${problem.recordId}`,
      label: row?.number ?? `Record ${problem.recordId}`,
      detail: [
        ...(row ? [formatDate(row.date)] : []),
        ...(row?.description ? [row.description] : []),
        problem.problem,
      ].join(" · "),
      amountMinor: problem.differenceMinor,
      ref: { kind: "record", id: problem.recordId },
    };
  });
}

export function previewClosing(
  ctx: AppContext,
  input: unknown,
): AppResult<ClosingPreview> {
  const deniedRead = requirePermissions(ctx, ["reports.read"]);
  if (deniedRead) return deniedRead;
  const parsed = previewSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const reason = allowedMonth(parsed.data.monthEnd, closedThrough(ctx.db));
  if (reason) return fail("REFUSED", reason);
  // One snapshot, so warnings, report notes and the revision describe the same book.
  return ctx.db.transaction(() => ok(review(ctx, parsed.data.monthEnd)));
}

export function closingPage(ctx: AppContext): AppResult<ClosingPageData> {
  const deniedRead = requirePermissions(ctx, ["reports.read"]);
  if (deniedRead) return deniedRead;
  const current = closedThrough(ctx.db);
  const latestMonthEnd = previousMonthEnd(localToday().slice(0, 7))!;
  let defaultMonth = latestMonthEnd.slice(0, 7);
  if (current && current < latestMonthEnd)
    defaultMonth = addDaysISO(current, 1).slice(0, 7);
  const rows = ctx.db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.recordType, "settings"),
        eq(auditLog.recordId, "closing"),
      ),
    )
    .orderBy(desc(auditLog.id))
    .limit(50)
    .all();
  const history: ClosingHistoryEntry[] = rows.map((row) => {
    const changes = parseChanges(row.changes) ?? [];
    const value = (field: string) =>
      changes.find((change) => change.field === field);
    const boundary = value("closedThrough");
    return {
      id: row.id,
      createdAt: row.createdAt,
      actorName: row.actorName,
      action: value("closingAction")?.after === "reopen" ? "reopen" : "close",
      before: typeof boundary?.before === "string" ? boundary.before : null,
      after: typeof boundary?.after === "string" ? boundary.after : null,
      reason:
        typeof value("reason")?.after === "string"
          ? (value("reason")!.after as string)
          : null,
    };
  });
  return ok({
    closedThrough: current,
    latestMonthEnd,
    defaultMonth,
    canReadAccounts: can(ctx.locals, "accounts.read"),
    canReadRecords: can(ctx.locals, "records.read"),
    canClose:
      !ctx.locals.credential &&
      !ctx.locals.oauth &&
      can(ctx.locals, "closing.close"),
    canReopen:
      !ctx.locals.credential &&
      !ctx.locals.oauth &&
      can(ctx.locals, "closing.reopen"),
    history,
  });
}

export function closeMonth(
  ctx: AppContext,
  input: unknown,
): AppResult<ClosingStatus> {
  const deniedWrite = requirePermissions(ctx, [
    "reports.read",
    "closing.close",
  ]);
  if (deniedWrite) return deniedWrite;
  if (ctx.locals.credential || ctx.locals.oauth) return denied();
  const parsed = closeSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const data = parsed.data;
  const result: AppResult<ClosingStatus> = withClosingRefusal(() =>
    ctx.db.transaction(
      (tx) => {
        const transactionCtx = { ...ctx, db: tx };
        const before = closedThrough(tx);
        const reason = allowedMonth(data.monthEnd, before);
        if (reason) return fail("REFUSED", reason);
        const current = review(transactionCtx, data.monthEnd);
        if (current.revision !== data.revision)
          return fail(
            "CONFLICT",
            "The book changed since these checks ran. Run the checks again before confirming the close.",
          );
        if (!current.integrity.ok)
          return fail(
            "REFUSED",
            "The ledger integrity check failed. Resolve the accounting errors before closing.",
          );
        if (!current.taxReview.ok)
          return fail(
            "REFUSED",
            `${current.taxReview.unresolvedLineCount} expense ${current.taxReview.unresolvedLineCount === 1 ? "line needs" : "lines need"} tax review. Classify every unresolved expense line before closing.`,
          );
        setSetting(tx, CLOSED_THROUGH_KEY, data.monthEnd);
        recordAudit(tx, {
          recordType: "settings",
          recordId: "closing",
          userId: actor(ctx),
          action: "update",
          changes: [
            { field: "closingAction", before: null, after: "close" },
            { field: "closedThrough", before, after: data.monthEnd },
            {
              field: "automatedChecks",
              before: null,
              after: { completedMonth: true, ...current.integrity },
            },
            { field: "taxReviewCheck", before: null, after: current.taxReview },
            {
              field: "closingNotices",
              before: null,
              after: current.warnings,
            },
          ],
        });
        return ok({ closedThrough: data.monthEnd });
      },
      { behavior: "immediate" },
    ),
  );
  if (result.ok) closingEvents.emit("closing-changed", result.value);
  return result;
}

export function reopenMonths(
  ctx: AppContext,
  input: unknown,
): AppResult<ClosingStatus> {
  const deniedWrite = requirePermissions(ctx, [
    "reports.read",
    "closing.reopen",
  ]);
  if (deniedWrite) return deniedWrite;
  if (ctx.locals.credential || ctx.locals.oauth) return denied();
  const parsed = reopenSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const data = parsed.data;
  const result: AppResult<ClosingStatus> = withClosingRefusal(() =>
    ctx.db.transaction(
      (tx) => {
        const before = closedThrough(tx);
        if (before !== data.expectedClosedThrough)
          return fail(
            "CONFLICT",
            "The closed-through date changed. Read the current status before reopening.",
          );
        const end = monthEndFor(data.fromMonth);
        if (!before || !end || end > before)
          return fail(
            "REFUSED",
            "Choose a month within the closed accounting history.",
          );
        const earliest = earliestRecordDate(tx);
        const preceding = previousMonthEnd(data.fromMonth);
        const after =
          !earliest || preceding === null || preceding < earliest
            ? null
            : preceding;
        setSetting(tx, CLOSED_THROUGH_KEY, after ?? "");
        recordAudit(tx, {
          recordType: "settings",
          recordId: "closing",
          userId: actor(ctx),
          action: "update",
          changes: [
            { field: "closingAction", before: null, after: "reopen" },
            { field: "closedThrough", before, after },
            { field: "reason", before: null, after: data.reason },
          ],
        });
        return ok({ closedThrough: after });
      },
      { behavior: "immediate" },
    ),
  );
  if (result.ok) closingEvents.emit("closing-changed", result.value);
  return result;
}
