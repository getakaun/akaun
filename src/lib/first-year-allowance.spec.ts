import { describe, it, expect } from "vitest";
import {
  firstYearDecision,
  resolveFirstYear,
  type FirstYearContext,
  type FirstYearRecord,
} from "./first-year-allowance.js";
import type { AssetTaxSchemeDefinition } from "./asset-tax-scheme.js";
import type { CapitalAssetEvidence } from "./capital-allowance.js";
const scheme: AssetTaxSchemeDefinition = {
  name: "Machinery",
  jurisdiction: "MY",
  yearFrom: 2025,
  yearTo: null,
  method: "original_cost",
  firstYearRateBps: 2000,
  regularRateBps: 1400,
};
const asset: CapitalAssetEvidence = {
  assetId: 1,
  name: "Printer",
  assetType: "Machinery",
  acquisitionDate: "2025-06-10",
  inServiceDate: "2025-06-10",
  costMinor: 229900,
  sourceRecordId: 9,
  sourceVersion: "source",
  version: "asset",
  documentReference: "Receipt",
  reviewReason: null,
};
const basis = {
  qualifyingMinor: 229900,
  businessUseBps: 10000,
  additionsMinor: 229900,
};
const empty: FirstYearContext = { historyHash: "a".repeat(64), records: [] };
const earlier: FirstYearRecord = {
  ya: 2024,
  revisionId: 1,
  status: "finalised",
  active: true,
  qualifyingMinor: 229900,
  businessUseBps: 10000,
  additionsMinor: 229900,
  initialMinor: 45980,
  annualMinor: 32186,
};
const context = (record: Partial<FirstYearRecord> = {}): FirstYearContext => ({
  historyHash: "b".repeat(64),
  records: [{ ...earlier, ...record }],
});
const decide = (
  a = asset,
  c: FirstYearContext | undefined = empty,
  b = basis,
) => firstYearDecision(scheme, b, a, c, "2025-01-01", "2025-12-31");
const resolve = (
  mode: "auto" | "include" | "exclude",
  a = asset,
  c: FirstYearContext | undefined = empty,
  b = basis,
  note = "",
) => resolveFirstYear(mode, scheme, b, a, c, "2025-01-01", "2025-12-31", note);
describe("history-aware first-year treatment", () => {
  it("calculates an unlinked asset before one worksheet-save confirmation without a per-asset remark", () => {
    const imported = { ...asset, sourceRecordId: null };
    const preview = resolveFirstYear(
      "auto",
      scheme,
      basis,
      imported,
      empty,
      "2025-01-01",
      "2025-12-31",
      "",
      "preview",
    );
    expect(preview).toMatchObject({
      version: 2,
      included: true,
      confirmation: "pending_save",
    });
    expect(
      resolveFirstYear(
        "auto",
        scheme,
        basis,
        imported,
        empty,
        "2025-01-01",
        "2025-12-31",
        "",
        "worksheet_save",
      ),
    ).toMatchObject({
      version: 2,
      included: true,
      confirmation: "worksheet_save",
    });
  });
  it("keeps known duplicate protection even if another historical entry has a different jurisdiction", () => {
    const mixed = {
      ...empty,
      records: [earlier, { ...earlier, revisionId: 2, jurisdiction: "GB" }],
    };
    expect(decide(asset, mixed)).toMatchObject({
      included: false,
      blocked: true,
    });
    expect(
      resolveFirstYear(
        "auto",
        scheme,
        basis,
        asset,
        mixed,
        "2025-01-01",
        "2025-12-31",
        "",
        "preview",
      ).included,
    ).toBe(false);
    expect(() =>
      resolveFirstYear(
        "include",
        scheme,
        basis,
        asset,
        mixed,
        "2025-01-01",
        "2025-12-31",
        "",
        "worksheet_save",
      ),
    ).toThrow("already recorded");
  });

  it("automatically includes a linked new purchase put into use this year", () => {
    expect(decide().included).toBe(true);
    expect(resolve("auto")).toMatchObject({
      mode: "auto",
      included: true,
      historyHash: empty.historyHash,
      previous: [],
    });
  });
  it("requires confirmation for imported assets, missing dates, older purchases and unknown history", () => {
    expect(decide({ ...asset, sourceRecordId: null }).included).toBe(null);
    expect(decide(asset, { ...empty, purchaseLinked: false }).included).toBe(
      null,
    );
    expect(decide({ ...asset, inServiceDate: null }).included).toBe(null);
    expect(decide({ ...asset, inServiceDate: "2026-01-01" }).included).toBe(
      null,
    );
    expect(decide({ ...asset, acquisitionDate: "2024-12-01" }).included).toBe(
      null,
    );
    expect(
      firstYearDecision(
        scheme,
        basis,
        asset,
        undefined,
        "2025-01-01",
        "2025-12-31",
      ).included,
    ).toBe(null);
  });
  it("never reapplies initial allowance to fully covered cost regardless of utilisation", () => {
    expect(decide(asset, context())).toMatchObject({
      included: false,
      blocked: true,
    });
    expect(resolve("auto", asset, context()).included).toBe(false);
    expect(() =>
      resolve(
        "include",
        asset,
        context(),
        basis,
        "Try to claim the same purchase again",
      ),
    ).toThrow("already recorded");
  });
  it("automatically excludes a zero-rate scheme and a year without additions", () => {
    expect(
      firstYearDecision(
        { ...scheme, firstYearRateBps: 0 },
        basis,
        asset,
        empty,
        "2025-01-01",
        "2025-12-31",
      ).included,
    ).toBe(false);
    expect(
      decide(asset, context(), { ...basis, additionsMinor: 0 }).included,
    ).toBe(false);
  });
  it("treats draft and inactive history as ambiguous rather than missing history", () => {
    expect(decide(asset, context({ status: "draft" })).included).toBe(null);
    expect(decide(asset, context({ active: false })).included).toBe(null);
    expect(decide(asset, context({ jurisdiction: "GB" })).included).toBe(null);
    expect(
      decide(asset, { ...context({ currency: "USD" }), currentCurrency: "MYR" })
        .included,
    ).toBe(null);
    expect(
      decide(asset, {
        ...empty,
        records: [
          earlier,
          { ...earlier, revisionId: 2, status: "draft", initialMinor: 0 },
        ],
      }),
    ).toMatchObject({ included: false, blocked: true });
  });
  it("requires a reasoned confirmation for new expenditure on a previously claimed asset", () => {
    const bigger = {
      ...basis,
      qualifyingMinor: 329900,
      additionsMinor: 100000,
    };
    expect(decide(asset, context(), bigger).included).toBe(null);
    expect(() => resolve("include", asset, context(), bigger)).toThrow(
      "remark",
    );
    expect(
      resolve(
        "include",
        asset,
        context(),
        bigger,
        "New qualifying improvement, not the earlier printer cost",
      ),
    ).toMatchObject({
      included: true,
      mode: "include",
      previous: [{ ya: 2024, revisionId: 1 }],
    });
  });
  it("keeps imported-asset confirmation and opt-out explicit without amount overrides", () => {
    const imported = { ...asset, sourceRecordId: null };
    expect(() => resolve("auto", imported)).toThrow("not linked");
    expect(
      resolve(
        "include",
        imported,
        empty,
        basis,
        "New purchase this year; no earlier or external claim",
      ).included,
    ).toBe(true);
    expect(resolve("exclude").included).toBe(false);
  });
  it("does not mistake partial earlier additions for proof that the whole cost received initial allowance", () => {
    expect(
      decide(asset, context({ additionsMinor: 100000, initialMinor: 20000 })),
    ).toMatchObject({ included: null, blocked: false });
  });
});
