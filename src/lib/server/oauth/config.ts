/**
 * What an MCP client can be granted. Three tiers per resource, each asked for
 * by name and each confirmed separately on the consent screen:
 *
 * - `:read` — what the user can view.
 * - `:write` — add and change. Never implied by a read grant.
 * - `:delete` — permanent removal, kept apart from `:write` so a client allowed
 *   to record things is not thereby allowed to destroy them.
 *
 * `reports` is read-only everywhere (CLAUDE.md, Permissions). `adjustments`
 * has no scope of its own: it is an RBAC-only extra under `records:write`, so
 * a client never holds more than the signed-in user can do.
 */
export const READ_SCOPES = [
  "records:read",
  "accounts:read",
  "contacts:read",
  "reports:read",
  "import:read",
  "invoices:read",
  "quotations:read",
  "reconciliation:read",
] as const;
export const WRITE_RESOURCES = [
  "records",
  "accounts",
  "contacts",
  "invoices",
  "quotations",
  "reconciliation",
  "import",
] as const;
export const WRITE_SCOPES = [
  "records:write",
  "accounts:write",
  "contacts:write",
  "invoices:write",
  "quotations:write",
  "reconciliation:write",
  "import:write",
] as const;
export const DELETE_SCOPES = [
  "records:delete",
  "accounts:delete",
  "contacts:delete",
  "invoices:delete",
  "quotations:delete",
  "reconciliation:delete",
  "import:delete",
] as const;
export const OAUTH_SCOPES = [
  ...READ_SCOPES,
  ...WRITE_SCOPES,
  ...DELETE_SCOPES,
] as const;
export type OAuthScope = (typeof OAUTH_SCOPES)[number];
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
