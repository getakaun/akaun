import { createHash } from "node:crypto";
import { withClosingRefusal } from "./closing-refusal.js";
import { z } from "zod";
import {
  AccountSubTypesByType,
  AccountType,
  AccountTypeDisplayLabels,
  DefaultAccountPurposeDisplayLabels,
  DefaultAccountPurposeTypes,
  type AccountSubTypeCode,
  type AccountTypeCode,
  type DefaultAccountPurposeCode,
} from "$lib/enums.js";
import { getAccount, openingBalanceFor } from "../queries/accounts.js";
import {
  ACCOUNT_DEFAULT_PURPOSES,
  accountDefaultId,
  getAccountDefaults,
  replaceAccountDefaults,
} from "../services/account-defaults.js";
import {
  createAccount as createAccountService,
  patchAccount,
  removeAccount,
  setOpeningBalance as setOpeningBalanceService,
} from "../services/accounts.js";
import { emitRecordUpdate } from "../services/ledger.js";
import { accountEvents, ledgerEvents } from "../ledger/events.js";
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

import { basisPointsSchema, taxTreatmentSchema } from "$lib/expense-tax.js";

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
  defaultTaxPercentageBps: basisPointsSchema.nullable().optional(),
  defaultTaxTreatment: taxTreatmentSchema.nullable().optional(),
  type: accountType,
  name: z.string().trim().min(1).max(120),
  code: z.number().int().positive().optional(),
  subType: accountSubType.optional(),
};

