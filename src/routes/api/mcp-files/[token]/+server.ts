import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import { fileStore } from "$lib/server/file-storage.js";
import { downloadMcpFile } from "$lib/server/mcp/file-links.js";

// downloadMcpFile verifies the capability and calls can(permissionForKind)
// against the token owner's freshly resolved permissions, without cookies.
export const GET: RequestHandler = ({ params, request }) =>
  downloadMcpFile(db, fileStore(), params.token, request);
