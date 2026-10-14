import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db/client.js';
import { getQuotation } from '$lib/server/queries/quotations.js';
import { canEditQuotation } from '$lib/server/locking.js';
import { isQuotationSealed, SEALED_SALES_FIELDS } from '$lib/sales/status.js';
import { patchQuotation, removeQuotation } from '$lib/server/services/quotations.js';
import { resolveOrCreateContact } from '$lib/server/queries/contacts.js';
import { QuotationStatus, Role } from '$lib/enums.js';
import { hasPermission } from '$lib/server/permissions.js';
import { salesLinesSchema, salesRateSchema, invalidLines } from '$lib/server/sales/schema.js';

export const GET: RequestHandler = async ({ locals, params }) => {
	if (!hasPermission(locals, 'quotations', 'view')) return new Response('Forbidden', { status: 403 });
	const id = parseInt(params.id!);
	const quotation = getQuotation(db, id);
	if (!quotation) return Response.json({ error: 'Not found' }, { status: 404 });
	return Response.json(quotation);
};

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	if (!hasPermission(locals, 'quotations', 'change')) return new Response('Forbidden', { status: 403 });
	const user = locals.user!;
	const id = parseInt(params.id!);

	const quotation = getQuotation(db, id);
	if (!quotation) return Response.json({ error: 'Not found' }, { status: 404 });

	if (!canEditQuotation(quotation)) {
		return Response.json(
			{
				error:
					quotation.status === QuotationStatus.Superseded
						? 'This quotation has been replaced by a revision, so it can no longer be changed.'
						: 'Converted quotations cannot be edited.'
			},
			{ status: 409 }
		);
	}

	const body = await request.json();
	const patch: Record<string, unknown> = {};
	// No `status`: a quotation's status changes through its own actions, which
	// check the move is allowed, never as a side effect of an edit.
	const fields = ['contactId', 'reference', 'issueDate', 'expiryDate', 'currency', 'exchangeRate', 'notes', 'terms'];
	for (const f of fields) {
		if (body[f] !== undefined) patch[f] = body[f];
	}
	if (body.lines !== undefined) {
		const lines = salesLinesSchema.safeParse(body.lines);
		if (!lines.success) return invalidLines(lines.error);
		patch.lines = lines.data;
	}
	if (patch.exchangeRate !== undefined) {
		const rate = salesRateSchema.safeParse(patch.exchangeRate);
		if (!rate.success) return invalidLines(rate.error);
	}
	// Once it has gone to the customer, what it offers is fixed: a change to it
	// is a revision, so the customer can tell the new offer from the one they
	// hold. Checked before a new customer name is resolved, so a refused edit
	// cannot leave a contact behind.
	if (
		isQuotationSealed(quotation) &&
		(SEALED_SALES_FIELDS.some((f) => patch[f] !== undefined) || Boolean(body.newContactName))
	) {
		return Response.json(
			{
				error:
					'This quotation has been sent. Its customer, date, currency and line items are fixed — revise it to change them.'
			},
			{ status: 409 }
		);
	}

	if (!patch.contactId && body.newContactName) {
		patch.contactId = resolveOrCreateContact(db, body.newContactName, Role.Customer, user.id);
	}

	const updated = patchQuotation(db, id, user.id, patch);
	return Response.json(updated);
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
	if (!hasPermission(locals, 'quotations', 'delete')) return new Response('Forbidden', { status: 403 });
	const id = parseInt(params.id!);

	const result = removeQuotation(db, id, locals.user!.id);
	if (!result.ok) {
		if (result.reason === 'not_found') return Response.json({ error: 'Not found' }, { status: 404 });
		if (result.reason === 'converted') return Response.json({ error: 'Converted quotations cannot be deleted.' }, { status: 409 });
		if (result.reason === 'superseded') return Response.json({ error: 'A quotation replaced by a revision is kept, so it cannot be deleted.' }, { status: 409 });
	}
	return new Response(null, { status: 204 });
};
