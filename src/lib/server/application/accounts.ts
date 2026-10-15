import { z } from "zod";
import {
  AccountSubTypesByType,
  AccountType,
  type AccountSubTypeCode,
  type AccountTypeCode,
} from "$lib/enums.js";
import { getAccount, openingBalanceFor } from "../queries/accounts.js";
import {
  createAccount as createAccountService,
  patchAccount,
  removeAccount,
  setOpeningBalance as setOpeningBalanceService,
} from "../services/accounts.js";
import { emitRecordUpdate } from "../services/ledger.js";
import { ledgerEvents } from "../ledger/events.js";
import type { AccountView } from "../ledger/types.js";
import { actor, requirePermissions, type AppContext } from "./context.js";
import { fail, missing, ok, type AppResult } from "./result.js";
import { isoDate } from "./records.js";
import {
  ABSENT,
  accountVersion,
  checkVersion,
  recordVersion,
} from "./version.js";

/**
 * Accounts — and categories, which are accounts with an Expense or Revenue
 * type (CLAUDE.md, The Ledger) — as authorized operations shared by the REST
 * routes, the accounts page's form actions and the MCP tools.
 *
 * Whether a sub-type belongs to a type, a code to its range, or an account may
 * be retyped or deleted at all is the service's to say
 * (`ledger/account-eligibility.ts`); these add who may, and the version check.
 */

const ACCOUNT_TYPES = Object.values(AccountType).filter(
  (value): value is AccountTypeCode => typeof value === "number",
);
const KNOWN_SUB_TYPES = Object.values(AccountSubTypesByType).flat();

export const accountType = z
  .number()
  .int()
  .refine(
    (value): value is AccountTypeCode =>
      ACCOUNT_TYPES.includes(value as AccountTypeCode),
    { message: "Choose one of the five account types." },
  )
  .describe("1 Asset, 2 Liability, 3 Equity, 4 Revenue, 5 Expense.");
export const accountSubType = z
  .number()
  .int()
  .refine(
    (value): value is AccountSubTypeCode =>
      KNOWN_SUB_TYPES.includes(value as AccountSubTypeCode),
    { message: "Choose a known sub-type." },
  );

export const createAccountShape = {
  type: accountType,
  name: z.string().trim().min(1).max(120),
  code: z.number().int().positive().optional(),
  subType: accountSubType.optional(),
};

export const updateAccountShape = {
  name: z.string().trim().min(1).max(120).optional(),
  type: accountType.optional(),
  /** False archives: the account keeps its history and is no longer offered. */
  active: z.boolean().optional(),
  code: z.number().int().positive().optional(),
  subType: accountSubType.optional(),
};

export const openingBalanceShape = {
  date: isoDate,
  /** Whole cents of the main currency. Negative is allowed: an account can start overdrawn. Zero removes it. */
  amountMinor: z.number().int(),
};

export type AccountWritten = { account: AccountView; version: string };

const NOT_FOUND = "That account no longer exists.";

function written(db: AppContext["db"], account: AccountView): AccountWritten {
  return { account, version: accountVersion(db, account.id) };
}

export function createAccount(
  ctx: AppContext,
  input: z.output<z.ZodObject<typeof createAccountShape>>,
): AppResult<AccountWritten> {
  const refused = requirePermissions(ctx, [["accounts", "add"]]);
  if (refused) return refused;
  const result = createAccountService(ctx.db, actor(ctx), {
    type: input.type,
    name: input.name,
    code: input.code,
    subType: input.subType as AccountSubTypeCode | undefined,
  });
  return result.ok
    ? ok(written(ctx.db, result.value))
    : fail("REFUSED", result.reason);
}

export function updateAccount(
  ctx: AppContext,
  id: number,
  patch: z.output<z.ZodObject<typeof updateAccountShape>>,
  expectedVersion?: string,
): AppResult<AccountWritten> {
  const refused = requirePermissions(ctx, [["accounts", "change"]]);
  if (refused) return refused;
  if (!getAccount(ctx.db, id)) return missing(NOT_FOUND);
  const stale = checkVersion(accountVersion(ctx.db, id), expectedVersion);
  if (stale) return stale;
  const result = patchAccount(ctx.db, id, actor(ctx), {
    ...patch,
    subType: patch.subType as AccountSubTypeCode | undefined,
  });
  return result.ok
    ? ok(written(ctx.db, result.value))
    : fail("REFUSED", result.reason);
}

export function deleteAccount(
  ctx: AppContext,
  id: number,
  expectedVersion?: string,
): AppResult<{ id: number }> {
  const refused = requirePermissions(ctx, [["accounts", "delete"]]);
  if (refused) return refused;
  if (!getAccount(ctx.db, id)) return missing(NOT_FOUND);
  const stale = checkVersion(accountVersion(ctx.db, id), expectedVersion);
  if (stale) return stale;
  // The refusal's sentence is exactly what the disabled delete button's tooltip
  // shows, so the two can never say different things (FR-009).
  const result = removeAccount(ctx.db, id, actor(ctx));
  return result.ok ? ok({ id }) : fail("REFUSED", result.reason);
}

/** The version `set_opening_balance` is checked against: its record's, or none. */
export function openingBalanceVersion(
  db: AppContext["db"],
  accountId: number,
): string {
  const recordId = openingBalanceFor(db, accountId)?.recordId;
  return recordId == null ? ABSENT : recordVersion(db, recordId);
}

/**
 * Creates, replaces or (at zero) removes an account's one opening balance.
 *
 * The opening balance is a record, so this asks for the records ability the
 * write amounts to — adding one where there was none, changing or removing the
 * one there is — on top of `accounts:change`. It used to ask for the second
 * alone, and the records screen never heard about the record it wrote.
 */
export function setOpeningBalance(
  ctx: AppContext,
  accountId: number,
  input: { date: string; amountMinor: number },
  expectedVersion?: string,
): AppResult<{ accountId: number; recordId: number | null; version: string }> {
  if (!getAccount(ctx.db, accountId)) return missing(NOT_FOUND);
  const before = openingBalanceFor(ctx.db, accountId)?.recordId ?? null;
  const refused = requirePermissions(ctx, [
    ["accounts", "change"],
    ["records", before === null ? "add" : "change"],
  ]);
  if (refused) return refused;
  const stale = checkVersion(
    openingBalanceVersion(ctx.db, accountId),
    expectedVersion,
  );
  if (stale) return stale;

  const result = setOpeningBalanceService(ctx.db, accountId, actor(ctx), input);
  if (!result.ok) return fail("REFUSED", result.reason);

  const after = openingBalanceFor(ctx.db, accountId)?.recordId ?? null;
  if (after !== null) emitRecordUpdate(ctx.db, after);
  else if (before !== null) ledgerEvents.emit("record-deleted", { id: before });
  return ok({
    accountId,
    recordId: after,
    version: openingBalanceVersion(ctx.db, accountId),
  });
}
