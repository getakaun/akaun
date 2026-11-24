import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db/client.js';
import { groups, userGroups } from '$lib/server/db/schema.js';
import { keepsRecoveryAdministrator } from '$lib/server/oidc/settings.js';
import { can } from '$lib/server/permissions.js';
import {
	auditGroup,
	groupAuditSnapshot,
	groupView,
	keepsASuperuser,
	LAST_SUPERUSER_MESSAGE,
	PROTECTED_GROUP
} from '$lib/server/admin/access.js';

export const GET: RequestHandler = async ({ locals, params }) => {
	if (!can(locals, 'users.manage')) return new Response('Forbidden', { status: 403 });

	const group = db.select().from(groups).where(eq(groups.id, parseInt(params.id))).get();
	if (!group) return new Response('Not Found', { status: 404 });
	return json(groupView(db, group));
};

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	if (!can(locals, 'users.manage')) return new Response('Forbidden', { status: 403 });

	const groupId = parseInt(params.id);
	const group = db.select().from(groups).where(eq(groups.id, groupId)).get();
	if (!group) return new Response('Not Found', { status: 404 });
	if (group.name === PROTECTED_GROUP) {
		return json({ error: 'Administrators group cannot be modified' }, { status: 400 });
	}

	const body = await request.json();
	const patch: Record<string, unknown> = {};
	if (body.name !== undefined) {
		const name = String(body.name).trim();
		if (!name) return json({ error: 'Give the group a name.' }, { status: 400 });
		if (name === PROTECTED_GROUP)
			return json({ error: `"${PROTECTED_GROUP}" is reserved.` }, { status: 400 });
		patch.name = name;
	}
	if (body.description !== undefined) patch.description = body.description;
	if (body.isSuperuser !== undefined) patch.isSuperuser = Boolean(body.isSuperuser);
  if (!Object.keys(patch).length) return json({ success: true });
  const problem = db.transaction((tx) => {
    if (patch.isSuperuser === false) {
      const change = { demoteGroupId: groupId };
      if (!keepsASuperuser(tx, change)) return LAST_SUPERUSER_MESSAGE;
      if (!keepsRecoveryAdministrator(tx, change)) return 'Keep at least one enabled recovery administrator.';
    }
    const before = groupAuditSnapshot(tx, groupId);
    tx.update(groups).set(patch).where(eq(groups.id, groupId)).run();
    auditGroup(tx, locals.user!.id, groupId, before, groupAuditSnapshot(tx, groupId));
    return null;
  }, { behavior: 'immediate' });
  return problem ? json({ error: problem }, { status: 400 }) : json({ success: true });
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
	if (!can(locals, 'users.manage')) return new Response('Forbidden', { status: 403 });

	const groupId = parseInt(params.id);
	const group = db.select().from(groups).where(eq(groups.id, groupId)).get();
	if (!group) return new Response('Not Found', { status: 404 });
	if (group.name === PROTECTED_GROUP) {
		return json({ error: 'Administrators group cannot be deleted' }, { status: 400 });
	}
	const members = db.select({ userId: userGroups.userId }).from(userGroups).where(eq(userGroups.groupId, groupId)).all();
	if (members.length > 0) {
		return json({ error: 'Cannot delete a group with members. Remove all members first.' }, { status: 400 });
	}

	db.transaction((tx) => {
		const before = groupAuditSnapshot(tx, groupId);
		tx.delete(groups).where(eq(groups.id, groupId)).run();
		auditGroup(tx, locals.user!.id, groupId, before, null);
	});
	return json({ success: true });
};
