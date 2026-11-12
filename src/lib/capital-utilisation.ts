import {
  capitalTotals,
  capitalSum,
  CapitalAllowanceError,
  type CapitalSchedule,
} from "./capital-allowance.js";
import {
  taxWorksheetTotals,
  safeTaxSum,
  type TaxSourceSnapshot,
  type TaxAdjustment,
} from "./tax-worksheet.js";
import type { UtilisationEvidence } from "./capital-utilisation-policy.js";

export type UtilisationContext = {
  hash: string;
  snapshot: TaxSourceSnapshot;
  adjustments: TaxAdjustment[];
  /** Operating/contra-operating revenue, including unclassified revenue as on the P&L. */
  businessIncomeAccounts: number[];
};

export function utilisationAdjustmentKey(context: UtilisationContext): string {
  return JSON.stringify(
    context.adjustments
      .filter(
        (a) =>
          !a.withdrawnAt &&
          !context.snapshot.pendingCorrectionIds?.includes(a.id),
      )
      .map((a) => [
        a.requestKey,
        a.kind,
        a.sourceMovementId,
        a.percentageBps,
        a.treatment,
        a.direction,
        a.amountMinor,
        a.balanceMinor,
        a.originYa,
      ])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
}

/** A tax-only projection. Inputs and instructions are retained; calculated uses are authoritative. */
export function calculateUtilisation(
  schedule: CapitalSchedule,
  year: number,
  context: UtilisationContext,
  strictOverrides = false,
): CapitalSchedule {
  const policy = schedule.utilisationPolicy;
  if (!policy) return schedule; // Retained pre-automatic evidence is never silently recalculated.
  const raw = capitalTotals(
    {
      ...schedule,
      utilisationPolicy: undefined,
      utilisationEvidence: undefined,
    },
    year,
  );
  const claimedSources = new Set(
    schedule.rows
      .filter((r) => r.treatment === "claim")
      .map((r) => r.businessSource),
  );
  // Current-year balances are generated from assets. Discard a stale zero-only
  // current row when an asset is excluded or its business source is renamed.
  const sources = raw.groups
    .filter(
      (g) =>
        g.businessSource &&
        (claimedSources.has(g.businessSource) || g.broughtForwardMinor > 0),
    )
    .map((g) => g.businessSource)
    .sort();
  const sourceSet = new Set(sources);
  for (const list of [policy.income, policy.overrides]) {
    const seen = new Set<string>();
    for (const row of list) {
      if (seen.has(row.businessSource))
        throw new CapitalAllowanceError(
          "Keep one income basis and override per current business source.",
        );
      seen.add(row.businessSource);
    }
  }
  const key = utilisationAdjustmentKey(context);
  const tax = taxWorksheetTotals(context.snapshot, context.adjustments);
  const active = context.adjustments.filter(
    (a) =>
      !a.withdrawnAt && !context.snapshot.pendingCorrectionIds?.includes(a.id),
  );
  const nonOperatingIncome = context.snapshot.profitLines.filter(
    (l) =>
      l.type === "income" &&
      l.amountMinor !== 0 &&
      !context.businessIncomeAccounts.includes(l.accountId),
  );
  const unsupportedReason = !schedule.jurisdiction
    ? "Choose a tax jurisdiction for this worksheet before calculating allowance usage."
    : schedule.jurisdiction !== "MY"
      ? `Automatic allowance usage is available for Malaysia (MY); this worksheet uses ${schedule.jurisdiction}.`
      : !policy.singleBusiness
        ? "This worksheet retains a saved multiple-business setting. Use automatic calculation only if these workings belong to one business."
        : sources.length > 1
          ? `This schedule has different business-source labels: ${sources.map((s) => `“${s}”`).join(", ")}. Use the same label on assets and earlier balances only when they belong to the same business.`
          : nonOperatingIncome.length
            ? `These income accounts are outside the operating-income classification: ${nonOperatingIncome.map((l) => `“${l.accountName}”`).join(", ")}. The worksheet cannot automatically assign their income and related expenses to the business for allowance usage.`
            : null;
  const derived =
    !unsupportedReason && sources.length === 1 && !tax.unresolvedCount;
  // Annual adjustments belong to this single-business worksheet. Brought-forward
  // losses apply after capital allowances and cannot reduce absorption capacity.
  const annualAdjustments = active
    .filter((a) => a.kind === "other")
    .map((a) => (a.direction === "increase" ? a.amountMinor : -a.amountMinor));
  const baseMinor = derived
    ? Math.max(
        0,
        safeTaxSum([
          context.snapshot.profitMinor,
          tax.addBackMinor,
          ...annualAdjustments,
        ]),
      )
    : null;
  const uses: CapitalSchedule["utilisation"] = [];
  const evidence: UtilisationEvidence = {
    version: 1,
    basisHash: context.hash,
    adjustmentKey: key,
    allocation: "oldest_first",
    groups: [],
    problems: [],
  };
  for (const source of sources) {
    const reviewed = policy.income.find((i) => i.businessSource === source);
    const stale =
      reviewed &&
      (reviewed.basisHash !== context.hash || reviewed.adjustmentKey !== key);
    let capacity =
      reviewed && !stale ? reviewed.capacityMinor : reviewed ? null : baseMinor;
    if (reviewed && reviewed.reason.trim().length < 10) capacity = null;
    if (capacity !== null && (!Number.isSafeInteger(capacity) || capacity < 0))
      capacity = null;
    if (tax.unresolvedCount || context.snapshot.pendingCorrectionIds?.length)
      capacity = null;
    if (capacity === null) {
      const problem =
        tax.unresolvedCount || context.snapshot.pendingCorrectionIds?.length
          ? "Complete the expense tax treatments and resolve changed annual corrections to calculate allowance usage automatically."
          : stale
            ? "Saved manual income settings no longer match this worksheet. Switch to automatic calculation to use current figures."
            : reviewed
              ? "Saved manual income settings are incomplete. Switch to automatic calculation to use the worksheet's calculated figures."
              : (unsupportedReason ??
                "Allowance usage could not be calculated from this worksheet.");
      if (!evidence.problems.includes(problem)) evidence.problems.push(problem);
    }
    const current = raw.groups.find(
      (g) => g.businessSource === source,
    )!.availableMinor;
    const balances = schedule.utilisation
      .filter((u) => u.businessSource === source && u.originYa < year)
      .map((u) => ({ ...u }))
      .sort((a, b) => a.originYa - b.originYa);
    balances.push({
      businessSource: source,
      originYa: year,
      balanceMinor: current,
      usedMinor: 0,
    });
    const available = capitalSum(balances.map((u) => u.balanceMinor));
    const maximum = Math.min(available, capacity ?? 0);
    const override = policy.overrides.find((o) => o.businessSource === source);
    const badOverride =
      !!override &&
      (!Number.isSafeInteger(override.usedMinor) ||
        override.usedMinor < 0 ||
        (capacity !== null && override.usedMinor > maximum));
    if (badOverride) {
      const problem = `${source}: the override exceeds the available allowance or reviewed income limit, or is not a valid amount.`;
      if (strictOverrides) throw new CapitalAllowanceError(problem);
      evidence.problems.push(problem);
    }
    const used =
      capacity === null || badOverride ? 0 : (override?.usedMinor ?? maximum);
    let remainingUse = used,
      remainingMaximum = maximum;
    for (const balance of balances) {
      const permitted = Math.min(balance.balanceMinor, remainingMaximum);
      const actual = Math.min(permitted, remainingUse);
      remainingMaximum -= permitted;
      remainingUse -= actual;
      uses.push({
        businessSource: source,
        originYa: balance.originYa,
        balanceMinor: balance.balanceMinor,
        usedMinor: actual,
        ...(permitted > actual ? { restrictedMinor: permitted - actual } : {}),
      });
    }
    evidence.groups.push({
      businessSource: source,
      capacityMinor: badOverride ? null : capacity,
      basis:
        capacity === null
          ? "needs_review"
          : reviewed
            ? "reviewed"
            : "bookkeeping",
      availableMinor: available,
      usedMinor: used,
      carriedMinor: available - maximum,
      restrictedMinor: maximum - used,
      overrideReason: override?.reason ?? null,
    });
  }
  return {
    ...schedule,
    utilisationPolicy: {
      ...policy,
      income: policy.income.filter((r) => sourceSet.has(r.businessSource)),
      overrides: policy.overrides.filter((r) =>
        sourceSet.has(r.businessSource),
      ),
    },
    utilisation: uses,
    utilisationEvidence: evidence,
  };
}
