import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import * as schema from "../db/schema.js";
import { applyMigrationRange } from "../db/auto-upgrade.js";
import { migrateBook } from "../db/migrate-book.js";
import type { LedgerDb } from "../ledger/types.js";
import { resolveAccess } from "../permissions.js";
import { patLocals } from "../tokens/pat.js";
import { createToken } from "../tokens/manage.js";
import { readGroupAccess, saveGroupAccess } from "../admin/access.js";
import { scopeAvailability, allowedScopes } from "../oauth/scopes.js";
import {
  createOAuth,
  digest,
  opaque,
  OAuthFailure,
  type AkaunOAuth,
} from "../oauth/service.js";
import { grantGroup, issueTestToken } from "./test-locals.js";

/**
 * `contacts.merge` is sensitive, and migration 0052 took it out of every
 * stored ceiling. What that means for a member's session, their personal
 * access tokens and their connected apps — before and after the migration,
 * and after an administrator allows it again. Every book is `:memory:`;
 * nothing imports `db/client.ts`.
 */

const BEFORE_0052 = 51;
const ADMIN = 1;
const MEMBER = 2;
const CONTACTS = [
  "contacts.read",
  "contacts.create",
  "contacts.update",
  "contacts.delete",
  "contacts.merge",
];

const opened: Database[] = [];
afterEach(() => {
  for (const raw of opened.splice(0)) raw.close();
});

/** A book at 0051 whose Keepers group may still hand merge on. */
function bookAt0051() {
  const raw = new Database(":memory:");
  opened.push(raw);
  applyMigrationRange(raw, 0, BEFORE_0052);
  raw.exec("PRAGMA foreign_keys = ON");
  const db = drizzle(raw, { schema }) as LedgerDb;
  db.insert(schema.users)
    .values(
      [ADMIN, MEMBER].map((id) => ({
        id,
        username: `user${id}`,
        email: `u${id}@test`,
        passwordHash: "unused",
      })),
    )
    .run();
  grantGroup(db, {
    name: "Administrators",
    userIds: [ADMIN],
    grants: [],
    superuser: true,
  });
  const keepers = grantGroup(db, {
    name: "Keepers",
    userIds: [MEMBER],
    grants: CONTACTS,
  });
  return { raw, db, keepers };
}

const viaToken = (db: LedgerDb, token: string) =>
  patLocals(db, `Bearer ${token}`)!.permissions!;
const session = (db: LedgerDb, userId: number) =>
  resolveAccess(db, userId).permissions;

describe("contacts.merge for tokens after migration 0052", () => {
  it("drops from a member's existing token, but not from their session", () => {
    const { raw, db } = bookAt0051();
    const token = issueTestToken(db, MEMBER, CONTACTS, "cleanup");
    expect(viaToken(db, token).has("contacts.merge")).toBe(true);

    migrateBook(raw);

    const effective = viaToken(db, token);
    expect(effective.has("contacts.merge")).toBe(false);
    // Nothing else the token carries is lost.
    for (const leaf of CONTACTS.filter((l) => l !== "contacts.merge"))
      expect(effective.has(leaf as never), leaf).toBe(true);
    // The member still merges in the app.
    expect(session(db, MEMBER).has("contacts.merge")).toBe(true);
    // The token row is unchanged: the ceiling, taken on every request, is
    // what stops it.
    expect(
      JSON.parse(
        db
          .select({ p: schema.personalAccessTokens.permissions })
          .from(schema.personalAccessTokens)
          .get()!.p,
      ),
    ).toEqual(CONTACTS);
  });

  it("refuses a new member token that asks for it", () => {
    const { raw, db } = bookAt0051();
    migrateBook(raw);
    const created = createToken(db, {
      ownerId: MEMBER,
      createdBy: MEMBER,
      owner: resolveAccess(db, MEMBER).role,
      input: {
        name: "merge",
        permissions: ["contacts.merge"],
        expiresOn: null,
      },
    });
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.code).toBe("FORBIDDEN");
  });

  it("leaves a superuser's tokens alone: a superuser has no ceiling", () => {
    const { raw, db } = bookAt0051();
    const token = issueTestToken(db, ADMIN, ["contacts.merge"], "admin");
    migrateBook(raw);
    expect(viaToken(db, token).has("contacts.merge")).toBe(true);
    expect(resolveAccess(db, ADMIN).role.delegable.has("contacts.merge")).toBe(
      true,
    );
  });

  it("comes back when an administrator adds it to the group's ceiling", () => {
    const { raw, db, keepers } = bookAt0051();
    const old = issueTestToken(db, MEMBER, CONTACTS, "old");
    migrateBook(raw);
    const access = readGroupAccess(db, keepers);
    expect(access.delegations).not.toContain("contacts.merge");
    expect(access.grants).toContain("contacts.merge");

    // What Users & Groups saves when "Merge" is switched on under "Members
    // may hand on to tokens & apps".
    const saved = saveGroupAccess(
      db,
      keepers,
      {
        grants: access.grants,
        delegations: [...access.delegations, "contacts.merge"],
      },
      ADMIN,
    );
    expect(saved.ok).toBe(true);
    if (saved.ok) expect(saved.value.delegations).toContain("contacts.merge");

    const fresh = issueTestToken(db, MEMBER, ["contacts.merge"], "new");
    expect(viaToken(db, fresh).has("contacts.merge")).toBe(true);
    // A token that listed it before the migration carries it again too.
    expect(viaToken(db, old).has("contacts.merge")).toBe(true);
    // The change is audited as the administrator's.
    const audit = db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.recordType, "group"))
      .all();
    expect(audit.some((row) => row.userId === ADMIN)).toBe(true);
  });
});

