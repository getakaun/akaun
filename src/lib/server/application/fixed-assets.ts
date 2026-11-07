import { eq, and, sql } from "drizzle-orm";
import { AccountType } from "$lib/enums.js";
import { assetCreateSchema, assetUpdateSchema } from "$lib/fixed-assets.js";
import { fixedAssets, ledgerRecords, ledgerMovements } from "../db/schema.js";
import { actor, requirePermissions, type AppContext } from "./context.js";
import {
  conflict,
  fail,
  invalid,
  missing,
  ok,
  type AppResult,
} from "./result.js";
import { diffRecords, recordAudit } from "../audit.js";
import { isFixedAssetAccount } from "../ledger/account-type.js";
import { getAccount } from "../queries/accounts.js";
import {
  assetLedgerLines,
  fixedAssetRegister,
  isAssetPurchase,
  sourceSnapshot,
  type FixedAsset,
} from "../queries/fixed-assets.js";
import { inVoidPair } from "../queries/void-state.js";
import { EventEmitter } from "node:events";

export const fixedAssetEvents = new EventEmitter();
fixedAssetEvents.setMaxListeners(200);
export const ASSET_READ_PERMISSIONS = [
  "accounts.read",
  "records.read",
] as const;
const WRITE_PERMISSIONS = [
  ...ASSET_READ_PERMISSIONS,
  "accounts.update",
] as const;

export function readFixedAssets(ctx: AppContext, asAt: string) {
  const denied = requirePermissions(ctx, ASSET_READ_PERMISSIONS);
  if (denied) return denied;
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(asAt) ||
    Number.isNaN(new Date(`${asAt}T00:00:00Z`).getTime()) ||
    new Date(`${asAt}T00:00:00Z`).toISOString().slice(0, 10) !== asAt
  )
    return fail("INVALID_INPUT", "Choose a valid as-at date.");
  return ok(ctx.db.transaction(() => fixedAssetRegister(ctx.db, asAt)));
}

function mappedAccount(
  ctx: AppContext,
  id: number | null | undefined,
  type: number,
) {
  if (id == null) return true;
  const account = getAccount(ctx.db, id);
  return (
    !!account &&
    account.id === id &&
    account.type === type &&
    account.archivedAt === null &&
    account.mergedIntoAccountId === null
  );
}

