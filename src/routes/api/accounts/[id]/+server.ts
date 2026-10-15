import { z } from "zod";
import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db/client.js";
import { can } from "$lib/server/permissions.js";
import {
  badRequest,
  forbidden,
  notFound,
  refused,
} from "$lib/server/api-response.js";
import { getAccount } from "$lib/server/queries/accounts.js";
import { patchAccount, removeAccount } from "$lib/server/services/accounts.js";
import {
  AccountSubTypesByType,
  AccountType,
  type AccountSubTypeCode,
  type AccountTypeCode,
} from "$lib/enums.js";

// A role is deliberately absent: an account that has been a bank account cannot
// become an expense category without rewriting what every movement against it
// meant.
//
// Every sub-type code valid for some type. Whether a given sub-type
// applies to *this particular* account depends on its existing type, which
// this schema cannot see, so that finer rejection is enforced by
// `patchAccount` itself (`ledger/account-eligibility.ts`).
const KNOWN_SUB_TYPES = Object.values(AccountSubTypesByType).flat();

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    type: z
      .number()
      .int()
      .refine((value): value is AccountTypeCode =>
        Object.values(AccountType).includes(value as AccountTypeCode),
      )
      .optional(),
    active: z.boolean().optional(),
    code: z.number().int().positive().optional(),
    subType: z
      .number()
      .int()
      .refine(
        (value): value is AccountSubTypeCode =>
          KNOWN_SUB_TYPES.includes(value as AccountSubTypeCode),
        {
          message: "Choose a known sub-type.",
        },
      )
      .optional(),
  })
  .strict();

function accountId(params: { id: string }): number | null {
  const id = Number(params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export const GET: RequestHandler = async ({ locals, params }) => {
  if (!can(locals, "accounts.read")) return forbidden();
  const id = accountId(params as { id: string });
  if (id === null) return notFound("That account no longer exists.");

  const account = getAccount(db, id);
  if (!account) return notFound("That account no longer exists.");
  return Response.json(account);
};

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
  if (!can(locals, "accounts.update")) return forbidden();
  const id = accountId(params as { id: string });
  if (id === null) return notFound("That account no longer exists.");

  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);

  const result = patchAccount(db, id, locals.user!.id, parsed.data);
  if (!result.ok) return refused(result.reason);
  return Response.json(result.value);
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
  if (!can(locals, "accounts.delete")) return forbidden();
  const id = accountId(params as { id: string });
  if (id === null) return notFound("That account no longer exists.");

  // The refusal's `reason` is exactly what the disabled delete button's tooltip
  // already showed, so the two can never say different things (FR-009).
  const result = removeAccount(db, id, locals.user!.id);
  if (!result.ok) return refused(result.reason);
  return new Response(null, { status: 204 });
};
