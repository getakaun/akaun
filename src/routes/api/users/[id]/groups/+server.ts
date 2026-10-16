import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db/client.js';
import { users, userGroups, groups } from '$lib/server/db/schema.js';
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
	const groupIds: number[] = body.groupIds ?? [];
	if (!keepsASuperuser(db, { userId, groupIds }))
		return json({ error: LAST_SUPERUSER_MESSAGE }, { status: 400 });

	// Replace all memberships atomically
	db.transaction((tx) => {
		const before = userAuditSnapshot(tx, userId);
		tx.delete(userGroups).where(eq(userGroups.userId, userId)).run();
		if (groupIds.length > 0) {
			tx.insert(userGroups)
				.values(groupIds.map((gid) => ({ userId, groupId: gid })))
				.run();
		}
		auditUser(tx, locals.user!.id, userId, before, userAuditSnapshot(tx, userId));
	});

	return json({ success: true });
};
