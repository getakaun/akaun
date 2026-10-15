import { z } from 'zod';
import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db/client.js';
import { issueInvoice } from '$lib/server/application/sales.js';
import { toResponse } from '$lib/server/application/http.js';
import { badRequest } from '$lib/server/api-response.js';

/**
 * Mark as sent. The app does not deliver the invoice; this records that it
 * went out, and it is the moment the invoice enters the books: the amount goes
 * into Money owed to us tagged with the customer, out of the income account it
 * earns into (FR-018a). Refusing repeats — an invoice already marked as sent —
 * keeps a double click from recording the same debt twice.
 */

const issueSchema = z.object({
	incomeAccountId: z.number().int().positive().optional()
});

export const POST: RequestHandler = async ({ locals, params, request }) => {
	// An empty body is the ordinary case — post it into the seeded Sales account.
	const raw = await request.json().catch(() => ({}));
	const parsed = issueSchema.safeParse(raw ?? {});
	if (!parsed.success) return badRequest(parsed.error);
	const id = parseInt(params.id!);
	// Sending puts a record in the books, so the operation asks for
	// `records:add` too, and checks the income account is one.
	return toResponse(issueInvoice({ db, locals }, id, parsed.data), 200, (written) => written.invoice);
};
