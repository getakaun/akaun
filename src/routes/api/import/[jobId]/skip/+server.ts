import { json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db/client.js';
import { importQueue } from '$lib/server/db/schema.js';
import { releaseIfUnreferenced } from '$lib/server/file-storage.js';
import { importEvents } from '$lib/server/import/events.js';
import { jobForEvent } from '$lib/server/import/job-event.js';
import { refused } from '$lib/server/api-response.js';
import { skipGroupItems } from '$lib/server/services/import-items.js';
import { ImportState } from '$lib/enums.js';
import type { RequestHandler } from './$types.js';
import { can } from '$lib/server/permissions.js';

export const POST: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) return new Response('Unauthorized', { status: 401 });
	if (!can(locals, 'import.confirm')) return new Response('Forbidden', { status: 403 });

	const row = db.select().from(importQueue).where(eq(importQueue.id, params.jobId)).get();

	if (!row) return new Response('Not found', { status: 404 });
	// "Skip all" on a group: every item still waiting is skipped, and the file
	// goes only if no record uses it (006 US4 scenario 8).
	if (row.state === ImportState.Grouped) {
		const skipped = skipGroupItems(db, params.jobId, 'all', { actingUserId: locals.user.id });
		if (!skipped.ok) return refused(skipped.reason);
		return new Response(null, { status: 204 });
	}
	if (row.state !== ImportState.PendingReview) {
		return json({ error: 'Job is not in pending_review state' }, { status: 400 });
	}

	db.update(importQueue)
		.set({ state: ImportState.Skipped })
		.where(eq(importQueue.id, params.jobId))
		.run();
	// After the state change, so this job no longer counts as using the file.
	// Another job or a record that shares the file keeps it.
	releaseIfUnreferenced(db, row.tempFilePath);

	const updated = db.select().from(importQueue).where(eq(importQueue.id, params.jobId)).get();
	if (updated) importEvents.emit('job-update', { userId: locals.user.id, job: jobForEvent(updated) });

	return new Response(null, { status: 204 });
};
