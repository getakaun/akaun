import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrationRange } from "./auto-upgrade.js";
import { LEGACY_MAP } from "../permissions/legacy-map.js";

/**
 * Migration 0033 moves every group's and user's permissions from the
 * view/add/change/delete grid into permission strings, seeds each group's
 * delegation ceiling, gives existing groups `settings.read`, and revokes the
 * old raw API tokens. Each test builds a database under `os.tmpdir()` from
 * the migrations up to 0032, fills it, and only then applies 0033.
 */

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function databaseAt0032(): Database {
  const directory = mkdtempSync(join(tmpdir(), "akaun-migration-0033-"));
  directories.push(directory);
  const db = new Database(join(directory, "akaun.db"));
  applyMigrationRange(db, 0, 32);
  return db;
}

const FLAGS = ["view", "add", "change", "delete"] as const;
const COLUMN = {
  view: "can_view",
  add: "can_add",
  change: "can_change",
  delete: "can_delete",
};

function grantsOf(db: Database, groupId: number): string[] {
  return db
    .query(
      "SELECT permission FROM group_grants WHERE group_id = ? ORDER BY permission",
    )
    .all(groupId)
    .map((row) => (row as { permission: string }).permission);
}

describe("migration 0033", () => {
  it("maps every old flag exactly as LEGACY_MAP does", () => {
    const db = databaseAt0032();
    const resources = [
      ...new Set(Object.keys(LEGACY_MAP).map((k) => k.split(".")[0])),
    ];
    let groupId = 0;
    const expected = new Map<number, string[]>();
    for (const resource of resources)
      for (const flag of FLAGS) {
        groupId += 1;
        db.query(
          "INSERT INTO groups(id, name, is_superuser) VALUES (?, ?, 0)",
        ).run(groupId, `${resource}-${flag}`);
        db.query(
          `INSERT INTO group_permissions(group_id, resource, ${COLUMN[flag]}) VALUES (?, ?, 1)`,
        ).run(groupId, resource);
        expected.set(groupId, [...(LEGACY_MAP[`${resource}.${flag}`] ?? [])]);
      }
    applyMigrationRange(db, 33, 33);
    for (const [id, leaves] of expected)
      expect(grantsOf(db, id)).toEqual(
        [...new Set([...leaves, "settings.read"])].sort(),
      );
  });

  it("converts a real group, skips superusers, seeds ceilings and revokes tokens", () => {
    const db = databaseAt0032();
    db.query(
      "INSERT INTO users(id, email, username, password_hash, bearer_token) VALUES (1, 'a@t', 'a', 'x', 'akn_secret')",
    ).run();
    db.query(
      "INSERT INTO groups(id, name, is_superuser) VALUES (1, 'Admins', 1), (2, 'Keepers', 0)",
    ).run();
    db.query(
      `INSERT INTO group_permissions(group_id, resource, can_view, can_add, can_change, can_delete)
       VALUES (1, 'records', 1, 1, 1, 1),
              (2, 'expenses', 1, 1, 0, 0),
              (2, 'income', 1, 0, 1, 0),
              (2, 'invoices', 1, 0, 1, 0),
              (2, 'journal', 0, 1, 0, 0),
              (2, 'reports', 1, 1, 1, 1)`,
    ).run();
    db.query(
      "INSERT INTO user_permissions(user_id, resource, can_view, can_add, can_change, can_delete) VALUES (1, 'contacts', 1, 0, 0, 1)",
    ).run();

    applyMigrationRange(db, 33, 33);

    expect(grantsOf(db, 1)).toEqual([]);
    expect(grantsOf(db, 2)).toEqual([
      "invoices.issue",
      "invoices.read",
      "invoices.update",
      "invoices.void",
      "records.adjust",
      "records.create",
      "records.read",
      "records.update",
      "reports.read",
      "settings.read",
    ]);
    const delegations = db
      .query(
        "SELECT permission FROM group_delegations WHERE group_id = 2 ORDER BY permission",
      )
      .all()
      .map((row) => (row as { permission: string }).permission);
    // The sensitive Adjustments is not delegable by default, nor is settings.
    expect(delegations).not.toContain("records.adjust");
    expect(delegations).not.toContain("settings.read");
    expect(delegations).toContain("invoices.issue");
    const userGrants = db
      .query(
        "SELECT permission FROM user_grants WHERE user_id = 1 ORDER BY permission",
      )
      .all()
      .map((row) => (row as { permission: string }).permission);
    expect(userGrants).toEqual([
      "contacts.delete",
      "contacts.merge",
      "contacts.read",
    ]);
    expect(
      (
        db.query("SELECT bearer_token FROM users WHERE id = 1").get() as {
          bearer_token: string | null;
        }
      ).bearer_token,
    ).toBeNull();
    // The temporary mapping table is gone.
    expect(
      db
        .query(
          "SELECT name FROM sqlite_temp_master WHERE name = 'permission_map'",
        )
        .get(),
    ).toBeNull();
  });
});
