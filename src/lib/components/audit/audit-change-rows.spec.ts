import { expect, it } from "vitest";
import { auditChangeRows } from "./audit-change-rows.js";

it("shows only changed nested values with asset labels, readable units and the full text", () => {
  const longText = "reference".repeat(200);
  expect(
    auditChangeRows("fixed_asset", [
      {
        field: "depreciationProfile",
        before: {
          months: 36,
          residualMinor: 10000,
          mode: "review",
          notes: "Old",
          unchanged: true,
          empty: [],
        },
        after: {
          months: 24,
          residualMinor: 20000,
          mode: "auto",
          notes: longText,
          unchanged: true,
          empty: [],
        },
      },
    ]),
  ).toEqual([
    {
      label: "Depreciation setup · Useful life (months)",
      before: "36",
      after: "24",
    },
    {
      label: "Depreciation setup · Residual value",
      before: "100.00",
      after: "200.00",
    },
    {
      label: "Depreciation setup · Posting mode",
      before: "Review before posting",
      after: "Auto-post monthly",
    },
    { label: "Depreciation setup · Notes", before: "Old", after: longText },
  ]);
});
it("names JSON-encoded basis values and keeps removed and added values", () => {
  const rows = auditChangeRows("fixed_asset", [
    {
      field: "basis",
      before: JSON.stringify([10000, 1, "2026-01-01", null, null, 0]),
      after: JSON.stringify([20000, 1, "2026-01-01", null, null, 0]),
    },
    {
      field: "sourceSnapshot",
      before: { recordDate: "2026-01-01", accountId: 5 },
      after: null,
    },
  ]);
  expect(rows).toEqual([
    {
      label: "Financial basis · Original cost",
      before: "100.00",
      after: "200.00",
    },
    {
      label: "Purchase details · Record date",
      before: "2026-01-01",
      after: "—",
    },
    { label: "Purchase details · Account", before: "5", after: "—" },
  ]);
});
