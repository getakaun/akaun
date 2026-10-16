import { eq } from "drizzle-orm";
import {
  expandAll,
  isDelegable,
  isPermission,
  leafMeta,
  sortLeaves,
  type LeafPermission,
} from "$lib/permissions/catalog.js";
import {
  groupDelegations,
  groupGrants,
  groups,
  userGrants,
  userGroups,
  users,
} from "../db/schema.js";
import type { LedgerDb } from "../ledger/types.js";
import { fail, ok, type AppResult } from "../application/result.js";
import { diffRecords, recordAudit, type FieldChange } from "../audit.js";

/**
 * Reading and saving what a group or a user is granted, for Users & Groups.
 *
 * Everything is stored as leaves (`invoices.issue`), in catalog order: the
 * screens edit leaves, and a stored root would silently widen when a leaf is
 * added to it later. `can()` and `expandAll` still understand a root, so a
 * hand-written one keeps working.
 */

export type GroupAccess = {
  grants: LeafPermission[];
  delegations: LeafPermission[];
};

/** Unknown strings, and leaves only a superuser holds, are refused. */
function validLeaves(
  permissions: unknown,
  label: string,
): AppResult<LeafPermission[]> {
  if (
    !Array.isArray(permissions) ||
    permissions.some((p) => typeof p !== "string")
  )
    return fail("INVALID_INPUT", `${label} must be a list of permissions.`);
  const unknown = (permissions as string[]).filter((p) => !isPermission(p));
  if (unknown.length)
    return fail("INVALID_INPUT", `Unknown permission: ${unknown.join(", ")}.`);
  const leaves = expandAll(permissions as string[]);
  const reserved = [...leaves].filter((leaf) => leafMeta(leaf).superuserOnly);
  if (reserved.length)
    return fail(
      "INVALID_INPUT",
      `${reserved.join(", ")} belongs to superuser groups only.`,
    );
  return ok(sortLeaves(leaves));
}

/**
 * What a group may delegate, cut down to what it grants and what may be
 * delegated at all. Reducing a group's grants reduces its ceiling with it, in
 * the same save — a ceiling can never name something the group cannot do.
 */
export function trimDelegations(
  grants: Iterable<LeafPermission>,
  delegations: Iterable<LeafPermission>,
): LeafPermission[] {
  const granted = new Set(grants);
  return sortLeaves(
    [...delegations].filter((leaf) => granted.has(leaf) && isDelegable(leaf)),
  );
}

export function readGroupAccess(db: LedgerDb, groupId: number): GroupAccess {
  const grants = db
    .select({ permission: groupGrants.permission })
    .from(groupGrants)
    .where(eq(groupGrants.groupId, groupId))
    .all()
    .map((row) => row.permission);
  const delegations = db
    .select({ permission: groupDelegations.permission })
    .from(groupDelegations)
    .where(eq(groupDelegations.groupId, groupId))
    .all()
    .map((row) => row.permission);
  return {
    grants: sortLeaves(expandAll(grants)),
    delegations: sortLeaves(expandAll(delegations)),
  };
}

export function saveGroupAccess(
  db: LedgerDb,
  groupId: number,
  body: { grants: unknown; delegations: unknown },
  /** Who made the change, for the audit log. */
  actorId: number,
): AppResult<GroupAccess> {
  const group = db.select().from(groups).where(eq(groups.id, groupId)).get();
  if (!group) return fail("NOT_FOUND", "That group no longer exists.");
  if (group.isSuperuser)
    return fail(
      "REFUSED",
      "A superuser group holds every permission; there is nothing to grant it.",
    );
  const grants = validLeaves(body.grants, "Grants");
  if (!grants.ok) return grants;
  const delegations = validLeaves(body.delegations ?? [], "Delegations");
  if (!delegations.ok) return delegations;
  const ceiling = trimDelegations(grants.value, delegations.value);

  db.transaction((tx) => {
    const before = groupAuditSnapshot(tx, groupId);
    tx.delete(groupGrants).where(eq(groupGrants.groupId, groupId)).run();
    tx.delete(groupDelegations)
      .where(eq(groupDelegations.groupId, groupId))
      .run();
    if (grants.value.length)
      tx.insert(groupGrants)
        .values(grants.value.map((permission) => ({ groupId, permission })))
        .run();
    if (ceiling.length)
      tx.insert(groupDelegations)
        .values(ceiling.map((permission) => ({ groupId, permission })))
        .run();
    auditGroup(tx, actorId, groupId, before, groupAuditSnapshot(tx, groupId));
  });
  return ok({ grants: grants.value, delegations: ceiling });
}

export function readUserGrants(db: LedgerDb, userId: number): LeafPermission[] {
  return sortLeaves(
    expandAll(
      db
        .select({ permission: userGrants.permission })
        .from(userGrants)
        .where(eq(userGrants.userId, userId))
        .all()
        .map((row) => row.permission),
    ),
  );
}

export function saveUserGrants(
  db: LedgerDb,
  userId: number,
  permissions: unknown,
  /** Who made the change, for the audit log. */
  actorId: number,
): AppResult<LeafPermission[]> {
  const grants = validLeaves(permissions, "Grants");
  if (!grants.ok) return grants;
  db.transaction((tx) => {
    const before = userAuditSnapshot(tx, userId);
    tx.delete(userGrants).where(eq(userGrants.userId, userId)).run();
    if (grants.value.length)
      tx.insert(userGrants)
        .values(grants.value.map((permission) => ({ userId, permission })))
        .run();
    auditUser(tx, actorId, userId, before, userAuditSnapshot(tx, userId));
  });
  return ok(grants.value);
}

