import OAuth2Server from "@node-oauth/oauth2-server";
import basicAuth from "basic-auth";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import type { LedgerDb } from "../ledger/types.js";
import {
  oauthClients,
  oauthPending,
  oauthGrants,
  oauthCodes,
  oauthTokens,
  users,
} from "../db/schema.js";
import { resolveAccess } from "../permissions.js";
import { expandScopes } from "$lib/permissions/oauth-scopes.js";
import { LAST_USED_WRITE_MS, patLocals } from "../tokens/pat.js";
import {
  OAUTH_SCOPES,
  READ_SCOPES,
  type OAuthConfig,
  type OAuthScope,
} from "./config.js";
import { allowedScopes } from "./scopes.js";
import { diffRecords, recordAudit } from "../audit.js";

const DAY = 86400_000;
export const opaque = () => randomBytes(32).toString("base64url");
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const BROWSER_COOKIE = "akaun_oauth_browser";
export class OAuthFailure extends Error {
  constructor(
    public code: string,
    public status = 400,
  ) {
    super(code);
  }
}
/** What the audit log keeps of a connected app's grant. */
function grantAuditFields(row: typeof oauthGrants.$inferSelect) {
  return {
    clientId: row.clientId,
    ownerId: row.userId,
    scopes: row.scopes.split(" "),
    expiresOn: new Date(row.expiresAt).toISOString().slice(0, 10),
  };
}

export function oauthJson(
  body: unknown,
  status = 200,
  headers: HeadersInit = {},
) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "application/json");
  responseHeaders.set("Cache-Control", "no-store");
  responseHeaders.set("Pragma", "no-cache");
  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders,
  });
}
export function oauthError(error: unknown) {
  if (error instanceof OAuthFailure)
    return oauthJson({ error: error.code }, error.status);
  if (error instanceof OAuth2Server.OAuthError) {
    // Internal errors can contain DB details. Return only standard error codes.
    return oauthJson(
      { error: error.name },
      error.code >= 400 && error.code <= 599 ? error.code : 400,
    );
  }
  return oauthJson({ error: "server_error" }, 500);
}
export function parseScopes(scope: string | undefined): OAuthScope[] {
  // A client that names no scope gets reads only. A write or delete scope is
  // always asked for by name, so no existing client gains one by upgrading.
  const scopes = scope === undefined ? [...READ_SCOPES] : scope.split(" ");
  if (
    !scopes.length ||
    scopes.some((s) => !OAUTH_SCOPES.includes(s as OAuthScope))
  )
    throw new OAuthFailure("invalid_scope");
  return [...new Set(scopes)] as OAuthScope[];
}
export function parameters(params: URLSearchParams) {
  const result: Record<string, string> = {};
  for (const [key, value] of params) {
    if (Object.hasOwn(result, key) || value.length > 4096)
      throw new OAuthFailure("invalid_request");
    result[key] = value;
  }
  return result;
}

