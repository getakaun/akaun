import { eq } from "drizzle-orm";
import {
  expandAll,
  isDelegable,
  leafMeta,
  type Permission,
} from "$lib/permissions/catalog.js";
import {
  groupDelegations,
  groupGrants,
  groups,
  userGroups,
  users,
} from "../db/schema.js";
import type { LedgerDb } from "../ledger/types.js";
import { getSetting, setSetting, SETTING_KEYS } from "../settings.js";

/**
 * The groups a new installation starts with, as permission strings from
 * `$lib/permissions/catalog.ts`. They are a starting point: once written,
 * Bookkeeper, Data Entry and Reviewer can be renamed, re-permissioned or
 * deleted on Users & Groups like any group, and a deleted one stays deleted.
 * Administrators is protected (`PROTECTED_GROUP`, `admin/access.ts`).
 *
 * `delegations` is what members may hand on to personal access tokens and
 * OAuth apps — the group's grants minus the sensitive ones, the same default
 * migration 0033 gives existing groups.
 *
 * `records.adjust` is deliberately absent: no seeded group may write a record
 * between any two accounts or add a third side. It is granted by name or not
 * at all (FR-031a).
 */
type SeedGroup = {
  name: string;
  description: string;
  isSuperuser: boolean;
  grants: Permission[];
};

const SEED_GROUPS: SeedGroup[] = [
  {
    name: "Administrators",
    description:
      "Unrestricted access to every area, including user management, backups and reset. Cannot be renamed or deleted.",
    isSuperuser: true,
    grants: [],
  },
  {
    name: "Bookkeeper",
    description: "Maintains day-to-day records across the shared ledger.",
    isSuperuser: false,
    grants: [
      "records.read",
      "records.create",
      "records.update",
      "import.read",
      "import.create",
      "contacts.read",
      "contacts.create",
      "contacts.update",
      "quotations.read",
      "quotations.create",
      "quotations.update",
      "quotations.revise",
      "quotations.convert",
      "invoices.read",
      "invoices.create",
      "invoices.update",
      "invoices.issue",
      "invoices.void",
      "reconciliation.read",
      "reconciliation.create",
      "reconciliation.update",
      "reconciliation.match",
      // A bookkeeper maintains the chart of accounts (the categories screen
      // writes here) but never deletes one.
      "accounts.read",
      "accounts.create",
      "accounts.update",
      "reports.read",
      "settings.read",
    ],
  },
  {
    name: "Data Entry",
    description:
      "Adds new records but cannot edit, claim or delete existing ones.",
    isSuperuser: false,
    // Adding a record must not let someone reshape the chart of accounts or
    // read the whole picture, so no accounts or reports.
    grants: [
      "records.create",
      "import.create",
      "contacts.read",
      "contacts.create",
      "quotations.create",
      "invoices.create",
      "settings.read",
    ],
  },
  {
    name: "Reviewer",
    description: "Read-only visibility across all financial records.",
    isSuperuser: false,
    grants: [
      "records.read",
      "import.read",
      "contacts.read",
      "quotations.read",
      "invoices.read",
      "reconciliation.read",
      "accounts.read",
      "reports.read",
      "settings.read",
    ],
  },
];

/** The default ceiling for a group's grants: everything but the sensitive. */
function defaultDelegations(grants: Permission[]): Permission[] {
  return grants.filter(
    (permission) =>
      permission.startsWith("settings.") === false &&
      [...expandAll([permission])].every(
        (leaf) => !leafMeta(leaf).sensitive && isDelegable(leaf),
      ),
  );
}

type Log = { info: (fields: object, message: string) => void };

/**
 * Writes the default groups the first time, and makes sure someone can
 * manage users.
 *
 * Groups are seeded **once**. This used to run on every boot and re-create
 * any default group missing by name, so a deleted Reviewer came back at the
 * next restart. Now a book that has never been seeded gets the defaults only
 * if it has no groups at all, and either way it is marked seeded and never
 * touched again.
 */
export function seedGroups(db: LedgerDb, log?: Log): void {
  if (getSetting(db, SETTING_KEYS.groupsSeeded) === null) {
    const anyGroup = db.select({ id: groups.id }).from(groups).get();
    if (!anyGroup) {
      for (const seed of SEED_GROUPS) {
        const group = db
          .insert(groups)
          .values({
            name: seed.name,
            description: seed.description,
            isSuperuser: seed.isSuperuser,
          })
          .returning({ id: groups.id })
          .get();
        if (!seed.isSuperuser && seed.grants.length > 0) {
          db.insert(groupGrants)
            .values(
              seed.grants.map((permission) => ({
                groupId: group.id,
                permission,
              })),
            )
            .run();
          const delegations = defaultDelegations(seed.grants);
          if (delegations.length > 0)
            db.insert(groupDelegations)
              .values(
                delegations.map((permission) => ({
                  groupId: group.id,
                  permission,
                })),
              )
              .run();
        }
        log?.info({ group: seed.name }, "Seeded default group");
      }
    }
    setSetting(db, SETTING_KEYS.groupsSeeded, "1");
  }

  // Bootstrap only: while nobody belongs to a superuser group, the users who
  // exist (the default admin of a fresh install, or every user of a book from
  // before groups) join the first superuser group so someone can manage the
  // rest: the first superuser group, which on a seeded book is Administrators.
  //
  // It used to run on every boot for every user without a group, which turned
  // a user an administrator had locked out by removing all their groups — a
  // state Users & Groups offers as "deactivated, not deleted" — into a
  // superuser on the next restart.
  const hasSuperuser = db
    .select({ userId: userGroups.userId })
    .from(userGroups)
    .innerJoin(groups, eq(groups.id, userGroups.groupId))
    .where(eq(groups.isSuperuser, true))
    .get();
  if (hasSuperuser) return;
  const adminGroup = db
    .select({ id: groups.id, name: groups.name })
    .from(groups)
    .where(eq(groups.isSuperuser, true))
    .orderBy(groups.id)
    .get();
  if (!adminGroup) return;

  const grouped = new Set(
    db
      .select({ userId: userGroups.userId })
      .from(userGroups)
      .all()
      .map((m) => m.userId),
  );
  for (const u of db.select({ id: users.id }).from(users).all()) {
    if (grouped.has(u.id)) continue;
    db.insert(userGroups)
      .values({ userId: u.id, groupId: adminGroup.id })
      .run();
    log?.info(
      { userId: u.id, group: adminGroup.name },
      "Assigned ungrouped user to the superuser group",
    );
  }
}
