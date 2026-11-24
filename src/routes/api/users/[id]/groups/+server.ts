import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { and, eq } from 'drizzle-orm';
import { db } from '$lib/server/db/client.js';
import { users, userGroups, groups } from '$lib/server/db/schema.js';
import { keepsRecoveryAdministrator } from '$lib/server/oidc/settings.js';
import { can } from '$lib/server/permissions.js';
import {
	auditUser,
	keepsASuperuser,
	LAST_SUPERUSER_MESSAGE,
	userAuditSnapshot
} from '$lib/server/admin/access.js';

export const GET: RequestHandler = async ({ locals, params }) => {
	if (!can(locals, 'users.manage')) return new Response('Forbidden', { status: 403 });

	const userId = parseInt(params.id);
	const memberships = db
		.select({ id: groups.id, name: groups.name, isSuperuser: groups.isSuperuser })
		.from(userGroups)
		.innerJoin(groups, eq(userGroups.groupId, groups.id))
		.where(eq(userGroups.userId, userId))
		.all();

	return json(memberships);
};

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	if (!can(locals, 'users.manage')) return new Response('Forbidden', { status: 403 });

	const userId = parseInt(params.id);
	const user = db.select({ id: users.id }).from(users).where(eq(users.id, userId)).get();
	if (!user) return new Response('Not Found', { status: 404 });

	const body = await request.json();
  const selection = body.groupIds ?? [];
  if (!Array.isArray(selection) || !selection.every((id: unknown) => Number.isSafeInteger(id) && Number(id) > 0))
    return json({ error: 'Select existing groups.' }, { status: 400 });
  const groupIds = [...new Set<number>(selection)];
  const problem = db.transaction((tx) => {
    const change = { userId, groupIds };
    if (!keepsASuperuser(tx, change)) return LAST_SUPERUSER_MESSAGE;
    if (!keepsRecoveryAdministrator(tx, change)) return 'Keep at least one enabled recovery administrator.';
    const before = userAuditSnapshot(tx, userId);
    const current = tx.select().from(userGroups).where(eq(userGroups.userId, userId)).all();
    for (const { groupId } of current) {
      if (!groupIds.includes(groupId))
        tx.delete(userGroups).where(and(eq(userGroups.userId, userId), eq(userGroups.groupId, groupId))).run();
    }
    const additions = groupIds.filter((groupId) => !current.some((row) => row.groupId === groupId));
    if (additions.length) tx.insert(userGroups).values(additions.map((groupId) => ({ userId, groupId }))).run();
    auditUser(tx, locals.user!.id, userId, before, userAuditSnapshot(tx, userId));
    return null;
  }, { behavior: 'immediate' });
  return problem ? json({ error: problem }, { status: 400 }) : json({ success: true });
};
