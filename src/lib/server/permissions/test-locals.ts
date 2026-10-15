import {
  groupDelegations,
  groupGrants,
  groups,
  userGroups,
} from "../db/schema.js";
import type { LedgerDb } from "../ledger/types.js";
import { effectivePermissions, type RoleAccess } from "../permissions.js";
import {
  expandAll,
  isDelegable,
  LEAF_PERMISSIONS,
  type LeafPermission,
} from "$lib/permissions/catalog.js";
import { createToken } from "../tokens/manage.js";
import { loadRoleAccess } from "../permissions.js";

/**
 * Locals for a spec, without a database: what a request would carry for a
 * user with exactly these permissions. `superuser` holds everything; a
 * `credential` (a token's or an app's permissions) is intersected the way a
 * real request's is.
 */
export function localsFor(
  permissions: Iterable<string>,
  options: {
    userId?: number;
    superuser?: boolean;
    /** What the role may delegate; defaults to everything it holds. */
    delegable?: Iterable<string>;
    credential?: Iterable<string>;
  } = {},
): App.Locals {
  const leaves = options.superuser
    ? new Set<LeafPermission>(LEAF_PERMISSIONS)
    : expandAll(permissions);
  const delegable = new Set(
    [...(options.delegable ? expandAll(options.delegable) : leaves)].filter(
      (leaf) => leaves.has(leaf) && isDelegable(leaf),
    ),
  );
  const role: RoleAccess = {
    isSuperuser: options.superuser ?? false,
    leaves,
    delegable,
  };
  return {
    user: {
      id: options.userId ?? 1,
      email: "u@test",
      username: "u",
      name: null,
      role: "user",
    },
    role,
    permissions: new Set(effectivePermissions(role, options.credential)),
  };
}

/** Puts a user in a new group that grants (and lets them delegate) these permissions. */
export function grantGroup(
  db: LedgerDb,
  args: {
    name: string;
    userIds: number[];
    grants: string[];
    /** Defaults to every grant. */
    delegations?: string[];
    superuser?: boolean;
  },
): number {
  const group = db
    .insert(groups)
    .values({ name: args.name, isSuperuser: args.superuser ?? false })
    .returning({ id: groups.id })
    .get();
  if (args.grants.length)
    db.insert(groupGrants)
      .values(
        args.grants.map((permission) => ({ groupId: group.id, permission })),
      )
      .run();
  const delegations = args.delegations ?? args.grants;
  if (delegations.length)
    db.insert(groupDelegations)
      .values(
        delegations.map((permission) => ({ groupId: group.id, permission })),
      )
      .run();
  if (args.userIds.length)
    db.insert(userGroups)
      .values(args.userIds.map((userId) => ({ userId, groupId: group.id })))
      .run();
  return group.id;
}

/** A personal access token for a spec, created as its owner would. */
export function issueTestToken(
  db: LedgerDb,
  userId: number,
  permissions: string[],
  name = `test-${permissions.join("-").slice(0, 40)}-${Math.random()}`,
): string {
  const created = createToken(db, {
    ownerId: userId,
    createdBy: userId,
    owner: loadRoleAccess(db, userId),
    input: { name, permissions, expiresOn: null },
  });
  if (!created.ok) throw new Error(created.reason);
  return created.value.token;
}
