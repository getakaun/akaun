import { asc, eq, lte, sql, or, inArray } from "drizzle-orm";
import {
  AccountType,
  LedgerRecordKind,
  type AccountTypeCode,
  type AccountSubTypeCode,
} from "$lib/enums.js";
import type { AssetSourceSnapshot } from "$lib/fixed-assets.js";
import {
  accounts,
  fixedAssets,
  ledgerMovements,
  ledgerRecords,
} from "../db/schema.js";
import type { LedgerDb } from "../ledger/types.js";
import { isFixedAssetAccount } from "../ledger/account-type.js";
import { inVoidPair } from "./void-state.js";

export type FixedAsset = typeof fixedAssets.$inferSelect;

export function assetRecordDeletionReason(
  db: LedgerDb,
  id: number,
): string | null {
  return db
    .select({ id: fixedAssets.id })
    .from(fixedAssets)
    .where(
      or(
        eq(fixedAssets.sourceRecordId, id),
        eq(fixedAssets.openingRecordId, id),
      ),
    )
    .get()
    ? "The fixed asset register uses this record as purchase or opening evidence. Keep its history; correct or void the source through the existing accounting workflow."
    : null;
}

export function assetAccountReferenceIds(db: LedgerDb): Set<number> {
  const ids = new Set<number>();
  for (const asset of db
    .select({
      cost: fixedAssets.assetAccountId,
      accumulated: fixedAssets.accumulatedDepreciationAccountId,
      expense: fixedAssets.depreciationExpenseAccountId,
    })
    .from(fixedAssets)
    .all()) {
    ids.add(asset.cost);
    if (asset.accumulated !== null) ids.add(asset.accumulated);
    if (asset.expense !== null) ids.add(asset.expense);
  }
  return ids;
}

export const ASSET_ACCOUNT_DELETE_REASON =
  "The fixed asset register uses this account. Archive it instead to preserve the register and its history.";

export function assetLedgerLines(db: LedgerDb) {
  return db
    .select({
      movementId: ledgerMovements.id,
      recordId: ledgerRecords.id,
      sortOrder: ledgerMovements.sortOrder,
      recordDate: ledgerRecords.date,
      accountId: accounts.id,
      accountName: accounts.name,
      type: accounts.type,
      subType: accounts.subType,
      amountMinor: ledgerMovements.amountMinor,
      recordNumber: ledgerRecords.recordNumber,
      description: ledgerRecords.description,
      label: ledgerMovements.label,
      kind: ledgerRecords.kind,
      voided: sql<number>`${inVoidPair(ledgerRecords.id)}`,
    })
    .from(ledgerMovements)
    .innerJoin(ledgerRecords, eq(ledgerRecords.id, ledgerMovements.recordId))
    .innerJoin(accounts, eq(accounts.id, ledgerMovements.accountId))
    .where(eq(accounts.type, AccountType.Asset))
    .orderBy(
      asc(ledgerRecords.date),
      asc(ledgerMovements.sortOrder),
      asc(ledgerMovements.id),
    )
    .all()
    .map((line) => ({
      ...line,
      type: line.type as AccountTypeCode,
      subType: line.subType as AccountSubTypeCode | null,
    }));
}
export type AssetLedgerLine = ReturnType<typeof assetLedgerLines>[number];

export function sourceSnapshot(line: AssetLedgerLine): AssetSourceSnapshot {
  return {
    movementId: line.movementId,
    recordId: line.recordId,
    sortOrder: line.sortOrder,
    recordDate: line.recordDate,
    accountId: line.accountId,
    amountMinor: line.amountMinor,
  };
}

export function isAssetPurchase(line: AssetLedgerLine, contraIds: Set<number>) {
  return (
    isFixedAssetAccount(line) &&
    !contraIds.has(line.accountId) &&
    line.amountMinor > 0 &&
    !line.voided &&
    (line.kind === LedgerRecordKind.Expense ||
      line.kind === LedgerRecordKind.Journal)
  );
}

