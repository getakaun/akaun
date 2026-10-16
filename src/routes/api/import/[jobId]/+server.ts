import { json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '$lib/server/db/client.js';
import { importQueue } from '$lib/server/db/schema.js';
import { badRequest, refused } from '$lib/server/api-response.js';
import { releaseIfUnreferenced } from '$lib/server/file-storage.js';
import { importEvents } from '$lib/server/import/events.js';
import { jobEvents } from '$lib/server/import/group-state.js';
import { discardGroup, setGroupSourceAccount } from '$lib/server/services/import-items.js';
import { ImportState } from '$lib/enums.js';
import type { RequestHandler } from './$types.js';
import { can } from '$lib/server/permissions.js';
import { auditJobDiscarded } from '$lib/server/import/audit.js';

export const GET: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) return new Response('Unauthorized', { status: 401 });
	if (!can(locals, 'import.read')) return new Response('Forbidden', { status: 403 });

	const row = db.select().from(importQueue).where(eq(importQueue.id, params.jobId)).get();

	if (!row) return new Response('Not found', { status: 404 });
	// The same shape as a live update: no document text, and a group's counts.
	return json(jobEvents(db, [row])[0]);
};

/**
 * Chooses one Source account for a whole group (006 FR-018). Every item still
 * waiting takes it as its own account; see `setGroupSourceAccount`. The reply
 * lists each waiting item and whether the account fitted it.
 */
const patchSchema = z.object({
	groupAccountId: z.number().int().positive().nullable()
});

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	if (!locals.user) return new Response('Unauthorized', { status: 401 });
	if (!can(locals, 'import.update')) return new Response('Forbidden', { status: 403 });

	const parsed = patchSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) return badRequest(parsed.error);

	const row = db.select().from(importQueue).where(eq(importQueue.id, params.jobId)).get();
	if (!row) return new Response('Not found', { status: 404 });

	const set = setGroupSourceAccount(db, params.jobId, parsed.data.groupAccountId, {
		actingUserId: locals.user.id
	});
	if (!set.ok) return refused(set.reason);
	return json({ results: set.value });
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) return new Response('Unauthorized', { status: 401 });
	if (!can(locals, 'import.delete')) return new Response('Forbidden', { status: 403 });

	const row = db.select().from(importQueue).where(eq(importQueue.id, params.jobId)).get();

	if (!row) return new Response('Not found', { status: 404 });

	// A group: only the items still waiting go. Records already made from it
	// stay, and so does the file while a record uses it (FR-020).
	if (row.state === ImportState.Grouped) {
		const discarded = discardGroup(db, params.jobId, { actingUserId: locals.user.id });
		if (!discarded.ok) return refused(discarded.reason);
		return new Response(null, { status: 204 });
	}

	const deletable: number[] = [ImportState.Queued, ImportState.Failed, ImportState.PendingReview];
	if (!deletable.includes(row.state)) {
		return json({ error: 'Can only delete queued, failed, or pending_review jobs' }, { status: 400 });
	}

	importEvents.emit('job-deleted', { userId: row.createdBy, jobId: params.jobId });
	db.transaction((tx) => {
		tx.delete(importQueue).where(eq(importQueue.id, params.jobId)).run();
		auditJobDiscarded(tx, row, locals.user!.id);
	});
	// After the row is gone, so it no longer counts as using the file.
	releaseIfUnreferenced(db, row.tempFilePath);

	return new Response(null, { status: 204 });
};
