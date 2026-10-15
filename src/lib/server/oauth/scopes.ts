import {
  hasPermission,
  type ActionName,
  type ResourceName,
} from "../permissions.js";
import { OAUTH_SCOPES, type OAuthScope } from "./config.js";

function scopeGranted(locals: App.Locals, scope: string): boolean {
  return !locals.oauth || locals.oauth.scopes.includes(scope as OAuthScope);
}

export function canMcpRead(
  locals: App.Locals,
  resource: ResourceName,
): boolean {
  // This check must precede hasPermission's superuser shortcut.
  if (!scopeGranted(locals, `${resource}:read`)) return false;
  return hasPermission(locals, resource, "view");
}

/**
 * Whether an MCP client may do `action` on `resource`: the token's scope first
 * (before the superuser shortcut, as for reads), then the user's own ability.
 *
 * `delete` needs `:delete`; `add` and `change` need `:write`. `adjustments`
 * has no scope of its own — it rides on `records:write`, and the user's RBAC
 * alone decides it. Without OAuth (an API token) only RBAC applies; whether an
 * API token may write at all is decided by the MCP context, not here.
 */
export function canMcpWrite(
  locals: App.Locals,
  resource: ResourceName,
  action: Exclude<ActionName, "view">,
): boolean {
  if (resource === "adjustments") {
    if (!scopeGranted(locals, "records:write")) return false;
  } else if (
    !scopeGranted(locals, `${resource}:${action === "delete" ? "delete" : "write"}`)
  ) {
    return false;
  }
  return hasPermission(locals, resource, action);
}

/** The scopes the signed-in user could grant, for the consent screen. */
export function allowedScopes(locals: App.Locals): OAuthScope[] {
  return OAUTH_SCOPES.filter((scope) => {
    const [resource, tier] = scope.split(":") as [ResourceName, string];
    if (tier === "read") return hasPermission(locals, resource, "view");
    if (tier === "delete") return hasPermission(locals, resource, "delete");
    return (
      hasPermission(locals, resource, "add") ||
      hasPermission(locals, resource, "change")
    );
  });
}
