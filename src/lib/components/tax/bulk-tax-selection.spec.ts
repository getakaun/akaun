import { describe, expect, it } from "vitest";
import { BULK_TAX_LIMIT } from "$lib/bulk-expense-tax.js";
import type { ExpenseTaxSnapshot } from "$lib/expense-tax.js";
import {
  selectTaxPage,
  taxLineSelectable,
  toggleTaxSelection,
  type TaxSelectionLine,
} from "./bulk-tax-selection.js";

function line(
  id: number,
  changes: Partial<TaxSelectionLine> = {},
): TaxSelectionLine {
  return {
    movementId: id,
    date: "2026-01-15",
    reviewRequired: true,
    classification: null,
    ...changes,
  };
}
describe("bulk tax report selection", () => {
  it("preserves selections across pages and never selects a manual review decision automatically", () => {
    const manual: ExpenseTaxSnapshot = {
      percentageBps: null,
      treatment: "requires_review",
      source: "override",
      reason: "Ask the owner",
      classifiedBy: 1,
      classifiedAt: "2026-01-01",
      provenance: "line_override",
    };
    const first = selectTaxPage(
      [],
      [line(1), line(2, { classification: manual })],
      null,
    );
    expect(first).toEqual([1]);
    expect(selectTaxPage(first, [line(1), line(3)], null)).toEqual([1, 3]);
    expect(toggleTaxSelection(first, 2, true)).toEqual([1, 2]);
  });
  it("follows the inclusive live close boundary and excludes resolved and void-exempt lines", () => {
    expect(taxLineSelectable(line(1), "2026-01-15")).toBe(false);
    expect(taxLineSelectable(line(1), "2026-01-14")).toBe(true);
    expect(taxLineSelectable(line(1), null)).toBe(true);
    expect(
      selectTaxPage(
        [],
        [
          line(1),
          line(2, { reviewRequired: false }),
          line(3, { date: "2026-02-01" }),
        ],
        "2026-01-31",
      ),
    ).toEqual([3]);
  });
  it("enforces 200 selected lines without dropping prior pages and permits deselection at the limit", () => {
    const prior = Array.from({ length: BULK_TAX_LIMIT }, (_, i) => i + 1);
    expect(selectTaxPage(prior, [line(201), line(202)], null)).toEqual(prior);
    expect(toggleTaxSelection(prior, 201, true)).toEqual(prior);
    expect(toggleTaxSelection(prior, 200, false)).toEqual(prior.slice(0, -1));
    expect(toggleTaxSelection(prior, 1, true)).toEqual(prior);
  });
});
