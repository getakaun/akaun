import { and, eq, isNull } from "drizzle-orm";
import type { LedgerDb } from "../ledger/types.js";
import { groups, users, userGroups } from "../db/schema.js";
import { PROTECTED_GROUP } from "../admin/access.js";
import { publicOrigin, readAuthentication } from "./settings.js";
import { CALLBACK_PATH, SSO_PATH } from "./protocol.js";

export function authenticationAdminView(db: LedgerDb, env: NodeJS.ProcessEnv) {
  const settings = readAuthentication(db, env);
  const availableGroups = db
    .select()
    .from(groups)
    .orderBy(groups.name)
    .all()
    .map((group) => ({
      id: group.id,
      name: group.name,
      defaultAllowed: !group.isSuperuser && group.name !== PROTECTED_GROUP,
    }));
  const recoveryAccounts = db
    .selectDistinct({
      id: users.id,
      username: users.username,
      name: users.name,
    })
    .from(users)
    .innerJoin(userGroups, eq(userGroups.userId, users.id))
    .innerJoin(groups, eq(groups.id, userGroups.groupId))
    .where(
      and(
        eq(groups.isSuperuser, true),
        eq(users.disabled, false),
        isNull(users.oidcManagedBy),
      ),
    )
    .orderBy(users.username)
    .all();
  let origin = "";
  try {
    origin = publicOrigin(env).origin;
  } catch {
    // The administrator can set the public origin before enabling SSO.
  }
  return {
    settings: settings.stored,
    revision: settings.revision,
    hasSecret: !!settings.encryptedSecret,
    recoveryMode: settings.recoveryMode,
    callback: origin ? origin + CALLBACK_PATH : "",
    logout: origin ? origin + SSO_PATH + "/backchannel-logout" : "",
    groups: availableGroups,
    recoveryAccounts,
  };
}
