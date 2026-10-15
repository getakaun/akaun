import type { RequestHandler } from "./$types.js";
import { eq } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { importQueue } from "$lib/server/db/schema.js";
import { fileStore } from "$lib/server/file-storage.js";
import { can } from "$lib/server/permissions.js";
import { storedFileResponse } from "$lib/server/stored-file-response.js";

export const GET: RequestHandler = async ({ locals, params, request }) => {
  if (!locals.user) return new Response("Unauthorized", { status: 401 });
  if (!can(locals, "import.read"))
    return new Response("Forbidden", { status: 403 });

  const row = db
    .select()
    .from(importQueue)
    .where(eq(importQueue.id, params.jobId))
    .get();
  if (!row) return new Response("Not found", { status: 404 });

  return storedFileResponse(
    fileStore(),
    request,
    row.tempFilePath,
    row.originalFilename,
  );
};
