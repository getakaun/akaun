import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db/client.js';
import { getSetting, setSetting, SETTING_KEYS, hasAnyDocuments } from '$lib/server/settings.js';
import { can } from '$lib/server/permissions.js';

/**
 * Settings over HTTP.
 *
 * This used to return every row of the settings table to anyone signed in —
 * or holding a token — including the AI provider's key, and to write any
 * known key, including the ledger upgrade's own state. Both are now explicit
 * lists: what may be read, and what may be written, and a secret is only ever
 * reported as set or not.
 */

/** Read with settings.read. A secret is answered `{ set: boolean }`, never its value. */
const READABLE_KEYS = [
	SETTING_KEYS.currencyCode,
	SETTING_KEYS.autoImportModel,
	SETTING_KEYS.autoImportEnabled,
	SETTING_KEYS.autoImportParallelTasks,
	SETTING_KEYS.autoImportCategoryHints,
	SETTING_KEYS.autoImportRateLimitMs,
	SETTING_KEYS.autoImportFreeModelsOnly,
	SETTING_KEYS.autoImportCustomInstructions,
	SETTING_KEYS.autoImportDuplicateThreshold,
	SETTING_KEYS.companyName,
	SETTING_KEYS.companyAddress,
	SETTING_KEYS.companyRegistrationNo,
	SETTING_KEYS.pdfInvoiceLayoutKey,
	SETTING_KEYS.pdfQuotationLayoutKey,
	SETTING_KEYS.pdfThemeColor,
	SETTING_KEYS.pdfHeader,
	SETTING_KEYS.sequenceTemplate,
	SETTING_KEYS.invoiceDueDays,
	SETTING_KEYS.quotationValidDays
] as const;
const SECRET_KEYS = [SETTING_KEYS.autoImportApiKey] as const;

/**
 * Written with settings.manage. Left out on purpose: the stored-file keys
 * (written only by the Company form, which saves the upload itself —
 * `/api/company/[image]` serves whatever file they name), the ledger
 * upgrade's state, the default account (an account write, through the
 * Settings form with accounts.update), and the token lifetime (users.manage,
 * on Users & Groups).
 */
const WRITABLE_KEYS = new Set<string>([...READABLE_KEYS, ...SECRET_KEYS]);

// Once any document exists, these settings are immutable — enforced here too,
// not just in the settings-page form actions, since this endpoint is a direct
// bypass of that UI.
const LOCKED_KEYS = new Set<string>([SETTING_KEYS.currencyCode, SETTING_KEYS.sequenceTemplate]);

function readable() {
	const map: Record<string, unknown> = {};
	for (const key of READABLE_KEYS) map[key] = getSetting(db, key);
	for (const key of SECRET_KEYS) map[key] = { set: Boolean(getSetting(db, key)) };
	return map;
}

export const GET: RequestHandler = async ({ locals }) => {
	if (!can(locals, 'settings.read')) return new Response('Forbidden', { status: 403 });
	return Response.json(readable());
};

export const PATCH: RequestHandler = async ({ locals, request }) => {
	if (!can(locals, 'settings.manage')) return new Response('Forbidden', { status: 403 });
	const body = await request.json().catch(() => null);

	if (body === null || typeof body !== 'object' || Array.isArray(body)) {
		return Response.json({ error: 'Body must be a JSON object' }, { status: 400 });
	}

	const entries = Object.entries(body);
	const unknown = entries.filter(([key]) => !WRITABLE_KEYS.has(key)).map(([key]) => key);
	if (unknown.length > 0) {
		return Response.json({ error: `Unknown setting key(s): ${unknown.join(', ')}` }, { status: 400 });
	}

	if (entries.some(([key]) => LOCKED_KEYS.has(key)) && hasAnyDocuments(db)) {
		return Response.json(
			{ error: 'Currency and sequence number format are locked once any document exists' },
			{ status: 400 }
		);
	}

	for (const [key, value] of entries) {
		setSetting(db, key, String(value));
	}

	return Response.json(readable());
};
