import { redirect } from "@sveltejs/kit";
import { localReturnTo } from "$lib/server/oidc/protocol.js";
import type { RequestHandler } from "./$types.js";

export const GET: RequestHandler = ({ url, setHeaders }) => {
  setHeaders({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  redirect(302, localReturnTo(url.searchParams.get("returnTo")));
};
