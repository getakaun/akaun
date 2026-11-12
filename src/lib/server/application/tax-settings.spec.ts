import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { beforeEach, afterEach, describe, it, expect } from "vitest";
import * as schema from "../db/schema.js";
import type { LedgerDb } from "../ledger/types.js";
import { localsFor } from "../permissions/test-locals.js";
import { readTaxSettings, saveTaxSettings } from "./tax-settings.js";
import { getSetting, SETTING_KEYS } from "../settings.js";
import { taxWorksheetEvents } from "./tax-worksheet-boundary.js";

let raw: Database;
let db: LedgerDb;
const ctx = (permissions = ["tax.read", "tax.update"]) => ({
  db,
  locals: localsFor(permissions),
});
beforeEach(() => {
  raw = new Database(":memory:");
  db = drizzle(raw, { schema }) as LedgerDb;
  migrate(db, { migrationsFolder: "drizzle" });
  db.insert(schema.users)
    .values({ id: 1, email: "u@test", username: "u", passwordHash: "unused" })
    .run();
});
afterEach(() => raw.close());

describe("tax worksheet defaults", () => {
  it("requires tax read/update independently of general settings permission", () => {
    expect(readTaxSettings(ctx([])).ok).toBe(false);
    expect(
      saveTaxSettings(ctx(["tax.read"]), {
        jurisdiction: "MY",
        expectedJurisdiction: null,
      }).ok,
    ).toBe(false);
    expect(getSetting(db, SETTING_KEYS.taxJurisdiction)).toBeNull();
    expect(
      saveTaxSettings(ctx(), { jurisdiction: "MY", expectedJurisdiction: null })
        .ok,
    ).toBe(true);
    expect(readTaxSettings(ctx(["tax.read"]))).toEqual({
      ok: true,
      value: { jurisdiction: "MY" },
    });
  });
  it("rejects stale writes and emits/audits only committed changes; clearing remains nullable", () => {
    let signals = 0;
    const listener = () => signals++;
    taxWorksheetEvents.on("changed", listener);
    try {
      expect(
        saveTaxSettings(ctx(), {
          jurisdiction: "MY",
          expectedJurisdiction: null,
        }).ok,
      ).toBe(true);
      expect(
        saveTaxSettings(ctx(), {
          jurisdiction: "GB",
          expectedJurisdiction: null,
        }).ok,
      ).toBe(false);
      expect(signals).toBe(1);
      expect(db.select().from(schema.auditLog).all()).toHaveLength(1);
      expect(
        saveTaxSettings(ctx(), {
          jurisdiction: null,
          expectedJurisdiction: "MY",
        }).ok,
      ).toBe(true);
      expect(readTaxSettings(ctx())).toEqual({
        ok: true,
        value: { jurisdiction: null },
      });
      expect(
        saveTaxSettings(ctx(), {
          jurisdiction: "US",
          expectedJurisdiction: null,
        }).ok,
      ).toBe(true);
      expect(signals).toBe(3);
    } finally {
      taxWorksheetEvents.off("changed", listener);
    }
  });
});
