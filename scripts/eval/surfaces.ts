import type Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/client";
import {
  InMemoryTransport,
  type CallToolResult,
  type McpServer,
  type Tool as McpTool,
} from "@modelcontextprotocol/server";
import { handleMcpRequest } from "../../src/lib/server/mcp/http.ts";
import {
  createServerV2,
  DEFAULT_NAMING,
  type NamingScheme,
  type ToolContext,
  type ToolSet,
} from "../../src/lib/server/mcp/registry.ts";
import { READ_TOOLS } from "../../src/lib/server/mcp/tools/reads/index.ts";
import { WRITE_TOOLS } from "../../src/lib/server/mcp/tools/writes/index.ts";
import { downloadMcpFile } from "../../src/lib/server/mcp/file-links.ts";
import { patLocals } from "../../src/lib/server/tokens/pat.ts";
import type { ToolExecutor, ToolOutcome } from "./agent.ts";

/**
 * The tool surface an evaluation runs against: `v2`, the registry
 * (`createServerV2`) with its tool lists, under one of the naming schemes of
 * the naming experiment. The v1 surface (68 endpoint-shaped tools) was
 * removed with the v1 server; its baseline runs from the tag
 * `mcp-v1-baseline`.
 *
 * A trial talks to its surface in-process over `InMemoryTransport`, so runs
 * compare tools rather than transports. `--serve` exposes the same surface
 * over the app's own `/mcp` transport for real clients.
 */

export const SURFACES = ["v2"] as const;
export type SurfaceKind = (typeof SURFACES)[number];

/** What asking for the removed v1 surface answers. */
export const V1_REMOVED =
  "v1 was removed; check out the tag mcp-v1-baseline to run it";

/** A `--surface` value, checked. Throws for v1 (removed) and anything unknown. */
export function parseSurface(value: string): SurfaceKind {
  if (value === "v1") throw new Error(V1_REMOVED);
  if (!(SURFACES as readonly string[]).includes(value))
    throw new Error(
      `Unknown surface ${value}; the surface is ${SURFACES.join(" or ")}.`,
    );
  return value as SurfaceKind;
}
export const NAMINGS: readonly NamingScheme[] = [
  "akaun_verb_noun",
  "akaun_noun_verb",
  "plain",
];
export type SurfaceConfig = { surface: SurfaceKind; naming: NamingScheme };

/** The origin file links are issued on inside a trial; `fetch_url` accepts only it. */
export const EVAL_ORIGIN = "http://akaun.eval";

/** What a surface needs to run: an `AppContext` whose store and storage root are the trial's own. */
export type SurfaceContext = ToolContext & { requestOrigin: string };

export function createSurfaceServer(
  config: SurfaceConfig,
  ctx: SurfaceContext,
  toolSet?: ToolSet,
): McpServer {
  return createServerV2({
    ...ctx,
    tools: toolSet ?? { reads: READ_TOOLS, writes: WRITE_TOOLS },
    naming: config.naming ?? DEFAULT_NAMING,
  });
}

export type SurfaceConnection = {
  client: Client;
  /** The listing, as `tools/list` returned it. */
  tools: McpTool[];
  instructions: string;
  /** `toolSurfaceHash` of the listing, recorded with every trial. */
  hash: string;
  close(): Promise<void>;
};

/** Connects an in-process MCP client to a fresh server for `ctx`. */
export async function connectSurface(
  config: SurfaceConfig,
  ctx: SurfaceContext,
  toolSet?: ToolSet,
): Promise<SurfaceConnection> {
  const server = createSurfaceServer(config, ctx, toolSet);
  const client = new Client({ name: "akaun-eval", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const tools = (await client.listTools()).tools;
  const instructions = client.getInstructions() ?? "";
  return {
    client,
    tools,
    instructions,
    hash: toolSurfaceHash(tools, instructions),
    async close() {
      await client.close();
      await server.close();
    },
  };
}

/** JSON with object keys sorted at every level, so equal listings hash equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  return value;
}

/**
 * A sha256 over everything the model is shown of a surface: each tool's
 * name, title, description, input schema and annotations, sorted by name,
 * plus the server instructions. Two runs with the same hash offered the model
 * the same tools.
 */
export function toolSurfaceHash(
  tools: readonly McpTool[],
  instructions: string,
): string {
  const listed = [...tools]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((tool) => ({
      name: tool.name,
      title: tool.title ?? null,
      description: tool.description ?? null,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations ?? null,
    }));
  return createHash("sha256")
    .update(canonicalJson({ tools: listed, instructions }))
    .digest("hex");
}

/** An MCP tool as a Messages API tool definition. */
export function toAnthropicTool(tool: McpTool): Anthropic.Tool {
  const { $schema: _schema, ...schema } = tool.inputSchema as Record<
    string,
    unknown
  >;
  void _schema;
  return {
    name: tool.name,
    description: tool.description ?? tool.title ?? tool.name,
    input_schema: { ...schema, type: "object" } as Anthropic.Tool.InputSchema,
  };
}

/** The error code an MCP error result carries, whichever of the shapes it uses. */
export function errorCodeOf(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const error = parsed.error;
    if (error && typeof error === "object" && "code" in error)
      return String((error as { code: unknown }).code);
    if (typeof error === "string" && /^[A-Z][A-Z_]+$/.test(error)) return error;
    if (typeof parsed.code === "string") return parsed.code;
  } catch {
    // Not JSON: fall through to the text.
  }
  if (/input validation error/i.test(text)) return "INVALID_INPUT";
  return text.match(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/)?.[1];
}

/** The input paths an `INVALID_INPUT` names: v2's `issues[].path`, or zod issues quoted in an SDK message. */
export function issuePathsOf(text: string): string[] {
  const paths = new Set<string>();
  const add = (path: unknown) => {
    if (Array.isArray(path)) paths.add(path.map(String).join(".") || "(root)");
    else if (typeof path === "string") paths.add(path || "(root)");
  };
  try {
    const parsed = JSON.parse(text) as { error?: { issues?: unknown } };
    const issues = parsed.error?.issues;
    if (Array.isArray(issues))
      for (const issue of issues)
        add(
          (issue as { path?: unknown; field?: unknown }).path ??
            (issue as { field?: unknown }).field,
        );
  } catch {
    for (const match of text.matchAll(/"path"\s*:\s*(\[[^\]]*\])/g)) {
      try {
        add(JSON.parse(match[1]));
      } catch {
        // A path that is not JSON is skipped.
      }
    }
  }
  return [...paths];
}

