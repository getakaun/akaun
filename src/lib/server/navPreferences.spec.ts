import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "./db/schema.js";
import { userNavPreferences, users } from "./db/schema.js";
import { DEFAULT_NAV_ITEMS } from "$lib/nav-config.js";
import { getUserNavOrder, setUserNavOrder } from "./navPreferences.js";
import { canAll } from "./permissions.js";
import { localsFor } from "./permissions/test-locals.js";

/**
 * A saved navigation preference naming a screen that no longer exists must
 * still resolve to a working navigation (FR-026).
 *
 * This release removes Expenses, Income, Journal and Reconciliation from the
 * menu, and any user who had reordered their menu has rows in
 * `user_nav_preferences` naming them. The code that handles this already
 * exists — `getUserNavOrder` skips an `itemId` that is not in
 * `DEFAULT_NAV_ITEMS`, and `setUserNavOrder` drops unknown ids on save — so
 * what FR-026 needs is a test proving it, not new code (research.md
 * correction 5).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "akaun-nav-"));
  const raw = new Database(join(dir, "test.db"));
  raw.exec("PRAGMA foreign_keys = ON;");
  db = drizzle(raw, { schema });
  migrate(db, { migrationsFolder: "drizzle" });
  db.insert(users)
    .values({
      email: "someone@localhost",
      username: "someone",
      passwordHash: "x",
      role: "owner",
    })
    .run();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A preference row naming a screen, as a reorder saved before this release. */
function savePreference(
  itemId: string,
  sortOrder: number,
  showOnMobile = false,
) {
  db.insert(userNavPreferences)
    .values({ userId: 1, itemId, sortOrder, showOnMobile })
    .run();
}

describe("a saved nav preference naming a removed screen", () => {
  it("adds the Assets module to existing saved navigation with its required reads", () => {
    savePreference("records", 0, true);
    const assets = getUserNavOrder(db, 1).find((item) => item.id === "assets")!;
    expect(assets).toMatchObject({
      label: "Assets",
      href: "/assets",
      permission: "accounts.read",
      requires: ["records.read"],
      showOnMobile: false,
    });
    const required = [assets.permission, ...(assets.requires ?? [])];
    expect(canAll(localsFor(["accounts.read"]), required)).toBe(false);
    expect(canAll(localsFor(["accounts.read", "records.read"]), required)).toBe(
      true,
    );
    setUserNavOrder(db, 1, [
      { itemId: "assets", showOnMobile: true },
      { itemId: "records", showOnMobile: false },
    ]);
    expect(getUserNavOrder(db, 1)[0]).toMatchObject({
      id: "assets",
      showOnMobile: true,
      requires: ["records.read"],
    });
  });
  it("skips the removed screens and still returns a working menu", () => {
    // Exactly what a user who reordered their menu before this release has.
    savePreference("expenses", 0, true);
    savePreference("dashboard", 1, true);
    savePreference("income", 2, true);
    savePreference("journal", 3);
    savePreference("reconciliation", 4);

    const order = getUserNavOrder(db, 1);
    const ids = order.map((i) => i.id);

    for (const removed of ["expenses", "income", "journal"]) {
      expect(ids).not.toContain(removed);
    }
    // Every item still resolves to a real nav item with a real address.
    const known = new Set(DEFAULT_NAV_ITEMS.map((i) => i.id));
    for (const item of order) {
      expect(known.has(item.id)).toBe(true);
      expect(item.href.startsWith("/")).toBe(true);
    }
    // Nothing is lost: the screens that still exist are all offered.
    expect(ids).toContain("dashboard");
    expect(ids).toContain("records");
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(DEFAULT_NAV_ITEMS.length);
  });

  it("keeps the saved order of the screens that survive", () => {
    savePreference("expenses", 0);
    savePreference("reports", 1);
    savePreference("dashboard", 2);

    const ids = getUserNavOrder(db, 1).map((i) => i.id);
    expect(ids.indexOf("reports")).toBeLessThan(ids.indexOf("dashboard"));
  });

  it("drops an unknown id on save rather than storing it", () => {
    setUserNavOrder(db, 1, [
      { itemId: "expenses", showOnMobile: true },
      { itemId: "records", showOnMobile: true },
      { itemId: "dashboard", showOnMobile: false },
    ]);

    const stored = db
      .select()
      .from(userNavPreferences)
      .all()
      .map((r: { itemId: string }) => r.itemId);

    expect(stored).not.toContain("expenses");
    expect(stored).toContain("records");
    expect(stored).toContain("dashboard");
  });

  it("gives a user with no preference at all the full default menu", () => {
    const ids = getUserNavOrder(db, 1).map((i) => i.id);
    expect(ids).toEqual(DEFAULT_NAV_ITEMS.map((i) => i.id));
  });
});
