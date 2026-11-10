import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import {
  changeTaxWorksheet,
  readTaxWorksheet,
} from "$lib/server/application/tax-worksheets.js";
import { toResponse, failureResponse } from "$lib/server/application/http.js";
import {
  taxWorksheetCsv,
  taxWorksheetHtml,
} from "$lib/server/queries/tax-worksheets.js";
import { toCsv } from "$lib/server/ledger/reports/csv.js";
export const GET: RequestHandler = ({ locals, params, url }) => {
  const revision = url.searchParams.has("revision")
    ? Number(url.searchParams.get("revision"))
    : undefined;
  const result = readTaxWorksheet(
    { db, locals },
    Number(params.id),
    revision,
    !["csv", "html"].includes(url.searchParams.get("format") ?? ""),
  );
  if (!result.ok) return failureResponse(result);
  if (url.searchParams.get("format") === "html")
    return new Response(taxWorksheetHtml(result.value), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
        "X-Content-Type-Options": "nosniff",
      },
    });
  if (url.searchParams.get("format") === "csv")
    return new Response(toCsv(taxWorksheetCsv(result.value)), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="annual-tax-${result.value.worksheet.ya}-revision-${result.value.revision.revision}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  return toResponse(result);
};
export const POST: RequestHandler = async ({ locals, params, request }) =>
  toResponse(
    changeTaxWorksheet(
      { db, locals },
      Number(params.id),
      await request.json().catch(() => null),
    ),
  );