function safeSum(values: number[]) {
  const result = Number(
    values.reduce((total, value) => total + BigInt(value), 0n),
  );
  if (!Number.isSafeInteger(result))
    throw Error("Asset totals exceed safe integer cents.");
  return result;
}

/** All figures use the selected book's own database and main-currency cents. */
export function fixedAssetRegister(db: LedgerDb, asAt: string) {
  const stored = db
    .select()
    .from(fixedAssets)
    .orderBy(asc(fixedAssets.id))
    .all();
  const chart = db
    .select()
    .from(accounts)
    .all()
    .map((account) => ({
      ...account,
      type: account.type as AccountTypeCode,
      subType: account.subType as AccountSubTypeCode | null,
      active:
        account.archivedAt === null && account.mergedIntoAccountId === null,
    }));
  const lines = assetLedgerLines(db);
  const byMovement = new Map(lines.map((line) => [line.movementId, line]));
  const bySlot = new Map(
    lines.map((line) => [`${line.recordId}:${line.sortOrder}`, line]),
  );
  const chartById = new Map(chart.map((account) => [account.id, account]));
  const openingIds = [
    ...new Set(
      stored.flatMap((asset) =>
        asset.openingRecordId === null ? [] : [asset.openingRecordId],
      ),
    ),
  ];
  const openings = openingIds.length
    ? db
        .select({
          id: ledgerRecords.id,
          date: ledgerRecords.date,
          voided: sql<number>`${inVoidPair(ledgerRecords.id)}`,
        })
        .from(ledgerRecords)
        .where(inArray(ledgerRecords.id, openingIds))
        .all()
    : [];
  const openingById = new Map(openings.map((record) => [record.id, record]));
  const contraIds = new Set(
    stored.flatMap((asset) =>
      asset.accumulatedDepreciationAccountId === null
        ? []
        : [asset.accumulatedDepreciationAccountId],
    ),
  );
  const registered = stored.map((asset) => {
    const originalSource =
      asset.sourceMovementId === null
        ? null
        : (byMovement.get(asset.sourceMovementId) ?? null);
    const source =
      originalSource ??
      bySlot.get(
        `${asset.sourceRecordId}:${asset.sourceSnapshot?.sortOrder ?? asset.sourceSortOrder}`,
      ) ??
      bySlot.get(`${asset.sourceRecordId}:${asset.sourceSortOrder}`) ??
      null;
    let reviewReason: string | null = null;
    if (asset.sourceRecordId !== null) {
      if (source?.voided)
        reviewReason =
          "Source purchase was voided. The register retains the original cost for review.";
      else if (!originalSource)
        reviewReason =
          "Source line changed or was replaced. Review the original record.";
      else if (
        source &&
        JSON.stringify(sourceSnapshot(source)) !==
          JSON.stringify(asset.sourceSnapshot)
      )
        reviewReason =
          "Source purchase details changed. Review before accepting new values.";
    }
    const account = chartById.get(asset.assetAccountId);
    if (
      !account ||
      !isFixedAssetAccount(account) ||
      account.mergedIntoAccountId !== null
    )
      reviewReason =
        "The asset account classification changed. Review its mapping.";
    const opening =
      asset.openingRecordId === null
        ? null
        : openingById.get(asset.openingRecordId);
    if (opening?.voided || (opening && opening.date > asset.openingAsAt!))
      reviewReason =
        "Opening evidence changed or was voided. Review opening values.";
    if (asset.accumulatedDepreciationAccountId !== null) {
      const contra = chartById.get(asset.accumulatedDepreciationAccountId);
      if (
        !contra ||
        contra.type !== AccountType.Asset ||
        contra.mergedIntoAccountId !== null
      )
        reviewReason = [
          reviewReason,
          "Accumulated depreciation account is missing or no longer an Asset account. Review its mapping.",
        ]
          .filter(Boolean)
          .join(" ");
    }
    return {
      ...asset,
      accountName: account?.name ?? "Missing account",
      source,
      sourceVersion: source ? JSON.stringify(sourceSnapshot(source)) : null,
      reviewReason,
      version: String(asset.revision),
    };
  });
  const included = registered.filter(
    (asset) => (asset.openingAsAt ?? asset.acquisitionDate) <= asAt,
  );
  const reserved = new Set(
    stored
      .filter((asset) => asset.sourceRecordId !== null)
      .flatMap((asset) => [
        `${asset.sourceRecordId}:${asset.sourceSortOrder}`,
        `${asset.sourceRecordId}:${asset.sourceSnapshot?.sortOrder}`,
      ]),
  );
  const registeredMovementIds = new Set(
    stored.map((asset) => asset.sourceMovementId),
  );
  const unregistered = lines.filter(
    (line) =>
      line.recordDate <= asAt &&
      isAssetPurchase(line, contraIds) &&
      !registeredMovementIds.has(line.movementId) &&
      !reserved.has(`${line.recordId}:${line.sortOrder}`),
  );
  const balances = db
    .select({
      accountId: ledgerMovements.accountId,
      balance: sql<number>`coalesce(sum(${ledgerMovements.amountMinor}), 0)`,
    })
    .from(ledgerMovements)
    .innerJoin(ledgerRecords, eq(ledgerRecords.id, ledgerMovements.recordId))
    .where(lte(ledgerRecords.date, asAt))
    .groupBy(ledgerMovements.accountId)
    .all();
  const balanceById = new Map(
    balances.map((row) => [row.accountId, row.balance]),
  );
  const costAccountIds = new Set(included.map((asset) => asset.assetAccountId));
  const costReconciliation = chart
    .filter(
      (account) =>
        (isFixedAssetAccount(account) && !contraIds.has(account.id)) ||
        costAccountIds.has(account.id),
    )
    .map((account) => {
      const registerMinor = safeSum(
        included
          .filter((asset) => asset.assetAccountId === account.id)
          .map((asset) => asset.costMinor),
      );
      const ledgerMinor = balanceById.get(account.id) ?? 0;
      const exceptions = lines.filter(
        (line) =>
          line.accountId === account.id &&
          line.recordDate <= asAt &&
          !reserved.has(`${line.recordId}:${line.sortOrder}`),
      );
      return {
        accountId: account.id,
        accountName: account.name,
        registerMinor,
        ledgerMinor,
        differenceMinor: safeSum([ledgerMinor, -registerMinor]),
        unregisteredCount: unregistered.filter(
          (line) => line.accountId === account.id,
        ).length,
        reviewCount: included.filter(
          (asset) => asset.assetAccountId === account.id && asset.reviewReason,
        ).length,
        exceptions,
      };
    });
  const depreciationReconciliation = chart
    .filter((account) => contraIds.has(account.id))
    .map((account) => {
      const registerMinor = safeSum(
        included
          .filter(
            (asset) => asset.accumulatedDepreciationAccountId === account.id,
          )
          .map((asset) => asset.broughtForwardDepMinor),
      );
      const ledgerMinor = -(balanceById.get(account.id) ?? 0);
      return {
        accountId: account.id,
        accountName: account.name,
        registerMinor,
        ledgerMinor,
        differenceMinor: safeSum([ledgerMinor, -registerMinor]),
      };
    });
  return {
    asAt,
    assets: included,
    unregistered,
    costReconciliation,
    depreciationReconciliation,
    totalCostMinor: safeSum(included.map((asset) => asset.costMinor)),
    totalOpeningDepMinor: safeSum(
      included.map((asset) => asset.broughtForwardDepMinor),
    ),
    accounts: chart
      .filter(
        (account) =>
          account.type === AccountType.Asset ||
          account.type === AccountType.Expense,
      )
      .map((account) => ({
        id: account.id,
        name: account.name,
        type: account.type,
        subType: account.subType,
        active: account.active,
      })),
  };
}
export type AssetRegister = ReturnType<typeof fixedAssetRegister>;
export type RegisteredAsset = AssetRegister["assets"][number];
