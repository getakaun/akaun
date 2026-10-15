import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db/client.js';
import { listInvoices } from '$lib/server/queries/invoices.js';
import { createInvoice } from '$lib/server/application/sales.js';
import { toResponse } from '$lib/server/application/http.js';
import { can } from '$lib/server/permissions.js';


export const GET: RequestHandler = async ({ locals, url }) => {
	if (!can(locals, 'invoices.read')) return new Response('Forbidden', { status: 403 });
	const p = url.searchParams;
	const statusRaw = p.get('status');
	const contactIdRaw = p.get('contactId');
	const limitRaw = p.get('limit');
	const offsetRaw = p.get('offset');

	const results = listInvoices(db, {
		status: statusRaw ? parseInt(statusRaw) : undefined,
		contactId: contactIdRaw ? parseInt(contactIdRaw) : undefined,
		overdueOnly: p.get('overdueOnly') === 'true' ? true : undefined,
		search: p.get('search') ?? undefined,
		dateFrom: p.get('dateFrom') ?? undefined,
		dateTo: p.get('dateTo') ?? undefined,
		limit: limitRaw ? parseInt(limitRaw) : undefined,
		offset: offsetRaw ? parseInt(offsetRaw) : undefined
	});
	return Response.json(results);
};

export const POST: RequestHandler = async ({ locals, request }) => {
	// Validation, the new-customer permission and the create itself are the one
	// operation the MCP tools call too (`application/sales.ts`).
	const body = await request.json().catch(() => null);
	return toResponse(createInvoice({ db, locals }, body), 201, (written) => written.invoice);
};
