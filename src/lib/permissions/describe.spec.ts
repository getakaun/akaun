import { describe, expect, it } from "vitest";
import { leavesOf, PERMISSION_ROOTS, type LeafPermission } from "./catalog.js";
import {
  describeArea,
  levelLeaves,
  levelOf,
  levelsFor,
  summarizeAccess,
} from "./describe.js";

describe("access levels", () => {
  it("offers only the levels that differ", () => {
    expect(levelsFor("reports")).toEqual(["none", "view"]);
    expect(levelsFor("dashboard")).toEqual(["none", "view"]);
    expect(levelsFor("settings")).toEqual(["none", "view", "edit"]);
    expect(levelsFor("invoices")).toEqual(["none", "view", "edit", "full"]);
  });

  it("puts destructive abilities in Full and never an explicit one in any level", () => {
    expect(levelLeaves("invoices", "edit")).toEqual([
      "invoices.read",
      "invoices.create",
      "invoices.update",
      "invoices.issue",
    ]);
    expect(levelLeaves("records", "full")).not.toContain("records.adjust");
    expect(levelLeaves("records", "full")).not.toContain("records.correctDate");
    expect(levelLeaves("records", "full")).not.toContain(
      "records.correctAllocations",
    );
    expect(levelLeaves("records", "full")).not.toContain(
      "records.correctPaymentRecipient",
    );
    expect(levelLeaves("records", "full")).not.toContain(
      "records.correctReimbursementAmount",
    );
    expect(levelLeaves("contacts", "full")).toContain("contacts.merge");
  });

  it("reads each level back from its own leaves, in every area", () => {
    for (const root of PERMISSION_ROOTS)
      for (const level of levelsFor(root))
        expect(levelOf(root, levelLeaves(root, level))).toBe(level);
  });

  it("calls anything else custom, and ignores explicit abilities", () => {
    expect(levelOf("records", ["records.create"])).toBe("custom");
    expect(
      levelOf("records", [...levelLeaves("records", "view"), "records.adjust"]),
    ).toBe("view");
  });

  it("gives every leaf words to be described with", () => {
    for (const root of PERMISSION_ROOTS)
      expect(describeArea(root, leavesOf(root))).not.toMatch(/undefined/);
  });
});

describe("summary sentences", () => {
  it("names what is allowed, then what is not", () => {
    expect(describeArea("invoices", levelLeaves("invoices", "edit"))).toBe(
      "Can see, add, change and send invoices. Cannot delete or void.",
    );
    expect(describeArea("reports", ["reports.read"])).toBe("Can see reports.");
    expect(describeArea("contacts", [])).toBe("No access.");
  });

  it("adds a standalone phrase and never lists an explicit ability as missing", () => {
    expect(describeArea("records", ["records.read", "records.adjust"])).toBe(
      "Can see records and make adjustments. Cannot add, change or delete.",
    );
    expect(describeArea("records", levelLeaves("records", "full"))).toBe(
      "Can see, add, change and delete records.",
    );
    expect(describeArea("import", ["import.profiles"])).toMatch(
      /^Can manage import profiles\. Cannot /,
    );
  });

  it("summarizes stored permissions, with roots expanded", () => {
    const summary = summarizeAccess(["invoices", "records.read", "bogus"]);
    expect(summary.map((s) => [s.root, s.level])).toEqual([
      ["records", "view"],
      ["invoices", "full"],
    ]);
    const adjustOnly = summarizeAccess(["records.adjust" as LeafPermission]);
    expect(adjustOnly[0]).toMatchObject({
      level: "custom",
      extras: ["Adjustments"],
    });
  });
});
