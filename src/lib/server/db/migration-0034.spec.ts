import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrationRange } from "./auto-upgrade.js";

/**
 * Migration 0034 recreates `audit_log` empty with the channel columns. The
 * entries before it carry no channel and were discarded on purpose.
 */

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function databaseAt0033(): Database {
  const directory = mkdtempSync(join(tmpdir(), "akaun-migration-0034-"));
  directories.push(directory);
  const db = new Database(join(directory, "akaun.db"));
  applyMigrationRange(db, 0, 33);
  return db;
}

describe("migration 0034", () => {
  it("drops the old entries and adds the channel columns and indexes", () => {
    const db = databaseAt0033();
    db.query(
      "INSERT INTO users(id, email, username, password_hash) VALUES (1, 'a@t', 'a', 'x')",
    ).run();
    db.query(
      "INSERT INTO audit_log(record_type, record_id, user_id, action) VALUES ('record', 1, 1, 'create')",
    ).run();

    applyMigrationRange(db, 34, 34);

    expect(db.query("SELECT count(*) AS n FROM audit_log").get()).toEqual({
      n: 0,
    });
    const columns = (
      db.query("PRAGMA table_info(audit_log)").all() as {
        name: string;
        type: string;
        notnull: number;
      }[]
    ).map((c) => [c.name, c.type, c.notnull]);
    expect(columns).toEqual(
      expect.arrayContaining([
        ["record_id", "TEXT", 1],
        ["via", "TEXT", 1],
        ["record_label", "TEXT", 0],
        ["actor_name", "TEXT", 0],
        ["credential_id", "TEXT", 0],
        ["client_id", "TEXT", 0],
        ["credential_label", "TEXT", 0],
        ["request_id", "TEXT", 0],
        ["operation", "TEXT", 0],
      ]),
    );
    const indexes = (
      db.query("PRAGMA index_list(audit_log)").all() as { name: string }[]
    ).map((i) => i.name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        "audit_log_record_idx",
        "audit_log_user_idx",
        "audit_log_via_idx",
        "audit_log_client_idx",
        "audit_log_request_idx",
      ]),
    );
    // Deleting a user keeps their entries and clears only the link.
    db.query(
      "INSERT INTO audit_log(record_type, record_id, user_id, actor_name, via, action) VALUES ('record', '1', 1, 'a', 'session', 'create')",
    ).run();
    db.exec("PRAGMA foreign_keys = ON");
    db.query("DELETE FROM users WHERE id = 1").run();
    expect(db.query("SELECT user_id, actor_name FROM audit_log").get()).toEqual(
      { user_id: null, actor_name: "a" },
    );
  });
});
