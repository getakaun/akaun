import { not, inArray } from 'drizzle-orm';
import { db } from '$lib/server/db/client.js';
import { importQueue } from '$lib/server/db/schema.js';
import { importEvents } from '$lib/server/import/events.js';
import { jobEvents } from '$lib/server/import/group-state.js';
import type { ImportItemEvent, ImportJobEvent } from '$lib/server/import/job-event.js';
import { ImportState } from '$lib/enums.js';
import type { RequestHandler } from './$types.js';
import { can } from '$lib/server/permissions.js';

const TERMINAL_STATES = [ImportState.Confirmed, ImportState.Skipped];

export const GET: RequestHandler = ({ locals }) => {
	if (!locals.user) return new Response('Unauthorized', { status: 401 });
	if (!can(locals, 'import.read')) return new Response('Forbidden', { status: 403 });

	const encoder = new TextEncoder();

	const encodeEvent = (data: object) => encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
	const encodeComment = (text: string) => encoder.encode(`: ${text}\n\n`);

	let cleanup: (() => void) | null = null;

	const stream = new ReadableStream({
		start(controller) {
			// Shared ledger — snapshot every active job, not just the caller's. The
			// snapshot is of queue rows only, never of a group's items: a group can
			// hold a thousand, and its page loads them itself. Items arrive as
			// changes only, like any paginated list.
			const currentJobs = jobEvents(
				db,
				db
					.select()
					.from(importQueue)
					.where(not(inArray(importQueue.state, TERMINAL_STATES)))
					.all()
			);
			controller.enqueue(encodeEvent({ type: 'snapshot', jobs: currentJobs }));

			const updateHandler = ({ job }: { job: ImportJobEvent }) => {
				try {
					controller.enqueue(encodeEvent({ type: 'job-update', job }));
				} catch {
					// stream already closed
				}
			};

			const deleteHandler = ({ jobId }: { jobId: string }) => {
				try {
					controller.enqueue(encodeEvent({ type: 'job-deleted', jobId }));
				} catch {
					// stream already closed
				}
			};

			const itemUpdateHandler = ({ jobId, item }: { jobId: string; item: ImportItemEvent }) => {
				try {
					controller.enqueue(encodeEvent({ type: 'item-update', jobId, item }));
				} catch {
					// stream already closed
				}
			};

			const itemDeleteHandler = ({ jobId, itemId }: { jobId: string; itemId: string }) => {
				try {
					controller.enqueue(encodeEvent({ type: 'item-deleted', jobId, itemId }));
				} catch {
					// stream already closed
				}
			};

			importEvents.on('job-update', updateHandler);
			importEvents.on('job-deleted', deleteHandler);
			importEvents.on('item-update', itemUpdateHandler);
			importEvents.on('item-deleted', itemDeleteHandler);

			// Keep connection alive through proxies and dev server
			const heartbeat = setInterval(() => {
				try {
					controller.enqueue(encodeComment('heartbeat'));
				} catch {
					clearInterval(heartbeat);
				}
			}, 15000);

			cleanup = () => {
				clearInterval(heartbeat);
				importEvents.off('job-update', updateHandler);
				importEvents.off('job-deleted', deleteHandler);
				importEvents.off('item-update', itemUpdateHandler);
				importEvents.off('item-deleted', itemDeleteHandler);
			};
		},
		cancel() {
			cleanup?.();
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			'X-Accel-Buffering': 'no'
		}
	});
};
