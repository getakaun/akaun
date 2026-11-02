import type { Cookies } from "@sveltejs/kit";
import { OAUTH_SCOPES, type OAuthConfig } from "./config.js";
import {
  BROWSER_COOKIE,
  opaque,
  OAuthFailure,
  oauthJson,
  oauthError,
  parameters,
  type AkaunOAuth,
} from "./service.js";

const PUBLIC_PATHS = new Set([
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server",
  "/oauth/register",
  "/oauth/token",
  "/oauth/revoke",
]);
export const isOAuthPublicPath = (path: string) => PUBLIC_PATHS.has(path);
export const authorizationPath = (id: string) =>
  `/oauth/authorize?transaction=${encodeURIComponent(id)}`;
const buckets = new Map<string, { count: number; until: number }>();
function limited(key: string, max: number) {
  const now = Date.now();
  for (const [k, v] of buckets) if (v.until <= now) buckets.delete(k);
  let bucket = buckets.get(key);
  if (!bucket) {
    if (buckets.size >= 4096) return true;
    bucket = { count: 0, until: now + 60_000 };
    buckets.set(key, bucket);
  }
  return ++bucket.count > max;
}
async function boundedText(request: Request) {
  if (Number(request.headers.get("content-length")) > 16 * 1024)
    throw new OAuthFailure("invalid_request", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new OAuthFailure("invalid_request");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16 * 1024) {
        await reader.cancel();
        throw new OAuthFailure("invalid_request", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Protocol routing is independent of the production DB singleton, and testable. */
export async function handleOAuthProtocol(
  request: Request,
  cookies: Cookies,
  address: string,
  service: AkaunOAuth | null,
  config: OAuthConfig | null,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const initialAuthorization =
    path === "/oauth/authorize" && !url.searchParams.has("transaction");
  if (!isOAuthPublicPath(path) && !initialAuthorization) return null;
  if (!service || !config)
    return oauthJson({ error: "OAuth is disabled" }, 404);
  try {
    const discovery = path.startsWith("/.well-known/");
    if (request.method !== (discovery || initialAuthorization ? "GET" : "POST"))
      return oauthJson({ error: "invalid_request" }, 405, {
        Allow: discovery || initialAuthorization ? "GET" : "POST",
      });
    if (discovery) {
      if (path.includes("oauth-protected-resource"))
        return oauthJson({
          resource: config.resource,
          authorization_servers: [config.issuer],
          scopes_supported: OAUTH_SCOPES,
          bearer_methods_supported: ["header"],
        });
      return oauthJson({
        issuer: config.issuer,
        authorization_endpoint: `${config.issuer}/oauth/authorize`,
        token_endpoint: `${config.issuer}/oauth/token`,
        registration_endpoint: `${config.issuer}/oauth/register`,
        revocation_endpoint: `${config.issuer}/oauth/revoke`,
        response_types_supported: ["code"],
        response_modes_supported: ["query"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: [
          "none",
          "client_secret_basic",
          "client_secret_post",
        ],
        revocation_endpoint_auth_methods_supported: [
          "none",
          "client_secret_basic",
          "client_secret_post",
        ],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: OAUTH_SCOPES,
      });
    }
    if (limited(`${path}:${address}`, path === "/oauth/register" ? 10 : 60))
      return oauthJson({ error: "temporarily_unavailable" }, 429, {
        "Retry-After": "60",
      });
    if (initialAuthorization) {
      if (url.search.length > 8192) throw new OAuthFailure("invalid_request");
      const browser = cookies.get(BROWSER_COOKIE) || opaque();
      const id = service.begin(parameters(url.searchParams), browser);
      const cookieOptions = {
        path: "/",
        httpOnly: true,
        sameSite: "lax" as const,
        secure: config.issuer.startsWith("https:"),
        maxAge: 1800,
      };
      // This response bypasses resolve(), where SvelteKit normally attaches
      // cookies.set() updates. Emit the binding cookie on the redirect itself.
      const browserCookie = cookies.serialize(
        BROWSER_COOKIE,
        browser,
        cookieOptions,
      );
      return new Response(null, {
        status: 302,
        headers: {
          Location: authorizationPath(id),
          "Set-Cookie": browserCookie,
          "Cache-Control": "no-store",
        },
      });
    }
    const mime = request.headers.get("content-type")?.split(";")[0].trim();
    if (path === "/oauth/register") {
      if (mime !== "application/json")
        throw new OAuthFailure("invalid_request");
      let body: unknown;
      try {
        body = JSON.parse(await boundedText(request));
      } catch (error) {
        if (error instanceof OAuthFailure) throw error;
        throw new OAuthFailure("invalid_client_metadata");
      }
      return oauthJson(service.register(body), 201);
    }
    if (mime !== "application/x-www-form-urlencoded")
      throw new OAuthFailure("invalid_request");
    const body = parameters(new URLSearchParams(await boundedText(request)));
    if (path === "/oauth/token") return await service.exchange(request, body);
    service.revokeToken(body, request);
    return new Response(null, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const response = oauthError(error);
    if (response.status === 401 && request.headers.has("authorization"))
      response.headers.set("WWW-Authenticate", 'Basic realm="akaun-oauth"');
    return response;
  }
}