export type MembershipView = { id: number; name: string; isSuperuser: boolean };

export function memberships(db: LedgerDb, userId: number): MembershipView[] {
  return db
    .select({
      id: groups.id,
      name: groups.name,
      isSuperuser: groups.isSuperuser,
    })
    .from(userGroups)
    .innerJoin(groups, eq(userGroups.groupId, groups.id))
    .where(eq(userGroups.userId, userId))
    .all();
}

/**
 * A change Users & Groups is about to make, as it touches who is a superuser:
 * a group losing its superuser switch, one user's groups replaced, or a user
 * deleted.
 */
export type SuperuserChange =
  | { demoteGroupId: number }
  | { userId: number; groupIds: number[] }
  | { deleteUserId: number };

/**
 * The one group Users & Groups never changes or deletes: the superuser group
 * a new installation starts with, so there is always a known way to manage
 * users. Every other group, default or not, is the administrator's to edit.
 */
export const PROTECTED_GROUP = "Administrators";

export const LAST_SUPERUSER_MESSAGE =
  "At least one user must stay in a superuser group, or nobody could manage users and groups.";

/**
 * Whether someone could still manage users and groups after `change`.
 *
 * Administrators is protected, but its members are not: removing every user
 * from it, or emptying another superuser group, could still leave nobody with
 * `users.manage` — locking everyone out with no way back short of editing the
 * database.
 */
export function keepsASuperuser(db: LedgerDb, change: SuperuserChange): boolean {
  const superGroups = new Set(
    db
      .select({ id: groups.id })
      .from(groups)
      .where(eq(groups.isSuperuser, true))
      .all()
      .map((g) => g.id),
  );
  if ("demoteGroupId" in change) superGroups.delete(change.demoteGroupId);
  let rows = db
    .select({ userId: userGroups.userId, groupId: userGroups.groupId })
    .from(userGroups)
    .all();
  if ("deleteUserId" in change)
    rows = rows.filter((r) => r.userId !== change.deleteUserId);
  if ("userId" in change)
    rows = [
      ...rows.filter((r) => r.userId !== change.userId),
      ...change.groupIds.map((groupId) => ({ userId: change.userId, groupId })),
    ];
  return rows.some((r) => superGroups.has(r.groupId));
}

/** A group as Users & Groups shows it. */
export function groupView(db: LedgerDb, groupRow: typeof groups.$inferSelect) {
  const memberCount = db
    .select({ userId: userGroups.userId })
    .from(userGroups)
    .where(eq(userGroups.groupId, groupRow.id))
    .all().length;
  return {
    id: groupRow.id,
    name: groupRow.name,
    description: groupRow.description,
    isSuperuser: !!groupRow.isSuperuser,
    locked: groupRow.name === PROTECTED_GROUP,
    ...readGroupAccess(db, groupRow.id),
    memberCount,
  };
}

// ---------------------------------------------------------------------------
// Audit. Users & Groups writes straight from its routes, so each route takes a
// snapshot before and after its write — inside the same transaction — and
// hands both here. A snapshot holds what an administrator would want to see
// changed, and never a password hash.
// ---------------------------------------------------------------------------

export type UserAuditSnapshot = {
  name: string | null;
  email: string;
  username: string;
  groups: string[];
  grants: LeafPermission[];
};

export function userAuditSnapshot(
  db: LedgerDb,
  userId: number,
): UserAuditSnapshot | null {
  const user = db
    .select({ name: users.name, email: users.email, username: users.username })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  if (!user) return null;
  return {
    ...user,
    groups: memberships(db, userId)
      .map((m) => m.name)
      .sort(),
    grants: readUserGrants(db, userId),
  };
}

export type GroupAuditSnapshot = {
  name: string;
  description: string;
  isSuperuser: boolean;
} & GroupAccess;

export function groupAuditSnapshot(
  db: LedgerDb,
  groupId: number,
): GroupAuditSnapshot | null {
  const group = db
    .select({
      name: groups.name,
      description: groups.description,
      isSuperuser: groups.isSuperuser,
    })
    .from(groups)
    .where(eq(groups.id, groupId))
    .get();
  return group ? { ...group, ...readGroupAccess(db, groupId) } : null;
}

function actionOf(before: unknown, after: unknown) {
  return before === null ? "create" : after === null ? "delete" : "update";
}

/**
 * `extra` carries a change no snapshot can show, such as a new password —
 * recorded as a field whose value the log redacts.
 */
export function auditUser(
  db: LedgerDb,
  actorId: number,
  userId: number,
  before: UserAuditSnapshot | null,
  after: UserAuditSnapshot | null,
  extra: FieldChange[] = [],
): void {
  recordAudit(db, {
    recordType: "user",
    recordId: userId,
    userId: actorId,
    action: actionOf(before, after),
    changes: [...diffRecords(before, after), ...extra],
    label: (after ?? before)?.name || (after ?? before)?.username,
  });
}

export function auditGroup(
  db: LedgerDb,
  actorId: number,
  groupId: number,
  before: GroupAuditSnapshot | null,
  after: GroupAuditSnapshot | null,
): void {
  recordAudit(db, {
    recordType: "group",
    recordId: groupId,
    userId: actorId,
    action: actionOf(before, after),
    changes: diffRecords(before, after),
    label: (after ?? before)?.name,
  });
}
