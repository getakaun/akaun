import { eq, inArray } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import * as schema from "./db/schema.js";
import {
  groupDelegations,
  groupGrants,
  groups,
  userGrants,
  userGroups,
} from "./db/schema.js";
import {
  expandAll,
  isDelegable,
  LEAF_PERMISSIONS,
  leafMeta,
  type LeafPermission,
} from "$lib/permissions/catalog.js";

type Db = BunSQLiteDatabase<typeof schema>;

/**
 * Who may do what — in three layers, worked out once per request:
 *
 *   role        what the user's groups and own grants allow (a superuser: all)
 *   ∩ ceiling   what those groups let members hand on to tokens and apps
 *   ∩ credential what the token or app was itself granted
 *
 * The last two apply only when the request carries a personal access token
 * or an OAuth token; a signed-in browser acts with the whole role. Because the
 * intersection is taken on every request, removing a permission from a group,
 * or narrowing its ceiling, takes effect on every token at once — nothing
 * stored on the token needs rewriting.
 *
 * The superuser shortcut is inside "role", so a superuser's token is still
 * bounded by what the token was granted.
 */

export type RoleAccess = {
  isSuperuser: boolean;
  /** Everything the user may do in their own session. */
  leaves: ReadonlySet<LeafPermission>;
  /** What the user may hand on to a token or an app. Always ⊆ `leaves`. */
  delegable: ReadonlySet<LeafPermission>;
};

const NO_ACCESS: RoleAccess = {
  isSuperuser: false,
  leaves: new Set(),
  delegable: new Set(),
};

const ALL_DELEGABLE: ReadonlySet<LeafPermission> = new Set(
  LEAF_PERMISSIONS.filter(isDelegable),
);
const SUPERUSER_ACCESS: RoleAccess = {
  isSuperuser: true,
  leaves: new Set(LEAF_PERMISSIONS),
  delegable: ALL_DELEGABLE,
};

/** A superuser-only leaf (`users.manage`) never comes from a grant. */
function grantable(leaves: Set<LeafPermission>): Set<LeafPermission> {
  for (const leaf of leaves)
    if (leafMeta(leaf).superuserOnly) leaves.delete(leaf);
  return leaves;
}

export function loadRoleAccess(db: Db, userId: number): RoleAccess {
  const memberships = db
    .select({ groupId: userGroups.groupId, isSuperuser: groups.isSuperuser })
    .from(userGroups)
    .innerJoin(groups, eq(groups.id, userGroups.groupId))
    .where(eq(userGroups.userId, userId))
    .all();
  if (memberships.some((m) => m.isSuperuser)) return SUPERUSER_ACCESS;
  const extra = db
    .select({ permission: userGrants.permission })
    .from(userGrants)
    .where(eq(userGrants.userId, userId))
    .all()
    .map((row) => row.permission);
  if (memberships.length === 0 && extra.length === 0) return NO_ACCESS;

  const groupIds = memberships.map((m) => m.groupId);
  const grantRows = groupIds.length
    ? db
        .select()
        .from(groupGrants)
        .where(inArray(groupGrants.groupId, groupIds))
        .all()
    : [];
  const delegationRows = groupIds.length
    ? db
        .select()
        .from(groupDelegations)
        .where(inArray(groupDelegations.groupId, groupIds))
        .all()
    : [];

  const leaves = grantable(
    expandAll([...grantRows.map((row) => row.permission), ...extra]),
  );

  // Each group may delegate only what it itself grants: the union over groups
  // of (that group's ceiling ∩ that group's grants). A user's own extra grants
  // are never delegable — they were given to the person, not to their tools.
  const delegable = new Set<LeafPermission>();
  for (const groupId of groupIds) {
    const granted = expandAll(
      grantRows.filter((r) => r.groupId === groupId).map((r) => r.permission),
    );
    for (const leaf of expandAll(
      delegationRows
        .filter((r) => r.groupId === groupId)
        .map((r) => r.permission),
    ))
      if (granted.has(leaf) && leaves.has(leaf) && isDelegable(leaf))
        delegable.add(leaf);
  }
  return { isSuperuser: false, leaves, delegable };
}

/**
 * What a request may do. Pure, so the layering is tested on its own.
 *
 * `credential` absent: a browser session, with the whole role. Present: the
 * token's or app's own permissions, expanded, ∩ what the role may delegate.
 */
export function effectivePermissions(
  role: RoleAccess,
  credential?: Iterable<string> | null,
): ReadonlySet<LeafPermission> {
  if (credential === undefined || credential === null) return role.leaves;
  const granted = expandAll(credential);
  const effective = new Set<LeafPermission>();
  for (const leaf of granted) if (role.delegable.has(leaf)) effective.add(leaf);
  return effective;
}

/** Everything a request's locals need about who it is and what it may do. */
export function resolveAccess(
  db: Db,
  userId: number,
  credential?: Iterable<string> | null,
): { role: RoleAccess; permissions: ReadonlySet<LeafPermission> } {
  const role = loadRoleAccess(db, userId);
  return { role, permissions: effectivePermissions(role, credential) };
}

export function can(locals: App.Locals, permission: LeafPermission): boolean {
  return locals.user !== null && (locals.permissions?.has(permission) ?? false);
}

export function canAll(
  locals: App.Locals,
  permissions: readonly LeafPermission[],
): boolean {
  return permissions.every((permission) => can(locals, permission));
}

/** One complete authorization route, never a mixture of partial routes. */
export function canAny(
  locals: App.Locals,
  alternatives: readonly (readonly LeafPermission[])[],
): boolean {
  return alternatives.some((permissions) => canAll(locals, permissions));
}
