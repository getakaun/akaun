import { createHash, randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { AccountType } from "$lib/enums.js";
import {
  bulkTaxSchema,
  bulkTaxApplySchema,
  type BulkTaxInput,
  type BulkTaxLine,
  type BulkTaxPreview,
} from "$lib/bulk-expense-tax.js";
import {
  accountTaxDefault,
  deductionMinor,
  needsTaxReview,
  type TaxOverride,
} from "$lib/expense-tax.js";
import {
  accounts,
  ledgerMovements,
  ledgerRecords,
  reimbursementEntries,
} from "../db/schema.js";
import { closedThrough } from "../closing/policy.js";
import { isValidDate } from "../date.js";
import { isReadOnlyKind } from "../ledger/record-permissions.js";
import { getRecord } from "../queries/ledger.js";
import { unresolvedTaxLineCount } from "../queries/tax-review.js";
import { patchRecordInTransaction } from "../services/ledger.js";
import { actor, requirePermissions, type AppContext } from "./context.js";
import { recordVersions } from "./version.js";
import { withClosingRefusal } from "./closing-refusal.js";
import { fail, invalid, ok, Rollback, type AppResult } from "./result.js";

export const BULK_TAX_PERMISSIONS = [
  "reports.read",
  "records.read",
  "records.update",
] as const;

function sum(values: number[]) {
  const total = Number(values.reduce((s, value) => s + BigInt(value), 0n));
  if (!Number.isSafeInteger(total))
    throw new Error("The tax total exceeds safe integer cents.");
  return total;
}

/** Caller holds a consistent read snapshot or the apply operation's immediate transaction. */
function review(
  ctx: AppContext,
  input: BulkTaxInput,
): AppResult<BulkTaxPreview> {
  if (!isValidDate(input.dateFrom) || !isValidDate(input.dateTo))
    return fail("INVALID_INPUT", "Choose a valid inclusive date range.");
  const data = {
    ...input,
    movementIds: [...input.movementIds].sort((a, b) => a - b),
  };
  const rows = ctx.db
    .select({
      movementId: ledgerMovements.id,
      recordId: ledgerRecords.id,
      recordNumber: ledgerRecords.recordNumber,
      date: ledgerRecords.date,
      description: ledgerRecords.description,
      label: ledgerMovements.label,
      amountMinor: ledgerMovements.amountMinor,
      classification: ledgerMovements.taxClassification,
      account: accounts,
    })
    .from(ledgerMovements)
    .innerJoin(ledgerRecords, eq(ledgerRecords.id, ledgerMovements.recordId))
    .innerJoin(accounts, eq(accounts.id, ledgerMovements.accountId))
    .where(inArray(ledgerMovements.id, data.movementIds))
    .all()
    .sort((a, b) => a.movementId - b.movementId);
  if (rows.length !== data.movementIds.length)
    return fail(
      "CONFLICT",
      "Some selected lines no longer exist in this book. Refresh the report and preview again.",
    );
  if (
    rows.some(
      (r) =>
        r.account.type !== AccountType.Expense ||
        r.date < data.dateFrom ||
        r.date > data.dateTo ||
        (data.accountId !== null && r.account.id !== data.accountId),
    )
  )
    return fail(
      "REFUSED",
      "Select only expense lines within the displayed account and dates.",
    );
  const ids = [...new Set(rows.map((r) => r.recordId))];
  const records = new Map(ids.map((id) => [id, getRecord(ctx.db, id)!]));
  const transferRecords = new Set(
    ctx.db
      .select({ id: reimbursementEntries.recordId })
      .from(reimbursementEntries)
      .where(inArray(reimbursementEntries.recordId, ids))
      .all()
      .map((r) => r.id),
  );
  const boundary = closedThrough(ctx.db);
  const lines: BulkTaxLine[] = rows.map((r) => {
    const record = records.get(r.recordId)!;
    let blockedReason: string | null = null;
    if (boundary && r.date <= boundary)
      blockedReason = `Accounting is closed through ${boundary}. Reopen the affected months to classify this line.`;
    else if (
      record.voidedByRecordId !== null ||
      record.reversesRecordId !== null
    )
      blockedReason = "Voided entries do not need tax review.";
    else if (isReadOnlyKind(record.kind) || transferRecords.has(record.id))
      blockedReason = "This source record is read-only.";
    else if (!needsTaxReview(r.classification))
      blockedReason =
        "This line is already classified. Its saved treatment will be preserved.";
    const proposed =
      data.action.kind === "account-default"
        ? accountTaxDefault(r.account)
        : data.action;
    if (!blockedReason && needsTaxReview(proposed))
      blockedReason =
        "This account has no resolved tax default. Set a treatment or configure its default first.";
    const after: BulkTaxLine["after"] = blockedReason
      ? null
      : {
          percentageBps: proposed.percentageBps,
          treatment: proposed.treatment,
          source:
            data.action.kind === "account-default"
              ? "account_default"
              : "override",
        };
    const deductible =
      after?.percentageBps == null
        ? null
        : deductionMinor(r.amountMinor, after.percentageBps);
    return {
      movementId: r.movementId,
      recordId: r.recordId,
      recordNumber: r.recordNumber,
      date: r.date,
      accountId: r.account.id,
      accountName: r.account.name,
      description: r.label ?? r.description,
      amountMinor: r.amountMinor,
      before: r.classification,
      after,
      deductibleMinor: deductible,
      addBackMinor: deductible === null ? null : r.amountMinor - deductible,
      blockedReason,
    };
  });
  const eligible = lines.filter((line) => line.after !== null);
  const unresolvedCount = unresolvedTaxLineCount(
    ctx.db,
    data.dateFrom,
    data.dateTo,
    data.accountId,
  );
  const revision = createHash("sha256")
    .update(
      JSON.stringify({
        actor: actor(ctx),
        data,
        boundary,
        versions: recordVersions(ctx.db, ids),
        defaults:
          data.action.kind === "account-default"
            ? rows.map((r) => [
                r.account.id,
                r.account.defaultTaxPercentageBps,
                r.account.defaultTaxTreatment,
              ])
            : null,
        lines,
      }),
    )
    .digest("hex");
  return ok({
    revision,
    lines,
    eligibleLineCount: eligible.length,
    recordCount: new Set(eligible.map((line) => line.recordId)).size,
    skippedLineCount: lines.length - eligible.length,
    expenseMinor: sum(
      eligible.filter((r) => r.amountMinor >= 0).map((r) => r.amountMinor),
    ),
    refundMinor: sum(
      eligible.filter((r) => r.amountMinor < 0).map((r) => r.amountMinor),
    ),
    deductibleMinor: sum(eligible.map((r) => r.deductibleMinor!)),
    addBackMinor: sum(eligible.map((r) => r.addBackMinor!)),
    unresolvedBefore: unresolvedCount,
    unresolvedAfter: unresolvedCount - eligible.length,
  });
}

export function previewBulkTax(
  ctx: AppContext,
  input: unknown,
): AppResult<BulkTaxPreview> {
  const denied = requirePermissions(ctx, BULK_TAX_PERMISSIONS);
  if (denied) return denied;
  const parsed = bulkTaxSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  return withClosingRefusal(() =>
    ctx.db.transaction(() => review(ctx, parsed.data)),
  );
}

export function applyBulkTax(
  ctx: AppContext,
  input: unknown,
): AppResult<{
  batchId: string;
  updatedLineCount: number;
  updatedRecordCount: number;
  skippedLineCount: number;
}> {
  const denied = requirePermissions(ctx, BULK_TAX_PERMISSIONS);
  if (denied) return denied;
  const parsed = bulkTaxApplySchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { revision, ...data } = parsed.data;
  const pending: (() => void)[] = [];
  return withClosingRefusal(() => {
    try {
      const result = ctx.db.transaction(
        (tx) => {
          const current = review({ ...ctx, db: tx }, data);
          if (!current.ok) return current;
          if (current.value.revision !== revision)
            return fail(
              "CONFLICT",
              "The selected records, defaults or closing boundary changed. Refresh the preview before applying.",
            );
          const eligible = current.value.lines.filter(
            (line) => line.after !== null,
          );
          if (eligible.length === 0)
            return fail(
              "REFUSED",
              "There are no eligible lines to classify in this preview.",
            );
          const batchId = randomUUID();
          const groups = new Map<number, BulkTaxLine[]>();
          for (const line of eligible)
            groups.set(line.recordId, [
              ...(groups.get(line.recordId) ?? []),
              line,
            ]);
          for (const [id, lines] of groups) {
            const record = getRecord(tx, id)!;
            const taxOverrides: TaxOverride[] = lines.map((line) => ({
              accountId: line.accountId,
              occurrence: record.movements
                .filter((m) => m.accountId === line.accountId)
                .findIndex((m) => m.id === line.movementId),
              percentageBps: line.after!.percentageBps,
              treatment: line.after!.treatment,
              source:
                data.action.kind === "account-default"
                  ? "account_default"
                  : "override",
              reason: data.reason,
            }));
            const written = patchRecordInTransaction(
              tx,
              id,
              actor(ctx),
              { taxOverrides },
              pending,
              {
                id: batchId,
                movementIds: lines.map((line) => line.movementId),
              },
            );
            if (!written.ok)
              throw new Rollback({
                ok: false,
                code: "REFUSED",
                reason: written.reason,
              });
          }
          return ok({
            batchId,
            updatedLineCount: eligible.length,
            updatedRecordCount: groups.size,
            skippedLineCount: current.value.skippedLineCount,
          });
        },
        { behavior: "immediate" },
      );
      if (result.ok) for (const emit of pending) emit();
      return result;
    } catch (error) {
      if (error instanceof Rollback) return error.failure;
      throw error;
    }
  });
}