export function createOAuth(db: LedgerDb, config: OAuthConfig) {
  const client = (id: string): OAuth2Server.Client | null => {
    const row = db
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.id, id))
      .get();
    return row
      ? {
          id: row.id,
          name: row.name,
          redirectUris: JSON.parse(row.redirectUris) as string[],
          grants: ["authorization_code", "refresh_token"],
        }
      : null;
  };
  const grant = (id: string) =>
    db
      .select()
      .from(oauthGrants)
      .where(
        and(
          eq(oauthGrants.id, id),
          isNull(oauthGrants.revokedAt),
          gt(oauthGrants.expiresAt, Date.now()),
          eq(oauthGrants.issuer, config.issuer),
          eq(oauthGrants.resource, config.resource),
        ),
      )
      .get();
  const user = (id: number) =>
    db
      .select({
        id: users.id,
        email: users.email,
        username: users.username,
        name: users.name,
        role: users.role,
      })
      .from(users)
      .where(eq(users.id, id))
      .get();

  function validClient(
    id: string,
    secret: string | null | undefined,
    method: string,
  ) {
    const row = db
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.id, id))
      .get();
    if (!row || row.authMethod !== method) return false;
    if (method === "none") return !secret;
    return Boolean(
      secret &&
      row.secretHash &&
      timingSafeEqual(Buffer.from(digest(secret)), Buffer.from(row.secretHash)),
    );
  }
  function credentials(body: Record<string, string>, request?: Request) {
    const header = request?.headers.get("authorization");
    if (header) {
      const parsed = basicAuth.parse(header);
      if (
        !parsed ||
        body.client_secret !== undefined ||
        (body.client_id && body.client_id !== parsed.name)
      )
        throw new OAuthFailure("invalid_client", 401);
      return {
        id: parsed.name,
        secret: parsed.pass,
        method: "client_secret_basic",
      };
    }
    return {
      id: body.client_id,
      secret: body.client_secret,
      method: body.client_secret === undefined ? "none" : "client_secret_post",
    };
  }

  // Never reclaim a client while consent is in progress or a grant is usable.
  // Pending parameters are validated before persistence and contain client_id.
  function unusedClient(now: number) {
    return sql`not exists (
      select 1 from ${oauthGrants}
      where ${oauthGrants.clientId} = ${oauthClients.id}
        and ${oauthGrants.revokedAt} is null and ${oauthGrants.expiresAt} > ${now}
    ) and not exists (
      select 1 from ${oauthPending}
      where json_extract(${oauthPending.params}, '$.client_id') = ${oauthClients.id}
        and ${oauthPending.expiresAt} > ${now}
    )`;
  }
  function cleanup() {
    const now = Date.now();
    db.delete(oauthPending).where(lt(oauthPending.expiresAt, now)).run();
    db.delete(oauthCodes).where(lt(oauthCodes.expiresAt, now)).run();
    db.delete(oauthGrants).where(lt(oauthGrants.expiresAt, now)).run();
    db.delete(oauthClients)
      .where(and(lt(oauthClients.createdAt, now - DAY), unusedClient(now)))
      .run();
  }
  /**
   * A revoke is audited as the grant's delete, credited to `actorId` — or,
   * when the protocol revoked it (a replayed refresh token, an app revoking
   * its own token), to the grant's owner, with the channel saying 'system'.
   * Expiry is not a revoke and is never logged.
   */
  function auditRevoked(
    rows: (typeof oauthGrants.$inferSelect)[],
    actorId: number | undefined,
  ) {
    for (const row of rows)
      recordAudit(db, {
        recordType: "oauth_grant",
        recordId: row.id,
        userId: actorId ?? row.userId,
        action: "delete",
        changes: diffRecords(grantAuditFields(row), null),
      });
  }
  function revokeGrant(id: string, userId?: number, actorId = userId) {
    const rows = db
      .update(oauthGrants)
      .set({ revokedAt: Date.now() })
      .where(
        and(
          eq(oauthGrants.id, id),
          isNull(oauthGrants.revokedAt),
          userId === undefined ? undefined : eq(oauthGrants.userId, userId),
        ),
      )
      .returning()
      .all();
    auditRevoked(rows, actorId);
  }
  function revokeUser(userId: number, actorId = userId) {
    const rows = db
      .update(oauthGrants)
      .set({ revokedAt: Date.now() })
      .where(and(eq(oauthGrants.userId, userId), isNull(oauthGrants.revokedAt)))
      .returning()
      .all();
    auditRevoked(rows, actorId);
  }
  function listGrants(userId: number) {
    return db
      .select({
        id: oauthGrants.id,
        clientName: oauthClients.name,
        clientId: oauthClients.id,
        scopes: oauthGrants.scopes,
        createdAt: oauthGrants.createdAt,
        expiresAt: oauthGrants.expiresAt,
        lastUsedAt: oauthGrants.lastUsedAt,
      })
      .from(oauthGrants)
      .innerJoin(oauthClients, eq(oauthClients.id, oauthGrants.clientId))
      .where(
        and(
          eq(oauthGrants.userId, userId),
          isNull(oauthGrants.revokedAt),
          gt(oauthGrants.expiresAt, Date.now()),
        ),
      )
      .all()
      .map((g) => ({ ...g, scopes: g.scopes.split(" ") }));
  }
  function register(body: unknown) {
    cleanup();
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new OAuthFailure("invalid_client_metadata");
    const data = body as Record<string, unknown>;
    const uris = data.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > 10)
      throw new OAuthFailure("invalid_redirect_uri");
    for (const uri of uris) {
      if (typeof uri !== "string" || uri.length > 2048)
        throw new OAuthFailure("invalid_redirect_uri");
      let url: URL;
      try {
        url = new URL(uri);
      } catch {
        throw new OAuthFailure("invalid_redirect_uri");
      }
      const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      if (
        url.hash ||
        url.username ||
        url.password ||
        (url.protocol !== "https:" && !(local && url.protocol === "http:"))
      )
        throw new OAuthFailure("invalid_redirect_uri");
    }
    const authMethod = data.token_endpoint_auth_method ?? "client_secret_basic";
    if (
      typeof authMethod !== "string" ||
      !["none", "client_secret_basic", "client_secret_post"].includes(
        authMethod,
      )
    )
      throw new OAuthFailure("invalid_client_metadata");
    if (
      data.grant_types !== undefined &&
      (!Array.isArray(data.grant_types) ||
        !data.grant_types.length ||
        data.grant_types.some(
          (g) => g !== "authorization_code" && g !== "refresh_token",
        ))
    )
      throw new OAuthFailure("invalid_client_metadata");
    if (
      data.response_types !== undefined &&
      (!Array.isArray(data.response_types) ||
        data.response_types.length !== 1 ||
        data.response_types[0] !== "code")
    )
      throw new OAuthFailure("invalid_client_metadata");
    if (data.scope !== undefined) {
      if (typeof data.scope !== "string")
        throw new OAuthFailure("invalid_client_metadata");
      parseScopes(data.scope);
    }
    if (
      data.client_name !== undefined &&
      (typeof data.client_name !== "string" ||
        data.client_name.length > 100 ||
        [...data.client_name].some(
          (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
        ))
    )
      throw new OAuthFailure("invalid_client_metadata");
    const count = db
      .select({ n: sql<number>`count(*)` })
      .from(oauthClients)
      .get()!.n;
    if (count >= 1000) {
      // Public registrations cannot permanently occupy capacity. Under pressure,
      // reclaim one oldest unused client, even before its ordinary expiry.
      const reclaim = db
        .select({ id: oauthClients.id })
        .from(oauthClients)
        .where(unusedClient(Date.now()))
        .orderBy(oauthClients.createdAt, oauthClients.id)
        .limit(1)
        .get();
      if (!reclaim) throw new OAuthFailure("temporarily_unavailable", 503);
      db.delete(oauthClients).where(eq(oauthClients.id, reclaim.id)).run();
    }
    const id = `aknc_${opaque()}`;
    const name =
      typeof data.client_name === "string" && data.client_name.trim()
        ? data.client_name.trim()
        : "MCP client";
    const secret = authMethod === "none" ? undefined : opaque();
    db.insert(oauthClients)
      .values({
        id,
        authMethod,
        secretHash: secret ? digest(secret) : null,
        name,
        redirectUris: JSON.stringify(uris),
        createdAt: Date.now(),
      })
      .run();
    return {
      client_id: id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: name,
      redirect_uris: uris,
      token_endpoint_auth_method: authMethod,
      client_secret: secret,
      client_secret_expires_at: secret ? 0 : undefined,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: OAUTH_SCOPES.join(" "),
    };
  }
  function validateAuthorization(params: Record<string, string>) {
    if (params.response_type !== "code")
      throw new OAuthFailure("unsupported_response_type");
    if (!params.client_id || !client(params.client_id))
      throw new OAuthFailure("invalid_client");
    const c = client(params.client_id)!;
    if (
      !params.redirect_uri ||
      !(c.redirectUris as string[]).includes(params.redirect_uri)
    )
      throw new OAuthFailure("invalid_request");
    if (params.resource !== config.resource)
      throw new OAuthFailure("invalid_target");
    if (
      params.code_challenge_method !== "S256" ||
      !/^[A-Za-z0-9_-]{43}$/.test(params.code_challenge ?? "")
    )
      throw new OAuthFailure("invalid_request");
    if (
      params.state !== undefined &&
      (!params.state || !/^[\x20-\x7e]+$/.test(params.state))
    )
      throw new OAuthFailure("invalid_request");
    // A single explicit response mode; never let client parameters skip consent.
    if (params.response_mode && params.response_mode !== "query")
      throw new OAuthFailure("invalid_request");
    return { client: c, scopes: parseScopes(params.scope) };
  }
  function begin(params: Record<string, string>, browser: string) {
    cleanup();
    validateAuthorization(params);
    const count = db
      .select({ n: sql<number>`count(*)` })
      .from(oauthPending)
      .get()!.n;
    if (count >= 5000) throw new OAuthFailure("temporarily_unavailable", 503);
    const id = opaque();
    db.insert(oauthPending)
      .values({
        idHash: digest(id),
        browserHash: digest(browser),
        params: JSON.stringify(params),
        expiresAt: Date.now() + 10 * 60_000,
      })
      .run();
    return id;
  }
  function pending(id: string, browser: string) {
    if (!id || !browser) throw new OAuthFailure("invalid_request");
    const p = db
      .select()
      .from(oauthPending)
      .where(
        and(
          eq(oauthPending.idHash, digest(id)),
          eq(oauthPending.browserHash, digest(browser)),
          gt(oauthPending.expiresAt, Date.now()),
        ),
      )
      .get();
    if (!p) throw new OAuthFailure("invalid_request");
    const params = JSON.parse(p.params) as Record<string, string>;
    return { params, ...validateAuthorization(params) };
  }

  // A fresh library/model per operation. No user or request state is global.
  function protocol(
    resource: string,
    expectedClientId?: string,
    authMethod?: string,
  ) {
    const model: OAuth2Server.AuthorizationCodeModel &
      OAuth2Server.RefreshTokenModel = {
      getClient: async (id, secret) => {
        if (!expectedClientId) return client(id); // Browser authorization does not authenticate clients.
        return id === expectedClientId && validClient(id, secret, authMethod!)
          ? client(id)
          : null;
      },
      generateAccessToken: async () => `akno_${opaque()}`,
      generateRefreshToken: async () => `aknr_${opaque()}`,
      generateAuthorizationCode: async () => opaque(),
      validateScope: async (u, _c, scopes) => {
        const g = typeof u.grantId === "string" ? grant(u.grantId) : undefined;
        if (
          !g ||
          !Array.isArray(scopes) ||
          scopes.some((s) => !g.scopes.split(" ").includes(s))
        )
          return false;
        return scopes;
      },
      saveAuthorizationCode: async (code, c, u) => {
        db.insert(oauthCodes)
          .values({
            hash: digest(code.authorizationCode),
            grantId: u.grantId as string,
            redirectUri: code.redirectUri,
            challenge: code.codeChallenge!,
            expiresAt: code.expiresAt.getTime(),
          })
          .run();
        return { ...code, client: c, user: u };
      },
      getAuthorizationCode: async (raw) => {
        const code = db
          .select()
          .from(oauthCodes)
          .where(eq(oauthCodes.hash, digest(raw)))
          .get();
        const g = code && grant(code.grantId);
        if (
          !code ||
          !g ||
          code.consumedAt !== null ||
          resource !== g.resource ||
          !user(g.userId)
        )
          return null;
        return {
          authorizationCode: raw,
          expiresAt: new Date(code.expiresAt),
          redirectUri: code.redirectUri,
          codeChallenge: code.challenge,
          codeChallengeMethod: "S256",
          scope: g.scopes.split(" "),
          client: client(g.clientId)!,
          user: { id: g.userId, grantId: g.id },
        };
      },
      revokeAuthorizationCode: async (code) =>
        db
          .update(oauthCodes)
          .set({ consumedAt: Date.now() })
          .where(
            and(
              eq(oauthCodes.hash, digest(code.authorizationCode)),
              isNull(oauthCodes.consumedAt),
              gt(oauthCodes.expiresAt, Date.now()),
            ),
          )
          .returning({ hash: oauthCodes.hash })
          .all().length === 1,
      saveToken: async (token, c, u) => {
        const g = grant(u.grantId as string);
        if (
          !g ||
          g.clientId !== c.id ||
          g.userId !== u.id ||
          !user(g.userId) ||
          !token.scope?.length ||
          token.scope.some((s) => !g.scopes.split(" ").includes(s))
        )
          throw new OAuth2Server.InvalidGrantError("Invalid grant");
        const accessExpiresAt = Math.min(
          token.accessTokenExpiresAt!.getTime(),
          g.expiresAt,
        );
        const refreshExpiresAt = Math.min(
          token.refreshTokenExpiresAt!.getTime(),
          g.expiresAt,
        );
        db.insert(oauthTokens)
          .values({
            accessHash: digest(token.accessToken),
            refreshHash: digest(token.refreshToken!),
            grantId: g.id,
            scopes: token.scope!.join(" "),
            accessExpiresAt,
            refreshExpiresAt,
          })
          .run();
        return {
          ...token,
          accessTokenExpiresAt: new Date(accessExpiresAt),
          refreshTokenExpiresAt: new Date(refreshExpiresAt),
          client: c,
          user: u,
        };
      },
      getRefreshToken: async (raw) => {
        const t = db
          .select()
          .from(oauthTokens)
          .where(eq(oauthTokens.refreshHash, digest(raw)))
          .get();
        const g = t && grant(t.grantId);
        // Don't let a different client or audience revoke another client's family.
        if (
          !t ||
          !g ||
          g.clientId !== expectedClientId ||
          resource !== g.resource ||
          !user(g.userId)
        )
          return null;
        if (t.refreshUsedAt !== null) {
          revokeGrant(g.id);
          return null;
        }
        return {
          refreshToken: raw,
          refreshTokenExpiresAt: new Date(t.refreshExpiresAt),
          scope: t.scopes.split(" "),
          client: client(g.clientId)!,
          user: { id: g.userId, grantId: g.id },
        };
      },
      revokeToken: async (t) => {
        const claimed =
          db
            .update(oauthTokens)
            .set({ refreshUsedAt: Date.now() })
            .where(
              and(
                eq(oauthTokens.refreshHash, digest(t.refreshToken)),
                isNull(oauthTokens.refreshUsedAt),
                gt(oauthTokens.refreshExpiresAt, Date.now()),
              ),
            )
            .returning({ hash: oauthTokens.refreshHash })
            .all().length === 1;
        if (!claimed) revokeGrant(t.user.grantId as string);
        return claimed;
      },
      getAccessToken: async (raw) => {
        const t = db
          .select()
          .from(oauthTokens)
          .where(eq(oauthTokens.accessHash, digest(raw)))
          .get();
        const g = t && grant(t.grantId);
        const u = g && user(g.userId);
        if (
          !t ||
          !g ||
          !u ||
          resource !== g.resource ||
          t.scopes.split(" ").some((s) => !g.scopes.split(" ").includes(s))
        )
          return null;
        return {
          accessToken: raw,
          accessTokenExpiresAt: new Date(t.accessExpiresAt),
          scope: t.scopes.split(" "),
          client: client(g.clientId)!,
          user: { ...u, grantId: g.id },
        };
      },
    };
    return new OAuth2Server({
      model,
      accessTokenLifetime: 900,
      refreshTokenLifetime: 30 * 86400,
      authorizationCodeLifetime: 120,
      requireClientAuthentication: {
        authorization_code: false,
        refresh_token: false,
      },
      alwaysIssueNewRefreshToken: true,
    });
  }
  async function finish(
    id: string,
    browser: string,
    locals: App.Locals,
    selected: string[],
    approve: boolean,
  ) {
    // Consent is given in a browser session only: never by a token or an app.
    if (!locals.user || locals.credential || !locals.role)
      throw new OAuthFailure("access_denied", 403);
    const p = pending(id, browser);
    const allowed = allowedScopes(locals.role);
    if (
      approve &&
      (!selected.length ||
        selected.some(
          (s) =>
            !p.scopes.includes(s as OAuthScope) ||
            !allowed.includes(s as OAuthScope),
        ))
    )
      throw new OAuthFailure("invalid_scope");
    const consumed = db
      .delete(oauthPending)
      .where(
        and(
          eq(oauthPending.idHash, digest(id)),
          eq(oauthPending.browserHash, digest(browser)),
          gt(oauthPending.expiresAt, Date.now()),
        ),
      )
      .returning({ id: oauthPending.idHash })
      .all();
    if (consumed.length !== 1) throw new OAuthFailure("invalid_request");
    if (!approve) {
      const redirect = new URL(p.params.redirect_uri);
      redirect.searchParams.set("error", "access_denied");
      if (p.params.state) redirect.searchParams.set("state", p.params.state);
      return redirect.href;
    }
    const grantId = opaque();
    db.transaction((tx) => {
      const row = tx
        .insert(oauthGrants)
        .values({
          id: grantId,
          userId: locals.user!.id,
          clientId: p.client.id,
          issuer: config.issuer,
          resource: config.resource,
          scopes: [...new Set(selected)].join(" "),
          createdAt: Date.now(),
          expiresAt: Date.now() + 30 * DAY,
        })
        .returning()
        .get();
      recordAudit(tx, {
        recordType: "oauth_grant",
        recordId: grantId,
        userId: locals.user!.id,
        action: "create",
        changes: diffRecords(null, grantAuditFields(row)),
      });
    });
    const response = new OAuth2Server.Response();
    try {
      await protocol(config.resource).authorize(
        new OAuth2Server.Request({
          method: "GET",
          headers: {},
          query: {
            ...p.params,
            scope: [...new Set(selected)].join(" "),
            allowed: "true",
          },
          body: {},
        }),
        response,
        {
          allowEmptyState: true,
          authenticateHandler: {
            handle: async () => ({ id: locals.user!.id, grantId }),
          },
        },
      );
      return response.get("location") as string;
    } catch (error) {
      revokeGrant(grantId);
      throw error;
    }
  }
  async function exchange(request: Request, body: Record<string, string>) {
    if (body.resource !== config.resource)
      throw new OAuthFailure("invalid_target");
    if (!["authorization_code", "refresh_token"].includes(body.grant_type))
      throw new OAuthFailure("unsupported_grant_type");
    const auth = credentials(body, request);
    if (!auth.id || !validClient(auth.id, auth.secret, auth.method))
      throw new OAuthFailure("invalid_client", 401);
    const response = new OAuth2Server.Response();
    await protocol(body.resource, auth.id, auth.method).token(
      new OAuth2Server.Request({
        method: request.method,
        headers: {
          ...Object.fromEntries(request.headers),
          "content-length": String(
            Buffer.byteLength(new URLSearchParams(body).toString()),
          ),
        },
        body,
        query: {},
      }),
      response,
    );
    return oauthJson(response.body, response.status);
  }
  async function authenticate(request: Request): Promise<App.Locals | null> {
    const header = request.headers.get("authorization");
    const match = header?.match(/^Bearer ([^\s]+)$/i);
    if (!match) return null;
    if (!match[1].startsWith("akno_") && !match[1].startsWith("aknr_"))
      return patLocals(db, header);
    if (!match[1].startsWith("akno_")) return null;
    try {
      const token = await protocol(config.resource).authenticate(
        new OAuth2Server.Request({
          method: request.method,
          headers: { authorization: header! },
          body: {},
          query: {},
        }),
        new OAuth2Server.Response(),
        { addAcceptedScopesHeader: false, addAuthorizedScopesHeader: false },
      );
      const u = user(token.user.id as number);
      if (!u) return null;
      // Throttled like a personal access token's: a busy client must not turn
      // every read into a write.
      const now = Date.now();
      db.update(oauthGrants)
        .set({ lastUsedAt: now })
        .where(
          and(
            eq(oauthGrants.id, token.user.grantId as string),
            or(
              isNull(oauthGrants.lastUsedAt),
              lt(oauthGrants.lastUsedAt, now - LAST_USED_WRITE_MS + 1),
            ),
          ),
        )
        .run();
      const scopes = token.scope as OAuthScope[];
      return {
        user: u,
        // What the app may do: its scopes, expanded to catalog permissions,
        // ∩ the user's role ∩ their groups' delegation ceiling — on every
        // request, so narrowing either takes effect at once.
        ...resolveAccess(db, u.id, expandScopes(scopes)),
        credential: {
          kind: "oauth" as const,
          grantId: token.user.grantId as string,
          clientId: token.client.id,
        },
        oauth: {
          clientId: token.client.id,
          grantId: token.user.grantId as string,
          resource: config.resource,
          scopes,
        },
      };
    } catch (error) {
      if (
        error instanceof OAuth2Server.OAuthError ||
        error instanceof OAuthFailure
      )
        return null;
      throw error;
    }
  }
  function revokeToken(body: Record<string, string>, request?: Request) {
    const auth = credentials(body, request);
    if (!auth.id || !validClient(auth.id, auth.secret, auth.method))
      throw new OAuthFailure("invalid_client", 401);
    if (!body.token) throw new OAuthFailure("invalid_request");
    const t = db
      .select()
      .from(oauthTokens)
      .where(
        body.token.startsWith("aknr_")
          ? eq(oauthTokens.refreshHash, digest(body.token))
          : eq(oauthTokens.accessHash, digest(body.token)),
      )
      .get();
    const g = t && grant(t.grantId);
    if (g && g.clientId === auth.id) revokeGrant(g.id);
  }
  return {
    register,
    begin,
    pending,
    finish,
    exchange,
    authenticate,
    revokeToken,
    revokeGrant,
    revokeUser,
    listGrants,
    cleanup,
  };
}
export type AkaunOAuth = ReturnType<typeof createOAuth>;
