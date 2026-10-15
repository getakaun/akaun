import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../db/schema.js";
import { setSetting, SETTING_KEYS } from "../settings.js";
import { documentDefaults, parseTermDays, termDaysInput } from "./defaults.js";

/**
 * The two term settings: what each stored value means for a new document.
 * Against a real in-memory database, so nothing here can touch `data/`.
 */

describe("parseTermDays", () => {
  it("falls back to 30 when the setting was never saved", () => {
    expect(parseTermDays(null)).toBe(30);
  });

  it("reads an empty setting as no term at all", () => {
    expect(parseTermDays("")).toBeNull();
    expect(parseTermDays("   ")).toBeNull();
  });

  it("reads a whole number of days, including 0 for on receipt", () => {
    expect(parseTermDays("14")).toBe(14);
    expect(parseTermDays(" 60 ")).toBe(60);
    expect(parseTermDays("0")).toBe(0);
  });

  it("falls back to 30 for anything that is not a whole number of days", () => {
    for (const junk of ["abc", "-5", "7.5", "1e3", "30 days", "NaN"]) {
      expect(parseTermDays(junk)).toBe(30);
    }
  });
});

describe("termDaysInput", () => {
  it("keeps a blank as none", () => {
    expect(termDaysInput("")).toBe("");
    expect(termDaysInput("  ")).toBe("");
  });

  it("accepts a whole number of days from 0 to 365", () => {
    expect(termDaysInput("0")).toBe("0");
    expect(termDaysInput(" 30 ")).toBe("30");
    expect(termDaysInput("365")).toBe("365");
  });

  it("drops leading zeros, so the page reads back what it saved", () => {
    expect(termDaysInput("007")).toBe("7");
  });

  it("refuses anything else", () => {
    for (const junk of ["366", "-1", "7.5", "1e2", "abc", "30 days"]) {
      expect(termDaysInput(junk)).toBeNull();
    }
  });

  it("stores only what parseTermDays reads back as the same term", () => {
    for (const raw of ["", "0", "14", "365"]) {
      const stored = termDaysInput(raw)!;
      expect(parseTermDays(stored)).toBe(raw === "" ? null : Number(raw));
    }
  });
});

describe("documentDefaults", () => {
  let sqlite: Database;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: "drizzle" });
  });
  afterEach(() => sqlite.close());

  it("starts both terms at 30 days on a fresh book", () => {
    expect(documentDefaults(db)).toEqual({
      invoiceDueDays: 30,
      quotationValidDays: 30,
    });
  });

  it("reads each setting on its own", () => {
    setSetting(db, SETTING_KEYS.invoiceDueDays, "");
    setSetting(db, SETTING_KEYS.quotationValidDays, "15");
    expect(documentDefaults(db)).toEqual({
      invoiceDueDays: null,
      quotationValidDays: 15,
    });
  });
});
