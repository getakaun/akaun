import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "./db/schema.js";
import { auditLog } from "./db/schema.js";
import { getAuditTrail, recordAudit, REDACTED } from "./audit.js";
import { runInAuditScope, scopeFromLocals } from "./audit-context.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

let dir: string;
let raw: Database;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "akaun-audit-"));
  raw = new Database(join(dir, "test.db"));
  raw.exec("PRAGMA foreign_keys = ON;");
  db = drizzle(raw, { schema });
  migrate(db, { migrationsFolder: "drizzle" });
  raw.exec(`
    INSERT INTO users(id, email, username, password_hash, name) VALUES (1, 'a@t', 'alice', 'x', 'Alice');
    INSERT INTO personal_access_tokens(id, user_id, name, token_hash, last_four, permissions, created_at)
      VALUES (5, 1, 'CI', 'h', 'abcd', '[]', 0);
    INSERT INTO oauth_clients(id, name, redirect_uris, created_at) VALUES ('c1', 'Claude', '[]', 0);
    INSERT INTO oauth_grants(id, user_id, client_id, issuer, resource, scopes, created_at, expires_at)
      VALUES ('g1', 1, 'c1', 'i', 'r', 'books', 0, 0);
    INSERT INTO contacts(id, entity_type, legal_name) VALUES (3, 2, 'Acme Sdn Bhd');
  `);
});

afterEach(() => {
  raw.close();
  rmSync(dir, { recursive: true, force: true });
});

const rows = () => db.select().from(auditLog).all();

describe("recordAudit", () => {
  it("records a write with no scope as the system", () => {
    recordAudit(db, {
      recordType: "contact",
      recordId: 3,
      userId: 1,
      action: "create",
    });
    expect(rows()[0]).toMatchObject({
      recordId: "3",
      recordLabel: "Acme Sdn Bhd",
      actorName: "Alice",
      via: "system",
      requestId: null,
      credentialLabel: null,
    });
  });

  it("names the token and the app, and keeps the names after they change", () => {
    const pat = scopeFromLocals(
      { credential: { kind: "pat", tokenId: 5 } },
      "PATCH /api/contacts/3",
    );
    runInAuditScope(pat, () =>
      recordAudit(db, {
        recordType: "contact",
        recordId: 3,
        userId: 1,
        action: "update",
        changes: [{ field: "email", before: null, after: "a@b" }],
      }),
    );
    const app = scopeFromLocals(
      { credential: { kind: "oauth", grantId: "g1", clientId: "c1" } },
      "mcp:update_contact",
    );
    runInAuditScope(app, () => {
      for (const after of ["x", "y"])
        recordAudit(db, {
          recordType: "contact",
          recordId: 3,
          userId: 1,
          action: "update",
          changes: [{ field: "phone", before: null, after }],
        });
    });

    raw.exec(
      "UPDATE personal_access_tokens SET name = 'renamed'; UPDATE oauth_clients SET name = 'Other'; DELETE FROM contacts; DELETE FROM users",
    );
    const [second, first, viaToken] = getAuditTrail(db, "contact", "3");
    expect(viaToken).toMatchObject({
      via: "pat",
      credentialLabel: "CI",
      userName: "Alice",
      operation: "PATCH /api/contacts/3",
    });
    expect(first).toMatchObject({
      via: "oauth",
      credentialLabel: "Claude",
      operation: "mcp:update_contact",
    });
    const all = rows();
    expect(all[1].requestId).toBe(app.requestId);
    expect(all[2].requestId).toBe(all[1].requestId);
    expect(all[0].requestId).not.toBe(all[1].requestId);
    expect(all[1]).toMatchObject({ clientId: "c1", credentialId: "g1" });
    expect(second.userId).toBeNull();
  });

  it("never stores a secret, at the top level or nested", () => {
    recordAudit(db, {
      recordType: "llm_provider",
      recordId: "p1",
      userId: 1,
      action: "update",
      changes: [
        { field: "apiKey", before: "sk-old", after: "sk-new" },
        { field: "model", before: "a", after: "b" },
        {
          field: "autoImport",
          before: { enabled: true, apiKey: "secret" },
          after: { enabled: true, apiKey: "" },
        },
      ],
    });
    const [entry] = getAuditTrail(db, "llm_provider", "p1");
    expect(entry.changes).toEqual([
      { field: "apiKey", before: REDACTED, after: REDACTED },
      { field: "model", before: "a", after: "b" },
      {
        field: "autoImport",
        before: { enabled: true, apiKey: REDACTED },
        after: { enabled: true, apiKey: "" },
      },
    ]);
    expect(JSON.stringify(rows())).not.toContain("sk-");
  });

  it("names a deleted record from the snapshot its delete carries", () => {
    recordAudit(db, {
      recordType: "account",
      recordId: 99,
      userId: 1,
      action: "delete",
      changes: [
        { field: "code", before: 4000, after: null },
        { field: "name", before: "Sales", after: null },
      ],
    });
    expect(rows()[0].recordLabel).toBe("Sales");
  });

  it("skips an update that changed nothing", () => {
    recordAudit(db, {
      recordType: "contact",
      recordId: 3,
      userId: 1,
      action: "update",
      changes: [],
    });
    expect(rows()).toEqual([]);
  });
});

