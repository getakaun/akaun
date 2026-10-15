import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { hash } from 'argon2';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db/client.js';
import { oauth } from '$lib/server/oauth/runtime.js';
import { users } from '$lib/server/db/schema.js';
import { can } from '$lib/server/permissions.js';
import {
	keepsASuperuser,
	LAST_SUPERUSER_MESSAGE,
	memberships,
	readUserGrants
} from '$lib/server/admin/access.js';
import { listTokens, revokeAllTokens } from '$lib/server/tokens/manage.js';

export const GET: RequestHandler = async ({ locals, params }) => {
	if (!can(locals, 'users.manage')) return new Response('Forbidden', { status: 403 });

	const userId = parseInt(params.id);
	const user = db.select().from(users).where(eq(users.id, userId)).get();
	if (!user) return new Response('Not Found', { status: 404 });

	const groupsOf = memberships(db, userId);
	return json({
		id: user.id,
		name: user.name,
		email: user.email,
		username: user.username,
		tokenCount: listTokens(db, userId).length,
		groups: groupsOf.map((m) => ({ id: m.id, name: m.name })),
		isSuperuser: groupsOf.some((m) => m.isSuperuser),
		extraGrants: readUserGrants(db, userId),
		createdAt: user.createdAt
	});
};

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	if (!can(locals, 'users.manage')) return new Response('Forbidden', { status: 403 });

	const userId = parseInt(params.id);
	const user = db.select({ id: users.id }).from(users).where(eq(users.id, userId)).get();
	if (!user) return new Response('Not Found', { status: 404 });

	const body = await request.json();
	const patch: Record<string, unknown> = {};

	if (body.name !== undefined) patch.name = body.name || null;
	if (body.email) patch.email = body.email;
	if (body.username) patch.username = body.username;
	if (body.password) patch.passwordHash = await hash(body.password);

	if (Object.keys(patch).length > 0) {
		db.update(users).set(patch).where(eq(users.id, userId)).run();
		// A new password ends every way in that the old one could have set up:
		// connected apps and personal access tokens alike.
		if (body.password) {
			oauth?.revokeUser(userId);
			revokeAllTokens(db, userId);
		}
	}
	return json({ success: true });
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
	if (!can(locals, 'users.manage')) return new Response('Forbidden', { status: 403 });

	const userId = parseInt(params.id);
	if (locals.user?.id === userId) {
		return json({ error: 'Cannot delete your own account' }, { status: 400 });
	}

	const user = db.select({ id: users.id }).from(users).where(eq(users.id, userId)).get();
	if (!user) return new Response('Not Found', { status: 404 });

	if (!keepsASuperuser(db, { deleteUserId: userId }))
		return json({ error: LAST_SUPERUSER_MESSAGE }, { status: 400 });

	db.delete(users).where(eq(users.id, userId)).run();
	return json({ success: true });
};