describe("the consent screen once the ceiling lacks contacts.merge", () => {
  const config = {
    issuer: "https://books.example.com",
    resource: "https://books.example.com/mcp",
  };
  const redirectUri = "https://client.example.com/callback";

  function flow(db: LedgerDb) {
    const oauth: AkaunOAuth = createOAuth(db, config);
    const client = oauth.register({
      client_name: "Test MCP",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
    });
    const verifier = opaque();
    const browser = opaque();
    const actor = (): App.Locals => {
      const user = db
        .select({
          id: schema.users.id,
          email: schema.users.email,
          username: schema.users.username,
          name: schema.users.name,
          role: schema.users.role,
        })
        .from(schema.users)
        .where(eq(schema.users.id, MEMBER))
        .get()!;
      return { user, ...resolveAccess(db, MEMBER) };
    };
    const begin = (scope: string) =>
      oauth.begin(
        {
          client_id: client.client_id,
          redirect_uri: redirectUri,
          response_type: "code",
          scope,
          resource: config.resource,
          code_challenge: Buffer.from(digest(verifier), "hex").toString(
            "base64url",
          ),
          code_challenge_method: "S256",
        },
        browser,
      );
    const finish = (id: string, selected: string[]) =>
      oauth.finish(id, browser, actor(), selected, true);
    async function accessToken(id: string, selected: string[]) {
      const code = new URL(await finish(id, selected)).searchParams.get(
        "code",
      )!;
      const response = await oauth.exchange(
        new Request(`${config.issuer}/oauth/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        }),
        {
          client_id: client.client_id,
          resource: config.resource,
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          code_verifier: verifier,
        },
      );
      return ((await response.json()) as { access_token: string }).access_token;
    }
    const appPermissions = async (token: string) =>
      (await oauth.authenticate(
        new Request(config.resource, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        }),
      ))!.permissions!;
    return { oauth, actor, begin, finish, accessToken, appPermissions };
  }

  it("shows the merge scope as blocked by the administrator and connects without it", async () => {
    const { raw, db } = bookAt0051();
    migrateBook(raw);
    const { actor, begin, accessToken, appPermissions } = flow(db);

    const merge = scopeAvailability(actor().role!).find(
      (entry) => entry.scope === "contacts:merge",
    );
    expect(merge).toEqual({
      scope: "contacts:merge",
      allowed: false,
      reason: "ceiling",
    });
    expect(allowedScopes(actor().role!)).toContain("contacts:delete");

    // An app may still ask for it; the request is accepted, the scope is
    // simply not offered, and consent to the rest goes through.
    const id = begin(
      "contacts:read contacts:write contacts:delete contacts:merge",
    );
    const token = await accessToken(id, [
      "contacts:read",
      "contacts:write",
      "contacts:delete",
    ]);
    const permissions = await appPermissions(token);
    expect(permissions.has("contacts.delete")).toBe(true);
    expect(permissions.has("contacts.merge")).toBe(false);
  });

  it("refuses a consent form that ticks it anyway", async () => {
    const { raw, db } = bookAt0051();
    migrateBook(raw);
    const { begin, finish } = flow(db);
    const id = begin("contacts:read contacts:merge");
    await expect(
      finish(id, ["contacts:read", "contacts:merge"]),
    ).rejects.toBeInstanceOf(OAuthFailure);
  });

  it("stops an app connected before the migration from merging, without an error", async () => {
    const { raw, db } = bookAt0051();
    const { begin, accessToken, appPermissions } = flow(db);
    const id = begin("contacts:read contacts:merge");
    const token = await accessToken(id, ["contacts:read", "contacts:merge"]);
    expect((await appPermissions(token)).has("contacts.merge")).toBe(true);

    migrateBook(raw);

    const after = await appPermissions(token);
    expect(after.has("contacts.merge")).toBe(false);
    expect(after.has("contacts.read")).toBe(true);
    // The stored grant still names the scope.
    expect(
      db
        .select({ s: schema.oauthGrants.scopes })
        .from(schema.oauthGrants)
        .get()!.s,
    ).toBe("contacts:read contacts:merge");
  });
});