describe("the audit feed", () => {
  // Imported here so the spec above stays about recordAudit alone.
  async function feed() {
    return await import("./audit-feed.js");
  }

  function write(
    scope: ReturnType<typeof scopeFromLocals> | null,
    recordType: "contact" | "user" | "settings",
    recordId: number | string,
  ) {
    const run = () =>
      recordAudit(db, { recordType, recordId, userId: 1, action: "create" });
    if (scope) runInAuditScope(scope, run);
    else run();
  }

  it("filters by channel, token, app, type and request, newest first", async () => {
    const { listAuditLog } = await feed();
    const pat = scopeFromLocals(
      { credential: { kind: "pat", tokenId: 5 } },
      null,
    );
    const app = scopeFromLocals(
      { credential: { kind: "oauth", grantId: "g1", clientId: "c1" } },
      null,
    );
    write(scopeFromLocals({}, null), "contact", 3);
    write(pat, "contact", 3);
    write(app, "user", 1);
    write(app, "settings", "company");
    write(null, "contact", 3);

    const ids = (filters: Parameters<typeof listAuditLog>[1]) =>
      listAuditLog(db, filters).entries.map((e) => e.id);
    expect(ids({})).toEqual([5, 4, 3, 2, 1]);
    expect(ids({ via: "agent" })).toEqual([4, 3, 2]);
    expect(ids({ via: "system" })).toEqual([5]);
    expect(ids({ credentialId: "5" })).toEqual([2]);
    expect(ids({ clientId: "c1" })).toEqual([4, 3]);
    expect(ids({ recordTypes: ["user", "settings"] })).toEqual([4, 3]);
    expect(ids({ requestId: app.requestId })).toEqual([4, 3]);
    expect(ids({ recordTypes: ["contact"], recordId: "3" })).toEqual([5, 2, 1]);
  });

  it("pages back by id and returns only newer entries after one", async () => {
    const { listAuditLog } = await feed();
    for (let i = 0; i < 5; i += 1) write(null, "contact", 3);
    const first = listAuditLog(db, {}, { limit: 2 });
    expect(first.entries.map((e) => e.id)).toEqual([5, 4]);
    expect(first.nextCursor).toBe(4);
    const second = listAuditLog(db, {}, { limit: 2, before: 4 });
    expect(second.entries.map((e) => e.id)).toEqual([3, 2]);
    const last = listAuditLog(db, {}, { limit: 2, before: 2 });
    expect(last).toMatchObject({ nextCursor: null });
    expect(listAuditLog(db, {}, { after: 3 }).entries.map((e) => e.id)).toEqual(
      [5, 4],
    );
  });

  it("recovers a burst across every page without including older history", async () => {
    const { listAuditLog } = await feed();
    write(null, "contact", 3);
    for (let i = 0; i < 125; i += 1) write(null, "contact", 3);
    const ids: number[] = [];
    let before: number | undefined;
    do {
      const page = listAuditLog(db, {}, { after: 1, before });
      ids.push(...page.entries.map((entry) => entry.id));
      before = page.nextCursor ?? undefined;
    } while (before !== undefined);
    expect(ids).toEqual(Array.from({ length: 125 }, (_, i) => 126 - i));
  });

  it("filters by date as instants, and reads filters from an address", async () => {
    const { listAuditLog, parseAuditFilters } = await feed();
    write(null, "contact", 3);
    raw.exec("UPDATE audit_log SET created_at = '2026-01-10 16:30:00'");
    // 00:30 on the 11th in UTC+8 is still the 10th in UTC.
    const filters = parseAuditFilters(
      new URLSearchParams(
        "from=2026-01-10T16:00:00.000Z&to=2026-01-11T15:59:59.999Z&via=bogus&type=nope&type=contact",
      ),
    );
    expect(filters).toEqual({
      from: "2026-01-10T16:00:00.000Z",
      to: "2026-01-11T15:59:59.999Z",
      recordTypes: ["contact"],
    });
    expect(listAuditLog(db, filters).entries).toHaveLength(1);
    expect(
      listAuditLog(db, { from: "2026-01-11T00:00:00.000Z" }).entries,
    ).toHaveLength(0);
  });

  it("links to records that still exist, and not to deleted ones", async () => {
    const { listAuditLog } = await feed();
    write(null, "contact", 3);
    recordAudit(db, {
      recordType: "contact",
      recordId: 404,
      userId: 1,
      action: "delete",
      changes: [{ field: "legalName", before: "Gone Ltd", after: null }],
    });
    write(null, "settings", "company");
    const [settings, gone, contact] = listAuditLog(db, {}).entries;
    expect(contact.href).toBe("/contacts/3");
    expect(gone).toMatchObject({ href: null, recordLabel: "Gone Ltd" });
    expect(settings).toMatchObject({
      href: "/settings",
      recordLabel: "Company details",
    });
  });

  it("uses the latest stored labels even when older names sort last", async () => {
    const { auditFilterOptions } = await feed();
    for (const name of ["Zoe", "Alice"]) {
      raw.exec(`UPDATE users SET name = '${name}';
        UPDATE personal_access_tokens SET name = '${name}';
        UPDATE oauth_clients SET name = '${name}';`);
      write(
        scopeFromLocals({ credential: { kind: "pat", tokenId: 5 } }, null),
        "contact",
        3,
      );
      write(
        scopeFromLocals(
          { credential: { kind: "oauth", grantId: "g1", clientId: "c1" } },
          null,
        ),
        "contact",
        3,
      );
    }
    raw.exec(
      "DELETE FROM personal_access_tokens; DELETE FROM oauth_grants; DELETE FROM oauth_clients",
    );
    expect(auditFilterOptions(db)).toEqual({
      actors: [{ userId: 1, name: "Alice" }],
      tokens: [{ credentialId: "5", label: "Alice" }],
      apps: [{ clientId: "c1", label: "Alice" }],
    });
  });

  it("names the people, tokens and apps that appear, even once deleted", async () => {
    const { auditFilterOptions } = await feed();
    write(
      scopeFromLocals({ credential: { kind: "pat", tokenId: 5 } }, null),
      "contact",
      3,
    );
    write(
      scopeFromLocals(
        { credential: { kind: "oauth", grantId: "g1", clientId: "c1" } },
        null,
      ),
      "contact",
      3,
    );
    raw.exec(
      "DELETE FROM personal_access_tokens; DELETE FROM oauth_grants; DELETE FROM oauth_clients",
    );
    expect(auditFilterOptions(db)).toEqual({
      actors: [{ userId: 1, name: "Alice" }],
      tokens: [{ credentialId: "5", label: "CI" }],
      apps: [{ clientId: "c1", label: "Claude" }],
    });
  });
});

