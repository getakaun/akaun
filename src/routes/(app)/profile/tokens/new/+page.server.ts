import type { Actions, PageServerLoad } from './$types.js';
import { error, fail } from '@sveltejs/kit';
import { db } from '$lib/server/db/client.js';
import { sortLeaves } from '$lib/permissions/catalog.js';
import { createToken, tokenInputSchema } from '$lib/server/tokens/manage.js';

/**
 * Make a personal access token. A form action, never an /api route: it is
 * reached only from a signed-in browser session, so a token can never be
 * used to make, widen or keep alive another token. The owner is always the
 * signed-in user — nobody makes a token for someone else.
 */
export const load: PageServerLoad = async ({ locals }) => {
	if (locals.credential) error(403, 'Sign in to make a token.');
	return { delegable: sortLeaves(locals.role?.delegable ?? []) };
};

export const actions: Actions = {
	create: async ({ locals, request }) => {
		if (locals.credential || !locals.role)
			return fail(403, { error: 'Sign in to make a token.' });
		const data = await request.formData();
		let permissions: unknown;
		try {
			permissions = JSON.parse(String(data.get('permissions') ?? '[]'));
		} catch {
			permissions = null;
		}
		const expiresOn = String(data.get('expiresOn') ?? '');
		const parsed = tokenInputSchema.safeParse({
			name: String(data.get('name') ?? ''),
			permissions,
			expiresOn: expiresOn === '' ? null : expiresOn
		});
		if (!parsed.success)
			return fail(400, { error: parsed.error.issues[0]?.message ?? 'Check the form.' });
		const result = createToken(db, {
			ownerId: locals.user!.id,
			createdBy: locals.user!.id,
			owner: locals.role,
			input: parsed.data
		});
		if (!result.ok) return fail(400, { error: result.reason });
		return { token: result.value.token, name: result.value.view.name };
	}
};
