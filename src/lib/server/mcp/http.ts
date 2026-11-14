import { createMcpHandler } from "@modelcontextprotocol/server";
import {
  createServerV2,
  DEFAULT_NAMING,
  type NamingScheme,
  type ToolContext,
} from "./registry.js";
import { READ_TOOLS } from "./tools/reads/index.js";
import { WRITE_TOOLS } from "./tools/writes/index.js";
import { inspectRpc } from "./oauth-challenge.js";

/**
 * What one `/mcp` request runs against: the tool context without the request
 * origin, which is taken from the request itself.
 */
export type McpContext = Omit<ToolContext, "requestOrigin">;

/**
 * `/mcp`: stateless Streamable HTTP, POST only, serving the v2 tools
 * (`READ_TOOLS`, `WRITE_TOOLS`) under `naming` — the default `akaun_` scheme in
 * production; the evaluation's `--serve` passes another for the naming
 * experiment. Every check before the SDK runs is the same for every scheme:
 * a signed-in caller (401), the exact Origin when one is sent (403), POST
 * (405), and `inspectRpc`'s body limit and OAuth step-up.
 */
export async function handleMcpRequest(
  request: Request,
  context: McpContext,
  expectedOrigin: string,
  { naming = DEFAULT_NAMING }: { naming?: NamingScheme } = {},
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

  const inspection = await inspectRpc(request, context.locals, { naming });
  if (inspection.response) return inspection.response;
  // Capture this request's authenticated context only. SDK v2 serves modern
  // per-request envelopes and stateless legacy traffic from the same factory.
  const handler = createMcpHandler(
    () =>
      createServerV2({
        ...context,
        requestOrigin: new URL(request.url).origin,
        tools: { reads: READ_TOOLS, writes: WRITE_TOOLS },
        naming,
      }),
    {
      legacy: "stateless",
      // Auto returns JSON for these synchronous calls; no handler emits related
      // protocol notifications that would upgrade a modern response to SSE.
      responseMode: "auto",
      // 128 KiB, or enough for one file when the call is `akaun_attach_file`:
      // chosen by `inspectRpc` after reading which tool this is.
      maxRequestBodySize: inspection.maxRequestBodySize,
      // Akaun has no MCP change-notification channel. Do not hold a stream open
      // against a handler whose lifetime is a single authenticated request.
      maxSubscriptions: 0,
    },
  );
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
