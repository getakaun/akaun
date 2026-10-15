import { z } from "zod";
import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import { can } from "$lib/server/permissions.js";
import { badRequest, forbidden, refused } from "$lib/server/api-response.js";
import { accountEvents } from "$lib/server/ledger/events.js";
import {
  getAccountDefaults,
  replaceAccountDefaults,
} from "$lib/server/services/account-defaults.js";
import { DefaultAccountPurpose } from "$lib/enums.js";

const purposeSchema = z.union([
  z.literal(DefaultAccountPurpose.Receivable),
  z.literal(DefaultAccountPurpose.Payable),
  z.literal(DefaultAccountPurpose.OpeningBalances),
  z.literal(DefaultAccountPurpose.SalesRevenue),
  z.literal(DefaultAccountPurpose.UncategorisedExpense),
  z.literal(DefaultAccountPurpose.EverydayTransaction),
  z.literal(DefaultAccountPurpose.UncategorisedIncome),
]);
const replaceSchema = z
  .object({
    defaults: z.array(
      z
        .object({
          purpose: purposeSchema,
          accountId: z.number().int().positive(),
        })
        .strict(),
    ),
  })
  .strict();

export const GET: RequestHandler = async ({ locals }) => {
  if (!can(locals, "accounts.read")) return forbidden();
  return Response.json({ defaults: getAccountDefaults(db) });
};

export const PUT: RequestHandler = async ({ locals, request }) => {
  if (!can(locals, "accounts.update")) return forbidden();
  const parsed = replaceSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) return badRequest(parsed.error);

  const result = replaceAccountDefaults(
    db,
    locals.user!.id,
    parsed.data.defaults,
  );
  if (!result.ok) return refused(result.reason);

  // The service transaction has committed both defaults and their audits before
  // subscribers are told to refetch the chart.
  accountEvents.emit("accounts-refresh", { reason: "defaults" });
  return Response.json({ defaults: result.value });
};
