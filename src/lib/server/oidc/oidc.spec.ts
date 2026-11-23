import { afterEach, describe, expect, it } from "vitest";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { eq } from "drizzle-orm";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { Cookies } from "@sveltejs/kit";
import * as schema from "../db/schema.js";
import { createSession, getSessionUser, SESSION_MAX_AGE } from "../auth.js";
import { findIdentity, receiveLogout, signIn } from "./accounts.js";
import {
  beginBrowserFlow,
  completeBrowserFlow,
  continueLink,
} from "./browser.js";
import {
  CALLBACK_PATH,
  localReturnTo,
  LOGOUT_EVENT,
  verifyLogout,
} from "./protocol.js";
import {
  clientSecret,
  readAuthentication,
  saveAuthentication,
  scopes,
} from "./settings.js";
import { authorizationPath } from "../oauth/http.js";
import {
  BROWSER_COOKIE,
  createOAuth,
  digest,
  opaque,
} from "../oauth/service.js";
import { resolveAccess } from "../permissions.js";

const issuer = "https://provider.example.test/application/o/akaun/";
const origin = "https://akaun.example.test";
const clientId = "akaun";
const secret = "private-client-credential";
const claims = {
  preferred_username: "sso-user",
  email: "sso-user@example.test",
  email_verified: true,
  groups: ["Accounting"],
};
const originalEnv = {
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
  DATABASE_PATH: process.env.DATABASE_PATH,
  ORIGIN: process.env.ORIGIN,
};

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function fixture() {
  const folder = mkdtempSync(join(tmpdir(), "akaun-oidc-key-"));
  const env = {
    PUBLIC_BASE_URL: origin,
    DATABASE_PATH: join(folder, "fixture.db"),
  };
  const raw = new Database(":memory:");
  const db = drizzle(raw, { schema });
  migrate(db, { migrationsFolder: "drizzle" });
  raw.exec("PRAGMA foreign_keys = ON");
  db.insert(schema.users)
    .values([
      {
        id: 1,
        username: "admin",
        email: "admin@example.test",
        passwordHash: "local",
      },
      {
        id: 2,
        username: "local",
        email: "local@example.test",
        passwordHash: "local",
      },
    ])
    .run();
  db.insert(schema.groups)
    .values([
      { id: 1, name: "Administrators", isSuperuser: true },
      { id: 2, name: "Readers" },
      { id: 3, name: "Accounting" },
      { id: 4, name: "Manual" },
    ])
    .run();
  db.insert(schema.userGroups).values({ userId: 1, groupId: 1 }).run();
  const administrator = createSession(db, 1);
  const local = createSession(db, 2);
  const settings = {
    ...readAuthentication(db).stored,
    oidcEnabled: true,
    authority: issuer,
    clientId,
    jitEnabled: true,
    defaultGroupId: 2,
    groupMappings: [{ externalGroup: "Accounting", groupId: 3 }],
  };
  saveAuthentication(db, settings, "", secret, 1, administrator, env);
  function close() {
    raw.close();
    rmSync(folder, { force: true, recursive: true });
  }
  return { db, close, administrator, local, settings, env };
}

function sessionCookies(session?: string): Cookies {
  const values = new Map<string, string>();
  if (session) values.set("session", session);
  return {
    get: (name: string) => values.get(name),
    getAll: () => Array.from(values, ([name, value]) => ({ name, value })),
    serialize: (name: string, value: string) => `${name}=${value}`,
    set: (name: string, value: string) => {
      values.set(name, value);
    },
    delete: (name: string) => {
      values.delete(name);
    },
  };
}