export const updateAccountShape = {
  defaultTaxPercentageBps: basisPointsSchema.nullable().optional(),
  defaultTaxTreatment: taxTreatmentSchema.nullable().optional(),
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
  const refused = requirePermissions(ctx, ["accounts.create"]);
  if (refused) return refused;
  const result = createAccountService(ctx.db, actor(ctx), {
    defaultTaxPercentageBps: input.defaultTaxPercentageBps,
    defaultTaxTreatment: input.defaultTaxTreatment,
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
  return withClosingRefusal(() =>
    updateAccountOperation(ctx, id, patch, expectedVersion),
  );
}

function updateAccountOperation(
  ctx: AppContext,
  id: number,
  patch: z.output<z.ZodObject<typeof updateAccountShape>>,
  expectedVersion?: string,
): AppResult<AccountWritten> {
  const refused = requirePermissions(ctx, ["accounts.update"]);
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
  const refused = requirePermissions(ctx, ["accounts.delete"]);
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
 * write amounts to — adding one where there was none, changing the one there
 * is, or deleting it (zero) — on top of `accounts.update`. It used to ask for the second
 * alone, and the records screen never heard about the record it wrote.
 */
export function setOpeningBalance(
  ctx: AppContext,
  accountId: number,
  input: { date: string; amountMinor: number },
  expectedVersion?: string,
): AppResult<{ accountId: number; recordId: number | null; version: string }> {
  return withClosingRefusal(() =>
    setOpeningBalanceOperation(ctx, accountId, input, expectedVersion),
  );
}

function setOpeningBalanceOperation(
  ctx: AppContext,
  accountId: number,
  input: { date: string; amountMinor: number },
  expectedVersion?: string,
): AppResult<{ accountId: number; recordId: number | null; version: string }> {
  // Asked before anything is looked up, so a caller without the ability
  // cannot learn which ids exist.
  const refusedAccount = requirePermissions(ctx, ["accounts.update"]);
  if (refusedAccount) return refusedAccount;
  if (!getAccount(ctx.db, accountId)) return missing(NOT_FOUND);
  const before = openingBalanceFor(ctx.db, accountId)?.recordId ?? null;
  const refused = requirePermissions(ctx, [
    before === null
      ? "records.create"
      : input.amountMinor === 0
        ? // Zero deletes the record, so it needs what deleting one needs.
          "records.delete"
        : "records.update",
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

/**
 * The version `setAccountDefault` is checked against: which account the
 * purpose names now. Only the account counts: saving the defaults rewrites
 * every purpose's `updated_at`, so a version that hashed it would go stale
 * whenever any one default was saved.
 */
export function accountDefaultVersion(
  db: AppContext["db"],
  purpose: DefaultAccountPurposeCode,
): string {
  const accountId = accountDefaultId(db, purpose);
  return accountId === null
    ? ABSENT
    : createHash("sha256")
        .update(JSON.stringify(["account-default", purpose, accountId]))
        .digest("hex")
        .slice(0, 16);
}

export type AccountDefaultChange = {
  purpose: DefaultAccountPurposeCode;
  accountId: number;
  /** The account the purpose named before; null when it named none. */
  previousAccountId: number | null;
  version: string;
};

function purposeName(purpose: DefaultAccountPurposeCode): string {
  return DefaultAccountPurposeDisplayLabels[purpose] ?? `purpose ${purpose}`;
}

/** `"Sales revenue default"`, `"Sales revenue and Uncategorised income defaults"`. */
function defaultsNamed(purposes: DefaultAccountPurposeCode[]): string {
  const names = purposes.map(purposeName);
  return names.length === 1
    ? `${names[0]} default`
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)} defaults`;
}

/**
 * Points one default purpose at another account: what Settings › Default
 * accounts saves, for one row.
 *
 * It asks for `accounts.update`, as `PUT /api/settings/account-defaults`
 * does. `replaceAccountDefaults` saves and checks the whole set, so this
 * passes every other purpose's saved account unchanged. The new account must
 * suit the purpose by the rule the Settings screen applies, and the service
 * audits the change inside its own transaction. `accounts-refresh` then tells
 * open screens, as the route does.
 *
 * Because the set is saved whole, another purpose whose saved account is not
 * usable now refuses this as well, and the refusal names it. With one such
 * purpose, setting that one first works; with more, only Settings can choose
 * them together. Setting the account a purpose already names saves nothing.
 */
export function setAccountDefault(
  ctx: AppContext,
  input: { purpose: DefaultAccountPurposeCode; accountId: number },
  expectedVersion?: string,
): AppResult<AccountDefaultChange> {
  const refused = requirePermissions(ctx, ["accounts.update"]);
  if (refused) return refused;
  const { purpose, accountId } = input;
  if (!(ACCOUNT_DEFAULT_PURPOSES as readonly number[]).includes(purpose))
    return fail(
      "INVALID_INPUT",
      `Choose one of these default purposes: ${ACCOUNT_DEFAULT_PURPOSES.map(purposeName).join(", ")}.`,
    );
  // `getAccount` follows a merge; a merged account is gone for this purpose.
  const account =
    Number.isSafeInteger(accountId) && accountId > 0
      ? getAccount(ctx.db, accountId)
      : null;
  if (!account || account.id !== accountId) return missing(NOT_FOUND);
  const stale = checkVersion(
    accountDefaultVersion(ctx.db, purpose),
    expectedVersion,
  );
  if (stale) return stale;

  const saved = getAccountDefaults(ctx.db);
  const current = saved.find((item) => item.purpose === purpose);
  const previousAccountId = current?.account?.id ?? null;
  const changed = (): AccountDefaultChange => ({
    purpose,
    accountId,
    previousAccountId,
    version: accountDefaultVersion(ctx.db, purpose),
  });
  if (previousAccountId === accountId && current?.valid) return ok(changed());

  const blocking = saved
    .filter((item) => item.purpose !== purpose && !item.valid)
    .map((item) => item.purpose);
  if (blocking.length)
    return fail(
      "REFUSED",
      `The ${defaultsNamed(blocking)} ${blocking.length === 1 ? "names" : "name"} no usable account, and the defaults are saved together. ${
        blocking.length === 1 && current?.valid
          ? `Set the ${defaultsNamed(blocking)} first.`
          : "Choose all of them in Settings › Default accounts."
      }`,
    );

  const replaced = replaceAccountDefaults(
    ctx.db,
    actor(ctx),
    saved.map((item) => ({
      purpose: item.purpose,
      accountId: item.purpose === purpose ? accountId : item.account!.id,
    })),
  );
  if (!replaced.ok)
    return fail(
      "REFUSED",
      `Account ${account.code ?? account.id} ${account.name} cannot be the ${purposeName(purpose)} default. It needs an active ${(AccountTypeDisplayLabels[DefaultAccountPurposeTypes[purpose]] ?? "").toLowerCase()} account that suits that purpose.`,
    );
  // After the service's transaction, as the route emits it. Inside a unit of
  // work the emitter holds it until the outermost commit.
  accountEvents.emit("accounts-refresh", { reason: "defaults" });
  return ok(changed());
}
