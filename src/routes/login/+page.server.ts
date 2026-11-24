import { fail, redirect } from '@sveltejs/kit';
import * as argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db/client.js';
import { users } from '$lib/server/db/schema.js';
import { createSession, setSessionCookie } from '$lib/server/auth.js';
import { oauth } from '$lib/server/oauth/runtime.js';
import { BROWSER_COOKIE } from '$lib/server/oauth/service.js';
import { authorizationPath } from '$lib/server/oauth/http.js';
import { hit, reset } from '$lib/server/rate-limit.js';
import { allowsPassword, readAuthentication } from '$lib/server/oidc/settings.js';
import { localReturnTo } from '$lib/server/oidc/protocol.js';
import type { Actions, PageServerLoad } from './$types.js';

const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

function resume(url: URL, browser: string | undefined) {
	const id = url.searchParams.get('oauth');
	if (!id) return localReturnTo(url.searchParams.get('returnTo'));
	if (!browser || !oauth) return '/';
	try {
		oauth.pending(id, browser);
		return authorizationPath(id);
	} catch {
		return '/';
	}
}
export const load: PageServerLoad = ({ locals, url, cookies }) => {
	if (locals.user) redirect(302, resume(url, cookies.get(BROWSER_COOKIE)));
  const settings = readAuthentication(db);
  const query = new URLSearchParams({ returnTo: resume(url, cookies.get(BROWSER_COOKIE)) });
  const pending = url.searchParams.get('oauth');
  if (pending) query.set('oauth', pending);
  const local = new URLSearchParams(url.searchParams);
  const ssoError = url.searchParams.get('ssoError');
  const preference = local.get('local');
  const showPassword = !settings.enabled || preference === '1' || (preference !== '0' &&
    (ssoError === 'provider_configuration' || (!!ssoError && settings.internalEnabled)));
  local.set('local', showPassword ? '0' : '1');
  return {
    enabled: settings.enabled,
    internalEnabled: settings.internalEnabled,
    displayName: settings.displayName,
    showPassword,
    ssoError,
    signInQuery: query.toString(),
    localQuery: local.toString(),
  };
};

export const actions: Actions = {
	default: async ({ request, cookies, getClientAddress, url }) => {
		const data = await request.formData();
		const username = String(data.get('username') ?? '');
		const password = String(data.get('password') ?? '');

		if (!username || !password) {
			return fail(400, { error: 'Username and password are required' });
		}

		const rateKey = `login:${getClientAddress()}:${username.toLowerCase()}`;
		const limit = hit(rateKey, LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_MS);
		if (limit.limited) {
			return fail(429, {
				error: `Too many attempts. Try again in ${Math.ceil(limit.retryAfterSeconds / 60)} minute(s).`
			});
		}

		const user = db
			.select()
			.from(users)
			.where(eq(users.username, username))
			.get();
		if (!user || user.disabled || user.oidcManagedBy || !allowsPassword(readAuthentication(db), user.id) ||
      !(await argon2.verify(user.passwordHash, password))) {
			return fail(400, { error: 'Invalid username or password' });
		}

    const session = db.transaction((tx) => {
      const settings = readAuthentication(tx);
      const current = tx.select().from(users).where(eq(users.id, user.id)).get();
      if (!current || current.disabled || current.oidcManagedBy || current.passwordHash !== user.passwordHash ||
          !allowsPassword(settings, current.id)) return null;
      return {
        id: createSession(tx, current.id),
        secure: url.protocol === 'https:' || process.env.NODE_ENV === 'production',
      };
    }, { behavior: 'immediate' });
    if (!session) return fail(400, { error: 'Invalid username or password' });
    reset(rateKey);
    setSessionCookie(cookies, session.id, session.secure);

		redirect(302, resume(url, cookies.get(BROWSER_COOKIE)));
	}
};
