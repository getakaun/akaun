import type { PageServerLoad } from './$types.js';
import { loadAuditPage } from '$lib/server/loaders/audit.js';

export const load: PageServerLoad = ({ locals, url }) => loadAuditPage(locals, url);
