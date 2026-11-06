import { describe, expect, it } from "vitest";
import {
  editTaxLine,
  initialTaxDraft,
  taxLineChanged,
  taxLineIsOverride,
  taxLineRequest,
  useCurrentTaxDefault,
  type ExpenseTaxLine,
} from "./tax-line-state.js";

function line(savedOverride = false): ExpenseTaxLine {
  return {
    key: "2:5",
    account: { id: 5, name: "Fuel" },
    side: { label: "" },
    occurrence: 0,
    persisted: true,
    percentageBps: 5000,
    treatment: "partial",
    currentDefault: { percentageBps: 10000, treatment: "ordinary_deductible" },
    saved: {
      percentageBps: 5000,
      treatment: "partial",
      source: savedOverride ? "override" : "account_default",
      reason: savedOverride ? "Original business share" : null,
      classifiedBy: 1,
      classifiedAt: "2026-01-01T00:00:00.000Z",
      provenance: "record_creation",
    },
  };
}

describe("direct tax line edits", () => {
  it("opens on saved values without manufacturing a change or adopting a newer default", () => {
    const original = line();
    const before = JSON.stringify(original);
    expect(initialTaxDraft(original)).toMatchObject({
      treatment: "partial",
      percentage: "50.00",
    });
    expect(taxLineChanged(original, undefined)).toBe(false);
    expect(taxLineChanged(original, initialTaxDraft(original))).toBe(false);
    expect(original.currentDefault?.percentageBps).toBe(10000);
    expect(JSON.stringify(original)).toBe(before);
  });
  it("derives the override from a real edit and drops it when the user returns to the numeric baseline", () => {
    const original = line();
    const draft = editTaxLine(original, undefined, {
      treatment: "partial",
      percentage: "25",
    });
    expect(taxLineIsOverride(original, draft)).toBe(true);
    expect(taxLineChanged(original, draft)).toBe(true);
    expect(
      editTaxLine(
        original,
        { ...draft!, reason: "Business share" },
        { treatment: "partial", percentage: "50.0" },
      ),
    ).toBeUndefined();
    expect(taxLineIsOverride(original, undefined)).toBe(false);
  });
  it("keeps the Override chip on a saved override even when current defaults or an undone draft match it", () => {
    const original = line(true);
    original.currentDefault = { percentageBps: 5000, treatment: "partial" };
    expect(taxLineIsOverride(original, undefined)).toBe(true);
    const changed = editTaxLine(original, undefined, {
      treatment: "partial",
      percentage: "25",
    });
    expect(
      editTaxLine(original, changed, {
        treatment: "partial",
        percentage: "50.00",
      }),
    ).toBeUndefined();
    expect(taxLineIsOverride(original, undefined)).toBe(true);
  });
  it("treats Use current account default as a distinct source change and captures the chosen expected values", () => {
    const original = line(true);
    original.currentDefault = { percentageBps: 5000, treatment: "partial" };
    const draft = useCurrentTaxDefault(original)!;
    expect(taxLineChanged(original, draft)).toBe(true);
    expect(taxLineIsOverride(original, draft)).toBe(false);
    expect(taxLineRequest(draft)).toMatchObject({
      percentageBps: 5000,
      treatment: "partial",
      source: "account_default",
      reason: "",
    });
    expect(
      editTaxLine(original, draft, { treatment: "partial", percentage: "50.0" })
        ?.source,
    ).toBe("account_default");
    expect(
      editTaxLine(original, draft, { treatment: "partial", percentage: "25" })
        ?.source,
    ).toBe("override");
    original.currentDefault = { percentageBps: 2500, treatment: "partial" };
    expect(taxLineRequest(draft).percentageBps).toBe(5000);
  });
  it("resets new records to inheritance, and does not invent an unavailable current default", () => {
    const original = line();
    original.persisted = false;
    original.saved = null;
    expect(useCurrentTaxDefault(original)).toBeUndefined();
    original.persisted = true;
    original.currentDefault = null;
    expect(useCurrentTaxDefault(original)).toBeUndefined();
    expect(
      taxLineChanged(
        original,
        editTaxLine(original, undefined, {
          treatment: "partial",
          percentage: "0",
        }),
      ),
    ).toBe(true);
  });
  it("preserves tentative review values until an explicit edit or a reasoned default reset", () => {
    const original = line();
    original.treatment = "requires_review";
    original.percentageBps = 2500;
    const initial = initialTaxDraft(original);
    expect(initial.percentage).toBe("25.00");
    expect(taxLineChanged(original, undefined)).toBe(false);
    original.currentDefault = {
      percentageBps: 2500,
      treatment: "requires_review",
    };
    original.saved = {
      ...original.saved!,
      source: "override",
      treatment: "requires_review",
      percentageBps: 2500,
    };
    const reset = useCurrentTaxDefault(original)!;
    expect(taxLineRequest(reset).percentageBps).toBe(2500);
    const manual = editTaxLine(original, reset, {
      treatment: "requires_review",
      percentage: "",
    })!;
    expect(taxLineRequest(manual)).toMatchObject({
      percentageBps: null,
      source: "override",
    });
  });
  it("keeps duplicate-account lines independent and does not retain reason-only edits on unchanged values", () => {
    const a = line();
    const b = { ...line(), key: "3:5", occurrence: 1 };
    const drafts = {
      [a.key]: editTaxLine(a, undefined, {
        treatment: "partial",
        percentage: "25",
      }),
    };
    expect(taxLineChanged(a, drafts[a.key])).toBe(true);
    expect(taxLineChanged(b, undefined)).toBe(false);
    expect(
      taxLineChanged(a, {
        ...initialTaxDraft(a),
        reason: "Unchanged classification",
      }),
    ).toBe(false);
  });
});
