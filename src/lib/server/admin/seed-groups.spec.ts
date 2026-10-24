import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../db/schema.js";
import { groups, userGroups, users } from "../db/schema.js";
import type { LedgerDb } from "../ledger/types.js";
import { seedGroups } from "./seed-groups.js";
import { keepsASuperuser } from "./access.js";

let sqlite: Database;
let db: LedgerDb;

beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema }) as unknown as LedgerDb;
  migrate(db as never, { migrationsFolder: "drizzle" });
  db.insert(users)
    .values({ id: 1, email: "a@test", username: "a", passwordHash: "x" })
    .run();
});
afterEach(() => sqlite.close());

const names = () =>
  db
    .select({ name: groups.name })
    .from(groups)
    .all()
    .map((g) => g.name)
    .sort();
const groupId = (name: string) =>
  db.select().from(groups).where(eq(groups.name, name)).get()!.id;

describe("seeding the default groups", () => {
  it("writes them once, and a deleted one stays deleted", () => {
    seedGroups(db);
    expect(names()).toEqual([
      "Administrators",
      "Bookkeeper",
      "Data Entry",
      "Reviewer",
    ]);
    db.delete(groups).where(eq(groups.name, "Reviewer")).run();
    seedGroups(db);
    expect(names()).not.toContain("Reviewer");
  });

  it("does not seed historical correction grants or delegation ceilings", () => {
    seedGroups(db);
    for (const table of [schema.groupGrants, schema.groupDelegations]) {
      const permissions = db
        .select()
        .from(table)
        .all()
        .map((row) => row.permission);
      expect(permissions).not.toContain("records.correctDate");
      expect(permissions).not.toContain("records.correctReimbursementAmount");
    }
  });

  it("leaves a book that already has groups alone", () => {
    db.insert(groups).values({ name: "Owners", isSuperuser: true }).run();
    seedGroups(db);
    expect(names()).toEqual(["Owners"]);
  });

  it("puts ungrouped users in a superuser group of any name", () => {
    seedGroups(db);
    db.update(groups)
      .set({ name: "Owners" })
      .where(eq(groups.name, "Administrators"))
      .run();
    db.delete(userGroups).run();
    seedGroups(db);
    expect(db.select().from(userGroups).all()).toEqual([
      { userId: 1, groupId: groupId("Owners") },
    ]);
  });
});

describe("keeping someone who can manage users", () => {
  beforeEach(() => seedGroups(db));

  it("refuses to take the last superuser out", () => {
    const admins = groupId("Administrators");
    expect(keepsASuperuser(db, { demoteGroupId: admins })).toBe(false);
    expect(keepsASuperuser(db, { deleteUserId: 1 })).toBe(false);
    expect(
      keepsASuperuser(db, { userId: 1, groupIds: [groupId("Reviewer")] }),
    ).toBe(false);
  });

  it("allows it while another superuser remains", () => {
    db.insert(users)
      .values({ id: 2, email: "b@test", username: "b", passwordHash: "x" })
      .run();
    const owners = db
      .insert(groups)
      .values({ name: "Owners", isSuperuser: true })
      .returning()
      .get();
    db.insert(userGroups).values({ userId: 2, groupId: owners.id }).run();
    expect(
      keepsASuperuser(db, { demoteGroupId: groupId("Administrators") }),
    ).toBe(true);
    expect(keepsASuperuser(db, { deleteUserId: 1 })).toBe(true);
    expect(keepsASuperuser(db, { userId: 2, groupIds: [] })).toBe(true);
  });
});