describe("administration is audited", () => {
  it("records token create, rename, regenerate and revoke without the secret", async () => {
    const { createToken, updateToken, regenerateToken, revokeAllTokens } =
      await import("./tokens/manage.js");
    const { resolveAccess } = await import("./permissions.js");
    raw.exec(`
      INSERT INTO users(id, email, username, password_hash) VALUES (2, 'b@t', 'admin', 'x');
      INSERT INTO groups(id, name, description, is_superuser) VALUES (9, 'Admins', '', 1);
      INSERT INTO user_groups(user_id, group_id) VALUES (1, 9);
    `);
    const owner = resolveAccess(db, 1).role!;
    const created = createToken(db, {
      ownerId: 1,
      createdBy: 1,
      owner,
      input: { name: "Agent", permissions: ["records.read"], expiresOn: null },
    } as Parameters<typeof createToken>[1]);
    if (!created.ok) throw new Error(created.reason);
    const id = created.value.view.id;
    updateToken(db, {
      ownerId: 1,
      tokenId: id,
      owner,
      name: "Agent 2",
      permissions: ["records.read"],
    });
    const again = regenerateToken(db, { ownerId: 1, tokenId: id, owner });
    if (!again.ok) throw new Error(again.reason);
    revokeAllTokens(db, 1, 2);

    const trail = getAuditTrail(db, "access_token", id).reverse();
    expect(trail.map((e) => [e.action, e.userId])).toEqual([
      ["create", 1],
      ["update", 1],
      ["update", 1],
      ["delete", 2],
    ]);
    expect(trail[1].changes).toEqual([
      { field: "name", before: "Agent", after: "Agent 2" },
    ]);
    expect(trail[2].changes?.map((c) => c.field)).toEqual(["lastFour"]);
    const stored = JSON.stringify(rows());
    expect(stored).not.toContain(created.value.token);
    expect(stored).not.toContain(again.value.token);
  });

  it("records a group's and a user's grants as they were and became", async () => {
    const { saveGroupAccess, saveUserGrants } =
      await import("./admin/access.js");
    raw.exec(
      "INSERT INTO groups(id, name, description, is_superuser) VALUES (7, 'Clerks', '', 0)",
    );
    const saved = saveGroupAccess(
      db,
      7,
      {
        grants: ["records.read", "records.create"],
        delegations: ["records.read"],
      },
      1,
    );
    expect(saved.ok).toBe(true);
    saveUserGrants(db, 1, ["audit.read"], 1);
    const [group] = getAuditTrail(db, "group", 7);
    expect(group.changes).toEqual([
      {
        field: "grants",
        before: [],
        after: ["records.read", "records.create"],
      },
      { field: "delegations", before: [], after: ["records.read"] },
    ]);
    const [user] = getAuditTrail(db, "user", 1);
    expect(user.changes).toEqual([
      { field: "grants", before: [], after: ["audit.read"] },
    ]);
  });
});

