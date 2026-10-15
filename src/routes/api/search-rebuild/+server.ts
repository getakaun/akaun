import { can } from '$lib/server/permissions.js';
import { json } from '@sveltejs/kit';
import { startRebuild } from '$lib/server/search-rebuild/worker.js';
import type { RequestHandler } from './$types.js';

export const POST: RequestHandler = async ({ locals }) => {
	if (!locals.user) return new Response('Unauthorized', { status: 401 });
	// Rebuilding the search index is maintenance, started from Settings.
	if (!can(locals, 'settings.manage')) return new Response('Forbidden', { status: 403 });

	const status = startRebuild();
	return json(status, { status: 202 });
};
