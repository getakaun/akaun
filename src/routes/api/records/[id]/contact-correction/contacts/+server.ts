import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import { toResponse } from "$lib/server/application/http.js";
import { searchContactCorrectionContacts } from "$lib/server/application/contact-correction-search.js";

export const GET: RequestHandler = ({ locals, params, url }) =>
  toResponse(
    searchContactCorrectionContacts(
      { db, locals },
      Number(params.id),
      url.searchParams.get("search") ?? "",
    ),
  );