export function registerFixedAsset(
  ctx: AppContext,
  input: unknown,
): AppResult<FixedAsset> {
  const denied = requirePermissions(ctx, WRITE_PERMISSIONS);
  if (denied) return denied;
  const parsed = assetCreateSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const deferredEmits: (() => void)[] = [];
  const result = ctx.db.transaction((): AppResult<FixedAsset> => {
    const {
      sourceMovementId,
      openingAsAt,
      openingRecordId,
      broughtForwardDepMinor,
      accumulatedDepreciationAccountId,
      acquisitionDate: enteredDate,
      costMinor: enteredCost,
      assetAccountId: enteredAccount,
      ...details
    } = parsed.data;
    const existing = ctx.db.select().from(fixedAssets).all();
    const contraIds = new Set(
      existing.flatMap((asset) =>
        asset.accumulatedDepreciationAccountId == null
          ? []
          : [asset.accumulatedDepreciationAccountId],
      ),
    );
    let acquisitionDate: string;
    let costMinor: number;
    let assetAccountId: number;
    let source: ReturnType<typeof sourceSnapshot> | null = null;
    if (sourceMovementId !== null) {
      const line = assetLedgerLines(ctx.db).find(
        (row) => row.movementId === sourceMovementId,
      );
      if (!line)
        return missing(
          "That purchase line no longer exists. Refresh the record.",
        );
      if (!isAssetPurchase(line, contraIds))
        return fail(
          "REFUSED",
          "Choose a non-voided purchase line in a fixed-asset account.",
        );
      if (
        existing.some(
          (asset) =>
            asset.sourceMovementId === line.movementId ||
            (asset.sourceRecordId === line.recordId &&
              (asset.sourceSortOrder === line.sortOrder ||
                asset.sourceSnapshot?.sortOrder === line.sortOrder)),
        )
      )
        return fail(
          "CONFLICT",
          "This purchase line is already registered. Open its asset instead.",
        );
      if (
        enteredDate !== undefined ||
        enteredCost !== undefined ||
        enteredAccount !== undefined ||
        openingAsAt ||
        openingRecordId !== null ||
        broughtForwardDepMinor !== 0
      )
        return fail(
          "INVALID_INPUT",
          "Purchase cost, date and account come from the saved line; opening values apply only to legacy assets.",
        );
      source = sourceSnapshot(line);
      acquisitionDate = line.recordDate;
      costMinor = line.amountMinor;
      assetAccountId = line.accountId;
    } else {
      if (!enteredDate || !enteredAccount || !enteredCost || !openingAsAt)
        return fail(
          "INVALID_INPUT",
          "Existing assets need acquisition date, account, original cost and an opening as-at date.",
        );
      acquisitionDate = enteredDate;
      costMinor = enteredCost;
      assetAccountId = enteredAccount;
      if (openingAsAt < acquisitionDate)
        return fail(
          "INVALID_INPUT",
          "Opening date must be on or after acquisition.",
        );
      if (!details.documentReference && openingRecordId === null)
        return fail(
          "INVALID_INPUT",
          "Add a supporting-document reference or an existing opening record.",
        );
      if (openingRecordId !== null) {
        const opening = ctx.db
          .select({ id: ledgerRecords.id })
          .from(ledgerRecords)
          .innerJoin(
            ledgerMovements,
            eq(ledgerMovements.recordId, ledgerRecords.id),
          )
          .where(
            and(
              eq(ledgerRecords.id, openingRecordId),
              eq(ledgerMovements.accountId, assetAccountId),
            ),
          )
          .get();
        const record = ctx.db
          .select({
            date: ledgerRecords.date,
            voided: sql<number>`${inVoidPair(ledgerRecords.id)}`,
          })
          .from(ledgerRecords)
          .where(eq(ledgerRecords.id, openingRecordId))
          .get();
        if (!opening || !record || record.voided || record.date > openingAsAt)
          return fail(
            "INVALID_INPUT",
            "Opening evidence must include this asset account on or before the opening date.",
          );
      }
    }
    const account = getAccount(ctx.db, assetAccountId);
    if (
      !account ||
      account.id !== assetAccountId ||
      !isFixedAssetAccount(account) ||
      account.mergedIntoAccountId !== null ||
      contraIds.has(assetAccountId)
    )
      return fail("INVALID_INPUT", "Choose a fixed-asset cost account.");
    if (
      !Number.isSafeInteger(costMinor) ||
      costMinor <= 0 ||
      broughtForwardDepMinor > costMinor
    )
      return fail(
        "INVALID_INPUT",
        "Opening depreciation must be between zero and original cost.",
      );
    if (
      details.inServiceDate !== null &&
      details.inServiceDate < acquisitionDate
    )
      return fail(
        "INVALID_INPUT",
        "In-service date must be on or after acquisition.",
      );
    if (details.residualMinor !== null && details.residualMinor > costMinor)
      return fail(
        "INVALID_INPUT",
        "Residual value cannot exceed original cost.",
      );
    if (
      !mappedAccount(
        ctx,
        accumulatedDepreciationAccountId,
        AccountType.Asset,
      ) ||
      accumulatedDepreciationAccountId === assetAccountId ||
      existing.some(
        (asset) => asset.assetAccountId === accumulatedDepreciationAccountId,
      )
    )
      return fail(
        "INVALID_INPUT",
        "Choose a separate Asset account for accumulated depreciation, unused as a registered cost account.",
      );
    if (broughtForwardDepMinor > 0 && accumulatedDepreciationAccountId === null)
      return fail(
        "INVALID_INPUT",
        "Map the accumulated depreciation account for opening depreciation.",
      );
    if (
      !mappedAccount(
        ctx,
        details.depreciationExpenseAccountId,
        AccountType.Expense,
      )
    )
      return fail(
        "INVALID_INPUT",
        "Choose an active Expense account for future depreciation.",
      );
    const asset = ctx.db
      .insert(fixedAssets)
      .values({
        ...details,
        acquisitionDate,
        assetAccountId,
        costMinor,
        sourceMovementId,
        sourceRecordId: source?.recordId ?? null,
        sourceSortOrder: source?.sortOrder ?? null,
        sourceSnapshot: source,
        openingAsAt: openingAsAt ?? null,
        broughtForwardDepMinor,
        accumulatedDepreciationAccountId,
        openingRecordId,
        createdBy: actor(ctx),
        updatedBy: actor(ctx),
      })
      .returning()
      .get();
    recordAudit(ctx.db, {
      userId: actor(ctx),
      recordType: "fixed_asset",
      recordId: asset.id,
      action: "create",
      changes: diffRecords(null, asset),
      deferredEmits,
    });
    return ok(asset);
  });
  if (result.ok) {
    for (const emit of deferredEmits) emit();
    fixedAssetEvents.emit("assets-refresh", {});
  }
  return result;
}

