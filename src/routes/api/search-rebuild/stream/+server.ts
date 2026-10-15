import { can } from '$lib/server/permissions.js';
import { getRebuildStatus } from '$lib/server/search-rebuild/worker.js';
import { searchRebuildEvents } from '$lib/server/search-rebuild/events.js';
import type { RebuildStatus } from '$lib/server/search-rebuild/worker.js';
import type { RequestHandler } from './$types.js';

export const GET: RequestHandler = ({ locals }) => {
	if (!locals.user) return new Response('Unauthorized', { status: 401 });
	if (!can(locals, 'settings.manage')) return new Response('Forbidden', { status: 403 });

	const encoder = new TextEncoder();
	const encodeEvent = (data: object) => encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
	const encodeComment = (text: string) => encoder.encode(`: ${text}\n\n`);

	let cleanup: (() => void) | null = null;

	const stream = new ReadableStream({
		start(controller) {
			controller.enqueue(encodeEvent({ type: 'snapshot', status: getRebuildStatus() }));

			const progressHandler = (status: RebuildStatus) => {
				try {
					controller.enqueue(encodeEvent({ type: 'progress', status }));
				} catch {
					// stream already closed
				}
			};

			searchRebuildEvents.on('progress', progressHandler);

			const heartbeat = setInterval(() => {
				try {
					controller.enqueue(encodeComment('heartbeat'));
				} catch {
					clearInterval(heartbeat);
				}
			}, 15000);

			cleanup = () => {
				clearInterval(heartbeat);
				searchRebuildEvents.off('progress', progressHandler);
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
