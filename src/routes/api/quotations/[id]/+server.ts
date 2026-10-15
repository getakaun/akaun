import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db/client.js';
import { getQuotation } from '$lib/server/queries/quotations.js';
import { hasPermission } from '$lib/server/permissions.js';
import { deleteQuotation, updateQuotation } from '$lib/server/application/sales.js';
import { toResponse } from '$lib/server/application/http.js';

export const GET: RequestHandler = async ({ locals, params }) => {
	if (!hasPermission(locals, 'quotations', 'view')) return new Response('Forbidden', { status: 403 });
	const id = parseInt(params.id!);
	const quotation = getQuotation(db, id);
	if (!quotation) return Response.json({ error: 'Not found' }, { status: 404 });
	return Response.json(quotation);
};

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	const id = parseInt(params.id!);
	const body = await request.json().catch(() => null);
	// No `status`: a quotation's status changes through its own actions. What a
	// sent quotation may still change is the operation's to say.
	return toResponse(updateQuotation({ db, locals }, id, body), 200, (written) => written.quotation);
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
	const id = parseInt(params.id!);
	return toResponse(deleteQuotation({ db, locals }, id), 204);
};
