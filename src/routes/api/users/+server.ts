import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { hash } from 'argon2';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db/client.js';
import { users, userGroups } from '$lib/server/db/schema.js';
import { can } from '$lib/server/permissions.js';
import {
	auditUser,
	memberships,
	readUserGrants,
	userAuditSnapshot
} from '$lib/server/admin/access.js';
import { listTokens } from '$lib/server/tokens/manage.js';

export const GET: RequestHandler = async ({ locals }) => {
	if (!can(locals, 'users.manage')) return new Response('Forbidden', { status: 403 });

	const allUsers = db.select().from(users).all();

	const result = allUsers.map((u) => {
		const groupsOf = memberships(db, u.id);
		return {
			id: u.id,
			name: u.name,
			email: u.email,
			username: u.username,
			tokenCount: listTokens(db, u.id).length,
			groups: groupsOf.map((m) => ({ id: m.id, name: m.name })),
			isSuperuser: groupsOf.some((m) => m.isSuperuser),
			extraGrants: readUserGrants(db, u.id),
			createdAt: u.createdAt
		};
	});

	return json(result);
};

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!can(locals, 'users.manage')) return new Response('Forbidden', { status: 403 });

	const body = await request.json();
	const { name, email, username, password, groupIds = [] } = body;

	if (!email || !username || !password) {
		return json({ error: 'email, username and password are required' }, { status: 400 });
	}

	const existing = db.select({ id: users.id }).from(users).where(eq(users.email, email)).get();
	if (existing) return json({ error: 'Email already in use' }, { status: 409 });

	const passwordHash = await hash(password);
	const newUser = db.transaction((tx) => {
		const [created] = tx
			.insert(users)
			.values({ email, username, name: name || null, passwordHash, role: 'user' })
			.returning({ id: users.id })
			.all();

		if (groupIds.length > 0) {
			tx.insert(userGroups)
				.values(groupIds.map((gid: number) => ({ userId: created.id, groupId: gid })))
				.run();
		}
		auditUser(tx, locals.user!.id, created.id, null, userAuditSnapshot(tx, created.id));
		return created;
	});

	return json({ id: newUser.id }, { status: 201 });
};
