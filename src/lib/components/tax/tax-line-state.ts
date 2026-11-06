import {
  percentageToBps,
  taxFormValues,
  type ExpenseTaxSnapshot,
  type TaxFormDraft,
} from "$lib/expense-tax.js";

export type TaxClassification = Pick<
  ExpenseTaxSnapshot,
  "percentageBps" | "treatment"
>;
export type TaxLineDraft = TaxFormDraft & {
  source: "override" | "account_default";
  reason: string;
  /** An explicit review hold can matter even when the displayed values match. */
  explicitReview?: boolean;
};
export type ExpenseTaxLine = TaxClassification & {
  key: string;
  account: { id: number; name: string };
  side: { label: string };
  occurrence: number;
  persisted: boolean;
  saved?: ExpenseTaxSnapshot | null;
  currentDefault: TaxClassification | null;
  amountMinor?: number;
};

export function sameTaxClassification(
  a: TaxClassification,
  b: TaxClassification,
): boolean {
  return a.treatment === b.treatment && a.percentageBps === b.percentageBps;
}

export function initialTaxDraft(line: TaxClassification): TaxLineDraft {
  return {
    treatment: line.treatment,
    percentage:
      line.percentageBps === null ? "" : (line.percentageBps / 100).toFixed(2),
    source: "override",
    reason: "",
  };
}

/** A reset carries the expected current default, including legacy tentative review percentages. */
export function taxLineRequest(draft: TaxLineDraft) {
  const tax = taxFormValues(draft.treatment, draft.percentage);
  return {
    percentageBps:
      draft.source === "account_default"
        ? draft.percentage === ""
          ? null
          : percentageToBps(draft.percentage)
        : tax.percentageBps,
    treatment: tax.treatment ?? "unclassified",
    source: draft.source,
    reason: draft.reason,
  };
}

export function taxLineChanged(
  line: ExpenseTaxLine,
  draft: TaxLineDraft | undefined,
): boolean {
  if (!draft) return false;
  if (taxFormValues(draft.treatment, draft.percentage).error) return true;
  const value = taxLineRequest(draft);
  if (
    draft.explicitReview &&
    draft.source === "override" &&
    value.treatment === "requires_review" &&
    line.saved?.source !== "override"
  )
    return true;
  if (!sameTaxClassification(line, value)) return true;
  // Applying the default can change provenance even when the numbers happen to match.
  return (
    draft.source === "account_default" &&
    line.persisted &&
    line.saved?.source === "override"
  );
}

export function editTaxLine(
  line: ExpenseTaxLine,
  current: TaxLineDraft | undefined,
  values: TaxFormDraft,
): TaxLineDraft | undefined {
  const draft: TaxLineDraft = {
    ...(current ?? initialTaxDraft(line)),
    ...values,
    source: "override",
    explicitReview: false,
  };
  // Merely formatting an already selected default percentage must not change its source.
  if (
    current?.source === "account_default" &&
    !taxFormValues(values.treatment, values.percentage).error &&
    sameTaxClassification(taxLineRequest(current), taxLineRequest(draft))
  )
    draft.source = "account_default";
  return taxLineChanged(line, draft) ? draft : undefined;
}

export function useCurrentTaxDefault(
  line: ExpenseTaxLine,
): TaxLineDraft | undefined {
  if (!line.persisted || !line.currentDefault) return undefined;
  const draft: TaxLineDraft = {
    ...initialTaxDraft(line.currentDefault),
    source: "account_default",
  };
  return taxLineChanged(line, draft) ? draft : undefined;
}

export function taxLineIsOverride(
  line: ExpenseTaxLine,
  draft: TaxLineDraft | undefined,
): boolean {
  return taxLineChanged(line, draft)
    ? draft?.source === "override"
    : line.saved?.source === "override";
}
