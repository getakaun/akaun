import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db/client.js';
import { mergeContacts } from '$lib/server/services/contacts.js';
import { can } from '$lib/server/permissions.js';

export const POST: RequestHandler = async ({ locals, request }) => {
	// Merge repoints records AND hard-deletes losers → needs both change and delete.
	if (!can(locals, 'contacts.merge') ||
      !can(locals, 'contacts.update') ||
      !can(locals, 'contacts.delete')) {
		return new Response('Forbidden', { status: 403 });
	}
	const user = locals.user!;
	const body = await request.json();

	const survivorId = Number(body.survivorId);
	const loserIds: number[] = Array.isArray(body.loserIds) ? body.loserIds.map(Number) : [];

	if (!survivorId || loserIds.length === 0 || loserIds.includes(survivorId) || loserIds.some(Number.isNaN)) {
		return Response.json({ error: 'Invalid survivorId / loserIds' }, { status: 400 });
	}

	const survivor = mergeContacts(db, survivorId, loserIds, user.id);
	if (!survivor) return Response.json({ error: 'Survivor not found' }, { status: 404 });
	return Response.json(survivor);
};