describe("OpenFarm OIDC behavior", () => {
  it("round-trips authorization code with S256, provisions from the signed ID token, and validates back-channel logout", async () => {
    const { db, close, local, env } = fixture();
    process.env.PUBLIC_BASE_URL = process.env.ORIGIN = origin;
    process.env.DATABASE_PATH = env.DATABASE_PATH;
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    let nonce = "";
    let challenge = "";
    let subject = "provider-user";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : input);
        expect(url.origin).toBe(new URL(issuer).origin);
        if (url.href === issuer + ".well-known/openid-configuration") {
          return Response.json({
            issuer,
            authorization_endpoint: issuer + "authorize",
            token_endpoint: issuer + "token",
            jwks_uri: issuer + "jwks",
            code_challenge_methods_supported: ["S256"],
            id_token_signing_alg_values_supported: ["RS256"],
          });
        }
        if (url.href === issuer + "jwks")
          return Response.json({
            keys: [{ ...jwk, kid: "provider", alg: "RS256" }],
          });
        expect(url.href).toBe(issuer + "token");
        const body = new URLSearchParams(init?.body as URLSearchParams);
        expect(body.get("code")).toBe("authorization-code");
        expect(body.get("redirect_uri")).toBe(origin + CALLBACK_PATH);
        expect(body.get("client_secret")).toBe(secret);
        const verifier = body.get("code_verifier")!;
        const hash = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(verifier),
        );
        expect(Buffer.from(hash).toString("base64url")).toBe(challenge);
        const id = await new SignJWT({
          ...claims,
          nonce,
          sid: "provider-session",
          auth_time: Math.floor(Date.now() / 1000),
        })
          .setProtectedHeader({ alg: "RS256", kid: "provider" })
          .setIssuer(issuer)
          .setAudience(clientId)
          .setSubject(subject)
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(privateKey);
        return Response.json({
          id_token: id,
          token_type: "Bearer",
          access_token: "temporary-provider-token",
        });
      },
      { preconnect: originalFetch.preconnect },
    );

    try {
      const cookies = sessionCookies();
      const mcp = createOAuth(db, {
        issuer: origin,
        resource: origin + "/mcp",
      });
      const redirectUri = "https://mcp-client.example.test/callback";
      const client = mcp.register({
        client_name: "MCP test client",
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
      });
      const browser = opaque();
      const verifier = opaque();
      cookies.set(BROWSER_COOKIE, browser, { path: "/" });
      const transaction = mcp.begin(
        {
          client_id: client.client_id,
          redirect_uri: redirectUri,
          response_type: "code",
          scope: "records:read",
          resource: origin + "/mcp",
          code_challenge: Buffer.from(digest(verifier), "hex").toString(
            "base64url",
          ),
          code_challenge_method: "S256",
        },
        browser,
      );
      const consent = authorizationPath(transaction);
      const authorize = new URL(
        (await beginBrowserFlow(db, cookies, consent))!,
      );
      expect(authorize.searchParams.get("scope")).toBe("openid profile email");
      expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
      expect(authorize.searchParams.get("response_mode")).toBe("query");
      nonce = authorize.searchParams.get("nonce")!;
      challenge = authorize.searchParams.get("code_challenge")!;
      const callback = new URL(origin + CALLBACK_PATH);
      callback.search = new URLSearchParams({
        state: authorize.searchParams.get("state")!,
        code: "authorization-code",
      }).toString();
      expect(await completeBrowserFlow(db, sessionCookies(), callback)).toBe(
        "/login?ssoError=unavailable",
      );
      const completed = new URL(
        await completeBrowserFlow(db, cookies, callback),
        origin,
      );
      expect(completed.pathname).toBe("/auth/complete");
      expect(localReturnTo(completed.searchParams.get("returnTo"))).toBe(
        consent,
      );
      expect(
        mcp.pending(transaction, cookies.get(BROWSER_COOKIE)!).client.id,
      ).toBe(client.client_id);
      expect(db.select().from(schema.oauthGrants).all()).toHaveLength(0);
      const session = cookies.get("session")!;
      const user = getSessionUser(db, session)!;
      expect(user.username).toBe(claims.preferred_username);
      expect(
        db
          .select()
          .from(schema.userGroups)
          .where(eq(schema.userGroups.userId, user.id))
          .get()?.groupId,
      ).toBe(3);
      expect(await completeBrowserFlow(db, cookies, callback)).toBe(
        "/login?ssoError=unavailable",
      );

      subject = "local-link";
      const linkCookies = sessionCookies(local);
      expect(
        await beginBrowserFlow(db, linkCookies, null, {
          sessionId: local,
          userId: 2,
          password: "",
        }),
      ).toBe("/api/v1/auth/sso/link");
      expect(await continueLink(db, sessionCookies(local))).toBeNull();
      const link = new URL((await continueLink(db, linkCookies))!);
      expect(link.searchParams.get("prompt")).toBe("login");
      expect(link.searchParams.get("max_age")).toBe("0");
      nonce = link.searchParams.get("nonce")!;
      challenge = link.searchParams.get("code_challenge")!;
      callback.searchParams.set("state", link.searchParams.get("state")!);
      expect(await completeBrowserFlow(db, linkCookies, callback)).toBe(
        "/profile?tab=security&sso=linked",
      );
      expect(findIdentity(db, issuer, 2)).toEqual({ userId: 2 });

      db.insert(schema.groupGrants)
        .values({ groupId: 3, permission: "records.read" })
        .run();
      db.insert(schema.groupDelegations)
        .values({ groupId: 3, permission: "records.read" })
        .run();
      const approval = new URL(
        await mcp.finish(
          transaction,
          browser,
          { user, ...resolveAccess(db, user.id) },
          ["records:read"],
          true,
        ),
      );
      expect(approval.searchParams.get("code")).toBeTruthy();
      expect(db.select().from(schema.oauthGrants).get()?.userId).toBe(user.id);

      const logout = await new SignJWT({
        events: { [LOGOUT_EVENT]: {} },
        sid: "provider-session",
      })
        .setProtectedHeader({ alg: "RS256", kid: "provider" })
        .setIssuer(issuer)
        .setAudience(clientId)
        .setJti("logout-1")
        .setIssuedAt()
        .sign(privateKey);
      const settings = readAuthentication(db);
      const notification = await verifyLogout(settings, process.env, logout);
      receiveLogout(db, settings, notification);
      receiveLogout(db, settings, notification);
      expect(getSessionUser(db, session)).toBeNull();
      expect(getSessionUser(db, local)?.id).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
      close();
    }
  });

  it("protects recovery access and preserves manual groups when provider mappings are removed", () => {
    const { db, close, administrator, local, settings, env } = fixture();
    try {
      const before = readAuthentication(db);
      expect(before.encryptedSecret).not.toContain(secret);
      expect(() =>
        saveAuthentication(
          db,
          {
            ...settings,
            internalAuthenticationEnabled: false,
            recoveryUserIds: [],
          },
          before.revision,
          "",
          1,
          administrator,
          env,
        ),
      ).toThrow("recovery administrator");
      expect(() =>
        db.transaction((tx) =>
          signIn(
            tx,
            before,
            "unverified",
            null,
            { ...claims, email_verified: false },
            Date.now(),
          ),
        ),
      ).toThrow("email_unverified");
      expect(() =>
        db.transaction((tx) =>
          signIn(
            tx,
            before,
            "duplicate",
            null,
            { ...claims, email: "LOCAL@example.test" },
            Date.now(),
          ),
        ),
      ).toThrow("account_conflict");
      const session = db.transaction((tx) =>
        signIn(tx, before, "provider-user", "sid", claims, Date.now()),
      );
      const userId = getSessionUser(db, session)!.id;
      db.insert(schema.userGroups).values({ userId, groupId: 4 }).run();
      saveAuthentication(
        db,
        {
          ...settings,
          internalAuthenticationEnabled: false,
          recoveryUserIds: [1],
          groupMappings: [],
        },
        before.revision,
        "",
        1,
        administrator,
        env,
      );
      const current = readAuthentication(db);
      expect(getSessionUser(db, local)).toBeNull();
      expect(getSessionUser(db, administrator)?.id).toBe(1);
      expect(getSessionUser(db, session)?.id).toBe(userId);
      db.transaction((tx) =>
        signIn(tx, current, "provider-user", "sid", claims, Date.now()),
      );
      expect(
        db
          .select()
          .from(schema.userGroups)
          .where(eq(schema.userGroups.userId, userId))
          .all()
          .map((row) => row.groupId)
          .sort(),
      ).toEqual([2, 4]);

      const createdAt = new Date(Date.now() - SESSION_MAX_AGE + 60_000);
      db.update(schema.sessions)
        .set({
          createdAt: createdAt.toISOString(),
          expiresAt: new Date(Date.now() + 10_000).toISOString(),
        })
        .where(eq(schema.sessions.id, session))
        .run();
      expect(getSessionUser(db, session)?.id).toBe(userId);
      expect(
        db
          .select()
          .from(schema.sessions)
          .where(eq(schema.sessions.id, session))
          .get()?.expiresAt,
      ).toBe(new Date(createdAt.getTime() + SESSION_MAX_AGE).toISOString());
    } finally {
      close();
    }
  });

  it("generates a persistent key automatically and keeps the client secret encrypted", () => {
    const { db, close, administrator, settings, env } = fixture();
    try {
      const keyFile = env.DATABASE_PATH + ".oidc-key";
      const key = readFileSync(keyFile);
      expect(key).toHaveLength(32);
      if (process.platform !== "win32")
        expect(statSync(keyFile).mode & 0o777).toBe(0o600);
      const saved = readAuthentication(db, env);
      expect(saved.encryptedSecret).not.toContain(secret);
      expect(clientSecret(saved, env)).toBe(secret);
      saveAuthentication(
        db,
        { ...settings, displayName: "Authentik" },
        saved.revision,
        "",
        1,
        administrator,
        env,
      );
      expect(readFileSync(keyFile)).toEqual(key);
      expect(clientSecret(readAuthentication(db, env), env)).toBe(secret);
    } finally {
      close();
    }
  });

  it("accepts safe redirects and configured scopes", () => {
    expect(localReturnTo("/oauth/authorize?transaction=abc")).toBe(
      "/oauth/authorize?transaction=abc",
    );
    expect(localReturnTo("//elsewhere.example/path")).toBe("/");
    expect(localReturnTo("/a/../api/private")).toBe("/");
    expect(localReturnTo("/\\elsewhere.example")).toBe("/");
    expect(scopes("email groups entitlements")).toEqual([
      "openid",
      "profile",
      "email",
      "groups",
      "entitlements",
    ]);
    expect(() => scopes("offline_access")).toThrow("offline_access");
    expect(() => scopes('"groups"')).toThrow();
  });
});
