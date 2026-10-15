import type { PageServerLoad, Actions } from './$types.js';
import { fail } from '@sveltejs/kit';
import { hash, verify } from 'argon2';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db/client.js';
import { users } from '$lib/server/db/schema.js';
import { getUserNavOrder, setUserNavOrder } from '$lib/server/navPreferences.js';
import { oauth } from '$lib/server/oauth/runtime.js';
import { MAX_MOBILE_NAV_ITEMS } from '$lib/nav-config.js';
import { can } from '$lib/server/permissions.js';
import {
	listTokens,
	regenerateToken,
	revokeAllTokens,
	revokeToken
} from '$lib/server/tokens/manage.js';

export const load: PageServerLoad = async ({ locals }) => {
	const userId = locals.user!.id;

	const navItems = getUserNavOrder(db, userId)
		.filter((item) => can(locals, item.permission))
		.map((item) => ({ id: item.id, label: item.label, showOnMobile: item.showOnMobile }));

	return {
		name: locals.user!.name,
		email: locals.user!.email,
		username: locals.user!.username,
		tokens: listTokens(db, userId),
		navItems,
		connectedApps: oauth?.listGrants(userId) ?? []
	};
};

export const actions: Actions = {
	revokeApp: async ({ locals, request }) => {
		const data = await request.formData();
		oauth?.revokeGrant(String(data.get('grantId') ?? ''), locals.user!.id);
		return { action: 'apps', success: true };
	},
	updateProfile: async ({ locals, request }) => {
		const userId = locals.user!.id;
		const data = await request.formData();

		const name = String(data.get('name') ?? '').trim() || null;
		const email = String(data.get('email') ?? '').trim();
		const username = String(data.get('username') ?? '').trim();

		if (!email) return fail(400, { action: 'profile', error: 'Email is required.' });
		if (!username) return fail(400, { action: 'profile', error: 'Username is required.' });
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
			return fail(400, { action: 'profile', error: 'Enter a valid email address.' });

		try {
			db.update(users).set({ name, email, username }).where(eq(users.id, userId)).run();
		} catch {
			return fail(400, { action: 'profile', error: 'Email or username is already taken.' });
		}

		return { action: 'profile', success: true };
	},

	changePassword: async ({ locals, request }) => {
		const userId = locals.user!.id;
		const data = await request.formData();

		const currentPassword = String(data.get('currentPassword') ?? '');
		const newPassword = String(data.get('newPassword') ?? '');
		const confirmPassword = String(data.get('confirmPassword') ?? '');

		if (!currentPassword)
			return fail(400, { action: 'security', error: 'Current password is required.' });
		if (newPassword.length < 8)
			return fail(400, { action: 'security', error: 'New password must be at least 8 characters.' });
		if (newPassword !== confirmPassword)
			return fail(400, { action: 'security', error: 'Passwords do not match.' });

		const row = db
			.select({ passwordHash: users.passwordHash })
			.from(users)
			.where(eq(users.id, userId))
			.get();

		if (!row) return fail(400, { action: 'security', error: 'User not found.' });

		const valid = await verify(row.passwordHash, currentPassword);
		if (!valid)
			return fail(400, { action: 'security', error: 'Current password is incorrect.' });

		const passwordHash = await hash(newPassword);
		db.update(users).set({ passwordHash }).where(eq(users.id, userId)).run();
		// A new password ends every way in the old one could have set up.
		oauth?.revokeUser(userId);
		revokeAllTokens(db, userId);

		return { action: 'security', success: true };
	},

	// Personal access tokens. Form actions, never an /api route: these are only
	// reached with a signed-in browser session, so a token can never be used
	// to make, widen or keep alive another token. Making one is its own page,
	// /profile/tokens/new.
	regenerateToken: async ({ locals, request }) => {
		const data = await request.formData();
		const result = regenerateToken(db, {
			ownerId: locals.user!.id,
			tokenId: Number(data.get('tokenId')),
			owner: locals.role!
		});
		if (!result.ok) return fail(400, { action: 'token', error: result.reason });
		return { action: 'token', success: true, newToken: result.value.token };
	},

	revokeToken: async ({ locals, request }) => {
		const data = await request.formData();
		if (!revokeToken(db, locals.user!.id, Number(data.get('tokenId'))))
			return fail(404, { action: 'token', error: 'That token no longer exists.' });
		return { action: 'token', success: true };
	},

	revokeAllTokens: async ({ locals }) => {
		revokeAllTokens(db, locals.user!.id);
		return { action: 'token', success: true };
	},

	saveNavOrder: async ({ locals, request }) => {
		const userId = locals.user!.id;
		const data = await request.formData();

		let items: { itemId: string; showOnMobile: boolean }[];
		try {
			items = JSON.parse(String(data.get('items') ?? '[]'));
		} catch {
			return fail(400, { action: 'navigation', error: 'Invalid navigation order.' });
		}

		const mobileCount = items.filter((i) => i.showOnMobile).length;
		if (mobileCount > MAX_MOBILE_NAV_ITEMS) {
			return fail(400, {
				action: 'navigation',
				error: `At most ${MAX_MOBILE_NAV_ITEMS} items can be shown on mobile.`
			});
		}

		setUserNavOrder(db, userId, items);

		return { action: 'navigation', success: true };
	}
};