/** An MCP tool result as `tool_result` content for the model, plus what the metrics need. */
export function toToolOutcome(result: CallToolResult): ToolOutcome {
  const blocks: Exclude<
    Anthropic.ToolResultBlockParam["content"],
    string | undefined
  > = [];
  const traceParts: string[] = [];
  let bytes = 0;
  for (const block of result.content ?? []) {
    if (block.type === "text") {
      blocks.push({ type: "text", text: block.text });
      traceParts.push(block.text);
      bytes += Buffer.byteLength(block.text);
    } else if (
      block.type === "image" &&
      ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
        block.mimeType,
      )
    ) {
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: block.mimeType as "image/png",
          data: block.data,
        },
      });
      traceParts.push(
        `[image ${block.mimeType}, ${block.data.length} base64 chars]`,
      );
      bytes += block.data.length;
    } else {
      const text = JSON.stringify(block);
      blocks.push({ type: "text", text });
      traceParts.push(text);
      bytes += Buffer.byteLength(text);
    }
  }
  const traceText = traceParts.join("\n");
  const isError = result.isError === true;
  return {
    content: blocks.length ? blocks : "(empty result)",
    isError,
    ...(isError
      ? {
          errorCode: errorCodeOf(traceText) ?? "ERROR",
          issuePaths: issuePathsOf(traceText),
        }
      : {}),
    traceText,
    outputBytes: bytes,
  };
}

/**
 * The surface's tools for the agent: sorted by name, each call made through
 * the MCP client. A name the surface does not list (a made-up tool) and a
 * protocol-level failure come back as error results, never as throws.
 */
export function mcpToolExecutor(connection: SurfaceConnection): ToolExecutor {
  const tools = [...connection.tools].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const names = new Set(tools.map((tool) => tool.name));
  return {
    definitions: tools.map(toAnthropicTool),
    async call(name, input) {
      if (!names.has(name)) {
        const message = `There is no tool named ${name}.`;
        return {
          content: message,
          isError: true,
          errorCode: "UNKNOWN_TOOL",
          traceText: message,
          outputBytes: Buffer.byteLength(message),
        };
      }
      try {
        const result = (await connection.client.callTool({
          name,
          arguments: (input ?? {}) as Record<string, unknown>,
        })) as CallToolResult;
        return toToolOutcome(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: message,
          isError: true,
          errorCode: errorCodeOf(message) ?? "PROTOCOL_ERROR",
          issuePaths: issuePathsOf(message),
          traceText: message,
          outputBytes: Buffer.byteLength(message),
        };
      }
    },
  };
}

/**
 * An HTTP handler for `--serve`: `POST /mcp` with a personal access token,
 * and the signed file links (`GET /api/mcp-files/<token>`), against one book.
 * `/mcp` goes through the app's own `handleMcpRequest`, so a real client meets
 * the production transport (the Origin check, POST only, the 128 KiB limit
 * with its `attach_file` allowance) under the naming scheme asked for.
 */
export function createSurfaceHandler(
  config: SurfaceConfig,
  base: Omit<ToolContext, "locals">,
  origin: string,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    const fileToken = url.pathname.match(/^\/api\/mcp-files\/([^/]+)$/)?.[1];
    if (fileToken && request.method === "GET")
      return downloadMcpFile(base.db, base.store, fileToken, request);
    if (url.pathname !== "/mcp")
      return new Response("Not found", { status: 404 });
    const locals = patLocals(base.db, request.headers.get("Authorization")) ?? {
      user: null,
      permissions: null,
    };
    return handleMcpRequest(request, { ...base, locals }, origin, {
      naming: config.naming ?? DEFAULT_NAMING,
    });
  };
}
