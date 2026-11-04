import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import { readClosingStatus } from "$lib/server/application/closing.js";
import { toResponse } from "$lib/server/application/http.js";

export const GET: RequestHandler = ({ locals }) =>
  toResponse(readClosingStatus({ db, locals }));
