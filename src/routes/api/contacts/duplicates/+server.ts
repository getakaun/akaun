import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db/client.js';
import { findDuplicates } from '$lib/server/queries/contacts.js';
import { can } from '$lib/server/permissions.js';

export const GET: RequestHandler = async ({ locals }) => {
	if (!can(locals, 'contacts.read')) return new Response('Not Found', { status: 404 });
	return Response.json(findDuplicates(db));
};
