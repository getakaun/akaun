import type { RequestHandler } from "./$types.js";
import { env } from "$env/dynamic/private";
import { db } from "$lib/server/db/client.js";
import { config } from "$lib/server/oauth/runtime.js";
import { handleMcpRequest } from "$lib/server/mcp/http.js";
import { fileStore } from "$lib/server/file-storage.js";
import { STORAGE_PATH } from "$lib/server/env.js";
import { extractAttachmentsText } from "$lib/server/extraction/attachment-text.js";

/**
 * An API token (not OAuth) sees write tools only when this is set. Phase one
 * told people to connect a read-only user with a token; this keeps that token
 * read-only after the upgrade unless the operator opts in.
 */
const bearerWrites = env.MCP_BEARER_WRITES === "true";

const handle: RequestHandler = ({ request, locals, url }) =>
  handleMcpRequest(
    request,
    {
      db,
      locals,
      store: fileStore(),
      storageRoot: STORAGE_PATH,
      indexAttachments: (keys) => extractAttachmentsText(keys),
      bearerWrites,
    },
    config?.issuer ?? url.origin,
  );

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
export const PUT = handle;
export const PATCH = handle;
export const OPTIONS = handle;
