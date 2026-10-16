import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types.js';
import { loadAuditDetail } from '$lib/server/loaders/audit.js';

export const load: PageServerLoad = ({ locals, params }) => {
	const id = Number(params.id);
	if (!Number.isInteger(id) || id <= 0) throw redirect(302, '/audit');
	return loadAuditDetail(locals, id);
};
