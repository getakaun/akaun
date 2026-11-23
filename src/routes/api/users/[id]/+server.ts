import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { hash } from 'argon2';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db/client.js';
import { revokeUserGrants } from '$lib/server/oauth/service.js';
import { sessions, users } from '$lib/server/db/schema.js';
import { can } from '$lib/server/permissions.js';
import {
	auditUser,
	keepsASuperuser,
	LAST_SUPERUSER_MESSAGE,
	memberships,
	readUserGrants,
	userAuditSnapshot
} from '$lib/server/admin/access.js';
import { allowsPassword, keepsRecoveryAdministrator, readAuthentication } from '$lib/server/oidc/settings.js';
import { listTokens, revokeAllTokens } from '$lib/server/tokens/manage.js';

export const GET: RequestHandler = async ({ locals, params }) => {
	if (!can(locals, 'users.manage')) return new Response('Forbidden', { status: 403 });

	const userId = parseInt(params.id);
	const user = db.select().from(users).where(eq(users.id, userId)).get();
	if (!user) return new Response('Not Found', { status: 404 });

	const groupsOf = memberships(db, userId);
	return json({
		id: user.id,
		name: user.name,
		email: user.email,
		username: user.username,
		tokenCount: listTokens(db, userId).length,
		groups: groupsOf.map((m) => ({ id: m.id, name: m.name })),
		isSuperuser: groupsOf.some((m) => m.isSuperuser),
		extraGrants: readUserGrants(db, userId),
    disabled: user.disabled,
    managed: !!user.oidcManagedBy,
    passwordAllowed: !user.oidcManagedBy && allowsPassword(readAuthentication(db), user.id),
    createdAt: user.createdAt
	});
};

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	if (!can(locals, 'users.manage')) return new Response('Forbidden', { status: 403 });

	const userId = parseInt(params.id);
	const user = db.select({ id: users.id }).from(users).where(eq(users.id, userId)).get();
	if (!user) return new Response('Not Found', { status: 404 });

	const body = await request.json();
  if (body.disabled !== undefined && typeof body.disabled !== 'boolean')
    return json({ error: 'Choose whether the account is enabled.' }, { status: 400 });
  if (body.password && typeof body.password !== 'string')
    return json({ error: 'Enter a password.' }, { status: 400 });
  const passwordHash = body.password ? await hash(body.password) : undefined;
  const problem = db.transaction((tx) => {
    const account = tx.select().from(users).where(eq(users.id, userId)).get();
    if (!account) return 'User not found.';
    const identityChange = body.name !== undefined || !!body.email || !!body.username;
    if (account.oidcManagedBy && (identityChange || passwordHash))
      return 'Account details are managed by the sign-in provider.';
    if (passwordHash && !allowsPassword(readAuthentication(tx), userId))
      return 'Password changes are unavailable for this account.';
    if (body.disabled && !account.disabled) {
      const change = { disableUserId: userId };
      if (!keepsASuperuser(tx, change)) return LAST_SUPERUSER_MESSAGE;
      if (!keepsRecoveryAdministrator(tx, change)) return 'Keep at least one enabled recovery administrator.';
    }

    const before = userAuditSnapshot(tx, userId);
    const patch: Partial<typeof users.$inferInsert> = {};
    if (body.name !== undefined) patch.name = body.name || null;
    if (body.email) patch.email = body.email;
    if (body.username) patch.username = body.username;
    if (passwordHash) patch.passwordHash = passwordHash;
    if (body.disabled !== undefined) patch.disabled = body.disabled;
    if (!Object.keys(patch).length) return null;
    tx.update(users).set(patch).where(eq(users.id, userId)).run();
    auditUser(tx, locals.user!.id, userId, before, userAuditSnapshot(tx, userId), [
      ...(passwordHash ? [{ field: 'password', before: null, after: 'changed' }] : []),
      ...(body.disabled !== undefined && body.disabled !== account.disabled
        ? [{ field: 'disabled', before: account.disabled, after: body.disabled }] : []),
    ]);
    if (passwordHash || body.disabled) {
      tx.delete(sessions).where(eq(sessions.userId, userId)).run();
      revokeUserGrants(tx, userId, locals.user!.id);
      revokeAllTokens(tx, userId, locals.user!.id);
    }
    return null;
  }, { behavior: 'immediate' });
  return problem ? json({ error: problem }, { status: 400 }) : json({ success: true });
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
	if (!can(locals, 'users.manage')) return new Response('Forbidden', { status: 403 });

	const userId = parseInt(params.id);
	if (locals.user?.id === userId) {
		return json({ error: 'Cannot delete your own account' }, { status: 400 });
	}

	const user = db.select({ id: users.id }).from(users).where(eq(users.id, userId)).get();
	if (!user) return new Response('Not Found', { status: 404 });

  const problem = db.transaction((tx) => {
    const change = { deleteUserId: userId };
    if (!keepsASuperuser(tx, change)) return LAST_SUPERUSER_MESSAGE;
    if (!keepsRecoveryAdministrator(tx, change)) return 'Keep at least one enabled recovery administrator.';
    const before = userAuditSnapshot(tx, userId);
    tx.delete(users).where(eq(users.id, userId)).run();
    auditUser(tx, locals.user!.id, userId, before, null);
    return null;
  }, { behavior: 'immediate' });
  return problem ? json({ error: problem }, { status: 400 }) : json({ success: true });
};
