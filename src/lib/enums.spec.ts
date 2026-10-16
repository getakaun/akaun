import { describe, expect, it } from "vitest";
import * as enums from "./enums.js";
import {
  ENUM_FIELDS,
  changesSummary,
  describeChange,
  fieldLabel,
} from "./components/audit/audit-format.js";

/**
 * Every code has a name a reader sees. A code added to an enum without one
 * would show as a bare number on a screen and in the audit log, so each enum
 * is checked against its display map: every value named, nothing extra.
 */
const DISPLAY_MAPS: [string, Record<string, number>, Record<number, string>][] =
  [
    ["EntityType", enums.EntityType, enums.EntityTypeLabels],
    ["Role", enums.Role, enums.RoleLabels],
    ["ImportState", enums.ImportState, enums.ImportStateDisplayLabels],
    ["DocumentType", enums.DocumentType, enums.DocumentTypeDisplayLabels],
    ["ResetScope", enums.ResetScope, enums.ResetScopeDisplayLabels],
    [
      "QuotationStatus",
      enums.QuotationStatus,
      enums.QuotationStatusDisplayLabels,
    ],
    ["InvoiceStatus", enums.InvoiceStatus, enums.InvoiceStatusDisplayLabels],
    [
      "StatementDirection",
      enums.StatementDirection,
      enums.StatementDirectionDisplayLabels,
    ],
    [
      "StatementExtractionState",
      enums.StatementExtractionState,
      enums.StatementExtractionStateDisplayLabels,
    ],
    ["AccountRole", enums.AccountRole, enums.AccountRoleDisplayLabels],
    // `Object.values` skips the hidden `Income` and `Equipment` aliases: they
    // are the same codes as Revenue and FixedAsset.
    ["AccountType", enums.AccountType, enums.AccountTypeDisplayLabels],
    ["AccountSubType", enums.AccountSubType, enums.AccountSubTypeDisplayLabels],
    [
      "DefaultAccountPurpose",
      enums.DefaultAccountPurpose,
      enums.DefaultAccountPurposeDisplayLabels,
    ],
    [
      "LedgerRecordKind",
      enums.LedgerRecordKind,
      enums.LedgerRecordKindDisplayLabels,
    ],
    // ReconItemType is retired: nothing shows or writes its codes.
  ];

describe("enum display names", () => {
  it.each(DISPLAY_MAPS)(
    "names every %s code, and nothing else",
    (_, codes, names) => {
      const values = Object.values(codes).sort((a, b) => a - b);
      expect(
        Object.keys(names)
          .map(Number)
          .sort((a, b) => a - b),
      ).toEqual(values);
      for (const value of values) expect(names[value]?.trim()).toBeTruthy();
    },
  );

  it("covers every exported enum", () => {
    // An `X` with an `XLabels` map is an enum; each needs a row above.
    const exported = Object.keys(enums).filter(
      (name) =>
        /^[A-Z]/.test(name) &&
        `${name}Labels` in enums &&
        name !== "ReconItemType",
    );
    const checked = DISPLAY_MAPS.map(([name]) => name);
    // AccountRole has no wire map, so it is checked without being found here.
    expect(exported.filter((name) => !checked.includes(name))).toEqual([]);
  });
});

describe("the audit log names codes", () => {
  it("names each audited code field from a display map", () => {
    const shared = new Set<unknown>(Object.values(enums));
    for (const [type, fields] of Object.entries(ENUM_FIELDS))
      for (const [field, map] of Object.entries(fields)) {
        expect(Object.keys(map).length, `${type}.${field}`).toBeGreaterThan(0);
        // Either a map from enums.ts or one of the text-code maps, which are
        // keyed by strings rather than codes.
        const fromEnums = shared.has(map);
        const textCodes = Object.keys(map).every((key) => !/^\d+$/.test(key));
        expect(fromEnums || textCodes, `${type}.${field}`).toBe(true);
      }
  });

  it("reads a status by its name, per kind of record", () => {
    const sent = { field: "status", before: 1, after: 2 };
    expect(describeChange("quotation", sent)).toMatchObject({
      before: "Draft",
      after: "Sent",
    });
    expect(changesSummary("quotation", "update", [sent])).toBe(
      "Status Draft → Sent",
    );
    expect(
      describeChange("invoice", { field: "status", before: 2, after: 3 }).after,
    ).toBe("Paid");
    expect(
      describeChange("quotation", { field: "status", before: 2, after: 3 })
        .after,
    ).toBe("Accepted");
  });

  it("names import items, roles, account defaults, and leaves unknown codes as they are", () => {
    expect(
      describeChange("import_job", {
        field: "item 2.documentType",
        before: 1,
        after: 2,
      }),
    ).toMatchObject({ before: "Expense", after: "Income" });
    expect(
      describeChange("contact", { field: "roles", before: [1], after: [1, 2] }),
    ).toMatchObject({ added: ["Supplier"], removed: [] });
    expect(fieldLabel("savedDefault:6")).toBe(
      "Default account: Default transaction account",
    );
    expect(
      describeChange("quotation", { field: "status", before: 1, after: 99 })
        .after,
    ).toBe("99");
    // Not a code on this kind of record: shown as it is.
    expect(
      describeChange("import_profile", { field: "status", before: 1, after: 2 })
        .after,
    ).toBe("2");
  });
});
