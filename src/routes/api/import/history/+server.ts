import { inArray } from 'drizzle-orm';
import { db } from '$lib/server/db/client.js';
import { importItems, importQueue } from '$lib/server/db/schema.js';
import { releaseIfUnreferenced } from '$lib/server/file-storage.js';
import { importEvents } from '$lib/server/import/events.js';
import { ImportState } from '$lib/enums.js';
import type { RequestHandler } from './$types.js';
import { can } from '$lib/server/permissions.js';

const HISTORY_STATES = [ImportState.Confirmed, ImportState.Imported, ImportState.Skipped];

export const DELETE: RequestHandler = async ({ locals }) => {
	if (!locals.user) return new Response('Unauthorized', { status: 401 });
	if (!can(locals, 'import.delete'))
		return new Response('Forbidden', { status: 403 });

	const rows = db
		.select()
		.from(importQueue)
		.where(inArray(importQueue.state, HISTORY_STATES))
		.all();

	// A finished group is in the history too (Imported or Skipped); one that
	// still has an item waiting is Grouped and stays. Its items go with it.
	const jobIds = rows.map((row) => row.id);
	for (let start = 0; start < jobIds.length; start += 500) {
		db.delete(importItems)
			.where(inArray(importItems.jobId, jobIds.slice(start, start + 500)))
			.run();
	}
	db.delete(importQueue).where(inArray(importQueue.state, HISTORY_STATES)).run();
	// An imported receipt's temp path is not updated when its file moves. If the
	// move failed, the record's attachment still points at that temp path, and a
	// plain delete here would remove the record's receipt. A group's path is the
	// file its records share. Release keeps any file a record still uses.
	for (const path of new Set(rows.map((row) => row.tempFilePath))) {
		releaseIfUnreferenced(db, path);
	}

	for (const row of rows) {
		importEvents.emit('job-deleted', { userId: row.createdBy, jobId: row.id });
	}

	return new Response(null, { status: 204 });
};
