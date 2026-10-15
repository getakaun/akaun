import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import {
  AUDIT_RESOURCE,
  getAuditTrail,
  type RecordType,
} from "$lib/server/audit.js";
import { hasPermission } from "$lib/server/permissions.js";

export const GET: RequestHandler = ({ locals, params }) => {
  const recordType = params.recordType as RecordType;
  const resource = AUDIT_RESOURCE[recordType];
  if (!resource)
    return Response.json({ error: "Unknown record type" }, { status: 400 });
  if (!hasPermission(locals, resource, "view"))
    return new Response("Forbidden", { status: 403 });

  const recordId = parseInt(params.recordId!);
  if (!recordId)
    return Response.json({ error: "Invalid record id" }, { status: 400 });

  return Response.json(getAuditTrail(db, recordType, recordId));
};
