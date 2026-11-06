import { BULK_TAX_LIMIT } from "$lib/bulk-expense-tax.js";
import type { ExpenseTaxSnapshot } from "$lib/expense-tax.js";

export type TaxSelectionLine = {
  movementId: number;
  date: string;
  reviewRequired: boolean;
  classification: ExpenseTaxSnapshot | null;
};

export function taxLineSelectable(
  line: TaxSelectionLine,
  closedThrough: string | null,
): boolean {
  return line.reviewRequired && !(closedThrough && line.date <= closedThrough);
}

/** Page selection never clears earlier pages or automatically replaces a manual review decision. */
export function selectTaxPage(
  selected: number[],
  lines: TaxSelectionLine[],
  closedThrough: string | null,
): number[] {
  return [
    ...new Set([
      ...selected,
      ...lines
        .filter(
          (line) =>
            taxLineSelectable(line, closedThrough) &&
            line.classification?.source !== "override",
        )
        .map((line) => line.movementId),
    ]),
  ].slice(0, BULK_TAX_LIMIT);
}

export function toggleTaxSelection(
  selected: number[],
  id: number,
  checked: boolean,
): number[] {
  return checked
    ? [...new Set([...selected, id])].slice(0, BULK_TAX_LIMIT)
    : selected.filter((value) => value !== id);
}
