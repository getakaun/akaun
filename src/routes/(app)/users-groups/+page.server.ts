import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types.js';
import { can } from '$lib/server/permissions.js';

export const load: PageServerLoad = async ({ locals }) => {
	if (!can(locals, 'users.manage')) throw redirect(302, '/');
	// Data is loaded client-side via /api/users and /api/groups
	return {};
};
