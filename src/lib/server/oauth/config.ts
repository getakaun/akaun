// The scope strings, and what each expands to, live in
// `$lib/permissions/oauth-scopes.ts` so the consent page can read them too.
export {
  DELETE_SCOPES,
  OAUTH_SCOPES,
  READ_SCOPES,
  WRITE_RESOURCES,
  WRITE_SCOPES,
  type OAuthScope,
} from "$lib/permissions/oauth-scopes.js";
export type OAuthConfig = { issuer: string; resource: string };

/** Public identity is configuration, never caller-controlled Host headers. */
export function oauthConfig(
  env: Record<string, string | undefined>,
): OAuthConfig | null {
  if (env.OAUTH_ENABLED !== "true") return null;
  const base = env.PUBLIC_BASE_URL || env.ORIGIN;
  if (!base) throw new Error("OAuth requires PUBLIC_BASE_URL or ORIGIN");
  const url = new URL(base);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error(
      "OAuth public URL must be an HTTPS origin (HTTP loopback is allowed)",
    );
  if (env.ORIGIN && new URL(env.ORIGIN).origin !== url.origin)
    throw new Error("OAuth PUBLIC_BASE_URL must match ORIGIN");
  if (env.AUTH_ISSUER && env.AUTH_ISSUER.replace(/\/$/, "") !== url.origin)
    throw new Error("OAuth AUTH_ISSUER must match the public origin");
  const resource = `${url.origin}/mcp`;
  if (env.MCP_RESOURCE && env.MCP_RESOURCE !== resource)
    throw new Error("OAuth MCP_RESOURCE must be the public /mcp URL");
  return { issuer: url.origin, resource };
}

export function mcpChallenge(config: OAuthConfig | null, invalid = false) {
  return (
    'Bearer realm="akaun-mcp"' +
    (config
      ? `, resource_metadata="${config.issuer}/.well-known/oauth-protected-resource/mcp"`
      : "") +
    (invalid ? ', error="invalid_token"' : "")
  );
}
