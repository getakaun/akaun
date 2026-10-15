import type { RequestHandler } from "./$types.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "$lib/server/db/client.js";
import {
  deleteStatementFile,
  MAX_UPLOAD_BYTES,
  saveReconciliationStatement,
  sniffAllowedType,
} from "$lib/server/file-storage.js";
import { hasPermission } from "$lib/server/permissions.js";
import {
  createStatement,
  ReconciliationError,
} from "$lib/server/services/reconciliation.js";
import { processStatementImport } from "$lib/server/reconciliation/statement-import.js";

/**
 * Uploading a statement for one account.
 *
 * The account comes from the **path**, not from a field in the form. A
 * statement always belonged to exactly one account — without knowing which,
 * there is no way to know which movements its lines could be, which is how
 * money sitting in a wallet once ended up offered against a bank statement —
 * and reconciling now starts from the account it belongs to, so the answer is
 * already in the address (FR-048, FR-050).
 *
 * That removes a question the user had to answer twice, and with it the `400`
 * "Choose the account this statement belongs to" refusal: an address cannot
 * fail to name an account.
 *
 * Everything else is unchanged and deliberately so (FR-057): the same
 * `reconciliation` ability, the same Zod boundary, the same size and type
 * checks, the same `createStatement` (whose money-holding validation still
 * runs), the same audit entry and the same event.
 */
const accountIdSchema = z.coerce.number().int().positive();

export const POST: RequestHandler = async ({ locals, params, request }) => {
  if (!locals.user) return new Response("Unauthorized", { status: 401 });
  if (!hasPermission(locals, "reconciliation", "add"))
    return new Response("Forbidden", { status: 403 });

  const accountId = accountIdSchema.safeParse(params.id);
  if (!accountId.success)
    return Response.json(
      { error: "That account no longer exists." },
      { status: 404 },
    );

  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File))
    return Response.json({ error: "file is required" }, { status: 400 });
  if (file.size > MAX_UPLOAD_BYTES)
    return Response.json(
      { error: "File is larger than 15 MB" },
      { status: 413 },
    );
  const buffer = Buffer.from(await file.arrayBuffer());
  if (!sniffAllowedType(buffer))
    return Response.json(
      { error: "Only PDF, JPEG, and PNG statements are supported" },
      { status: 400 },
    );
  const path = await saveReconciliationStatement(
    buffer,
    randomUUID(),
    file.name,
  );
  let statement;
  try {
    statement = createStatement(db, locals, {
      originalFilename: file.name,
      storedFilePath: path,
      accountId: accountId.data,
    });
  } catch (e) {
    // No statement row points at the file, so nothing ever would.
    deleteStatementFile(path);
    if (e instanceof ReconciliationError)
      return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
  void processStatementImport(db, {
    statementId: statement.id,
    relativePath: path,
    originalFilename: file.name,
    userId: locals.user.id,
  });
  return Response.json(statement, { status: 202 });
};
