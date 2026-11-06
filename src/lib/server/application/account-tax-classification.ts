import { createHash, randomUUID } from "node:crypto";
import { asc, eq, sql } from "drizzle-orm";
import { AccountType, type LedgerRecordKindCode } from "$lib/enums.js";
import {
  accountTaxDefault,
  canApplyAccountTaxDefault,
  deductionMinor,
  needsTaxReview,
  type TaxOverride,
} from "$lib/expense-tax.js";
import {
  ACCOUNT_TAX_BATCH_LIMIT,
  accountTaxPreviewSchema,
  accountTaxApplySchema,
  type AccountTaxOverview,
  type AccountTaxPreview,
  type AccountTaxProtected,
} from "$lib/account-tax-classification.js";
import {
  accounts,
  ledgerRecords,
  ledgerMovements,
  reimbursementEntries,
} from "../db/schema.js";
import { closedThrough } from "../closing/policy.js";
import { isReadOnlyKind } from "../ledger/record-permissions.js";
import { inVoidPair } from "../queries/void-state.js";
import { getRecord } from "../queries/ledger.js";
import { patchRecordInTransaction } from "../services/ledger.js";
import { actor, requirePermissions, type AppContext } from "./context.js";
import { accountVersion, recordVersions } from "./version.js";
import {
  fail,
  invalid,
  missing,
  ok,
  Rollback,
  type AppResult,
} from "./result.js";
import { withClosingRefusal } from "./closing-refusal.js";

export const ACCOUNT_TAX_PERMISSIONS = [
  "accounts.read",
  "accounts.update",
  "records.read",
  "records.update",
] as const;

/** Read only the current account; no report or caller-supplied movement selection is involved. */
function inspect(ctx: AppContext, id: number) {
  const account = ctx.db
    .select()
    .from(accounts)
    .where(eq(accounts.id, id))
    .get();
  if (!account) return missing("That account no longer exists.");
  if (account.type !== AccountType.Expense)
    return fail(
      "REFUSED",
      "Tax classification applies only to Expense accounts.",
    );
  const rows = ctx.db
    .select({
      movementId: ledgerMovements.id,
      recordId: ledgerRecords.id,
      date: ledgerRecords.date,
      amountMinor: ledgerMovements.amountMinor,
      classification: ledgerMovements.taxClassification,
      kind: ledgerRecords.kind,
      sortOrder: ledgerMovements.sortOrder,
      voided: sql<number>`${inVoidPair(ledgerRecords.id)}`,
      transfer: sql<number>`exists(select 1 from ${reimbursementEntries} where ${reimbursementEntries.recordId} = ${ledgerRecords.id})`,
    })
    .from(ledgerMovements)
    .innerJoin(ledgerRecords, eq(ledgerRecords.id, ledgerMovements.recordId))
    .where(eq(ledgerMovements.accountId, id))
    .orderBy(
      asc(ledgerRecords.date),
      asc(ledgerRecords.id),
      asc(ledgerMovements.sortOrder),
      asc(ledgerMovements.id),
    )
    .all();
  const boundary = closedThrough(ctx.db);
  const protectedCounts: AccountTaxProtected = {
    resolved: 0,
    individual: 0,
    closed: 0,
    voided: 0,
    readOnly: 0,
    ambiguous: 0,
  };
  const candidates = rows.filter((row) => {
    if (row.voided) {
      protectedCounts.voided++;
      return false;
    }
    if (!needsTaxReview(row.classification)) {
      protectedCounts.resolved++;
      return false;
    }
    if (boundary && row.date <= boundary) {
      protectedCounts.closed++;
      return false;
    }
    if (isReadOnlyKind(row.kind as LedgerRecordKindCode) || row.transfer) {
      protectedCounts.readOnly++;
      return false;
    }
    if (!canApplyAccountTaxDefault(row.classification)) {
      if (
        row.classification?.source === "override" ||
        row.classification?.provenance === "account_default_reset" ||
        row.classification?.reason
      )
        protectedCounts.individual++;
      else protectedCounts.ambiguous++;
      return false;
    }
    return true;
  });
  const treatment = accountTaxDefault(account);
  return ok({
    account,
    treatment,
    rows,
    candidates,
    boundary,
    overview: {
      eligibleCount: candidates.length,
      protected: protectedCounts,
      hasResolvedDefault: !needsTaxReview(treatment),
    },
  });
}

export function accountTaxOverview(
  ctx: AppContext,
  id: number,
): AppResult<AccountTaxOverview> {
  const denied = requirePermissions(ctx, ACCOUNT_TAX_PERMISSIONS);
  if (denied) return denied;
  return ctx.db.transaction(() => {
    const result = inspect(ctx, id);
    return result.ok ? ok(result.value.overview) : result;
  });
}

