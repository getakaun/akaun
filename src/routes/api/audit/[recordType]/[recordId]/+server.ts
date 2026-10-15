import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import {
  AUDIT_PERMISSION,
  getAuditTrail,
  type RecordType,
} from "$lib/server/audit.js";
import { can } from "$lib/server/permissions.js";

export const GET: RequestHandler = ({ locals, params }) => {
  const recordType = params.recordType as RecordType;
  const permission = AUDIT_PERMISSION[recordType];
  if (!permission)
    return Response.json({ error: "Unknown record type" }, { status: 400 });
  if (!can(locals, permission))
    return new Response("Forbidden", { status: 403 });

  const recordId = parseInt(params.recordId!);
  if (!recordId)
    return Response.json({ error: "Invalid record id" }, { status: 400 });

  return Response.json(getAuditTrail(db, recordType, recordId));
};
