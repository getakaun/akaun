import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Database } from "bun:sqlite";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { eq } from "drizzle-orm";
import type { Cookies, RequestEvent } from "@sveltejs/kit";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  auth,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import * as schema from "../db/schema.js";
import type { LedgerDb } from "../ledger/types.js";
import { EntityType } from "$lib/enums.js";
import { createSession } from "../auth.js";
import { isLegacyToken, patLocals } from "../tokens/pat.js";
import { can, resolveAccess } from "../permissions.js";
import { grantGroup, issueTestToken } from "../permissions/test-locals.js";
import { SCOPE_PERMISSIONS } from "$lib/permissions/oauth-scopes.js";
import { createRequestHandle } from "../request-hook.js";
import { handleMcpRequest } from "../mcp/http.js";
import { LocalBlobStore } from "../storage/blob-store.js";
import { requireView } from "../mcp/common.js";
import { allowedScopes } from "./scopes.js";
import { handleOAuthProtocol } from "./http.js";
import { isSameOriginRequest } from "../browser-origin.js";
import { oauthConfig, READ_SCOPES, type OAuthConfig } from "./config.js";
import {
  BROWSER_COOKIE,
  createOAuth,
  digest,
  opaque,
  parameters,
  type AkaunOAuth,
} from "./service.js";

let sqlite: Database;
let db: LedgerDb;
let oauth: AkaunOAuth;
const config: OAuthConfig = {
  issuer: "https://books.example.com",
  resource: "https://books.example.com/mcp",
};
const redirectUri = "https://client.example.com/callback";
let registered: ReturnType<AkaunOAuth["register"]>;
let verifier: string;
let browser: string;
let address: string;
const protocolClients: Client[] = [];

beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "drizzle" });
  sqlite.exec("PRAGMA foreign_keys = ON");
  db.insert(schema.users)
    .values([
      {
        id: 1,
        username: "admin",
        email: "admin@test",
        passwordHash: "unused",
      },
      {
        id: 2,
        username: "limited",
        email: "limited@test",
        passwordHash: "unused",
      },
    ])
    .run();
  grantGroup(db, { name: "admins", userIds: [1], grants: [], superuser: true });
  grantGroup(db, {
    name: "directory",
    userIds: [2],
    grants: ["contacts.read"],
  });
  oauth = createOAuth(db, config);
  registered = oauth.register({
    client_name: "Test MCP",
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: "none",
  });
  verifier = opaque();
  browser = opaque();
  address = opaque();
});
afterEach(async () => {
  await Promise.all(protocolClients.splice(0).map((c) => c.close()));
  sqlite.close();
});
/** A signed-in browser session for the user: what the consent page acts with. */
function actor(user = 1): App.Locals {
  const row = db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      username: schema.users.username,
      name: schema.users.name,
      role: schema.users.role,
    })
    .from(schema.users)
    .where(eq(schema.users.id, user))
    .get()!;
  return { user: row, ...resolveAccess(db, user) };
}
function params(overrides: Record<string, string> = {}) {
  return {
    client_id: registered.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "contacts:read",
    resource: config.resource,
    code_challenge: Buffer.from(digest(verifier), "hex").toString("base64url"),
    code_challenge_method: "S256",
    state: "opaque state value",
    ...overrides,
  };
}
async function code(scopes = ["contacts:read"], user = 1) {
  const id = oauth.begin(params({ scope: scopes.join(" ") }), browser);
  const redirect = new URL(
    await oauth.finish(id, browser, actor(user), scopes, true),
  );
  expect(redirect.origin).toBe("https://client.example.com");
  expect(redirect.searchParams.get("state")).toBe("opaque state value");
  return redirect.searchParams.get("code")!;
}
async function exchange(body: Record<string, string>) {
  return oauth.exchange(
    new Request(`${config.issuer}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }),
    { client_id: registered.client_id, resource: config.resource, ...body },
  );
}
async function tokens(
  scopes = ["contacts:read"],
  user = 1,
): Promise<OAuthTokens> {
  return (
    await exchange({
      grant_type: "authorization_code",
      code: await code(scopes, user),
      redirect_uri: redirectUri,
      code_verifier: verifier,
    })
  ).json();
}
function bearer(token: string) {
  return new Request(config.resource, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
}
function cookieJar() {
  const values = new Map<string, string>();
  const cookies: Cookies = {
    get: (name) => values.get(name),
    getAll: () => [...values].map(([name, value]) => ({ name, value })),
    set: (name, value) => {
      values.set(name, value);
    },
    delete: (name) => {
      values.delete(name);
    },
    serialize: (name, value, options) =>
      `${name}=${encodeURIComponent(value)}; Path=${options.path}; HttpOnly; SameSite=Lax${options.secure ? "; Secure" : ""}`,
  };
  return cookies;
}
async function throughHook(
  request: Request,
  cookies = cookieJar(),
  service: AkaunOAuth | null = oauth,
) {
  const handle = createRequestHandle(db, service, service ? config : null);
  const event = {
    request,
    url: new URL(request.url),
    cookies,
    getClientAddress: () => address,
    locals: { user: null, permissions: null },
  } as unknown as RequestEvent;
  try {
    return await handle({
      event,
      resolve: async (e) =>
        e.url.pathname === "/mcp"
          ? handleMcpRequest(
              e.request,
              // No tool here reads a file; the store is an empty folder.
              { db, locals: e.locals, store: new LocalBlobStore(tmpdir()) },
              config.issuer,
            )
          : new Response(JSON.stringify({ userId: e.locals.user?.id }), {
              headers: { "Content-Type": "application/json" },
            }),
    });
  } catch (e) {
    if (e && typeof e === "object" && "status" in e && "location" in e)
      return new Response(null, {
        status: Number(e.status),
        headers: { Location: String(e.location) },
      });
    throw e;
  }
}

// All fixtures are in-memory. Never import oauth/runtime or db/client here.
describe("OAuth authorization and persistence", () => {
  it("upgrades an older database without changing users or bookkeeping, and revokes old API tokens", () => {
    const folder = mkdtempSync(join(tmpdir(), "akaun-oauth-migrations-"));
    const oldRaw = new Database(":memory:");
    try {
      const journal = JSON.parse(
        readFileSync("drizzle/meta/_journal.json", "utf8"),
      ) as { entries: { tag: string }[] };
      // Everything before 0033, the migration that revokes old API tokens.
      journal.entries = journal.entries.slice(
        0,
        journal.entries.findIndex((entry) => entry.tag.startsWith("0033_")),
      );
      mkdirSync(join(folder, "meta"));
      writeFileSync(
        join(folder, "meta", "_journal.json"),
        JSON.stringify(journal),
      );
      for (const entry of journal.entries)
        copyFileSync(
          `drizzle/${entry.tag}.sql`,
          join(folder, `${entry.tag}.sql`),
        );
      const oldDb = drizzle(oldRaw, { schema });
      migrate(oldDb, { migrationsFolder: folder });
      oldDb
        .insert(schema.users)
        .values({
          id: 99,
          username: "preserved",
          email: "preserved@test",
          passwordHash: "unused",
          bearerToken: "akn_preserved",
        })
        .run();
      oldDb
        .insert(schema.contacts)
        .values({
          id: 99,
          entityType: EntityType.Business,
          legalName: "Preserved supplier",
          createdBy: 99,
        })
        .run();
      const before = oldDb.select().from(schema.users).all();
      migrate(oldDb, { migrationsFolder: "drizzle" });
      // Everything but the raw API token, which migration 0033 revokes: they
      // are replaced by hashed, fine-grained personal access tokens.
      expect(oldDb.select().from(schema.users).all()).toEqual(
        before.map((user) => ({ ...user, bearerToken: null })),
      );
      expect(oldDb.select().from(schema.contacts).all()[0].legalName).toBe(
        "Preserved supplier",
      );
      expect(isLegacyToken("Bearer akn_preserved")).toBe(false);
      expect(patLocals(oldDb, "Bearer akn_preserved")).toBeNull();
      expect(oldDb.select().from(schema.oauthTokens).all()).toHaveLength(0);
    } finally {
      oldRaw.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });
  it("requires a canonical configured HTTPS origin and allows explicit loopback", () => {
    expect(oauthConfig({})).toBeNull();
    expect(
      oauthConfig({ OAUTH_ENABLED: "true", ORIGIN: config.issuer }),
    ).toEqual(config);
    expect(
      oauthConfig({ OAUTH_ENABLED: "true", ORIGIN: "http://127.0.0.1:6969" })
        ?.resource,
    ).toBe("http://127.0.0.1:6969/mcp");
    for (const publicUrl of [
      "http://public.example.com",
      `${config.issuer}/prefix`,
      `${config.issuer}?q=x`,
      "https://user:pass@example.com",
    ]) {
      expect(() =>
        oauthConfig({ OAUTH_ENABLED: "true", PUBLIC_BASE_URL: publicUrl }),
      ).toThrow();
    }
    expect(() =>
      oauthConfig({
        OAUTH_ENABLED: "true",
        PUBLIC_BASE_URL: config.issuer,
        ORIGIN: "https://other.example.com",
      }),
    ).toThrow();
    expect(() =>
      oauthConfig({
        OAUTH_ENABLED: "true",
        ORIGIN: config.issuer,
        AUTH_ISSUER: "https://other.example.com",
      }),
    ).toThrow();
  });
  it("expires unused registrations across service restarts while preserving consent and grants", async () => {
    const active = await tokens();
    const pendingClient = oauth.register({ redirect_uris: [redirectUri] });
    const pendingId = oauth.begin(
      params({ client_id: pendingClient.client_id }),
      browser,
    );
    const unused = oauth.register({ redirect_uris: [redirectUri] });
    db.update(schema.oauthClients)
      .set({ createdAt: Date.now() - 2 * 86400_000 })
      .run();
    oauth = createOAuth(db, config);
    oauth.register({ redirect_uris: [redirectUri] });
    expect(
      db
        .select()
        .from(schema.oauthClients)
        .where(eq(schema.oauthClients.id, unused.client_id))
        .get(),
    ).toBeUndefined();
    expect(oauth.pending(pendingId, browser).params.client_id).toBe(
      pendingClient.client_id,
    );
    expect(
      await oauth.authenticate(bearer(active.access_token)),
    ).not.toBeNull();
    oauth.revokeUser(1);
    oauth.register({ redirect_uris: [redirectUri] });
    expect(
      db
        .select()
        .from(schema.oauthClients)
        .where(eq(schema.oauthClients.id, registered.client_id))
        .get(),
    ).toBeUndefined();
  });

  it("reclaims unused capacity without invalidating active grants or consent", async () => {
    const active = await tokens();
    const consentClient = oauth.register({ redirect_uris: [redirectUri] });
    const pendingId = oauth.begin(
      params({ client_id: consentClient.client_id }),
      browser,
    );
    const now = Date.now();
    for (let i = 0; i < 998; i++) {
      db.insert(schema.oauthClients)
        .values({
          id: `unused-${i}`,
          name: "unused",
          redirectUris: JSON.stringify([redirectUri]),
          createdAt: now - 10000 + i,
        })
        .run();
    }
    oauth = createOAuth(db, config);
    const fresh = oauth.register({ redirect_uris: [redirectUri] });
    expect(db.select().from(schema.oauthClients).all()).toHaveLength(1000);
    expect(
      db
        .select()
        .from(schema.oauthClients)
        .where(eq(schema.oauthClients.id, "unused-0"))
        .get(),
    ).toBeUndefined();
    expect(
      db
        .select()
        .from(schema.oauthClients)
        .where(eq(schema.oauthClients.id, fresh.client_id))
        .get(),
    ).toBeTruthy();
    expect(
      await oauth.authenticate(bearer(active.access_token)),
    ).not.toBeNull();
    expect(oauth.pending(pendingId, browser).params.client_id).toBe(
      consentClient.client_id,
    );
  });

  it("retains the cap when every client has a pending authorization", () => {
    const now = Date.now();
    for (let i = 0; i < 999; i++) {
      db.insert(schema.oauthClients)
        .values({
          id: `pending-${i}`,
          name: "pending",
          redirectUris: JSON.stringify([redirectUri]),
          createdAt: now,
        })
        .run();
      db.insert(schema.oauthPending)
        .values({
          idHash: `pending-${i}`,
          browserHash: "fixture",
          params: JSON.stringify({ client_id: `pending-${i}` }),
          expiresAt: now + 60000,
        })
        .run();
    }
    const id = oauth.begin(params(), browser);
    expect(() => oauth.register({ redirect_uris: [redirectUri] })).toThrow(
      "temporarily_unavailable",
    );
    expect(db.select().from(schema.oauthClients).all()).toHaveLength(1000);
    expect(oauth.pending(id, browser).params.client_id).toBe(
      registered.client_id,
    );
  });

  it("validates public client registration and rejects unsupported auth/redirects", () => {
    for (const body of [
      null,
      {},
      { redirect_uris: ["http://remote.example.com/cb"] },
      { redirect_uris: [`${redirectUri}#fragment`] },
      {
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "private_key_jwt",
      },
      { redirect_uris: [redirectUri], grant_types: ["password"] },
      { redirect_uris: [redirectUri], scope: "records:admin" },
    ]) {
      expect(() => oauth.register(body)).toThrow();
    }
    expect(
      oauth.register({ redirect_uris: ["http://127.0.0.1:5555/callback"] })
        .client_id,
    ).toMatch("aknc_");
  });
  it("authenticates confidential clients for code exchange, refresh and revocation", async () => {
    for (const method of ["client_secret_basic", "client_secret_post"]) {
      registered = oauth.register({
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: method,
      });
      const secret = registered.client_secret!;
      expect(secret).toBeTruthy();
      expect(
        JSON.stringify(db.select().from(schema.oauthClients).all()),
      ).not.toContain(secret);
      const request = (credential = secret) =>
        new Request(`${config.issuer}/oauth/token`, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            ...(method === "client_secret_basic"
              ? {
                  Authorization: `Basic ${Buffer.from(`${registered.client_id}:${credential}`).toString("base64")}`,
                }
              : {}),
          },
        });
      const body = (fields: Record<string, string>, credential = secret) => ({
        client_id: registered.client_id,
        resource: config.resource,
        ...(method === "client_secret_post"
          ? { client_secret: credential }
          : {}),
        ...fields,
      });
      const c = await code();
      const exchangeFields = {
        grant_type: "authorization_code",
        code: c,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      };
      await expect(
        oauth.exchange(
          request("wrong-secret"),
          body(exchangeFields, "wrong-secret"),
        ),
      ).rejects.toThrow();
      await expect(exchange(exchangeFields)).rejects.toThrow();
      const t: OAuthTokens = await (
        await oauth.exchange(request(), body(exchangeFields))
      ).json();
      expect(await oauth.authenticate(bearer(t.access_token))).not.toBeNull();
      const next: OAuthTokens = await (
        await oauth.exchange(
          request(),
          body({
            grant_type: "refresh_token",
            refresh_token: t.refresh_token!,
          }),
        )
      ).json();
      expect(next.refresh_token).not.toBe(t.refresh_token);
      if (method === "client_secret_basic")
        await expect(
          oauth.exchange(
            new Request(`${config.issuer}/oauth/token`, {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
            }),
            {
              client_id: registered.client_id,
              client_secret: secret,
              resource: config.resource,
              grant_type: "refresh_token",
              refresh_token: next.refresh_token!,
            },
          ),
        ).rejects.toThrow();
      oauth.revokeToken(body({ token: next.refresh_token! }), request());
      expect(await oauth.authenticate(bearer(next.access_token))).toBeNull();
    }
  });
  it("requires S256, exact redirect, correct resource and known scopes", () => {
    for (const overrides of <Record<string, string>[]>[
      { code_challenge_method: "plain" },
      { code_challenge: "" },
      { code_challenge_method: "" },
      { resource: config.issuer },
      { redirect_uri: `${redirectUri}/` },
      { scope: "records:admin" },
      { response_type: "token" },
      { client_id: "unknown" },
    ]) {
      expect(() => oauth.begin(params(overrides), browser)).toThrow();
    }
    expect(() =>
      parameters(new URLSearchParams("resource=a&resource=b")),
    ).toThrow();
  });
  it("asks for reads only when a client names no scope", () => {
    const withoutScope: Record<string, string> = params();
    delete withoutScope.scope;
    const id = oauth.begin(withoutScope, browser);
    expect(oauth.pending(id, browser).scopes).toEqual([...READ_SCOPES]);
  });
  it("bounds writes and deletes by their own scopes, ahead of superuser", async () => {
    const reads = (await oauth.authenticate(
      bearer((await tokens(["records:read"])).access_token),
    ))!;
    expect(reads.role?.isSuperuser).toBe(true);
    expect(can(reads, "records.create")).toBe(false);
    expect(can(reads, "records.adjust")).toBe(false);
    const writes = (await oauth.authenticate(
      bearer((await tokens(["records:read", "records:write"])).access_token),
    ))!;
    expect(can(writes, "records.create")).toBe(true);
    expect(can(writes, "records.update")).toBe(true);
    // Adjustments are never part of "change records": they need their own scope.
    expect(can(writes, "records.adjust")).toBe(false);
    expect(can(writes, "records.delete")).toBe(false);
    expect(can(writes, "contacts.create")).toBe(false);
    expect(can(writes, "users.manage")).toBe(false);
  });
  it("grants adjustments only through records:adjust", async () => {
    const adjust = (await oauth.authenticate(
      bearer(
        (await tokens(["records:read", "records:write", "records:adjust"]))
          .access_token,
      ),
    ))!;
    expect(can(adjust, "records.adjust")).toBe(true);
    expect(can(adjust, "records.create")).toBe(true);
  });
  it.each([
    [
      "records:correct-date",
      "records.correctDate",
      "records.correctReimbursementAmount",
    ],
    [
      "records:correct-reimbursement-amount",
      "records.correctReimbursementAmount",
      "records.correctDate",
    ],
  ] as const)(
    "grants only the correction named by %s",
    async (scope, permission, other) => {
      const ordinary = (await oauth.authenticate(
        bearer((await tokens(["records:read", "records:write"])).access_token),
      ))!;
      expect(can(ordinary, permission)).toBe(false);
      const token = await tokens(["records:read", "records:write", scope]);
      const auth = (await oauth.authenticate(bearer(token.access_token)))!;
      expect(can(auth, permission)).toBe(true);
      expect(can(auth, other)).toBe(false);
      db.update(schema.groups)
        .set({ isSuperuser: false })
        .where(eq(schema.groups.id, 1))
        .run();
      const groupId = grantGroup(db, {
        name: "corrections",
        userIds: [1],
        grants: ["records.read", "records.update", permission],
        delegations: ["records.read", "records.update"],
      });
      expect(allowedScopes(actor().role!)).not.toContain(scope);
      expect(
        can(
          (await oauth.authenticate(bearer(token.access_token)))!,
          permission,
        ),
      ).toBe(false);
      db.insert(schema.groupDelegations).values({ groupId, permission }).run();
      expect(
        can(
          (await oauth.authenticate(bearer(token.access_token)))!,
          permission,
        ),
      ).toBe(true);
      db.delete(schema.groupGrants)
        .where(eq(schema.groupGrants.permission, permission))
        .run();
      expect(
        can(
          (await oauth.authenticate(bearer(token.access_token)))!,
          permission,
        ),
      ).toBe(false);
    },
  );

  it("bounds an app by the user's delegation ceiling, at once", async () => {
    db.update(schema.groups)
      .set({ isSuperuser: false })
      .where(eq(schema.groups.id, 1))
      .run();
    grantGroup(db, {
      name: "keepers",
      userIds: [1],
      grants: ["contacts.read", "contacts.create"],
      delegations: ["contacts.read"],
    });
    const scope = ["contacts:read", "contacts:write"] as const;
    expect(allowedScopes(actor().role!)).toContain("contacts:read");
    expect(allowedScopes(actor().role!)).not.toContain("contacts:write");
    const id = oauth.begin(params({ scope: scope.join(" ") }), browser);
    await expect(
      oauth.finish(id, browser, actor(), [...scope], true),
    ).rejects.toThrow();
  });
  it("offers only the scopes the user may delegate", () => {
    const limited = actor(2).role!;
    const offered = allowedScopes(limited);
    expect(offered).toEqual(["contacts:read"]);
    for (const scope of offered)
      expect(
        SCOPE_PERMISSIONS[scope].some((leaf) => limited.delegable.has(leaf)),
      ).toBe(true);
    expect(offered.length).toBeLessThan(allowedScopes(actor(1).role!).length);
  });
  it("binds pending consent to the browser and consumes it once", async () => {
    const id = oauth.begin(params(), browser);
    expect(() => oauth.pending(id, opaque())).toThrow();
    await expect(
      oauth.finish(id, browser, actor(2), ["reports:read"], true),
    ).rejects.toThrow();
    expect(oauth.pending(id, browser).client.id).toBe(registered.client_id);
    await oauth.finish(id, browser, actor(2), ["contacts:read"], true);
    await expect(
      oauth.finish(id, browser, actor(2), ["contacts:read"], true),
    ).rejects.toThrow();
  });
  it("denial preserves state without issuing a grant or code", async () => {
    const id = oauth.begin(params(), browser);
    const redirect = new URL(
      await oauth.finish(id, browser, actor(), [], false),
    );
    expect(redirect.searchParams.get("error")).toBe("access_denied");
    expect(redirect.searchParams.get("state")).toBe("opaque state value");
    expect(db.select().from(schema.oauthGrants).all()).toHaveLength(0);
  });
  it("delegates code exchange/PKCE to the library and stores credential hashes", async () => {
    const t = await tokens();
    expect(t.access_token).toMatch("akno_");
    expect(t.refresh_token).toMatch("aknr_");
    expect(t.scope).toBe("contacts:read");
    expect(t.expires_in).toBeGreaterThan(850);
    const stored = JSON.stringify(db.select().from(schema.oauthTokens).all());
    expect(stored).not.toContain(t.access_token);
    expect(stored).not.toContain(t.refresh_token!);
    expect((await oauth.authenticate(bearer(t.access_token)))?.user?.id).toBe(
      1,
    );
    expect(await oauth.authenticate(bearer(t.refresh_token!))).toBeNull();
    // Recreating the service simulates a process restart without losing tokens.
    expect(
      (await createOAuth(db, config).authenticate(bearer(t.access_token)))
        ?.oauth?.clientId,
    ).toBe(registered.client_id);
    expect(
      await createOAuth(db, {
        ...config,
        issuer: "https://other.example.com",
      }).authenticate(bearer(t.access_token)),
    ).toBeNull();
  });
  it("rejects wrong verifiers and consumes codes after a failed PKCE attempt", async () => {
    const c = await code();
    await expect(
      exchange({
        grant_type: "authorization_code",
        code: c,
        code_verifier: opaque(),
        redirect_uri: redirectUri,
      }),
    ).rejects.toThrow();
    await expect(
      exchange({
        grant_type: "authorization_code",
        code: c,
        code_verifier: verifier,
        redirect_uri: redirectUri,
      }),
    ).rejects.toThrow();
  });
  it("rejects missing PKCE, wrong redirect, wrong client and expired codes", async () => {
    for (const change of <Record<string, string>[]>[
      { code_verifier: "" },
      { redirect_uri: `${redirectUri}?different=1` },
      { client_id: "unknown" },
    ]) {
      const c = await code();
      await expect(
        exchange({
          grant_type: "authorization_code",
          code: c,
          code_verifier: verifier,
          redirect_uri: redirectUri,
          ...change,
        }),
      ).rejects.toThrow();
    }
    const c = await code();
    db.update(schema.oauthCodes)
      .set({ expiresAt: Date.now() - 1000 })
      .run();
    await expect(
      exchange({
        grant_type: "authorization_code",
        code: c,
        code_verifier: verifier,
        redirect_uri: redirectUri,
      }),
    ).rejects.toThrow();
  });
  it("atomically permits only one concurrent code exchange", async () => {
    const c = await code();
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        exchange({
          grant_type: "authorization_code",
          code: c,
          code_verifier: verifier,
          redirect_uri: redirectUri,
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(db.select().from(schema.oauthTokens).all()).toHaveLength(1);
  });
  it("rotates refresh tokens and revokes the family after reuse", async () => {
    const t = await tokens();
    const next: OAuthTokens = await (
      await exchange({
        grant_type: "refresh_token",
        refresh_token: t.refresh_token!,
      })
    ).json();
    expect(next.refresh_token).not.toBe(t.refresh_token);
    expect(await oauth.authenticate(bearer(next.access_token))).not.toBeNull();
    await expect(
      exchange({
        grant_type: "refresh_token",
        refresh_token: t.refresh_token!,
      }),
    ).rejects.toThrow();
    expect(await oauth.authenticate(bearer(next.access_token))).toBeNull();
    expect(await oauth.authenticate(bearer(t.access_token))).toBeNull();
  });
  it("does not let another client/resource revoke a token family", async () => {
    const t = await tokens();
    const other = oauth.register({
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
    });
    await expect(
      exchange({
        grant_type: "refresh_token",
        refresh_token: t.refresh_token!,
        client_id: other.client_id,
      }),
    ).rejects.toThrow();
    await expect(
      exchange({
        grant_type: "refresh_token",
        refresh_token: t.refresh_token!,
        resource: "https://other.example.com/mcp",
      }),
    ).rejects.toThrow();
    oauth.revokeToken({ client_id: other.client_id, token: t.refresh_token! });
    expect(await oauth.authenticate(bearer(t.access_token))).not.toBeNull();
  });
  it("allows scope narrowing on refresh but rejects widening", async () => {
    const t = await tokens(["contacts:read", "records:read"]);
    const next: OAuthTokens = await (
      await exchange({
        grant_type: "refresh_token",
        refresh_token: t.refresh_token!,
        scope: "contacts:read",
      })
    ).json();
    expect(next.scope).toBe("contacts:read");
    await expect(
      exchange({
        grant_type: "refresh_token",
        refresh_token: next.refresh_token!,
        scope: "contacts:read reports:read",
      }),
    ).rejects.toThrow();
  });
  it("rejects expired access/refresh tokens, revoked grants and deleted users", async () => {
    const t = await tokens();
    db.update(schema.oauthTokens)
      .set({
        accessExpiresAt: Date.now() - 1000,
        refreshExpiresAt: Date.now() - 1000,
      })
      .run();
    expect(await oauth.authenticate(bearer(t.access_token))).toBeNull();
    await expect(
      exchange({
        grant_type: "refresh_token",
        refresh_token: t.refresh_token!,
      }),
    ).rejects.toThrow();
    const second = await tokens();
    oauth.revokeToken({
      client_id: registered.client_id,
      token: second.access_token,
    });
    expect(await oauth.authenticate(bearer(second.access_token))).toBeNull();
    const third = await tokens();
    db.delete(schema.users).where(eq(schema.users.id, 1)).run();
    expect(await oauth.authenticate(bearer(third.access_token))).toBeNull();
    expect(db.select().from(schema.oauthTokens).all()).toHaveLength(0);
  });
  it("limits grant revocation to its owner and revokes on credential reset", async () => {
    const t = await tokens();
    const g = oauth.listGrants(1)[0];
    oauth.revokeGrant(g.id, 2);
    expect(await oauth.authenticate(bearer(t.access_token))).not.toBeNull();
    expect(oauth.listGrants(2)).toHaveLength(0);
    oauth.revokeUser(1);
    expect(await oauth.authenticate(bearer(t.access_token))).toBeNull();
  });
});

