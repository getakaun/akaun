import type { CapitalInput } from "$lib/capital-allowance.js";
import type { capitalTotals } from "$lib/capital-allowance.js";
import {
  taxWorksheetTotals,
  type TaxAdjustmentInput,
  type TaxAdjustment,
} from "$lib/tax-worksheet.js";
import type { TaxWorksheetDetail as Detail } from "$lib/server/queries/tax-worksheets.js";

export type CapitalDraft = {
  input: CapitalInput | null;
  totals: ReturnType<typeof capitalTotals> | null;
  liveAssetHash: string;
  rolloverHash: string | null;
  errors: string[];
  problems: string[];
};
export type WorksheetWithdrawal = { adjustmentId: number; reason: string };
export type StagedAdjustment = TaxAdjustmentInput;

/** Local rows use negative IDs so withdrawals can distinguish unsaved entries. */
export function stagedAdjustments(
  detail: Detail,
  additions: StagedAdjustment[],
  withdrawals: WorksheetWithdrawal[],
  replaceManual = false,
): TaxAdjustment[] {
  const replaced = new Set(
    additions.filter((a) => a.kind === "source").map((a) => a.sourceMovementId),
  );
  const removed = new Set(withdrawals.map((w) => w.adjustmentId));
  const retained = detail.adjustments.map((a) =>
    removed.has(a.id) ||
    (replaceManual &&
      ["capital_allowance", "allowance_brought_forward"].includes(a.kind)) ||
    (a.kind === "source" && replaced.has(a.sourceMovementId!))
      ? {
          ...a,
          withdrawnAt: "pending",
          withdrawalReason: "Changed in worksheet draft",
        }
      : a,
  );
  return [
    ...retained,
    ...additions.map(
      (a, i): TaxAdjustment => ({
        id: -i - 1,
        revisionId: detail.revision.id,
        kind: a.kind,
        sourceMovementId: a.kind === "source" ? a.sourceMovementId : null,
        percentageBps: a.kind === "source" ? a.percentageBps : null,
        treatment: a.kind === "source" ? a.treatment : null,
        amountMinor: a.kind === "source" ? 0 : a.amountMinor,
        direction: a.kind === "source" ? "increase" : a.direction,
        balanceMinor: a.kind === "source" ? 0 : a.balanceMinor,
        originYa: a.kind === "source" ? null : a.originYa,
        reason: a.reason,
        evidence: a.evidence,
        requestKey: a.requestKey,
        createdBy: null,
        actorName: "Unsaved change",
        createdAt: "",
        withdrawnAt: null,
        withdrawalReason: null,
      }),
    ),
  ];
}
export function draftTotals(
  detail: Detail,
  additions: StagedAdjustment[],
  withdrawals: WorksheetWithdrawal[],
  capital: CapitalDraft | null,
  replaceManual = false,
) {
  return taxWorksheetTotals(
    detail.revision.snapshot,
    stagedAdjustments(detail, additions, withdrawals, replaceManual),
    capital?.totals ?? (detail.capital.active ? detail.capital.totals : null),
  );
}

/** Compare captured source facts, independently of the staged tax treatment. */
export function changedStagedSources(
  additions: StagedAdjustment[],
  captured: Record<string, string>,
  current: Record<string, string>,
) {
  return additions.filter(
    (a) =>
      a.kind === "source" &&
      (!captured[String(a.sourceMovementId)] ||
        captured[String(a.sourceMovementId)] !==
          current[String(a.sourceMovementId)]),
  );
}
