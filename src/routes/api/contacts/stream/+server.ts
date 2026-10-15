import { contactEvents } from '$lib/server/finance/events.js';
import type { RequestHandler } from './$types.js';
import { can } from '$lib/server/permissions.js';

export const GET: RequestHandler = ({ locals }) => {
	if (!locals.user) return new Response('Unauthorized', { status: 401 });
	if (!can(locals, 'contacts.read')) return new Response('Forbidden', { status: 403 });

	const encoder = new TextEncoder();
	const encodeEvent = (data: object) => encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
	const encodeComment = (text: string) => encoder.encode(`: ${text}\n\n`);

	let cleanup: (() => void) | null = null;

	const stream = new ReadableStream({
		start(controller) {
			const updateHandler = ({ item }: { item: unknown }) => {
				try {
					controller.enqueue(encodeEvent({ type: 'contact-update', item }));
				} catch {
					// stream closed
				}
			};

			const deleteHandler = ({ id }: { id: number }) => {
				try {
					controller.enqueue(encodeEvent({ type: 'contact-delete', id }));
				} catch {
					// stream closed
				}
			};

			contactEvents.on('contact-update', updateHandler);
			contactEvents.on('contact-delete', deleteHandler);

			const heartbeat = setInterval(() => {
				try {
					controller.enqueue(encodeComment('heartbeat'));
				} catch {
					clearInterval(heartbeat);
				}
			}, 15000);

			cleanup = () => {
				clearInterval(heartbeat);
				contactEvents.off('contact-update', updateHandler);
				contactEvents.off('contact-delete', deleteHandler);
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