describe("OAuth hook and MCP scope integration", () => {
  it("serves discovery publicly and challenges MCP without trusting cookies or Host", async () => {
    const jar = cookieJar();
    jar.set("session", createSession(db, 1), { path: "/" });
    const challenge = await throughHook(new Request(config.resource), jar);
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get("WWW-Authenticate")).toContain(
      'resource_metadata="https://books.example.com/.well-known/oauth-protected-resource/mcp"',
    );
    for (const path of [
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-authorization-server",
    ]) {
      const res = await throughHook(
        new Request(`https://attacker.example.com${path}`),
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toContain(config.issuer);
      expect(res.headers.get("location")).toBeNull();
    }
    expect(
      (
        await throughHook(
          new Request(
            `${config.issuer}/.well-known/oauth-authorization-server`,
          ),
          jar,
          null,
        )
      ).status,
    ).toBe(404);
  });
  it("validates pending transactions before sending the user to login", async () => {
    const jar = cookieJar();
    const start = await throughHook(
      new Request(
        `${config.issuer}/oauth/authorize?${new URLSearchParams(params())}`,
      ),
      jar,
    );
    expect(start.status).toBe(302);
    // A fresh browser receives only the response header, not cookie API state
    // inside the request hook. Replay that header on the redirect's next hop.
    const header = start.headers.get("set-cookie")!;
    expect(header).toContain(`${BROWSER_COOKIE}=`);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Secure");
    expect(jar.get(BROWSER_COOKIE)).toBeUndefined();
    const nextJar = cookieJar();
    nextJar.set(BROWSER_COOKIE, header.split(";")[0].split("=")[1], {
      path: "/",
    });
    const location = start.headers.get("location")!;
    const login = await throughHook(
      new Request(`${config.issuer}${location}`),
      nextJar,
    );
    expect(login.status).toBe(302);
    expect(login.headers.get("location")).toMatch("/login?oauth=");
    expect(
      (
        await throughHook(
          new Request(`${config.issuer}/oauth/authorize?transaction=bogus`),
          jar,
        )
      ).status,
    ).toBe(400);
    nextJar.set("session", createSession(db, 1), { path: "/" });
    const consent = await throughHook(
      new Request(`${config.issuer}${location}`),
      nextJar,
    );
    expect(consent.status).toBe(200);
    expect(consent.headers.get("Cache-Control")).toBe("no-store");
    expect(consent.headers.get("Referrer-Policy")).toBe("same-origin");
    const loginPage = await throughHook(new Request(`${config.issuer}/login`));
    expect(loginPage.headers.get("Referrer-Policy")).toBe("same-origin");
  });
  it("sends a browser-binding cookie usable on HTTP localhost", async () => {
    const localConfig = {
      issuer: "http://localhost:5173",
      resource: "http://localhost:5173/mcp",
    };
    const localOAuth = createOAuth(db, localConfig);
    const response = await handleOAuthProtocol(
      new Request(
        `${localConfig.issuer}/oauth/authorize?${new URLSearchParams(params({ resource: localConfig.resource }))}`,
      ),
      cookieJar(),
      address,
      localOAuth,
      localConfig,
    );
    expect(response!.status).toBe(302);
    const header = response!.headers.get("set-cookie")!;
    expect(header).toContain(`${BROWSER_COOKIE}=`);
    expect(header).not.toContain("Secure");
    const browserValue = header.split(";")[0].split("=")[1];
    const id = new URL(
      response!.headers.get("location")!,
      localConfig.issuer,
    ).searchParams.get("transaction")!;
    expect(localOAuth.pending(id, browserValue).params.resource).toBe(
      localConfig.resource,
    );
  });

  it("protects browser login, consent and revocation from cross-site form submissions", async () => {
    const jar = cookieJar();
    jar.set("session", createSession(db, 1), { path: "/" });
    const id = oauth.begin(params(), browser);
    jar.set(BROWSER_COOKIE, browser, { path: "/" });
    for (const path of [
      "/login",
      "/profile?/revokeApp",
      `/oauth/authorize?transaction=${id}`,
    ]) {
      for (const origin of ["https://attacker.example.com", "null", ""]) {
        const res = await throughHook(
          new Request(`${config.issuer}${path}`, {
            method: "POST",
            headers: origin ? { Origin: origin } : {},
            body: "decision=approve",
          }),
          jar,
        );
        expect(res.status).toBe(403);
      }
    }
    const sameSiteHeaders: HeadersInit[] = [
      { Origin: config.issuer },
      { Referer: `${config.issuer}/login?oauth=fixture` },
      { Origin: "null", "Sec-Fetch-Site": "same-origin" },
      { "Sec-Fetch-Site": "same-origin" },
    ];
    for (const headers of sameSiteHeaders) {
      const response = await throughHook(
        new Request(`${config.issuer}/login`, {
          method: "POST",
          headers,
          body: "username=fixture",
        }),
      );
      expect(response.status).toBe(200);
    }
    expect(oauth.pending(id, browser)).toBeDefined();
  });
  it("checks browser fetch metadata without allowing foreign origins to override consent CSRF", async () => {
    const id = oauth.begin(params(), browser);
    const jar = cookieJar();
    jar.set(BROWSER_COOKIE, browser, { path: "/" });
    jar.set("session", createSession(db, 1), { path: "/" });
    const headersToReject: HeadersInit[] = [
      { Origin: "null", "Sec-Fetch-Site": "cross-site" },
      { Origin: "null", "Sec-Fetch-Site": "same-site" },
      { Origin: "null", "Sec-Fetch-Site": "none" },
      {
        Origin: "https://attacker.example.com",
        "Sec-Fetch-Site": "same-origin",
      },
      {
        Origin: "null",
        Referer: "https://attacker.example.com/",
        "Sec-Fetch-Site": "same-origin",
      },
      { Origin: "invalid", "Sec-Fetch-Site": "same-origin" },
    ];
    for (const headers of headersToReject) {
      const request = new Request(
        `${config.issuer}/oauth/authorize?transaction=${id}`,
        { method: "POST", headers },
      );
      expect(isSameOriginRequest(request, config.issuer)).toBe(false);
      expect((await throughHook(request, jar)).status).toBe(403);
    }
    const request = new Request(
      `${config.issuer}/oauth/authorize?transaction=${id}`,
      {
        method: "POST",
        headers: { Origin: "null", "Sec-Fetch-Site": "same-origin" },
      },
    );
    expect(isSameOriginRequest(request, config.issuer)).toBe(true);
    expect((await throughHook(request, jar)).status).toBe(200);
    expect(oauth.pending(id, browser)).toBeDefined();
  });

  it("revokes through the public protocol endpoint without redirecting to login", async () => {
    const t = await tokens();
    const response = await throughHook(
      new Request(`${config.issuer}/oauth/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: registered.client_id,
          token: t.refresh_token!,
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await oauth.authenticate(bearer(t.access_token))).toBeNull();
  });
  it("revokes a family when two refresh requests race", async () => {
    const t = await tokens();
    const outcomes = await Promise.allSettled(
      [1, 2].map(() =>
        exchange({
          grant_type: "refresh_token",
          refresh_token: t.refresh_token!,
        }),
      ),
    );
    expect(
      outcomes.filter((o) => o.status === "fulfilled").length,
    ).toBeLessThanOrEqual(1);
    expect(oauth.listGrants(1)).toHaveLength(0);
  });
  it("returns an insufficient_scope challenge for direct out-of-scope calls", async () => {
    const t = await tokens();
    const response = await throughHook(
      new Request(config.resource, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${t.access_token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "get_contact_balance", arguments: { contactId: 1 } },
        }),
      }),
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("WWW-Authenticate")).toContain(
      'error="insufficient_scope"',
    );
    expect(response.headers.get("WWW-Authenticate")).toContain("records:read");
  });
  it("asks for records:read before an attached file is read", async () => {
    const t = await tokens();
    const response = await throughHook(
      new Request(config.resource, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${t.access_token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "get_attachment",
            arguments: { recordId: 1, attachmentId: 1 },
          },
        }),
      }),
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("WWW-Authenticate")).toContain(
      'error="insufficient_scope"',
    );
    expect(response.headers.get("WWW-Authenticate")).toContain("records:read");
  });
  it("handles protocol form POSTs without ambient login and refuses ambiguous/oversized input", async () => {
    const c = await code();
    const res = await throughHook(
      new Request(`${config.issuer}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: registered.client_id,
          resource: config.resource,
          code: c,
          redirect_uri: redirectUri,
          code_verifier: verifier,
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).access_token).toMatch("akno_");
    const bad = await throughHook(
      new Request(`${config.issuer}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "resource=a&resource=b",
      }),
    );
    expect(bad.status).toBe(400);
    expect(bad.headers.get("location")).toBeNull();
    const big = await throughHook(
      new Request(`${config.issuer}/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: " ".repeat(17000),
      }),
    );
    expect(big.status).toBe(413);
  });
  it("rejects MCP OAuth tokens in REST even with an authenticated browser cookie", async () => {
    const t = await tokens();
    const jar = cookieJar();
    jar.set("session", createSession(db, 1), { path: "/" });
    const rest = await throughHook(
      new Request(`${config.issuer}/api/users`, {
        headers: { Authorization: `Bearer ${t.access_token}` },
      }),
      jar,
    );
    expect(rest.status).toBe(401);
    for (const scheme of ["bearer", "BEARER", "Bearer\t"]) {
      expect(
        (
          await throughHook(
            new Request(`${config.issuer}/api/users`, {
              headers: { Authorization: `${scheme} ${t.access_token}` },
            }),
            jar,
          )
        ).status,
      ).toBe(401);
    }

    expect(
      (
        await throughHook(
          new Request(`${config.issuer}/api/users`, {
            headers: {
              Authorization: `Bearer ${issueTestToken(db, 2, ["contacts.read"])}`,
            },
          }),
        )
      ).status,
    ).toBe(200);
    // A revoked API token from before personal access tokens is told what replaced it.
    const legacy = await throughHook(
      new Request(`${config.issuer}/api/users`, {
        headers: { Authorization: `Bearer akn_${"ab".repeat(24)}` },
      }),
    );
    expect(legacy.status).toBe(401);
    expect(await legacy.text()).toContain("personal access tokens");
    expect(
      (await throughHook(new Request(`${config.issuer}/api/users`), jar))
        .status,
    ).toBe(200);
  });
  it("enforces scopes ahead of superuser permissions and checks current RBAC", async () => {
    const t = await tokens();
    const locals = (await oauth.authenticate(bearer(t.access_token)))!;
    expect(locals.role?.isSuperuser).toBe(true);
    expect(can(locals, "contacts.read")).toBe(true);
    expect(can(locals, "records.read")).toBe(false);
    expect(() =>
      requireView({ locals }, ["contacts.read", "records.read"]),
    ).toThrow();
    const limited = await tokens(["contacts:read"], 2);
    db.delete(schema.groupGrants)
      .where(eq(schema.groupGrants.permission, "contacts.read"))
      .run();
    expect(
      can(
        (await oauth.authenticate(bearer(limited.access_token)))!,
        "contacts.read",
      ),
    ).toBe(false);
  });
  it("links and refreshes public/confidential clients through the official SDK, then filters capabilities", async () => {
    for (const method of [
      "none",
      "client_secret_basic",
      "client_secret_post",
    ]) {
      let information: OAuthClientInformationMixed | undefined;
      let saved: OAuthTokens | undefined;
      let savedVerifier = "";
      let authorizeUrl: URL | undefined;
      const provider: OAuthClientProvider = {
        redirectUrl: redirectUri,
        clientMetadata: {
          client_name: "Official SDK",
          redirect_uris: [redirectUri],
          token_endpoint_auth_method: method,
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        },
        state: () => "sdk-state",
        clientInformation: () => information,
        saveClientInformation: (v) => {
          information = v;
        },
        tokens: () => saved,
        saveTokens: (v) => {
          saved = v;
        },
        saveCodeVerifier: (v) => {
          savedVerifier = v;
        },
        codeVerifier: () => savedVerifier,
        redirectToAuthorization: (v) => {
          authorizeUrl = v;
        },
      };
      const fetchFn = async (url: string | URL, init?: RequestInit) =>
        throughHook(new Request(url, init));
      expect(
        await auth(provider, {
          serverUrl: config.resource,
          scope: "accounts:read",
          fetchFn,
        }),
      ).toBe("REDIRECT");
      expect(authorizeUrl).toBeDefined();
      const jar = cookieJar();
      const start = await throughHook(new Request(authorizeUrl!), jar);
      const browserCookie = start.headers.get("set-cookie")!;
      jar.set(BROWSER_COOKIE, browserCookie.split(";")[0].split("=")[1], {
        path: "/",
      });
      const id = new URL(
        start.headers.get("location")!,
        config.issuer,
      ).searchParams.get("transaction")!;
      const callback = new URL(
        await oauth.finish(
          id,
          jar.get(BROWSER_COOKIE)!,
          actor(),
          ["accounts:read"],
          true,
        ),
      );
      expect(callback.searchParams.get("state")).toBe("sdk-state");
      expect(
        await auth(provider, {
          serverUrl: config.resource,
          authorizationCode: callback.searchParams.get("code")!,
          fetchFn,
        }),
      ).toBe("AUTHORIZED");
      const oldRefresh = saved!.refresh_token;
      expect(
        await auth(provider, { serverUrl: config.resource, fetchFn }),
      ).toBe("AUTHORIZED");
      expect(saved!.refresh_token).not.toBe(oldRefresh);
      const c = new Client({ name: "oauth-fixture", version: "1" });
      protocolClients.push(c);
      await c.connect(
        new StreamableHTTPClientTransport(new URL(config.resource), {
          fetch: fetchFn,
          requestInit: {
            headers: { Authorization: `Bearer ${saved!.access_token}` },
          },
        }),
      );
      // get_audit_history is listed to anyone who can read something; it
      // checks the item's own resource when it runs.
      expect((await c.listTools()).tools.map((tool) => tool.name)).toEqual([
        "list_accounts",
        "get_audit_history",
      ]);
      expect((await c.listPrompts()).prompts).toEqual([]);
      expect((await c.listResources()).resources.map((r) => r.uri)).toEqual([
        "akaun://context",
      ]);
      const context = await c.readResource({ uri: "akaun://context" });
      const content = context.contents[0];
      if (!("text" in content)) throw new Error("Expected context text");
      const flags = JSON.parse(content.text).permissions;
      expect(flags.accounts).toBe(true);
      expect(flags.records).toBe(false);
      await expect(
        c.callTool({ name: "list_records", arguments: {} }),
      ).rejects.toThrow();
      const result = await c.callTool({ name: "list_accounts", arguments: {} });
      expect(result.isError).not.toBe(true);
      oauth.revokeUser(1);
      expect((await throughHook(bearer(saved!.access_token))).status).toBe(401);
    }
  });
});