describe("settings are audited by section", () => {
  it("writes one entry per section changed, and none for an unchanged save", async () => {
    const { auditSettings, readSettings } = await import("./settings-audit.js");
    const { setSetting } = await import("./settings.js");
    const keys = ["company.name", "pdf.themeColor", "display.currencyCode"];
    const before = readSettings(db, keys);
    setSetting(db, "company.name", "Acme");
    setSetting(db, "pdf.themeColor", "#112233");
    auditSettings(db, 1, before, readSettings(db, keys));
    auditSettings(db, 1, readSettings(db, keys), readSettings(db, keys));
    expect(getAuditTrail(db, "settings", "company")[0].changes).toEqual([
      { field: "company.name", before: null, after: "Acme" },
    ]);
    expect(getAuditTrail(db, "settings", "pdf")).toHaveLength(1);
    expect(getAuditTrail(db, "settings", "general")).toHaveLength(0);
  });

  it("logs a provider's new key only as changed", async () => {
    const { auditProviders, providerSnapshot } =
      await import("./settings-audit.js");
    const { insertProvider, updateProvider } =
      await import("./llmProviders.js");
    let before = providerSnapshot(db);
    const provider = insertProvider(db, {
      type: "openrouter",
      name: "Router",
      apiKey: "sk-first",
      model: "m",
    });
    auditProviders(db, 1, before, providerSnapshot(db));
    before = providerSnapshot(db);
    updateProvider(db, provider.id, { apiKey: "sk-second" });
    auditProviders(db, 1, before, providerSnapshot(db));
    const [update, create] = getAuditTrail(db, "llm_provider", provider.id);
    expect(create.action).toBe("create");
    expect(update.changes).toEqual([
      { field: "apiKey", before: REDACTED, after: REDACTED },
    ]);
    expect(JSON.stringify(rows())).not.toContain("sk-");
  });
});
