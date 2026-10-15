import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db/client.js';
import { listContacts } from '$lib/server/queries/contacts.js';
import { createContact } from '$lib/server/services/contacts.js';
import { can } from '$lib/server/permissions.js';

export const GET: RequestHandler = async ({ locals, url }) => {
	if (!can(locals, 'contacts.read')) return new Response('Not Found', { status: 404 });
	const p = url.searchParams;
	const roleRaw = p.get('role');
	const entityRaw = p.get('entityType');

	const results = listContacts(db, {
		role: roleRaw ? parseInt(roleRaw) : undefined,
		entityType: entityRaw ? parseInt(entityRaw) : undefined,
		search: p.get('search') ?? undefined
	});

	return Response.json(results);
};

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!can(locals, 'contacts.create')) return new Response('Forbidden', { status: 403 });
	const user = locals.user!;
	const body = await request.json();

	const entityType = Number(body.entityType);
	const legalName = typeof body.legalName === 'string' ? body.legalName.trim() : '';
	if (!entityType || !legalName) {
		return Response.json({ error: 'entityType and legalName are required' }, { status: 400 });
	}

	const contact = createContact(db, user.id, {
		entityType,
		legalName,
		registrationNo: body.registrationNo ?? null,
		email: body.email ?? null,
		phone: body.phone ?? null,
		address: body.address ?? null,
		remark: body.remark ?? null,
		roles: Array.isArray(body.roles) ? body.roles.map(Number) : []
	});

	return Response.json(contact, { status: 201 });
};
