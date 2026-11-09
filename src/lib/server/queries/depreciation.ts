import { eq } from "drizzle-orm";
import {
  depreciationProfiles,
  depreciationAllocations,
  depreciationRuns,
  depreciationPostings,
  ledgerRecords,
  fixedAssets,
} from "../db/schema.js";
import type { LedgerDb } from "../ledger/types.js";
import { monthEndFor } from "$lib/closing.js";
import { straightLineSchedule } from "$lib/depreciation.js";

export type DepreciationProfile = typeof depreciationProfiles.$inferSelect;
export function assetDepreciationBasis(asset: typeof fixedAssets.$inferSelect) {
  return JSON.stringify([
    asset.costMinor,
    asset.assetAccountId,
    asset.acquisitionDate,
    asset.inServiceDate,
    asset.openingAsAt,
    asset.broughtForwardDepMinor,
  ]);
}
export function depreciationHistory(db: LedgerDb, assetId: number) {
  return db
    .select({ posting: depreciationPostings, run: depreciationRuns })
    .from(depreciationPostings)
    .innerJoin(
      depreciationRuns,
      eq(depreciationRuns.id, depreciationPostings.runId),
    )
    .where(eq(depreciationPostings.assetId, assetId))
    .all();
}
export function manualDepreciation(db: LedgerDb, assetId: number) {
  return db
    .select()
    .from(depreciationAllocations)
    .where(eq(depreciationAllocations.assetId, assetId))
    .all();
}
export function depreciationTotal(
  db: LedgerDb,
  assetId: number,
  asAt: string,
): number {
  let total = 0n;
  for (const { posting, run } of depreciationHistory(db, assetId)) {
    if (monthEndFor(posting.month)! <= asAt)
      total += BigInt(posting.amountMinor);
    if (run.reversedOn && run.reversedOn <= asAt)
      total -= BigInt(posting.amountMinor);
  }
  for (const allocation of manualDepreciation(db, assetId)) {
    if (allocation.recordDate <= asAt) total += BigInt(allocation.amountMinor);
  }
  const value = Number(total);
  if (!Number.isSafeInteger(value))
    throw Error("Depreciation exceeds safe integer cents.");
  return value;
}
export function assetSchedule(db: LedgerDb, assetId: number) {
  const profiles = db
    .select()
    .from(depreciationProfiles)
    .where(eq(depreciationProfiles.assetId, assetId))
    .all()
    .sort((a, b) => a.startMonth.localeCompare(b.startMonth) || a.id - b.id);
  const history = depreciationHistory(db, assetId);
  const rows = profiles.flatMap((profile, index) =>
    straightLineSchedule(
      profile.baseNbvMinor,
      profile.residualMinor,
      profile.startMonth,
      profile.months,
    )
      .filter(
        (row) =>
          history.some(
            ({ posting }) =>
              posting.profileId === profile.id && posting.month === row.month,
          ) ||
          ((!profiles[index + 1] ||
            row.month < profiles[index + 1].startMonth) &&
            (!profile.stoppedFrom || row.month < profile.stoppedFrom)),
      )
      .map((row) => {
        const saved = history.find(
          ({ posting }) => posting.month === row.month,
        );
        return {
          ...row,
          profile,
          status: saved
            ? saved.run.reversalRecordId
              ? "Reversed"
              : "Posted"
            : row.amountMinor === 0
              ? "No charge"
              : "Unposted",
          recordId: saved?.run.recordId ?? null,
          reversalRecordId: saved?.run.reversalRecordId ?? null,
          runId: saved?.run.id ?? null,
        };
      }),
  );
  return { profiles, rows, history };
}
export const DEPRECIATION_RECORD_REASON =
  "Depreciation journals are read-only. Reverse the run from Assets → Depreciation, then review the asset schedule.";
export function depreciationRecordReason(
  db: LedgerDb,
  recordId: number,
): string | null {
  const record = db
    .select({ kind: ledgerRecords.legacyKind })
    .from(ledgerRecords)
    .where(eq(ledgerRecords.id, recordId))
    .get();
  if (
    db
      .select({ id: depreciationAllocations.id })
      .from(depreciationAllocations)
      .where(eq(depreciationAllocations.recordId, recordId))
      .get()
  )
    return "This journal is linked to asset depreciation. Remove its allocation from the asset before editing, deleting or voiding it.";
  return record?.kind?.startsWith("asset-depreciation")
    ? DEPRECIATION_RECORD_REASON
    : null;
}
