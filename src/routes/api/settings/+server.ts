import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db/client.js';
import { settings } from '$lib/server/db/schema.js';
import { setSetting, SETTING_KEYS, hasAnyDocuments } from '$lib/server/settings.js';

// The stored-file keys are written only by the Company form, which saves the
// upload itself. `/api/files` serves whatever file these keys name, so letting a
// caller set one would let it publish any stored file — a receipt, a statement.
const FILE_PATH_KEYS = new Set<string>([
	SETTING_KEYS.companyLogoPath,
	SETTING_KEYS.companyLetterheadPath
]);

// Only these keys may be written through the API — prevents arbitrary keys being
// injected into the global settings namespace.
const ALLOWED_KEYS = new Set<string>(
	Object.values(SETTING_KEYS).filter((key) => !FILE_PATH_KEYS.has(key))
);

// Once any document exists, these settings are immutable — enforced here too,
// not just in the settings-page form actions, since this endpoint is a direct
// bypass of that UI.
const LOCKED_KEYS = new Set<string>([SETTING_KEYS.currencyCode, SETTING_KEYS.sequenceTemplate]);

export const GET: RequestHandler = async () => {
	const rows = db.select({ key: settings.key, value: settings.value }).from(settings).all();
	const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
	return Response.json(map);
};

export const PATCH: RequestHandler = async ({ request }) => {
	const body = await request.json();

	if (body === null || typeof body !== 'object' || Array.isArray(body)) {
		return Response.json({ error: 'Body must be a JSON object' }, { status: 400 });
	}

	const entries = Object.entries(body);
	const unknown = entries.filter(([key]) => !ALLOWED_KEYS.has(key)).map(([key]) => key);
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

	const rows = db.select({ key: settings.key, value: settings.value }).from(settings).all();
	const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
	return Response.json(map);
};
