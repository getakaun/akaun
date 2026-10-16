import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import {
  AUDIT_PERMISSION,
  getAuditTrail,
  isRecordType,
} from "$lib/server/audit.js";
import { can } from "$lib/server/permissions.js";

export const GET: RequestHandler = ({ locals, params }) => {
  const recordType = params.recordType;
  if (!isRecordType(recordType))
    return Response.json({ error: "Unknown record type" }, { status: 400 });
  if (!can(locals, AUDIT_PERMISSION[recordType]))
    return new Response("Forbidden", { status: 403 });

  // Text, because some kinds have text ids (an OAuth grant, an import job).
  const recordId = params.recordId.trim();
  if (!recordId || recordId.length > 200)
    return Response.json({ error: "Invalid record id" }, { status: 400 });

  return Response.json(getAuditTrail(db, recordType, recordId));
};
