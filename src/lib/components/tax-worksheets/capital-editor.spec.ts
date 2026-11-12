import { describe, it, expect } from "vitest";
import {
  blankCapitalRow,
  type CapitalSchedule,
} from "$lib/capital-allowance.js";
import type { AppliedAssetTaxScheme } from "$lib/asset-tax-scheme.js";
import {
  editorRows,
  editorUses,
  editorPreview,
  editorSchemes,
  mergeEditorRows,
} from "./capital-editor.js";
const period = { ya: 2025, dateFrom: "2025-01-01", dateTo: "2025-12-31" };
const scheme: AppliedAssetTaxScheme = {
  id: 1,
  familyKey: "ac9ae028-7a16-41fb-8dd0-ddb18ef8860d",
  version: 1,
  verification: "custom_unverified",
  definition: {
    name: "Machinery",
    jurisdiction: "MY",
    yearFrom: 2025,
    yearTo: null,
    method: "original_cost",
    firstYearRateBps: 2000,
    regularRateBps: 1400,
  },
};
function fixture(): CapitalSchedule {
  return {
    calculationVersion: 2,
    jurisdiction: "MY",
    currency: "MYR",
    evidence: "",
    predecessor: null,
    utilisation: [],
    rows: [blankCapitalRow(1)],
    assets: [
      {
        assetId: 1,
        name: "Printer",
        assetType: "Equipment",
        acquisitionDate: "2025-01-10",
        inServiceDate: "2025-01-10",
        costMinor: 500000,
        sourceRecordId: null,
        documentReference: "",
        version: "fixture",
        sourceVersion: null,
        reviewReason: null,
      },
    ],
  };
}
function draft(s = fixture()) {
  const rows = editorRows(s, period);
  Object.assign(rows[0].form, {
    schemeId: "1",
    treatment: "claim",
    firstYear: true,
  });
  return {
    s,
    rows,
    preview: (uses = editorUses(s)) =>
      editorPreview(s, rows, [scheme], uses, "", period),
  };
}
describe("inline asset deduction staging", () => {
  it("merges changed book facts and new assets while preserving edited asset inputs", () => {
    const s = fixture();
    const oldRows = editorRows(s, period);
    oldRows[0].form.percentage = "75";
    const incoming = {
      ...s,
      rows: [...s.rows, blankCapitalRow(2)],
      assets: [
        { ...s.assets[0], costMinor: 600000 },
        { ...s.assets[0], assetId: 2, name: "New printer", costMinor: 100000 },
      ],
    };
    const merged = mergeEditorRows(oldRows, editorRows(incoming, period));
    expect(merged[0].form.percentage).toBe("75");
    expect(merged[1].form.amounts.qualifyingMinor).toBe("1000.00");
    const untouched = mergeEditorRows(
      editorRows(s, period),
      editorRows(incoming, period),
    );
    expect(untouched[0].form.amounts.qualifyingMinor).toBe("6000.00");
    expect(s.assets[0].costMinor).toBe(500000);
  });
  it("uses canonical scheme snapshots when loading library rows with persistence metadata", () => {
    const library = {
      ...scheme,
      requestKey: "receipt",
      payloadHash: "hash",
      actorName: "Owner",
      createdAt: "fixture",
    };
    const { s, rows } = draft();
    const result = editorPreview(
      s,
      rows,
      editorSchemes([library]),
      [],
      "",
      period,
    );
    expect(result.errors).toEqual([]);
    expect(Object.keys(result.input.rows[0].appliedScheme!).sort()).toEqual(
      ["id", "familyKey", "version", "definition", "verification"].sort(),
    );
  });
  it("suggests inputs without changing saved evidence or claiming unselected assets", () => {
    const s = fixture(),
      before = JSON.stringify(s),
      rows = editorRows(s, period);
    expect(rows[0].form).toMatchObject({
      treatment: "pending",
      percentage: "100",
      businessSource: "Main business",
    });
    expect(
      editorPreview(s, rows, [scheme], [], "", period).input.rows[0],
    ).toEqual(s.rows[0]);
    expect(editorRows(s, period, false)[0].form.percentage).toBe("");
    expect(JSON.stringify(s)).toBe(before);
  });
  it("stages scheme calculations and explicit utilisation in one input with an optional remark", () => {
    const { preview } = draft();
    const result = preview([
      {
        source: "Main business",
        origin: "2025",
        balance: "0.00",
        used: "1700.00",
      },
    ]);
    expect(result.errors).toEqual([]);
    expect(result.totals.problems).toEqual([]);
    expect(result.input.utilisation[0]).toMatchObject({
      balanceMinor: 170000,
      usedMinor: 170000,
    });
    expect(result.totals).toMatchObject({
      allowanceMinor: 170000,
      usedMinor: 170000,
      carryForwardMinor: 0,
    });
  });
  it("updates current balance from edited assets without silently clamping an excessive claim", () => {
    const { rows, preview } = draft();
    rows[0].form.percentage = "50";
    const result = preview([
      {
        source: "Main business",
        origin: "2025",
        balance: "1700.00",
        used: "1700.00",
      },
    ]);
    expect(result.input.utilisation[0]).toMatchObject({
      balanceMinor: 85000,
      usedMinor: 170000,
    });
    expect(result.errors.length).toBeGreaterThan(0);
  });
  it("preserves prior-year allocations independently and never uses a balance automatically", () => {
    const { preview } = draft();
    const result = preview([
      {
        source: "Main business",
        origin: "2024",
        balance: "300.00",
        used: "100.00",
      },
    ]);
    expect(result.input.utilisation).toEqual([
      {
        businessSource: "Main business",
        originYa: 2024,
        balanceMinor: 30000,
        usedMinor: 10000,
      },
      {
        businessSource: "Main business",
        originYa: 2025,
        balanceMinor: 170000,
        usedMinor: 0,
      },
    ]);
    expect(result.totals.usedMinor).toBe(10000);
  });
  it("retains an untouched scheme calculation while editing its worksheet", () => {
    const { preview } = draft();
    const s = preview().schedule;
    const result = editorPreview(
      s,
      editorRows(s, period),
      [scheme],
      editorUses(s),
      "Worksheet remark",
      period,
    );
    expect(result.input.rows[0]).toEqual(s.rows[0]);
    expect(result.input.evidence).toBe("Worksheet remark");
  });
  it("does not drop a claim when its business source is removed", () => {
    const { rows, preview } = draft();
    rows[0].form.treatment = "exclude";
    rows[0].form.note = "Personal asset";
    const result = preview([
      {
        source: "Main business",
        origin: "2025",
        balance: "1700.00",
        used: "100.00",
      },
    ]);
    expect(result.input.utilisation[0]).toMatchObject({
      balanceMinor: 0,
      usedMinor: 10000,
    });
    expect(result.errors.length).toBeGreaterThan(0);
  });
  it("rejects duplicate, future and malformed claims rather than discarding them", () => {
    const { preview } = draft();
    const use = {
      source: "Main business",
      origin: "2025",
      balance: "0.00",
      used: "0.00",
    };
    expect(() => preview([use, use])).toThrow("one claim");
    expect(() => preview([{ ...use, origin: "2026" }])).toThrow(
      "current or earlier",
    );
    expect(() => preview([{ ...use, used: "invalid" }])).toThrow("two decimal");
    expect(() => preview([{ ...use, earlier: true }])).toThrow(
      "before this tax year",
    );
  });
});
