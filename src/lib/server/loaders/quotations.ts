import type { Actions } from '@sveltejs/kit';
import { db } from '$lib/server/db/client.js';
import { getQuotation, listQuotations } from '$lib/server/queries/quotations.js';
import { removeQuotation } from '$lib/server/services/quotations.js';
import { fail, redirect } from '@sveltejs/kit';
import { can } from '$lib/server/permissions.js';
import { documentDefaults } from '$lib/server/sales/defaults.js';

export function loadQuotationsPage(locals: App.Locals) {
	if (!can(locals, 'quotations.read')) throw redirect(302, '/dashboard');
	// The tab counts are worked out on the page, from the live list the stream
	// keeps current.
	return {
		quotations: listQuotations(db, { limit: 1000 }),
		perms: { add: can(locals, 'quotations.create') }
	};
}

/**
 * The blank form, for `/quotations/new`.
 *
 * Gated on `add`, not `view` — a create page's whole reason to exist fails
 * without it, so a user who lacks it is sent back rather than shown a form
 * that would 403 on submit.
 */
export function loadQuotationNew(locals: App.Locals) {
	if (!can(locals, 'quotations.create')) throw redirect(302, '/quotations');
	// Days from the issue date to the expiry date a new quotation starts with;
	// null when the setting is empty (no expiry).
	return { defaultDays: documentDefaults(db).quotationValidDays };
}

/**
 * One quotation, for `/quotations/[id]`.
 *
 * Server-rendered with its line items, which the drawer used to fetch after
 * opening — so the table a reader came for arrived a moment after the panel.
 */
export function loadQuotationDetail(locals: App.Locals, id: number) {
	if (!can(locals, 'quotations.read')) throw redirect(302, '/dashboard');

	const quotation = getQuotation(db, id);
	if (!quotation) throw redirect(302, '/quotations');

	return {
		quotation,
		perms: {
			change: can(locals, 'quotations.update'),
			delete: can(locals, 'quotations.delete'),
			// Converting makes an invoice from this quotation — the same pair the
			// convert endpoint checks.
			convert:
				can(locals, 'quotations.convert') && can(locals, 'invoices.create'),
			// Revising adds a new quotation in this one's place.
			revise:
				can(locals, 'quotations.revise') && can(locals, 'quotations.create')
		}
	};
}

export const quotationsActions: Actions = {
	delete: async ({ locals, request }) => {
		if (!can(locals, 'quotations.delete')) return fail(403, { error: 'Forbidden' });
		const userId = locals.user!.id;
		const data = await request.formData();
		const id = parseInt(String(data.get('id') ?? '0'));
		if (!id) return fail(400, { error: 'Invalid quotation' });
		const result = removeQuotation(db, id, userId);
		if (!result.ok) {
			if (result.reason === 'converted')
				return fail(409, { error: 'Converted quotations cannot be deleted.' });
			if (result.reason === 'superseded')
				return fail(409, { error: 'A quotation replaced by a revision is kept, so it cannot be deleted.' });
			return fail(404, { error: 'Not found' });
		}
		return { success: true };
	}
};
