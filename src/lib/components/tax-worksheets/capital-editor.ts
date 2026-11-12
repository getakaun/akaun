import type { FirstYearContext } from "$lib/first-year-allowance.js";
import {
  calculateUtilisation,
  type UtilisationContext,
} from "$lib/capital-utilisation.js";
import {
  capitalTotals,
  capitalInputSchema,
  type CapitalSchedule,
  type CapitalRowInput,
} from "$lib/capital-allowance.js";
import {
  schemeApplies,
  type AppliedAssetTaxScheme,
} from "$lib/asset-tax-scheme.js";
import {
  createAssetTaxForm,
  assetTaxRowFromForm,
  amountInput,
  parseTaxAmount,
  type AssetTaxForm,
  type CapitalUseForm,
} from "./asset-tax-form.js";
/** Keep persistence metadata out of the strict applied-scheme snapshot. */
export function editorSchemes(
  versions: Pick<
    AppliedAssetTaxScheme,
    "id" | "familyKey" | "version" | "definition"
  >[],
): AppliedAssetTaxScheme[] {
  return versions.map((s) => ({
    id: s.id,
    familyKey: s.familyKey,
    version: s.version,
    definition: s.definition,
    verification: "custom_unverified",
  }));
}
export type EditorRow = {
  assetId: number;
  form: AssetTaxForm;
  baseline: string;
};
export type EditorUse = CapitalUseForm & { earlier?: boolean };
export type EditorPeriod = { ya: number; dateFrom: string; dateTo: string };
export function editorRows(
  schedule: CapitalSchedule,
  period: EditorPeriod,
  suggestions = true,
): EditorRow[] {
  const sources = [
    ...new Set(schedule.rows.map((r) => r.businessSource).filter(Boolean)),
  ];
  return schedule.rows.map((row) => {
    const asset = schedule.assets.find((a) => a.assetId === row.assetId);
    const form = createAssetTaxForm(row, asset, period.dateFrom, period.dateTo);
    if (suggestions && row.treatment === "pending") {
      form.businessSource ||=
        sources.length === 1
          ? sources[0]
          : sources.length === 0
            ? "Main business"
            : "";
      form.amounts.qualifyingMinor ||= amountInput(asset?.costMinor);
      form.percentage ||= "100";
    }
    return { assetId: row.assetId, form, baseline: JSON.stringify(form) };
  });
}
export function editorUses(
  schedule: CapitalSchedule,
  year?: number,
): EditorUse[] {
  return schedule.utilisation.map((u) => ({
    source: u.businessSource,
    origin: String(u.originYa),
    balance: amountInput(u.balanceMinor),
    used: amountInput(u.usedMinor),
    earlier: year !== undefined && u.originYa < year,
  }));
}
export function editorSchemeChoices(
  schemes: AppliedAssetTaxScheme[],
  row: CapitalRowInput,
  jurisdiction: string | null,
  year: number,
) {
  const latest = new Map<string, AppliedAssetTaxScheme>();
  for (const s of schemes)
    if (schemeApplies(s.definition, jurisdiction, year)) {
      if ((latest.get(s.familyKey)?.version ?? 0) < s.version)
        latest.set(s.familyKey, s);
    }
  const result = [...latest.values()];
  const applied =
    schemes.find((s) => s.id === row.schemeId) ?? row.appliedScheme;
  if (applied && !result.some((s) => s.id === applied.id)) result.push(applied);
  return result;
}
/** Only edited rows and unconfirmed rolled-forward calculations are recomputed. */
export function editorPreview(
  schedule: CapitalSchedule,
  rows: EditorRow[],
  schemes: AppliedAssetTaxScheme[],
  uses: EditorUse[],
  remark: string,
  period: EditorPeriod,
  firstYearContexts?: Record<number, FirstYearContext>,
  utilisationContext?: UtilisationContext | null,
) {
  const errors: string[] = [];
  uses = uses.map((u) => ({ ...u, source: u.source.trim() }));
  const keys = new Set<string>();
  for (const use of uses) {
    if (use.earlier && Number(use.origin) >= period.ya)
      throw Error("An earlier balance must originate before this tax year.");
    if (!Number.isInteger(Number(use.origin)) || Number(use.origin) > period.ya)
      throw Error("Choose a current or earlier origin tax year.");
    const key = JSON.stringify([use.source, Number(use.origin)]);
    if (keys.has(key))
      throw Error("Keep one claim per business source and origin year.");
    keys.add(key);
  }
  const converted = schedule.rows.map((original) => {
    const draft = rows.find((r) => r.assetId === original.assetId);
    if (!draft) throw Error("Retain every asset in the schedule.");
    if (
      draft.baseline === JSON.stringify(draft.form) &&
      !(
        original.firstYearTreatment &&
        firstYearContexts &&
        original.firstYearTreatment.historyHash !==
          firstYearContexts[original.assetId]?.historyHash
      ) &&
      !(original.schemeId && original.annualMinor === null)
    )
      return original;
    try {
      return assetTaxRowFromForm(
        original,
        { ...draft.form, businessSource: draft.form.businessSource.trim() },
        period.ya,
        schemes,
        firstYearContexts
          ? {
              context: firstYearContexts[original.assetId],
              asset: schedule.assets.find(
                (a) => a.assetId === original.assetId,
              ),
              dateFrom: period.dateFrom,
              dateTo: period.dateTo,
            }
          : undefined,
      );
    } catch (error) {
      errors.push(
        `${schedule.assets.find((a) => a.assetId === original.assetId)?.name}: ${error instanceof Error ? error.message : "Check the asset."}`,
      );
      return { ...original, treatment: "pending" as const };
    }
  });
  // Rebuild current-year balances from the staged assets; never clamp a claim silently.
  const base: CapitalSchedule = {
    ...schedule,
    calculationVersion: 2,
    rows: converted,
    evidence: remark,
    utilisation: [],
  };
  const available = capitalTotals(base, period.ya);
  const sources = new Set([
    ...available.groups.map((g) => g.businessSource),
    ...uses.map((u) => u.source),
  ]);
  const utilisation = [
    ...uses
      .filter((u) => Number(u.origin) < period.ya)
      .map((u) => ({
        businessSource: u.source,
        originYa: Number(u.origin),
        balanceMinor: parseTaxAmount(u.balance)!,
        usedMinor: parseTaxAmount(u.used)!,
      })),
    ...[...sources].filter(Boolean).map((source) => ({
      businessSource: source,
      originYa: period.ya,
      balanceMinor:
        available.groups.find((g) => g.businessSource === source)
          ?.availableMinor ?? 0,
      usedMinor: parseTaxAmount(
        uses.find((u) => u.source === source && Number(u.origin) === period.ya)
          ?.used ?? "0.00",
      )!,
    })),
  ];
  const candidate = {
    jurisdiction: schedule.jurisdiction ?? null,
    rows: converted,
    evidence: remark,
    utilisation,
    ...(schedule.utilisationPolicy
      ? { utilisationPolicy: schedule.utilisationPolicy }
      : {}),
  };
  let staged: CapitalSchedule = { ...base, ...candidate };
  if (staged.utilisationPolicy) {
    if (!utilisationContext)
      errors.push("Refresh the worksheet to load its income basis.");
    else staged = calculateUtilisation(staged, period.ya, utilisationContext);
    candidate.utilisation = staged.utilisation;
  }
  const checked = capitalInputSchema.safeParse(candidate);
  const totals = capitalTotals(staged, period.ya);
  if (!checked.success)
    errors.push(...checked.error.issues.map((i) => i.message));
  return { input: candidate, schedule: staged, totals, errors };
}

/** Merge new accounting evidence without replacing edits made in this browser. */
export function mergeEditorRows(
  previous: EditorRow[],
  incoming: EditorRow[],
): EditorRow[] {
  return incoming.map(
    (fresh) =>
      previous.find(
        (old) =>
          old.assetId === fresh.assetId &&
          JSON.stringify(old.form) !== old.baseline,
      ) ?? fresh,
  );
}
