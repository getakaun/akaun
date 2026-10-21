import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import { toResponse } from "$lib/server/application/http.js";
import { reimbursementCandidates } from "$lib/server/application/reimbursements.js";
export const GET: RequestHandler = ({ locals, url }) =>
  toResponse(
    reimbursementCandidates(
      { db, locals },
      Number(url.searchParams.get("contactId")),
      url.searchParams.has("accountId")
        ? Number(url.searchParams.get("accountId"))
        : undefined,
    ),
  );
