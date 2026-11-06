import { z } from "zod";
import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import { can } from "$lib/server/permissions.js";
import { badRequest, forbidden } from "$lib/server/api-response.js";
import {
  expenseTaxReport,
  expenseTaxCsv,
} from "$lib/server/queries/expense-tax-report.js";
import {
  formatFrom,
  periodQuery,
  queryValues,
  reportResponse,
} from "../report-endpoint.js";

export const GET: RequestHandler = async ({ locals, url }) => {
  if (!can(locals, "reports.read")) return forbidden();
  const parsed = periodQuery
    .extend({ review: z.enum(["unresolved", "all"]).optional() })
    .refine((q) => q.dateFrom <= q.dateTo, {
      message: "The start date must not follow the end date.",
    })
    .safeParse(queryValues(url, ["dateFrom", "dateTo", "review"]));
  if (!parsed.success) return badRequest(parsed.error);
  const report = expenseTaxReport(
    db,
    parsed.data.dateFrom,
    parsed.data.dateTo,
    parsed.data.review === "unresolved",
  );
  return reportResponse(
    formatFrom(url),
    report,
    () => expenseTaxCsv(report),
    `expense-tax-${report.dateFrom}-to-${report.dateTo}`,
  );
};
