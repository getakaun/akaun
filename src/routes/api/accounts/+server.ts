import { z } from "zod";
import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import { can } from "$lib/server/permissions.js";
import { badRequest, forbidden, refused } from "$lib/server/api-response.js";
import { listAccounts } from "$lib/server/queries/accounts.js";
import { createAccount } from "$lib/server/services/accounts.js";
import {
  AccountSubTypesByType,
  AccountType,
  type AccountSubTypeCode,
  type AccountTypeCode,
} from "$lib/enums.js";
import { NEEDS_REVIEW_TYPES } from "$lib/server/ledger/account-type.js";

/**
 * The kinds of account a person may create.
 *
 * The shared owed accounts and Opening balances are seeded once and are the
 * app's own plumbing; a partner's pair comes from granting that contact the
 * Partner role (FR-008b). Neither is offered here.
 */
const ACCOUNT_TYPES = Object.values(AccountType).filter((value): value is AccountTypeCode => typeof value === "number");

const createSchema = z
  .object({
    type: z
      .number()
      .int()
      .refine((value): value is AccountTypeCode => ACCOUNT_TYPES.includes(value as AccountTypeCode), {
        message: "Choose one of the five account types.",
      }),
    name: z.string().trim().min(1).max(120),
    code: z.number().int().optional(),
    subType: z.number().int().optional() as z.ZodType<AccountSubTypeCode | undefined>,
  })
  .strict()
  .superRefine((data, ctx) => {
    const allowed = AccountSubTypesByType[data.type];
    if (allowed === undefined) {
      if (data.subType !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["subType"],
          message: "A sub-type does not apply to this account type.",
        });
      }
      return;
    }
    if (data.subType === undefined) {
      if (NEEDS_REVIEW_TYPES.includes(data.type)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["subType"],
          message: "Choose what kind of account this is.",
        });
      }
    } else if (!allowed.includes(data.subType)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["subType"],
        message: "That sub-type does not belong to this account type.",
      });
    }
  });

export const GET: RequestHandler = async ({ locals, url }) => {
  if (!can(locals, "accounts.read")) return forbidden();

  const typeRaw = url.searchParams.get("type");
  const type = typeRaw ? Number(typeRaw) : undefined;

  return Response.json({
    accounts: listAccounts(db, {
      type: ACCOUNT_TYPES.includes(type as AccountTypeCode) ? type as AccountTypeCode : undefined,
      search: url.searchParams.get("search") ?? undefined,
      includeArchived: url.searchParams.get("includeArchived") === "true",
    }),
  });
};

export const POST: RequestHandler = async ({ locals, request }) => {
  if (!can(locals, "accounts.create")) return forbidden();

  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);

  const result = createAccount(db, locals.user!.id, {
    type: parsed.data.type,
    name: parsed.data.name,
    code: parsed.data.code,
    subType: parsed.data.subType,
  });
  if (!result.ok) return refused(result.reason);

  return Response.json(result.value, { status: 201 });
};
