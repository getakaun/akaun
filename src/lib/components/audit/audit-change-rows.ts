import { fieldLabel, formatValue, type AuditChange } from "./audit-format.js";

const assetLabels: Record<string, string> = {
  depreciationProfile: "Depreciation setup",
  sourceSnapshot: "Purchase details",
  basis: "Financial basis",
  assetAccountId: "Asset cost account",
  acquisitionDate: "Purchase date",
  costMinor: "Original cost",
  broughtForwardDepMinor: "Accumulated depreciation brought forward",
  baseNbvMinor: "Starting net book value",
  residualMinor: "Residual value",
  months: "Useful life (months)",
  usefulLifeMonths: "Useful life (months)",
  expenseAccountId: "Depreciation expense account",
  accumulatedAccountId: "Accumulated depreciation account",
  accumulatedDepreciationAccountId: "Accumulated depreciation account",
  mode: "Posting mode",
  businessUseBps: "Business use (%)",
  id: "ID",
};

/** Older snapshots store the financial basis as a JSON tuple. Name its values. */
function decode(field: string, value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (!["basis", "sourceSnapshot", "sourceVersion"].includes(field))
    return value;
  try {
    const parsed = JSON.parse(value);
    if (field === "basis" && Array.isArray(parsed)) {
      const keys = [
        "costMinor",
        "assetAccountId",
        "acquisitionDate",
        "inServiceDate",
        "openingAsAt",
        "broughtForwardDepMinor",
      ];
      return Object.fromEntries(
        parsed.map((item, index) => [keys[index] ?? `item ${index + 1}`, item]),
      );
    }
    return parsed;
  } catch {
    return value;
  }
}
function children(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object") return null;
  return Array.isArray(value)
    ? Object.fromEntries(value.map((item, i) => [`item ${i + 1}`, item]))
    : (value as Record<string, unknown>);
}

export type AuditValueRow = { label: string; before: string; after: string };

/** Expand structured snapshots into changed leaf values without truncating history. */
export function auditChangeRows(
  recordType: string,
  changes: AuditChange[],
): AuditValueRow[] {
  const rows: AuditValueRow[] = [];
  const label = (field: string) =>
    recordType === "fixed_asset"
      ? (assetLabels[field] ?? fieldLabel(field))
      : fieldLabel(field);
  const display = (field: string, value: unknown): string => {
    if (recordType === "fixed_asset") {
      if (field === "mode" && value === "auto") return "Auto-post monthly";
      if (field === "mode" && value === "review")
        return "Review before posting";
      if (
        (field === "bookMethod" || field === "method") &&
        value === "straight_line"
      )
        return "Straight line";
      if (field === "businessUseBps" && typeof value === "number")
        return `${value / 100}%`;
    }
    return formatValue(recordType, field, value);
  };
  function visit(
    field: string,
    path: string[],
    before: unknown,
    after: unknown,
  ) {
    before = decode(field, before);
    after = decode(field, after);
    const was = children(before);
    const now = children(after);
    const keys = [
      ...new Set([...Object.keys(was ?? {}), ...Object.keys(now ?? {})]),
    ];
    if (keys.length) {
      // Retain an old scalar if the value's shape changed to or from an object.
      if ((!was && before != null) || (!now && after != null)) {
        rows.push({
          label: path.join(" · "),
          before: was ? "Structured values below" : display(field, before),
          after: now ? "Structured values below" : display(field, after),
        });
      }
      for (const key of keys)
        visit(key, [...path, label(key)], was?.[key], now?.[key]);
    } else if (before !== after && !(was && now)) {
      rows.push({
        label: path.join(" · "),
        before: was ? "No values" : display(field, before),
        after: now ? "No values" : display(field, after),
      });
    }
  }
  for (const change of changes)
    visit(change.field, [label(change.field)], change.before, change.after);
  return rows;
}
