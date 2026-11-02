import type { RequestEvent } from "@sveltejs/kit";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { expect, it, vi } from "vitest";
import type { LedgerDb } from "../ledger/types.js";
import { LocalBlobStore } from "../storage/blob-store.js";
import * as schema from "../db/schema.js";
import { grantGroup } from "../permissions/test-locals.js";
import { signFileToken } from "./file-links.js";
import { reset } from "../rate-limit.js";
import { GET, HEAD } from "../../../routes/api/mcp-files/[token]/+server.js";

const fixture = vi.hoisted(() => ({
  db: undefined as LedgerDb | undefined,
  store: undefined as LocalBlobStore | undefined,
  dbAccess: vi.fn(),
  fileStore: vi.fn(),
}));
vi.mock("$lib/server/db/client.js", () => ({
  get db() {
    fixture.dbAccess();
    if (!fixture.db) throw new Error("Only the fixture database is allowed");
    return fixture.db;
  },
}));
vi.mock("$lib/server/file-storage.js", () => ({
  fileStore: () => {
    fixture.fileStore();
    return fixture.store;
  },
}));

it("rejects HEAD without accessing the database or consuming the GET token", async () => {
  const sqlite = new Database(":memory:");
  const root = mkdtempSync(join(tmpdir(), "akaun-file-link-route-"));
  try {
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: "drizzle" });
    db.insert(schema.users)
      .values({
        id: 1,
        email: "reader@test",
        username: "reader",
        passwordHash: "unused",
      })
      .run();
    grantGroup(db, { name: "readers", userIds: [1], grants: ["records.read"] });
    db.insert(schema.ledgerRecords)
      .values({ id: 1, kind: 1, date: "2026-09-01", amount: 10 })
      .run();
    db.insert(schema.recordAttachments)
      .values({
        id: 1,
        recordId: 1,
        filename: "receipt.pdf",
        displayName: "receipt.pdf",
      })
      .run();
    fixture.db = db;
    fixture.store = new LocalBlobStore(root);
    const bytes = Buffer.from("%PDF-1.7 receipt");
    await fixture.store.put("receipt.pdf", bytes);
    const token = signFileToken({
      userId: 1,
      recordId: 1,
      attachmentId: 1,
      exp: Math.floor(Date.now() / 1000) + 120,
      jti: randomUUID(),
    });
    const event = (method: string) =>
      ({
        params: { token },
        request: new Request(`https://akaun.test/api/mcp-files/${token}`, {
          method,
        }),
      }) as RequestEvent<{ token: string }, "/api/mcp-files/[token]">;

    fixture.dbAccess.mockClear();
    fixture.fileStore.mockClear();
    const head = await HEAD(event("HEAD"));
    expect(head.status).toBe(405);
    expect(head.headers.get("Allow")).toBe("GET");
    expect(head.body).toBeNull();
    expect(fixture.dbAccess).not.toHaveBeenCalled();
    expect(fixture.fileStore).not.toHaveBeenCalled();
    expect(db.select().from(schema.mcpFileLinkUses).all()).toEqual([]);

    reset("mcp-file-download:1");
    const get = await GET(event("GET"));
    expect(get.status).toBe(200);
    expect(Buffer.from(await get.arrayBuffer())).toEqual(bytes);
    expect((await GET(event("GET"))).status).toBe(410);
  } finally {
    fixture.db = undefined;
    fixture.store = undefined;
    reset("mcp-file-download:1");
    sqlite.close();
    rmSync(root, { recursive: true, force: true });
  }
});
