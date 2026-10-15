import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import { can } from "$lib/server/permissions.js";
import { reconciliationEvents } from "$lib/server/reconciliation/events.js";
import { workspace } from "$lib/server/services/reconciliation.js";

export const GET: RequestHandler = ({ locals }) => {
  if (!locals.user) return new Response("Unauthorized", { status: 401 });
  if (!can(locals, "reconciliation.read")) {
    return new Response("Forbidden", { status: 403 });
  }

  const encoder = new TextEncoder();
  const encodeEvent = (data: object) =>
    encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
  const encodeComment = (text: string) => encoder.encode(`: ${text}\n\n`);
  let cleanup: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encodeEvent({ type: "snapshot", ...workspace(db, locals) }),
      );

      const eventNames = [
        "statement-update",
        "statement-deleted",
        "line-update",
        "line-deleted",
        "lines-added",
        "allocation-update",
        "allocations-bulk-update",
      ] as const;
      const handlers = eventNames.map((eventName) => {
        const handler = (payload: object) => {
          try {
            controller.enqueue(encodeEvent({ type: eventName, ...payload }));
          } catch {
            // The connection closed before cancel() completed cleanup.
          }
        };
        reconciliationEvents.on(eventName, handler);
        return { eventName, handler };
      });

      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encodeComment("heartbeat"));
        } catch {
          clearInterval(heartbeat);
        }
      }, 15_000);

      cleanup = () => {
        clearInterval(heartbeat);
        for (const { eventName, handler } of handlers) {
          reconciliationEvents.off(eventName, handler);
        }
      };
    },
    cancel() {
      cleanup?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
};
