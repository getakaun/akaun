import { redirect, type Handle } from "@sveltejs/kit";
import type { LedgerDb } from "./ledger/types.js";
import { getSessionUser } from "./auth.js";
import { resolveAccess } from "./permissions.js";
import {
  isLegacyToken,
  LEGACY_TOKEN_MESSAGE,
  patLocals,
} from "./tokens/pat.js";
import { isSameOriginRequest } from "./browser-origin.js";
import { mcpChallenge, type OAuthConfig } from "./oauth/config.js";
import { BROWSER_COOKIE, type AkaunOAuth } from "./oauth/service.js";
import { handleOAuthProtocol, isOAuthPublicPath } from "./oauth/http.js";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function withSecurityHeaders(response: Response): Response {
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  if (!response.headers.has("Referrer-Policy"))
    response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  if (!response.headers.has("Content-Security-Policy")) {
    response.headers.set("Content-Security-Policy", "frame-ancestors 'none'");
  }
  return response;
}

export function createRequestHandle(
  db: LedgerDb,
  oauth: AkaunOAuth | null,
  config: OAuthConfig | null,
): Handle {
  return async ({ event, resolve }) => {
    const { pathname } = event.url;
    const protocol = await handleOAuthProtocol(
      event.request,
      event.cookies,
      isOAuthPublicPath(pathname) || pathname === "/oauth/authorize"
        ? event.getClientAddress()
        : "",
      oauth,
      config,
    );
    if (protocol) return withSecurityHeaders(protocol);
    if (pathname === "/oauth/authorize") {
      if (!oauth)
        return withSecurityHeaders(
          new Response("OAuth is disabled", { status: 404 }),
        );
      try {
        oauth.pending(
          event.url.searchParams.get("transaction") ?? "",
          event.cookies.get(BROWSER_COOKIE) ?? "",
        );
      } catch {
        return withSecurityHeaders(
          new Response("Invalid or expired connection request", {
            status: 400,
            headers: { "Cache-Control": "no-store" },
          }),
        );
      }
    }

    // MCP is a protocol interface beside REST. Cookie sessions must never turn
    // an unauthenticated MCP request into a browser login redirect.
    if (pathname === "/mcp" || pathname === "/mcp/") {
      const authorization = event.request.headers.get("Authorization");
      const actor = oauth
        ? await oauth.authenticate(event.request)
        : patLocals(db, authorization);
      if (!actor) {
        return withSecurityHeaders(
          new Response(
            isLegacyToken(authorization) ? LEGACY_TOKEN_MESSAGE : "Unauthorized",
            {
            status: 401,
            headers: {
              "WWW-Authenticate": mcpChallenge(
                config,
                event.request.headers.has("Authorization"),
              ),
              "Cache-Control": "no-store",
            },
            },
          ),
        );
      }
      Object.assign(event.locals, actor);
      return withSecurityHeaders(await resolve(event));
    }

    if (pathname.startsWith("/api/")) {
      const header = event.request.headers.get("Authorization");
      if (header && /^Bearer(?:\s|$)/i.test(header)) {
        // Only a personal access token reaches the REST API. An OAuth token's
        // audience is /mcp alone (RFC 8707), and the old raw API tokens were
        // revoked by migration 0033.
        const actor = patLocals(db, header);
        if (!actor) {
          return new Response(
            isLegacyToken(header) ? LEGACY_TOKEN_MESSAGE : "Unauthorized",
            { status: 401 },
          );
        }
        Object.assign(event.locals, actor);
      } else {
        const sessionId = event.cookies.get("session");
        const sessionUser = sessionId ? getSessionUser(db, sessionId) : null;
        if (!sessionUser) {
          return new Response("Unauthorized", { status: 401 });
        }
        // CSRF defence-in-depth for cookie-authenticated state-changing requests:
        // require the Origin (or Referer) host to match this site. Bearer-token clients
        // are exempt (they authenticate without ambient cookies and send no Origin).
        if (MUTATING_METHODS.has(event.request.method)) {
          const origin = event.request.headers.get("origin");
          const referer = event.request.headers.get("referer");
          const source = origin ?? referer;
          let ok = false;
          if (source) {
            try {
              ok = new URL(source).host === event.url.host;
            } catch {
              ok = false;
            }
          }
          if (!ok) {
            return new Response("Forbidden (CSRF origin check failed)", {
              status: 403,
            });
          }
        }
        event.locals.user = sessionUser;
        Object.assign(event.locals, resolveAccess(db, sessionUser.id));
      }
      return withSecurityHeaders(await resolve(event));
    }

    // SvelteKit trustedOrigins is '*' for bearer/form API interoperability.
    // Browser actions (including login and connected-app revocation) need our own CSRF check.
    if (MUTATING_METHODS.has(event.request.method)) {
      if (!isSameOriginRequest(event.request, event.url.origin))
        return withSecurityHeaders(
          new Response("Forbidden (CSRF origin check failed)", { status: 403 }),
        );
    }
    const sessionId = event.cookies.get("session");
    const sessionUser = sessionId ? getSessionUser(db, sessionId) : null;
    event.locals.user = sessionUser;

    if (!sessionUser) {
      if (pathname !== "/login") {
        const target =
          pathname === "/oauth/authorize"
            ? `/login?oauth=${encodeURIComponent(event.url.searchParams.get("transaction")!)}`
            : "/login";
        throw redirect(302, target);
      }
      event.locals.permissions = null;
      event.locals.role = null;
      const response = await resolve(event);
      response.headers.set("Cache-Control", "no-store");
      // Keep same-site form provenance for CSRF checks without leaking OAuth
      // transaction URLs to external sites. no-referrer can yield a null Origin.
      response.headers.set("Referrer-Policy", "same-origin");
      return withSecurityHeaders(response);
    }

    Object.assign(event.locals, resolveAccess(db, sessionUser.id));

    const response = await resolve(event);
    if (pathname === "/oauth/authorize" || pathname === "/login") {
      response.headers.set("Cache-Control", "no-store");
      response.headers.set("Referrer-Policy", "same-origin");
    }
    return withSecurityHeaders(response);
  };
}
