import { createMcpHandler } from "@modelcontextprotocol/server";
import { createServer } from "./server.js";
import type { McpContext } from "./common.js";
import { inspectRpc } from "./oauth-challenge.js";

export async function handleMcpRequest(
  request: Request,
  context: McpContext,
  expectedOrigin: string,
): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  if (!context.locals.user)
    return new Response("Unauthorized", {
      status: 401,
      headers: { ...headers, "WWW-Authenticate": 'Bearer realm="akaun-mcp"' },
    });
  // Exact origin includes scheme and port. Native clients may omit Origin.
  const origin = request.headers.get("Origin");
  if (origin !== null && origin !== expectedOrigin)
    return new Response("Forbidden (MCP origin check failed)", {
      status: 403,
      headers,
    });
  if (request.method !== "POST")
    return new Response("This stateless MCP endpoint accepts POST only.", {
      status: 405,
      headers: { ...headers, Allow: "POST" },
    });

  const inspection = await inspectRpc(request, context.locals);
  if (inspection.response) return inspection.response;
  // Capture this request's authenticated context only. SDK v2 serves modern
  // per-request envelopes and stateless legacy traffic from the same factory.
  const handler = createMcpHandler(() => createServer(context), {
    legacy: "stateless",
    // Auto returns JSON for these synchronous calls; no handler emits related
    // protocol notifications that would upgrade a modern response to SSE.
    responseMode: "auto",
    // 128 KiB, or enough for one file when the call is `attach_file`: chosen
    // by `inspectRpc` after reading which tool this is.
    maxRequestBodySize: inspection.maxRequestBodySize,
    // Akaun has no MCP change-notification channel. Do not hold a stream open
    // against a handler whose lifetime is a single authenticated request.
    maxSubscriptions: 0,
  });
  try {
    const response = await handler.fetch(request);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } finally {
    // The SDK owns per-request server cleanup, including the legacy SSE leg.
    // close() releases the modern handler's bus and completed exchanges.
    await handler.close();
  }
}
