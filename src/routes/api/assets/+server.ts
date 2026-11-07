import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import { saveAsset } from "$lib/server/application/fixed-assets.js";
import { toResponse } from "$lib/server/application/http.js";
export const POST: RequestHandler = async ({ locals, request }) => {
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON." }, { status: 400 });
  }
  return toResponse(saveAsset({ db, locals }, input), 201);
};
import { can } from "$lib/server/permissions.js";
import { forbidden } from "$lib/server/api-response.js";
import { assetRegister } from "$lib/server/queries/fixed-assets.js";
import { isValidDate, today } from "$lib/server/date.js";
export const GET: RequestHandler = ({ locals, url }) => {
  if (!can(locals, "accounts.read")) return forbidden();
  const asOf = url.searchParams.get("asOf") ?? today();
  if (!isValidDate(asOf))
    return Response.json(
      { error: "Choose a valid reconciliation date." },
      { status: 400 },
    );
  const report = assetRegister(db, asOf);
  if (!can(locals, "records.read"))
    return Response.json({
      ...report,
      unregistered: [],
      rows: report.rows.map((a) => ({
        ...a,
        sourceMovementId: null,
        sourceRecordId: null,
      })),
    });
  return Response.json(report);
};
