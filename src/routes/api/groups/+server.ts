import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { db } from '$lib/server/db/client.js';
import { groups } from '$lib/server/db/schema.js';
import { can } from '$lib/server/permissions.js';
import { groupView, PROTECTED_GROUP } from '$lib/server/admin/access.js';

/**
 * Groups, for Users & Groups. Every route here asks for `users.manage`, which
 * only a superuser group holds and no token or app can be given — so the
 * people who decide who may do what are always signed in themselves.
 */
export const GET: RequestHandler = async ({ locals }) => {
	if (!can(locals, 'users.manage')) return new Response('Forbidden', { status: 403 });
	return json(db.select().from(groups).all().map((g) => groupView(db, g)));
};

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!can(locals, 'users.manage')) return new Response('Forbidden', { status: 403 });

	const body = await request.json();
	const { name, description = '', isSuperuser = false } = body;
	if (!name) return json({ error: 'name is required' }, { status: 400 });
	if (String(name).trim() === PROTECTED_GROUP)
		return json({ error: `"${PROTECTED_GROUP}" is reserved.` }, { status: 400 });

	const [group] = db
		.insert(groups)
		.values({ name, description, isSuperuser: Boolean(isSuperuser) })
		.returning({ id: groups.id })
		.all();

	return json({ id: group.id }, { status: 201 });
};