export function updateFixedAsset(
  ctx: AppContext,
  id: number,
  input: unknown,
): AppResult<FixedAsset> {
  const denied = requirePermissions(ctx, WRITE_PERMISSIONS);
  if (denied) return denied;
  const parsed = assetUpdateSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const deferredEmits: (() => void)[] = [];
  const result = ctx.db.transaction((): AppResult<FixedAsset> => {
    const before = ctx.db
      .select()
      .from(fixedAssets)
      .where(eq(fixedAssets.id, id))
      .get();
    if (!before) return missing("That asset no longer exists.");
    const {
      expectedVersion,
      reason,
      acknowledgeSource,
      expectedSourceVersion,
      legacyOpening,
      accumulatedDepreciationAccountId,
      ...details
    } = parsed.data;
    if (expectedVersion !== String(before.revision))
      return conflict(String(before.revision));
    const changes: Partial<FixedAsset> = { ...details };
    if (accumulatedDepreciationAccountId !== undefined)
      changes.accumulatedDepreciationAccountId =
        accumulatedDepreciationAccountId;
    if (legacyOpening) {
      if (before.sourceRecordId !== null)
        return fail(
          "INVALID_INPUT",
          "Opening values cannot replace a linked purchase.",
        );
      Object.assign(changes, legacyOpening);
      if (
        legacyOpening.openingAsAt < legacyOpening.acquisitionDate ||
        legacyOpening.broughtForwardDepMinor > legacyOpening.costMinor
      )
        return fail(
          "INVALID_INPUT",
          "Check the opening date, original cost and brought-forward depreciation.",
        );
      if (!details.documentReference && legacyOpening.openingRecordId === null)
        return fail(
          "INVALID_INPUT",
          "Add a supporting-document reference or opening record.",
        );
      const account = getAccount(ctx.db, legacyOpening.assetAccountId);
      if (
        !account ||
        account.id !== legacyOpening.assetAccountId ||
        !isFixedAssetAccount(account)
      )
        return fail("INVALID_INPUT", "Choose a fixed-asset cost account.");
      if (legacyOpening.openingRecordId !== null) {
        const evidence = ctx.db
          .select({
            date: ledgerRecords.date,
            voided: sql<number>`${inVoidPair(ledgerRecords.id)}`,
          })
          .from(ledgerRecords)
          .innerJoin(
            ledgerMovements,
            eq(ledgerMovements.recordId, ledgerRecords.id),
          )
          .where(
            and(
              eq(ledgerRecords.id, legacyOpening.openingRecordId),
              eq(ledgerMovements.accountId, legacyOpening.assetAccountId),
            ),
          )
          .get();
        if (
          !evidence ||
          evidence.voided ||
          evidence.date > legacyOpening.openingAsAt
        )
          return fail(
            "INVALID_INPUT",
            "Opening evidence must include this asset account on or before the opening date.",
          );
      }
    }
    if (acknowledgeSource) {
      if (before.sourceRecordId === null)
        return fail(
          "REFUSED",
          "Opening values require accountant review; they cannot be refreshed from a purchase.",
        );
      const existing = ctx.db.select().from(fixedAssets).all();
      const contra = new Set(
        existing.flatMap((asset) =>
          asset.accumulatedDepreciationAccountId === null
            ? []
            : [asset.accumulatedDepreciationAccountId],
        ),
      );
      const sourceLines = assetLedgerLines(ctx.db);
      const line =
        sourceLines.find((row) => row.movementId === before.sourceMovementId) ??
        sourceLines.find(
          (row) =>
            row.recordId === before.sourceRecordId &&
            row.sortOrder ===
              (before.sourceSnapshot?.sortOrder ?? before.sourceSortOrder),
        ) ??
        sourceLines.find(
          (row) =>
            row.recordId === before.sourceRecordId &&
            row.sortOrder === before.sourceSortOrder,
        );
      if (!line || !isAssetPurchase(line, contra))
        return fail(
          "REFUSED",
          "The source line is missing, voided or no longer an eligible purchase. Resolve the accounting record first.",
        );
      if (expectedSourceVersion !== JSON.stringify(sourceSnapshot(line)))
        return fail(
          "CONFLICT",
          "The source purchase changed since you reviewed it. Refresh and review its current values.",
        );
      if (
        existing.some(
          (asset) =>
            asset.id !== id && asset.sourceMovementId === line.movementId,
        )
      )
        return fail(
          "CONFLICT",
          "This source line belongs to another registered asset. Resolve the source lines before accepting a replacement.",
        );
      changes.sourceSnapshot = sourceSnapshot(line);
      changes.sourceMovementId = line.movementId;
      changes.acquisitionDate = line.recordDate;
      changes.costMinor = line.amountMinor;
      changes.assetAccountId = line.accountId;
      if (line.accountId === before.accumulatedDepreciationAccountId)
        return fail(
          "REFUSED",
          "The purchase now uses the accumulated depreciation account. Correct the source mapping first.",
        );
    }
    const cost = changes.costMinor ?? before.costMinor;
    const acquisition = changes.acquisitionDate ?? before.acquisitionDate;
    const costAccount = changes.assetAccountId ?? before.assetAccountId;
    const accumulatedAccount =
      changes.accumulatedDepreciationAccountId === undefined
        ? before.accumulatedDepreciationAccountId
        : changes.accumulatedDepreciationAccountId;
    const otherAssets = ctx.db
      .select()
      .from(fixedAssets)
      .all()
      .filter((asset) => asset.id !== id);
    if (
      otherAssets.some(
        (asset) => asset.accumulatedDepreciationAccountId === costAccount,
      )
    )
      return fail(
        "INVALID_INPUT",
        "This account is mapped as accumulated depreciation, not asset cost.",
      );
    if (
      !mappedAccount(ctx, accumulatedAccount, AccountType.Asset) ||
      accumulatedAccount === costAccount ||
      otherAssets.some((asset) => asset.assetAccountId === accumulatedAccount)
    )
      return fail(
        "INVALID_INPUT",
        "Choose a separate active Asset account for accumulated depreciation, unused as a registered cost account.",
      );
    if (
      (changes.broughtForwardDepMinor ?? before.broughtForwardDepMinor) > 0 &&
      accumulatedAccount === null
    )
      return fail(
        "INVALID_INPUT",
        "Map the accumulated depreciation account for opening depreciation.",
      );
    if (details.inServiceDate && details.inServiceDate < acquisition)
      return fail(
        "INVALID_INPUT",
        "In-service date must be on or after acquisition.",
      );
    if (details.residualMinor !== null && details.residualMinor > cost)
      return fail(
        "INVALID_INPUT",
        "Residual value cannot exceed original cost.",
      );
    if (
      !mappedAccount(
        ctx,
        details.depreciationExpenseAccountId,
        AccountType.Expense,
      )
    )
      return fail(
        "INVALID_INPUT",
        "Choose an active Expense account for future depreciation.",
      );
    const after = ctx.db
      .update(fixedAssets)
      .set({ ...changes, updatedBy: actor(ctx), revision: before.revision + 1 })
      .where(eq(fixedAssets.id, id))
      .returning()
      .get();
    recordAudit(ctx.db, {
      userId: actor(ctx),
      recordType: "fixed_asset",
      recordId: id,
      action: "update",
      changes: [
        ...diffRecords(before, after),
        { field: "reason", before: null, after: reason },
      ],
      deferredEmits,
    });
    return ok(after);
  });
  if (result.ok) {
    for (const emit of deferredEmits) emit();
    fixedAssetEvents.emit("assets-refresh", {});
  }
  return result;
}
