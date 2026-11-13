import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrationRange } from "./auto-upgrade.js";
import { migrateBook } from "./migrate-book.js";
import { releaseBook } from "../application/__fixtures__/release-book.js";

/**
 * Migration 0051 adds `mcp_idempotency` and `record_attachments.sha256`.
 * Everything runs on `:memory:` books built from `drizzle/`; nothing here
 * imports `db/client.ts`.
 */

/** The last migration before 0051 (0-based index into `drizzle/`). */
const BEFORE_0051 = 50;

const opened: Database[] = [];
function memory(): Database {
  const raw = new Database(":memory:");
  opened.push(raw);
  return raw;
}
afterEach(() => {
  for (const raw of opened.splice(0)) raw.close();
});

type ColumnInfo = {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
};
const columns = (raw: Database, table: string) =>
  raw.query(`PRAGMA table_info(${table})`).all() as ColumnInfo[];
const names = (raw: Database, type: "table" | "index") =>
  (
    raw
      .query("SELECT name FROM sqlite_master WHERE type = ? ORDER BY name")
      .all(type) as { name: string }[]
  ).map((row) => row.name);

function seedUser(raw: Database, id = 1) {
  raw
    .query(
      "INSERT INTO users (id, email, username, password_hash) VALUES (?, ?, ?, 'x')",
    )
    .run(id, `u${id}@test`, `user${id}`);
}
const idempotency = (
  raw: Database,
  userId: number,
  binding: string,
  key: string,
) =>
  raw
    .query(
      `INSERT INTO mcp_idempotency (user_id, binding, key, tool, input_hash, result)
       VALUES (?, ?, ?, 'change_records', 'h', '{}')`,
    )
    .run(userId, binding, key);

describe("migration 0051", () => {
  it("creates mcp_idempotency with its columns, foreign key, unique key and created_at index", () => {
    const raw = memory();
    migrateBook(raw);

    expect(names(raw, "table")).toContain("mcp_idempotency");
    const byName = Object.fromEntries(
      columns(raw, "mcp_idempotency").map((c) => [c.name, c]),
    );
    expect(Object.keys(byName)).toEqual([
      "id",
      "user_id",
      "binding",
      "key",
      "tool",
      "input_hash",
      "result",
      "created_at",
    ]);
    expect(byName.id).toMatchObject({ type: "INTEGER", pk: 1 });
    for (const name of [
      "user_id",
      "binding",
      "key",
      "tool",
      "input_hash",
      "result",
      "created_at",
    ]) {
      expect(byName[name].notnull, name).toBe(1);
    }
    expect(byName.user_id.type).toBe("INTEGER");
    for (const name of ["binding", "key", "tool", "input_hash", "result"])
      expect(byName[name].type, name).toBe("TEXT");
    // The same type and default as `users.created_at` and `audit_log.created_at`.
    expect(byName.created_at).toMatchObject({
      type: "TEXT",
      dflt_value: "datetime('now')",
    });

    const foreignKeys = raw
      .query("PRAGMA foreign_key_list(mcp_idempotency)")
      .all() as {
      from: string;
      table: string;
      to: string;
      on_delete: string;
    }[];
    expect(foreignKeys).toMatchObject([
      { from: "user_id", table: "users", to: "id", on_delete: "CASCADE" },
    ]);

    const indexes = raw.query("PRAGMA index_list(mcp_idempotency)").all() as {
      name: string;
      unique: number;
    }[];
    const unique = indexes.filter((i) => i.unique === 1);
    expect(unique).toHaveLength(1);
    expect(
      (
        raw.query(`PRAGMA index_info(${unique[0].name})`).all() as {
          name: string;
        }[]
      ).map((c) => c.name),
    ).toEqual(["user_id", "binding", "key"]);
    const createdAt = indexes.filter((i) => i.unique === 0);
    expect(createdAt).toHaveLength(1);
    expect(
      (
        raw.query(`PRAGMA index_info(${createdAt[0].name})`).all() as {
          name: string;
        }[]
      ).map((c) => c.name),
    ).toEqual(["created_at"]);
    expect(names(raw, "index")).toEqual(
      expect.arrayContaining([
        "mcp_idempotency_key_idx",
        "mcp_idempotency_created_at_idx",
      ]),
    );
  });

  it("enforces one row per (user, binding, key) and cascades with the user", () => {
    const raw = memory();
    migrateBook(raw);
    raw.exec("PRAGMA foreign_keys = ON");
    seedUser(raw, 1);
    seedUser(raw, 2);

    idempotency(raw, 1, "pat:7", "retry-1");
    expect(() => idempotency(raw, 1, "pat:7", "retry-1")).toThrow(/UNIQUE/i);
    // Another credential, another key, or another user is a different row.
    idempotency(raw, 1, "oauth:abc", "retry-1");
    idempotency(raw, 1, "pat:7", "retry-2");
    idempotency(raw, 2, "pat:7", "retry-1");

    const stamp = raw
      .query("SELECT created_at FROM mcp_idempotency WHERE id = 1")
      .get() as { created_at: string };
    expect(stamp.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    raw.query("DELETE FROM users WHERE id = 1").run();
    expect(raw.query("SELECT user_id FROM mcp_idempotency").all()).toEqual([
      { user_id: 2 },
    ]);
  });

  it("adds a nullable text record_attachments.sha256", () => {
    const raw = memory();
    migrateBook(raw);
    const sha = columns(raw, "record_attachments").find(
      (c) => c.name === "sha256",
    );
    expect(sha).toMatchObject({
      type: "TEXT",
      notnull: 0,
      dflt_value: null,
      pk: 0,
    });
  });

  it("upgrades a book at 0050 without touching old attachment rows, and a second run is a no-op", () => {
    const raw = memory();
    applyMigrationRange(raw, 0, BEFORE_0051);
    expect(names(raw, "table")).not.toContain("mcp_idempotency");
    expect(columns(raw, "record_attachments").map((c) => c.name)).not.toContain(
      "sha256",
    );

    raw.exec("PRAGMA foreign_keys = ON");
    seedUser(raw);
    raw.exec(
      `INSERT INTO ledger_records (id, kind, date, amount) VALUES (1, 1, '2026-01-02', 10);
       INSERT INTO record_attachments (record_id, filename, display_name)
       VALUES (1, 'records/2026/01/old_receipt.pdf', 'old_receipt.pdf');`,
    );

    migrateBook(raw);

    // No backfill: the old row stays as it was, with the new column NULL.
    expect(
      raw
        .query(
          "SELECT record_id, filename, display_name, sha256 FROM record_attachments",
        )
        .all(),
    ).toEqual([
      {
        record_id: 1,
        filename: "records/2026/01/old_receipt.pdf",
        display_name: "old_receipt.pdf",
        sha256: null,
      },
    ]);
    expect(names(raw, "table")).toContain("mcp_idempotency");
    expect(raw.query("PRAGMA foreign_key_check").all()).toEqual([]);

    const applied = () =>
      (
        raw.query("SELECT COUNT(*) AS n FROM __drizzle_migrations").get() as {
          n: number;
        }
      ).n;
    const count = applied();
    expect(count).toBeGreaterThan(BEFORE_0051 + 1);
    migrateBook(raw);
    expect(applied()).toBe(count);
  });

  it("still builds the release-book fixture", () => {
    const book = releaseBook();
    try {
      expect(names(book.raw, "table")).toContain("mcp_idempotency");
      expect(
        columns(book.raw, "record_attachments").map((c) => c.name),
      ).toContain("sha256");
      expect(book.raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      book.raw.close();
    }
  });
});