function sum(values: number[]) {
  const total = Number(values.reduce((s, n) => s + BigInt(n), 0n));
  if (!Number.isSafeInteger(total))
    throw Error("The classification total exceeds safe integer cents.");
  return total;
}

function review(ctx: AppContext, id: number, reason: string) {
  const result = inspect(ctx, id);
  if (!result.ok) return result;
  const state = result.value;
  if (!state.overview.hasResolvedDefault)
    return fail(
      "REFUSED",
      "Save a resolved account default before applying it to unclassified entries.",
    );
  const selected = state.candidates.slice(0, ACCOUNT_TAX_BATCH_LIMIT);
  const ids = [...new Set(selected.map((r) => r.recordId))];
  const revision = createHash("sha256")
    .update(
      JSON.stringify({
        actor: actor(ctx),
        id,
        reason,
        account: accountVersion(ctx.db, id),
        boundary: state.boundary,
        // Freeze the complete account scope too: new matching entries require a new confirmation.
        scope: state.rows,
        versions: recordVersions(ctx.db, ids),
      }),
    )
    .digest("hex");
  const deductible = selected.map((r) =>
    deductionMinor(r.amountMinor, state.treatment.percentageBps!),
  );
  const preview: AccountTaxPreview = {
    ...state.overview,
    revision,
    accountId: id,
    accountName: state.account.name,
    treatment: state.treatment,
    selectedCount: selected.length,
    recordCount: ids.length,
    remainingCount: state.candidates.length - selected.length,
    dateFrom: selected[0]?.date ?? null,
    dateTo: selected.at(-1)?.date ?? null,
    expenseMinor: sum(
      selected.filter((r) => r.amountMinor >= 0).map((r) => r.amountMinor),
    ),
    refundMinor: sum(
      selected.filter((r) => r.amountMinor < 0).map((r) => r.amountMinor),
    ),
    deductibleMinor: sum(deductible),
    addBackMinor: sum(selected.map((r, i) => r.amountMinor - deductible[i])),
  };
  return ok({ preview, selected });
}

export function previewAccountTaxDefault(
  ctx: AppContext,
  id: number,
  input: unknown,
): AppResult<AccountTaxPreview> {
  const denied = requirePermissions(ctx, ACCOUNT_TAX_PERMISSIONS);
  if (denied) return denied;
  const parsed = accountTaxPreviewSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  return withClosingRefusal(() =>
    ctx.db.transaction(() => {
      const result = review(ctx, id, parsed.data.reason);
      return result.ok ? ok(result.value.preview) : result;
    }),
  );
}

export function applyAccountTaxDefault(
  ctx: AppContext,
  id: number,
  input: unknown,
): AppResult<{
  batchId: string;
  updatedLineCount: number;
  updatedRecordCount: number;
  remainingCount: number;
}> {
  const denied = requirePermissions(ctx, ACCOUNT_TAX_PERMISSIONS);
  if (denied) return denied;
  const parsed = accountTaxApplySchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const pending: (() => void)[] = [];
  return withClosingRefusal(() => {
    try {
      const result = ctx.db.transaction(
        (tx) => {
          const current = review({ ...ctx, db: tx }, id, parsed.data.reason);
          if (!current.ok) return current;
          const { preview, selected } = current.value;
          if (preview.revision !== parsed.data.revision)
            return fail(
              "CONFLICT",
              "The account, entries or closing boundary changed. Refresh the confirmation before applying.",
            );
          if (selected.length === 0)
            return fail(
              "REFUSED",
              "There are no eligible unclassified entries to update.",
            );
          const batchId = randomUUID();
          const groups = new Map<number, typeof selected>();
          for (const row of selected)
            groups.set(row.recordId, [
              ...(groups.get(row.recordId) ?? []),
              row,
            ]);
          for (const [recordId, lines] of groups) {
            const record = getRecord(tx, recordId)!;
            const taxOverrides: TaxOverride[] = lines.map((line) => ({
              accountId: id,
              occurrence: record.movements
                .filter((m) => m.accountId === id)
                .findIndex((m) => m.id === line.movementId),
              ...preview.treatment,
              source: "account_default",
              reason: parsed.data.reason,
            }));
            const written = patchRecordInTransaction(
              tx,
              recordId,
              actor(ctx),
              { taxOverrides },
              pending,
              { id: batchId, movementIds: lines.map((r) => r.movementId) },
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
            updatedLineCount: selected.length,
            updatedRecordCount: groups.size,
            remainingCount: preview.remainingCount,
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
