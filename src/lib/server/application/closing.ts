import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  AccountType,
  ImportState,
  InvoiceStatus,
  StatementExtractionState,
} from "$lib/enums.js";
import { localToday, addDaysISO } from "$lib/local-date.js";
import {
  monthEndFor,
  previousMonthEnd,
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
import { integrityInputs } from "../queries/ledger.js";
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

function review(ctx: AppContext, monthEnd: string): ClosingPreview {
  const db = ctx.db;
  const current = closedThrough(db);
  const earliest =
    db
      .select({ date: sql<string | null>`min(${ledgerRecords.date})` })
      .from(ledgerRecords)
      .get()?.date ?? null;
  const dateFrom =
    current === null
      ? earliest && earliest <= monthEnd
        ? earliest
        : null
      : addDaysISO(current, 1);
  const reportFrom =
    dateFrom && dateFrom <= monthEnd ? dateFrom : `${monthEnd.slice(0, 7)}-01`;
  const integrity = checkIntegrity(integrityInputs(db));
  const warnings: ClosingWarning[] = [];
  if (current === null)
    warnings.push({
      id: "first-close",
      message: `This first close protects all accounting history on or before ${monthEnd}, including earlier months.`,
    });
  warnings.push({
    id: "completeness",
    message:
      "Figures include the receipts and bank statements recorded in Akaun. Automatic checks cannot identify documents that have not been supplied.",
  });

  const pendingStates = [
    ImportState.Queued,
    ImportState.Extracting,
    ImportState.Processing,
    ImportState.PendingReview,
    ImportState.Failed,
  ];
  const pendingJobs =
    db
      .select({ n: sql<number>`count(*)` })
      .from(importQueue)
      .where(
        and(
          inArray(importQueue.state, pendingStates),
          or(isNull(importQueue.date), lte(importQueue.date, monthEnd)),
        ),
      )
      .get()?.n ?? 0;
  const pendingItems =
    db
      .select({ n: sql<number>`count(*)` })
      .from(importItems)
      .where(
        and(
          eq(importItems.state, ImportState.PendingReview),
          or(isNull(importItems.date), lte(importItems.date, monthEnd)),
        ),
      )
      .get()?.n ?? 0;
  if (pendingJobs + pendingItems > 0)
    warnings.push({
      id: "pending-imports",
      message: `${pendingJobs} pending or failed import document(s) and ${pendingItems} pending item(s) have dates through ${monthEnd} or an unknown date. Review them before closing.`,
    });
  const drafts =
    db
      .select({ n: sql<number>`count(*)` })
      .from(invoices)
      .where(
        and(
          eq(invoices.status, InvoiceStatus.Draft),
          lte(invoices.issueDate, monthEnd),
        ),
      )
      .get()?.n ?? 0;
  if (drafts > 0)
    warnings.push({
      id: "draft-invoices",
      message: `${drafts} draft invoice(s) dated on or before ${monthEnd} have not posted. Confirm whether they belong in this close.`,
    });
  const unmatched =
    db
      .select({ n: sql<number>`count(*)` })
      .from(bankStatementLines)
      .where(
        and(
          lte(bankStatementLines.date, monthEnd),
          sql`abs(${bankStatementLines.amount} - coalesce((select sum(${reconciliationAllocations.amount}) from ${reconciliationAllocations} where ${reconciliationAllocations.lineId} = ${bankStatementLines.id}), 0)) > 0.005`,
        ),
      )
      .get()?.n ?? 0;
  if (unmatched > 0)
    warnings.push({
      id: "bank-differences",
      message: `${unmatched} bank statement line(s) through ${monthEnd} are unmatched, partly matched, or overmatched. Review missing entries and legitimate timing differences.`,
    });
  const unread =
    db
      .select({ n: sql<number>`count(*)` })
      .from(bankStatements)
      .where(
        sql`${bankStatements.extractionState} <> ${StatementExtractionState.Ready}`,
      )
      .get()?.n ?? 0;
  if (unread > 0)
    warnings.push({
      id: "unread-statements",
      message: `${unread} bank statement(s) are still reading or failed to read. Their accounting dates cannot yet be checked.`,
    });
  const unclassified =
    db
      .select({ n: sql<number>`count(distinct ${accounts.id})` })
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
        ),
      )
      .get()?.n ?? 0;
  if (unclassified > 0)
    warnings.push({
      id: "classification",
      message: `${unclassified} account(s) used through ${monthEnd} have no report classification. Review report grouping before closing; changing classification afterward requires reopening the affected history.`,
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
    integrity: {
      ok: integrity.ok,
      recordsChecked: integrity.recordsChecked,
      problemCount:
        integrity.unbalancedRecords.length + (integrity.booksBalance ? 0 : 1),
    },
  };
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
        const earliest =
          tx
            .select({ date: sql<string | null>`min(${ledgerRecords.date})` })
            .from(ledgerRecords)
            .get()?.date ?? null;
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
