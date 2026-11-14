import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterEach, describe, expect, it } from "vitest";
import * as schema from "./schema.js";
import { applyMigrationRange } from "./auto-upgrade.js";
import { migrateBook } from "./migrate-book.js";
import type { LedgerDb } from "../ledger/types.js";
import { seedGroups } from "../admin/seed-groups.js";
import { grantGroup, issueTestToken } from "../permissions/test-locals.js";
import {
  isPermission,
  leafMeta,
  type LeafPermission,
} from "$lib/permissions/catalog.js";

/**
 * Migration 0052 takes `contacts.merge` out of every stored delegation
 * ceiling, now that the leaf is sensitive. It must touch nothing else and be
 * harmless to run twice. Every book here is `:memory:`, built from
 * `drizzle/`; nothing imports `db/client.ts`.
 */

/** The last migration before 0052 (0-based index into `drizzle/`). */
const BEFORE_0052 = 51;
const INDEX_0052 = 52;

const opened: Database[] = [];
function memory(): Database {
  const raw = new Database(":memory:");
  opened.push(raw);
  return raw;
}
afterEach(() => {
  for (const raw of opened.splice(0)) raw.close();
});

const bookOver = (raw: Database) => drizzle(raw, { schema }) as LedgerDb;

type Row = Record<string, unknown>;
const tableNames = (raw: Database) =>
  (
    raw
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((row) => row.name);
const rowsOf = (raw: Database, table: string) =>
  (raw.query(`SELECT * FROM "${table}"`).all() as Row[])
    // The migrator's own receipt counter moves with every migration.
    .filter(
      (row) =>
        table !== "sqlite_sequence" || row.name !== "__drizzle_migrations",
    )
    .map((row) => JSON.stringify(row))
    .sort();
/** Every table's rows, order-independent, plus the schema itself. */
function digests(raw: Database): Record<string, string> {
  const out: Record<string, string> = {};
  for (const table of tableNames(raw))
    out[table] = createHash("sha256")
      .update(rowsOf(raw, table).join("\n"))
      .digest("hex");
  out["(schema)"] = createHash("sha256")
    .update(
      JSON.stringify(
        raw
          .query(
            "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name",
          )
          .all(),
      ),
    )
    .digest("hex");
  return out;
}
const delegationRows = (raw: Database) =>
  raw
    .query(
      "SELECT group_id, permission FROM group_delegations ORDER BY group_id, permission",
    )
    .all() as { group_id: number; permission: string }[];
const receipts = (raw: Database) =>
  (
    raw.query("SELECT COUNT(*) AS n FROM __drizzle_migrations").get() as {
      n: number;
    }
  ).n;

/** The statements of 0052, run by hand to prove a second run is harmless. */
function run0052Again(raw: Database) {
  const migration = readMigrationFiles({ migrationsFolder: "drizzle" })[
    INDEX_0052
  ];
  for (const statement of migration.sql)
    if (statement.trim()) raw.exec(statement);
}

/**
 * A book as an existing installation has it at 0051: a superuser group, a
 * group whose ceiling holds merge (as migration 0033 wrote it for any group
 * that could delete contacts), groups that never delegated it, a user's own
 * grant, a token and an app that list it.
 */
function existingBook() {
  const raw = memory();
  applyMigrationRange(raw, 0, BEFORE_0052);
  raw.exec("PRAGMA foreign_keys = ON");
  const db = bookOver(raw);
  db.insert(schema.users)
    .values(
      [1, 2, 3, 4].map((id) => ({
        id,
        username: `user${id}`,
        email: `u${id}@test`,
        passwordHash: "unused",
      })),
    )
    .run();
  const admins = grantGroup(db, {
    name: "Administrators",
    userIds: [1],
    grants: [],
    superuser: true,
  });
  // A superuser group has no ceiling; a stray row is read by nothing.
  db.insert(schema.groupDelegations)
    .values({ groupId: admins, permission: "contacts.merge" })
    .run();
  const keepers = grantGroup(db, {
    name: "Keepers",
    userIds: [2],
    grants: [
      "contacts.read",
      "contacts.create",
      "contacts.update",
      "contacts.delete",
      "contacts.merge",
      "records.read",
      "settings.read",
    ],
    delegations: [
      "contacts.read",
      "contacts.create",
      "contacts.update",
      "contacts.delete",
      "contacts.merge",
      "records.read",
    ],
  });
  const careful = grantGroup(db, {
    name: "Careful",
    userIds: [3],
    grants: ["contacts.read", "contacts.merge"],
    delegations: ["contacts.read"],
  });
  const readers = grantGroup(db, {
    name: "Readers",
    userIds: [3],
    grants: ["contacts.read", "records.read"],
  });
  // Screens store leaves only; a hand-written root is not a
  // `contacts.merge` row, so 0052 leaves it alone.
  const handWritten = grantGroup(db, {
    name: "Hand-written root",
    userIds: [4],
    grants: ["contacts"],
    delegations: ["contacts"],
  });
  db.insert(schema.userGrants)
    .values({ userId: 3, permission: "contacts.merge" })
    .run();
  issueTestToken(db, 2, ["contacts.read", "contacts.merge"], "merge token");
  db.insert(schema.oauthClients)
    .values({
      id: "client-1",
      name: "Agent",
      redirectUris: JSON.stringify(["https://client.example.com/cb"]),
      createdAt: 1,
    })
    .run();
  db.insert(schema.oauthGrants)
    .values({
      id: "grant-1",
      userId: 2,
      clientId: "client-1",
      issuer: "https://books.example.com",
      resource: "https://books.example.com/mcp",
      scopes: "contacts:read contacts:write contacts:delete contacts:merge",
      createdAt: 1,
      expiresAt: Date.now() + 86_400_000,
    })
    .run();
  return {
    raw,
    db,
    groups: { admins, keepers, careful, readers, handWritten },
  };
}

describe("migration 0052: contacts.merge leaves stored ceilings", () => {
  it("is a data-only migration: the schema snapshot is 0051's", () => {
    const migrations = readMigrationFiles({ migrationsFolder: "drizzle" });
    expect(migrations[INDEX_0052].sql.join("\n")).toMatch(
      /DELETE FROM `group_delegations` WHERE `permission` = 'contacts\.merge'/,
    );
    const raw = memory();
    applyMigrationRange(raw, 0, BEFORE_0052);
    const before = digests(raw)["(schema)"];
    applyMigrationRange(raw, INDEX_0052, INDEX_0052);
    expect(digests(raw)["(schema)"]).toBe(before);
  });

  it("removes only contacts.merge ceiling rows from a book at 0051, and nothing else changes", () => {
    const { raw, groups } = existingBook();
    const before = digests(raw);
    const delegationsBefore = delegationRows(raw);
    const receiptsBefore = receipts(raw);
    expect(
      delegationsBefore.filter((r) => r.permission === "contacts.merge"),
    ).toEqual([
      { group_id: groups.admins, permission: "contacts.merge" },
      { group_id: groups.keepers, permission: "contacts.merge" },
    ]);

    migrateBook(raw);

    const after = digests(raw);
    for (const table of Object.keys(before)) {
      if (table === "group_delegations" || table === "__drizzle_migrations")
        continue;
      expect(after[table], table).toBe(before[table]);
    }
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    // Exactly the merge rows went; every other ceiling row is as it was.
    expect(delegationRows(raw)).toEqual(
      delegationsBefore.filter((r) => r.permission !== "contacts.merge"),
    );
    expect(receipts(raw)).toBe(receiptsBefore + 1);

    // Grants are untouched: Keepers and Careful still merge in the app.
    const grants = raw
      .query(
        "SELECT group_id FROM group_grants WHERE permission = 'contacts.merge' ORDER BY group_id",
      )
      .all();
    expect(grants).toEqual([
      { group_id: groups.keepers },
      { group_id: groups.careful },
    ]);
    // The token and the app still list it; the ceiling is what stops it.
    expect(
      raw.query("SELECT permissions FROM personal_access_tokens").get(),
    ).toEqual({
      permissions: JSON.stringify(["contacts.read", "contacts.merge"]),
    });
    expect(raw.query("SELECT scopes FROM oauth_grants").get()).toEqual({
      scopes: "contacts:read contacts:write contacts:delete contacts:merge",
    });
    // The hand-written root row is not a contacts.merge row.
    expect(
      raw
        .query("SELECT permission FROM group_delegations WHERE group_id = ?")
        .all(groups.handWritten),
    ).toEqual([{ permission: "contacts" }]);
  });

  it("is harmless to run twice", () => {
    const { raw } = existingBook();
    migrateBook(raw);
    const once = digests(raw);
    const receiptsOnce = receipts(raw);

    // The migrator never replays it (its receipt is stored) ...
    migrateBook(raw);
    expect(receipts(raw)).toBe(receiptsOnce);
    // ... and the statement itself deletes nothing the second time.
    run0052Again(raw);
    expect(digests(raw)).toEqual(once);
  });

  it("follows 0033 on a book from before the leaf catalog", () => {
    // 0033 turned a contacts delete flag into contacts.delete + merge and
    // copied both into the ceiling; 0052 takes merge back out.
    const raw = memory();
    applyMigrationRange(raw, 0, 32);
    raw.exec(
      `INSERT INTO groups(id, name, is_superuser) VALUES (1, 'Admins', 1), (2, 'Office', 0);
       INSERT INTO group_permissions(group_id, resource, can_view, can_add, can_change, can_delete)
       VALUES (2, 'contacts', 1, 1, 1, 1);`,
    );
    applyMigrationRange(raw, 33, BEFORE_0052);
    const ceilingOf = () =>
      (
        raw
          .query(
            "SELECT permission FROM group_delegations WHERE group_id = 2 ORDER BY permission",
          )
          .all() as { permission: string }[]
      ).map((r) => r.permission);
    expect(ceilingOf()).toContain("contacts.merge");

    applyMigrationRange(raw, INDEX_0052, INDEX_0052);

    expect(ceilingOf()).toEqual([
      "contacts.create",
      "contacts.delete",
      "contacts.read",
      "contacts.update",
    ]);
    expect(
      raw
        .query(
          "SELECT permission FROM group_grants WHERE group_id = 2 AND permission = 'contacts.merge'",
        )
        .all(),
    ).toEqual([{ permission: "contacts.merge" }]);
  });
});

describe("a fresh install", () => {
  it("seeds ceilings without contacts.merge or any sensitive leaf, and grants as before", () => {
    const raw = memory();
    migrateBook(raw);
    raw.exec("PRAGMA foreign_keys = ON");
    const db = bookOver(raw);
    seedGroups(db);

    const groups = raw
      .query("SELECT id, name, is_superuser FROM groups ORDER BY id")
      .all() as { id: number; name: string; is_superuser: number }[];
    expect(groups.map((g) => g.name)).toEqual([
      "Administrators",
      "Bookkeeper",
      "Data Entry",
      "Reviewer",
    ]);
    const leavesOf = (table: string, groupId: number) =>
      (
        raw
          .query(`SELECT permission FROM ${table} WHERE group_id = ?`)
          .all(groupId) as { permission: string }[]
      ).map((r) => r.permission);

    expect(
      raw
        .query(
          "SELECT COUNT(*) AS n FROM group_delegations WHERE permission = 'contacts.merge'",
        )
        .get(),
    ).toEqual({ n: 0 });
    for (const group of groups.filter((g) => !g.is_superuser)) {
      const grants = leavesOf("group_grants", group.id);
      const ceiling = leavesOf("group_delegations", group.id);
      // No seeded group grants merge; a superuser holds it without a grant.
      expect(grants, group.name).not.toContain("contacts.merge");
      for (const leaf of ceiling) {
        expect(grants, group.name).toContain(leaf);
        expect(isPermission(leaf)).toBe(true);
        expect(leafMeta(leaf as LeafPermission).sensitive, leaf).toBeFalsy();
      }
      // The ceiling is the grants minus settings and the sensitive leaves.
      expect(
        grants.filter((leaf) => !ceiling.includes(leaf)),
        group.name,
      ).toEqual(
        grants.filter(
          (leaf) =>
            leaf.startsWith("settings.") ||
            leafMeta(leaf as LeafPermission).sensitive,
        ),
      );
    }
  });
});
