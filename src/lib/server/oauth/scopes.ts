import type { RoleAccess } from "../permissions.js";
import {
  OAUTH_SCOPES,
  SCOPE_PERMISSIONS,
  type OAuthScope,
} from "$lib/permissions/oauth-scopes.js";

export type ScopeAvailability = {
  scope: OAuthScope;
  allowed: boolean;
  /** Why it cannot be chosen, when it cannot. */
  reason: "role" | "ceiling" | null;
};

/**
 * Which scopes the signed-in user could grant an app, and why not where not.
 * A scope can be granted when something it stands for is in what the user may
 * delegate — their role ∩ their groups' ceiling. "role": the user cannot do
 * it at all; "ceiling": they can, but their administrator does not let them
 * hand it on.
 */
export function scopeAvailability(role: RoleAccess): ScopeAvailability[] {
  return OAUTH_SCOPES.map((scope) => {
    const leaves = SCOPE_PERMISSIONS[scope];
    if (leaves.some((leaf) => role.delegable.has(leaf)))
      return { scope, allowed: true, reason: null };
    return {
      scope,
      allowed: false,
      reason: leaves.some((leaf) => role.leaves.has(leaf)) ? "ceiling" : "role",
    };
  });
}

export function allowedScopes(role: RoleAccess): OAuthScope[] {
  return scopeAvailability(role)
    .filter((entry) => entry.allowed)
    .map((entry) => entry.scope);
}
