import { describe, expect, it } from "vitest";
import {
  expandAll,
  expandPermission,
  isDelegable,
  isPermission,
  LEAF_PERMISSIONS,
  leafMeta,
  PERMISSION_CATALOG,
  sortLeaves,
} from "./catalog.js";
import {
  OAUTH_SCOPES,
  SCOPE_LABELS,
  SCOPE_PERMISSIONS,
  expandScopes,
  scopeTier,
} from "./oauth-scopes.js";

describe("permission catalog", () => {
  it("names every leaf root.verb, with a label and a description", () => {
    for (const leaf of LEAF_PERMISSIONS) {
      expect(leaf).toMatch(/^[a-z]+\.[a-z][a-zA-Z]*$/);
      const meta = leafMeta(leaf);
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.description.length).toBeGreaterThan(0);
    }
  });

  it("expands a root to its leaves, but never to an explicit one", () => {
    expect(expandPermission("records")).toEqual([
      "records.read",
      "records.create",
      "records.update",
      "records.delete",
    ]);
    expect(expandPermission("records")).not.toContain("records.adjust");
    expect(expandPermission("records")).not.toContain("records.correctDate");
    expect(expandPermission("records")).not.toContain("records.correctContact");
    expect(leafMeta("records.correctContact").sensitive).toBe(true);
    expect(isDelegable("records.correctContact")).toBe(true);
    expect(leafMeta("records.correctDate").sensitive).toBe(true);
    expect(isDelegable("records.correctDate")).toBe(true);
    expect(expandPermission("records")).not.toContain(
      "records.correctReimbursementAmount",
    );
    expect(leafMeta("records.correctReimbursementAmount").sensitive).toBe(true);
    expect(isDelegable("records.correctReimbursementAmount")).toBe(true);
    for (const permission of [
      "records.correctAllocations",
      "records.correctPaymentRecipient",
    ] as const) {
      expect(expandPermission("records")).not.toContain(permission);
      expect(leafMeta(permission).sensitive).toBe(true);
      expect(isDelegable(permission)).toBe(true);
    }
    expect(expandPermission("records.adjust")).toEqual(["records.adjust"]);
  });

  it("drops a string it does not know rather than failing", () => {
    expect(isPermission("records.fly")).toBe(false);
    expect(isPermission("expenses")).toBe(false);
    expect([...expandAll(["records.read", "records.fly", "expenses"])]).toEqual(
      ["records.read"],
    );
  });

  it("keeps reports read-only and user management with superusers", () => {
    expect(Object.keys(PERMISSION_CATALOG.reports.children)).toEqual(["read"]);
    expect(leafMeta("users.manage").superuserOnly).toBe(true);
    expect(isDelegable("users.manage")).toBe(false);
    expect(leafMeta("records.adjust").sensitive).toBe(true);
    expect(leafMeta("settings.manage").sensitive).toBe(true);
  });

  it("sorts leaves into catalog order", () => {
    expect(
      sortLeaves(["invoices.read", "records.delete", "records.read"]),
    ).toEqual(["records.read", "records.delete", "invoices.read"]);
  });
});

describe("OAuth scopes", () => {
  it("expands every scope to known leaves, with a label", () => {
    for (const scope of OAUTH_SCOPES) {
      expect(SCOPE_PERMISSIONS[scope].length).toBeGreaterThan(0);
      for (const leaf of SCOPE_PERMISSIONS[scope])
        expect(LEAF_PERMISSIONS).toContain(leaf);
      expect(SCOPE_LABELS[scope].length).toBeGreaterThan(0);
    }
  });

  it("never offers settings, users or the dashboard to an app", () => {
    const offered = new Set(expandScopes(OAUTH_SCOPES));
    expect(offered.has("records.correctContact")).toBe(false);

    for (const leaf of offered)
      expect(leaf.split(".")[0]).not.toMatch(/^(settings|users|dashboard)$/);
  });

  it("requires independent correction scopes outside ordinary record access", () => {
    const ordinary = expandScopes([
      "records:read",
      "records:write",
      "records:delete",
      "records:adjust",
    ]);
    expect(ordinary).not.toContain("records.correctDate");
    expect(ordinary).not.toContain("records.correctReimbursementAmount");
    expect(expandScopes(["records:correct-date"])).toEqual([
      "records.correctDate",
    ]);
    expect(expandScopes(["records:correct-reimbursement-amount"])).toEqual([
      "records.correctReimbursementAmount",
    ]);
    expect(scopeTier("records:correct-date")).toBe("correct");
    expect(scopeTier("records:correct-reimbursement-amount")).toBe("correct");
    expect(scopeTier("records:correction")).toBe("correct");
    expect(expandScopes(["records:correction"])).toEqual([
      "records.correctAllocations",
      "records.correctPaymentRecipient",
      "records.correctDate",
      "records.correctReimbursementAmount",
    ]);
    expect(ordinary).not.toContain("records.correctAllocations");
    expect(ordinary).not.toContain("records.correctPaymentRecipient");
  });

  it("keeps every read scope to reads", () => {
    for (const scope of OAUTH_SCOPES.filter((s) => s.endsWith(":read")))
      for (const leaf of SCOPE_PERMISSIONS[scope])
        expect(leaf).toMatch(/\.read$/);
  });
});
