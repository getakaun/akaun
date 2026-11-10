import { eq, inArray } from "drizzle-orm";
import { AccountType } from "$lib/enums.js";
import { monthEndFor } from "$lib/closing.js";
import { localToday } from "$lib/local-date.js";
import {
  isAccumulatedDepreciationAccount,
  type AssetDepreciationOverview,
} from "$lib/depreciation.js";
import {
  accounts,
  fixedAssets,
  depreciationProfiles,
  depreciationPostings,
  depreciationRuns,
  depreciationAllocations,
  depreciationApprovals,
} from "../db/schema.js";
import type { LedgerDb } from "../ledger/types.js";
import { assetDepreciationBasis, buildAssetSchedule } from "./depreciation.js";

type Asset = typeof fixedAssets.$inferSelect & { reviewReason: string | null };
type Account = typeof accounts.$inferSelect;

/** Current setup, with posting progress through asAt (never future calendar months).
 * Batch reads avoid rebuilding the entire register for every asset's status.
 */
export function assetDepreciationOverviews(
  db: LedgerDb,
  assets: Asset[],
  chart: Account[],
  asAt: string,
  differences: { accountId: number; differenceMinor: number }[],
): Map<number, AssetDepreciationOverview> {
  if (!assets.length) return new Map();
  const ids = assets.map((asset) => asset.id);
  const profiles = db
    .select()
    .from(depreciationProfiles)
    .where(inArray(depreciationProfiles.assetId, ids))
    .all()
    .sort((a, b) => a.startMonth.localeCompare(b.startMonth) || a.id - b.id);
  const history = db
    .select({ posting: depreciationPostings, run: depreciationRuns })
    .from(depreciationPostings)
    .innerJoin(
      depreciationRuns,
      eq(depreciationRuns.id, depreciationPostings.runId),
    )
    .where(inArray(depreciationPostings.assetId, ids))
    .all();
  const allocations = db
    .select()
    .from(depreciationAllocations)
    .where(inArray(depreciationAllocations.assetId, ids))
    .all();
  const approvals = new Map(
    db
      .select()
      .from(depreciationApprovals)
      .all()
      .map((approval) => [approval.profileId, approval.futureFromMonth]),
  );
  const byAccount = new Map(chart.map((account) => [account.id, account]));
  const today = localToday();
  const through = asAt < today ? asAt : today;
  return new Map(
    assets.map((asset) => {
      const schedule = buildAssetSchedule(
        profiles.filter((p) => p.assetId === asset.id),
        history.filter(({ posting }) => posting.assetId === asset.id),
      );
      const latest = schedule.profiles.at(-1);
      const recorded = schedule.history.filter(
        ({ posting, run }) =>
          monthEndFor(posting.month)! <= through &&
          (!run.reversedOn || run.reversedOn > through),
      );
      const manual = allocations.filter(
        (a) => a.assetId === asset.id && a.recordDate <= through,
      );
      const lastPostedMonth =
        recorded
          .map(({ posting }) => posting.month)
          .concat(manual.map((a) => a.throughMonth))
          .sort()
          .at(-1) ?? null;
      // Schedule status is current; adjust reversals to the selected reporting date.
      const unposted = schedule.rows.filter(
        (row) =>
          row.amountMinor > 0 &&
          !recorded.some(({ posting }) => posting.month === row.month) &&
          (row.status !== "Reversed" || monthEndFor(row.month)! > through),
      );
      const due = unposted.filter(
        (row) =>
          monthEndFor(row.month)! <= through && monthEndFor(row.month)! < today,
      );
      const nextMonth =
        unposted.find((row) => !due.includes(row))?.month ?? null;
      const warnings = asset.reviewReason ? [asset.reviewReason] : [];
      if (latest) {
        if (latest.basis !== assetDepreciationBasis(asset))
          warnings.push(
            "The asset's financial basis changed. Review its depreciation schedule.",
          );
        const expense = byAccount.get(latest.expenseAccountId);
        const accumulated = byAccount.get(latest.accumulatedAccountId);
        if (
          !expense ||
          expense.type !== AccountType.Expense ||
          expense.archivedAt ||
          expense.mergedIntoAccountId ||
          !accumulated ||
          !isAccumulatedDepreciationAccount(accumulated) ||
          accumulated.archivedAt ||
          accumulated.mergedIntoAccountId ||
          latest.accumulatedAccountId !== asset.accumulatedDepreciationAccountId
        )
          warnings.push("Review the depreciation account mappings.");
        if (
          differences.some(
            (row) =>
              row.accountId === latest.accumulatedAccountId &&
              row.differenceMinor !== 0,
          )
        )
          warnings.push(
            "Reconcile existing manual depreciation before posting again.",
          );
        if (
          due.some(
            (row) =>
              !approvals.get(row.profile.id) ||
              row.month < approvals.get(row.profile.id)!,
          )
        )
          warnings.push("Review and approve missed depreciation months.");
        if (
          schedule.history.some(
            ({ posting, run }) =>
              run.reversedOn !== null &&
              run.reversedOn <= through &&
              posting.month >= latest.startMonth,
          )
        )
          warnings.push(
            "Review reversed depreciation and the remaining schedule.",
          );
      }
      const posted =
        recorded.reduce(
          (sum, { posting }) => sum + BigInt(posting.amountMinor),
          0n,
        ) + manual.reduce((sum, a) => sum + BigInt(a.amountMinor), 0n);
      const nbv =
        BigInt(asset.costMinor) - BigInt(asset.broughtForwardDepMinor) - posted;
      const status: AssetDepreciationOverview["status"] = !latest
        ? nbv <= 0n
          ? "depreciation-complete"
          : "depreciation-setup"
        : due.length
          ? "depreciation-pending"
          : nbv <= BigInt(latest.residualMinor)
            ? "depreciation-complete"
            : latest.stoppedFrom && latest.stoppedFrom <= through.slice(0, 7)
              ? "depreciation-stopped"
              : lastPostedMonth
                ? "depreciation-current"
                : "depreciation-scheduled";
      return [
        asset.id,
        {
          status,
          dueCount: due.length,
          firstDueMonth: due[0]?.month ?? null,
          lastPostedMonth,
          nextMonth,
          mode: latest?.mode ?? null,
          reviewReason: warnings.join(" ") || null,
        },
      ];
    }),
  );
}
