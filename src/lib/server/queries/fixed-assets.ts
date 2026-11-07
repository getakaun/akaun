import { asc, eq, or, sql } from "drizzle-orm";
import { AccountType, AssetSubType } from "$lib/enums.js";
import {
  accounts,
  fixedAssets,
  ledgerMovements,
  ledgerRecords,
} from "../db/schema.js";
import type { LedgerDb } from "../ledger/types.js";
import { isValidDate } from "../date.js";
import { inVoidPair } from "./void-state.js";

export function sumMinor(values: number[]): number {
  if (values.some((n) => !Number.isSafeInteger(n)))
    throw new Error("Amounts must be safe integer cents.");
  const total = Number(values.reduce((sum, n) => sum + BigInt(n), 0n));
  if (!Number.isSafeInteger(total))
    throw new Error("Register totals exceed safe integer cents.");
  return total;
}

/** Current register evidence compared to ledger through the chosen inclusive date.
 * This is not an immutable historical register: subsequent audited corrections are visible.
 */
export function assetRegister(db: LedgerDb, asOf: string) {
  if (!isValidDate(asOf))
    throw new Error("Choose a valid reconciliation date.");
  const allAssets = db
    .select()
    .from(fixedAssets)
    .orderBy(asc(fixedAssets.assetCode))
    .all();
  const allAccounts = db.select().from(accounts).all();
  const movements = db
    .select({
      id: ledgerMovements.id,
      recordId: ledgerRecords.id,
      accountId: ledgerMovements.accountId,
      amountMinor: ledgerMovements.amountMinor,
      date: ledgerRecords.date,
      description: ledgerRecords.description,
      voided: sql<number>`${inVoidPair(ledgerRecords.id)}`,
    })
    .from(ledgerMovements)
    .innerJoin(ledgerRecords, eq(ledgerRecords.id, ledgerMovements.recordId))
    .all();
  const rows = allAssets.map((asset) => {
    const included = (asset.openingDate ?? asset.acquisitionDate) <= asOf;
    const source = movements.find((m) => m.id === asset.sourceMovementId);
    const exceptions: string[] = [];
    if (asset.origin === "legacy")
      exceptions.push(
        "Legacy opening values are declared register evidence. Confirm gross cost and accumulated depreciation already exist in the GL; registration creates no opening journal.",
      );
    if (
      asset.origin === "purchase" &&
      (!source || source.recordId !== asset.sourceRecordId)
    )
      exceptions.push(
        "Source line missing or replaced; saved purchase link requires review.",
      );
    else if (
      source &&
      (source.voided ||
        source.accountId !== asset.accountId ||
        source.amountMinor !== asset.costMinor ||
        source.date !== asset.acquisitionDate)
    )
      exceptions.push(
        "Source was voided or its account, amount or date changed; saved registration requires review.",
      );
    const costAccount = allAccounts.find((a) => a.id === asset.accountId);
    if (
      !costAccount ||
      costAccount.archivedAt !== null ||
      costAccount.type !== AccountType.Asset ||
      costAccount.subType !== AssetSubType.FixedAsset
    )
      exceptions.push(
        "Cost account is inactive or no longer classified as a fixed asset.",
      );
    if (asset.accumulatedAccountId) {
      const contra = allAccounts.find(
        (a) => a.id === asset.accumulatedAccountId,
      );
      if (
        !contra ||
        contra.archivedAt !== null ||
        contra.type !== AccountType.Asset ||
        contra.subType !== AssetSubType.FixedAsset
      )
        exceptions.push(
          "Accumulated depreciation account is inactive or no longer a fixed asset.",
        );
    }
    return {
      ...asset,
      included,
      accountName: costAccount?.name ?? "Missing account",
      status:
        asset.inServiceDate && asset.inServiceDate <= asOf
          ? "In service"
          : "Not yet in service",
      exceptions,
      openingNetMinor: asset.costMinor - asset.openingAccumulatedMinor,
    };
  });
  const included = rows.filter((a) => a.included);
  const accountIds = new Set(
    allAccounts
      .filter(
        (a) =>
          a.type === AccountType.Asset && a.subType === AssetSubType.FixedAsset,
      )
      .map((a) => a.id),
  );
  for (const a of allAssets) {
    accountIds.add(a.accountId);
    if (a.accumulatedAccountId) accountIds.add(a.accumulatedAccountId);
  }
  const reconciliation = [...accountIds].map((accountId) => {
    const cost = sumMinor(
      included.filter((a) => a.accountId === accountId).map((a) => a.costMinor),
    );
    const accumulated = sumMinor(
      included
        .filter((a) => a.accumulatedAccountId === accountId)
        .map((a) => a.openingAccumulatedMinor),
    );
    const expectedMinor = sumMinor([cost, -accumulated]);
    const glMinor = sumMinor(
      movements
        .filter((m) => m.accountId === accountId && m.date <= asOf)
        .map((m) => m.amountMinor),
    );
    return {
      accountId,
      accountName:
        allAccounts.find((a) => a.id === accountId)?.name ?? "Missing account",
      costMinor: cost,
      accumulatedMinor: accumulated,
      expectedMinor,
      glMinor,
      differenceMinor: sumMinor([glMinor, -expectedMinor]),
    };
  });
  const registeredSources = new Set(allAssets.map((a) => a.sourceMovementId));
  const contraIds = new Set(allAssets.map((a) => a.accumulatedAccountId));
  const unregistered = movements.filter(
    (m) =>
      accountIds.has(m.accountId) &&
      !contraIds.has(m.accountId) &&
      m.date <= asOf &&
      !m.voided &&
      m.amountMinor > 0 &&
      !registeredSources.has(m.id),
  );
  const costMinor = sumMinor(included.map((a) => a.costMinor));
  const accumulatedMinor = sumMinor(
    included.map((a) => a.openingAccumulatedMinor),
  );
  return {
    asOf,
    rows,
    reconciliation,
    unregistered,
    costMinor,
    accumulatedMinor,
    openingNetMinor: sumMinor([costMinor, -accumulatedMinor]),
    note: "Current register evidence versus GL through this date. Legacy assets enter at their opening date. Accumulated values are brought forward only; no depreciation or disposal is calculated. Differences may reflect unregistered purchases, pooled opening balances, later depreciation, refunds, disposals or source corrections. Review each exception; a zero difference is not proof of individual matching.",
  };
}

/** Register mappings protect empty GL accounts as well as accounts with movements. */
export function assetAccountReferenceCount(
  db: LedgerDb,
  accountId: number,
): number {
  return (
    db
      .select({ n: sql<number>`count(*)` })
      .from(fixedAssets)
      .where(
        or(
          eq(fixedAssets.accountId, accountId),
          eq(fixedAssets.accumulatedAccountId, accountId),
          eq(fixedAssets.expenseAccountId, accountId),
        ),
      )
      .get()?.n ?? 0
  );
}
