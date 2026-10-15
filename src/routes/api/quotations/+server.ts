import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db/client.js';
import { listQuotations } from '$lib/server/queries/quotations.js';
import { createQuotation } from '$lib/server/application/sales.js';
import { toResponse } from '$lib/server/application/http.js';
import { can } from '$lib/server/permissions.js';


export const GET: RequestHandler = async ({ locals, url }) => {
	if (!can(locals, 'quotations.read')) return new Response('Forbidden', { status: 403 });
	const p = url.searchParams;
	const statusRaw = p.get('status');
	const contactIdRaw = p.get('contactId');
	const limitRaw = p.get('limit');
	const offsetRaw = p.get('offset');

	const results = listQuotations(db, {
		status: statusRaw ? parseInt(statusRaw) : undefined,
		contactId: contactIdRaw ? parseInt(contactIdRaw) : undefined,
		search: p.get('search') ?? undefined,
		dateFrom: p.get('dateFrom') ?? undefined,
		dateTo: p.get('dateTo') ?? undefined,
		limit: limitRaw ? parseInt(limitRaw) : undefined,
		offset: offsetRaw ? parseInt(offsetRaw) : undefined
	});
	return Response.json(results);
};

export const POST: RequestHandler = async ({ locals, request }) => {
	const body = await request.json().catch(() => null);
	return toResponse(createQuotation({ db, locals }, body), 201, (written) => written.quotation);
};
