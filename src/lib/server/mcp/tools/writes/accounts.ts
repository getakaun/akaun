import { z } from "zod";
import { eq } from "drizzle-orm";
import {
  AccountSubTypeLabels,
  AccountType,
  AccountTypeLabels,
  DefaultAccountPurposeLabels,
  type AccountSubTypeCode,
  type AccountTypeCode,
  type DefaultAccountPurposeCode,
} from "$lib/enums.js";
import {
  accountTaxDefault,
  percentageToBps,
  TAX_TREATMENTS,
  type TaxTreatment,
} from "$lib/expense-tax.js";
import { accounts, ledgerRecords } from "../../../db/schema.js";
import {
  accountTaxOverview,
  applyAccountTaxDefault,
  previewAccountTaxDefault,
} from "../../../application/account-tax-classification.js";
import {
  createAccount,
  deleteAccount,
  openingBalanceVersion,
  setAccountDefault,
  setOpeningBalance,
  updateAccount,
} from "../../../application/accounts.js";
import { runBatch, storedReplay } from "../../../application/batch.js";
import type { AppContext } from "../../../application/context.js";
import type { AccountBrief } from "../../../application/refs.js";
import { fail, ok, type AppResult } from "../../../application/result.js";
import { ABSENT, recordVersion } from "../../../application/version.js";
import type { LedgerDb } from "../../../ledger/types.js";
import { openingBalanceFor } from "../../../queries/accounts.js";
import { ACCOUNT_DEFAULT_PURPOSES } from "../../../services/account-defaults.js";
import { currentUnitOfWork } from "../../../unit-of-work.js";
import type { ItemFailure } from "../../batch-result.js";
import {
  dateInput,
  enumCodec,
  enumLabel,
  mainCurrency,
  money,
  moneyInput,
} from "../../format.js";
import { defineWriteTool, type ToolDefinition } from "../../registry.js";
import {
  actionRefusal,
  CHANGE_ACCOUNTS,
  missingForActions,
} from "../../requirements/index.js";
import { percentText } from "../reads/accounts.js";
import {
  batchCall,
  batchControls,
  batchReply,
  nothingToDo,
  refInput,
  refuseActions,
  Refs,
  SPLIT_CALL,
} from "./payments.js";

/**
 * The accounts write tool: `change_accounts`.
 *
 * It only parses, resolves references and formats. Every rule lives in
 * `application/accounts.ts` and `application/account-tax-classification.ts`:
 * which sub-type suits which type, which codes are free, what may be deleted
 * or archived, the opening balance's lock, and which entries a tax default may
 * fill. Each item calls exactly one operation.
 *
 * **A tax default follows the app.** `update { tax_default }` changes only the
 * default that new lines capture; it writes the account row and nothing else.
 * Saved classifications change only through `apply_tax_default`, the app's
 * "Apply default to unclassified entries": a dry run previews it and returns
 * a `revision`, and applying needs that revision, which goes stale when the
 * account, its entries or the closing boundary change.
 *
 * References are resolved before the batch opens, so every miss in a call is
 * reported together as `NOT_FOUND` / `AMBIGUOUS` with candidates, and nothing
 * runs. A retry with the same idempotency_key is answered before that
 * (`storedReplay`): an account a delete named may be gone by then.
 */

const typeCodec = enumCodec(AccountTypeLabels);
const subTypeCodec = enumCodec(AccountSubTypeLabels);
const purposeCodec = enumCodec(DefaultAccountPurposeLabels);
/** The purposes Settings saves; reimbursements payable is not one of them. */
const PURPOSE_LABELS = ACCOUNT_DEFAULT_PURPOSES.map(
  (purpose) => purposeCodec.label(purpose)!,
) as [string, ...string[]];

const NAME = z.string().trim().min(1).max(120);

/** A code, as the number the chart shows or as digits in a string. */
const codeInput = z
  .union([z.number().int().positive(), z.string().trim().regex(/^\d+$/)])
  .transform((value) => Number(value))
  .describe(
    "The account code, e.g. 5100. Omitted on create: the lowest free code of its type.",
  );

const subTypeInput = z
  .enum(subTypeCodec.labels)
  .describe(
    "What kind of account it is, e.g. bank, receivable, operating_expense. It must suit the type.",
  );

/** A percentage by digits: `"50"`, `"33.33"`, to basis points. */
const percentInput = z
  .union([z.string(), z.number()])
  .transform((value, ctx) => {
    const bps = percentageToBps(String(value));
    if (bps === null) {
      ctx.addIssue({
        code: "custom",
        message:
          'The percent must be between 0 and 100 with at most two decimals, e.g. "50" or "33.33".',
      });
      return z.NEVER;
    }
    return bps;
  })
  .describe('Deductible share, 0 to 100, e.g. "50". Only for partial.');

const taxDefaultInput = z
  .object({
    treatment: z.enum(TAX_TREATMENTS),
    percent: percentInput.optional(),
  })
  .strict()
  .describe(
    "What NEW lines on this expense account capture. Saved lines do not change. percent only for partial; use unclassified for no default.",
  );
type TaxDefaultInput = z.output<typeof taxDefaultInput>;

const versionInput = z
  .string()
  .min(1)
  .describe("The account's v from when it was read. A stale one is CONFLICT.");

const createItem = z
  .object({
    name: NAME,
    type: z.enum(typeCodec.labels),
    code: codeInput.optional(),
    sub_type: subTypeInput.optional(),
    tax_default: taxDefaultInput.optional(),
  })
  .strict();
type CreateItem = z.output<typeof createItem>;

const updateItem = z
  .object({
    account: refInput.describe(
      'The account: id, code ("5100"), name or "5100 Advertising".',
    ),
    expected_version: versionInput,
    set: z
      .object({
        name: NAME.optional(),
        code: codeInput.optional(),
        sub_type: subTypeInput.optional(),
        archived: z
          .boolean()
          .optional()
          .describe(
            "true hides the account from new entries and keeps its history; false brings it back.",
          ),
        tax_default: taxDefaultInput.optional(),
      })
      .strict(),
  })
  .strict();
type UpdateItem = z.output<typeof updateItem>;

const deleteItem = z
  .object({
    account: refInput.describe("The account to delete."),
    expected_version: versionInput,
  })
  .strict();

const openingItem = z
  .object({
    account: refInput.describe("The account that has the opening balance."),
    date: dateInput.describe("The day the balance stands, YYYY-MM-DD."),
    amount: moneyInput.describe(
      'Decimal string in the main currency, signed like the balance the account list shows: money held is positive, money owed negative, e.g. "-1250.00". "0" removes the opening balance.',
    ),
    expected_version: z
      .string()
      .min(1)
      .optional()
      .describe(
        "The opening balance record's v, to replace or remove it. Leave out when the account has none yet.",
      ),
  })
  .strict();

const defaultItem = z
  .object({
    purpose: z.enum(PURPOSE_LABELS),
    account: refInput.describe(
      "The active account to use for this purpose; it must suit the purpose's type.",
    ),
    expected_version: z
      .string()
      .min(1)
      .optional()
      .describe("The default's current version, to guard against a change."),
  })
  .strict();

const applyItem = z
  .object({
    account: refInput.describe("The expense account whose default is applied."),
    reason: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .describe("Why, kept in the history of every line it fills."),
    revision: z
      .string()
      .regex(
        /^[a-f0-9]{64}$/,
        "A revision is the 64-character code a dry run returns.",
      )
      .optional()
      .describe(
        "From the dry run of this same call. Needed to apply, never for a dry run.",
      ),
  })
  .strict();

const changeAccountsInput = z.object({
  create: z.array(createItem).max(50, SPLIT_CALL).optional(),
  update: z.array(updateItem).max(50, SPLIT_CALL).optional(),
  delete: z.array(deleteItem).max(50, SPLIT_CALL).optional(),
  set_opening_balance: z.array(openingItem).max(50, SPLIT_CALL).optional(),
  set_default: z.array(defaultItem).max(50, SPLIT_CALL).optional(),
  apply_tax_default: z.array(applyItem).max(50, SPLIT_CALL).optional(),
  ...batchControls,
});
type ChangeAccountsArgs = z.output<typeof changeAccountsInput>;

const DESCRIPTION = `Create or change accounts and categories (a category is an expense or income account), opening balances, default accounts and tax defaults. Read the accounts first: the list gives each id and v.

- create[]: name, type (asset, liability, equity, revenue, expense), optional code and sub_type (asset and liability need one), tax_default for expense accounts.
- update[]: account, expected_version (its v), set {name, code, sub_type, archived, tax_default}.
- delete[]: account, expected_version. Only an unused account; archive others.
- set_opening_balance[]: account, date, amount (signed like its balance; "0" removes it), expected_version (the opening balance record's v; leave out when it has none yet).
- set_default[]: purpose (e.g. uncategorised_expense), account.
- apply_tax_default[]: account, reason, revision.

TAX DEFAULT: tax_default sets only what NEW lines on the account capture; saved entries do not change. To fill entries still unclassified, send apply_tax_default with dry_run: true, alone in its own call. It returns eligible and protected counts, totals, deductible and add-back amounts and a revision. Show the user, then send the same call without dry_run, with that revision. Classified entries, individual decisions, voided and closed-month lines are never touched. At most 200 lines per call; remaining says how many are left.

Up to 50 items per call, saved together or not at all. dry_run: true saves nothing; idempotency_key makes a retry return the first result.`;

type Value = Record<string, unknown>;
type AccountRow = typeof accounts.$inferSelect;

const accountRow = (db: LedgerDb, id: number) =>
  db.select().from(accounts).where(eq(accounts.id, id)).get();

/** `"5100 Advertising"`, the way an agent names an account. */
const labelOf = (row: Pick<AccountRow, "id" | "code" | "name">) =>
  `${row.code ?? row.id} ${row.name}`;

const briefLabel = (account: AccountBrief) => `${account.code} ${account.name}`;

const isDryRun = () => currentUnitOfWork()?.mode === "dry_run";

/** An expense account's default as an agent reads it. */
function taxDefaultOf(row: AccountRow) {
  const { treatment, percentageBps } = accountTaxDefault(row);
  return {
    treatment,
    percent: percentageBps === null ? undefined : percentText(percentageBps),
  };
}

function accountFacts(row: AccountRow): Record<string, unknown> {
  return {
    name: row.name,
    code: row.code,
    sub_type: enumLabel(AccountSubTypeLabels, row.subType),
    archived: row.archivedAt !== null,
    tax_default: row.type === AccountType.Expense ? taxDefaultOf(row) : null,
  };
}

function changesBetween(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of Object.keys(after))
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key]))
      out[key] = { from: before[key], to: after[key] };
  return out;
}

/** What `treatment` implies for the percent, where it implies one. */
function impliedBps(treatment: TaxTreatment): number | null | undefined {
  switch (treatment) {
    case "ordinary_deductible":
      return 10_000;
    case "non_deductible":
    case "capital_expenditure":
      return 0;
    case "unclassified":
    case "requires_review":
      return null;
    case "partial":
      return undefined;
  }
}

type TaxFields = {
  defaultTaxTreatment: TaxTreatment;
  defaultTaxPercentageBps: number | null;
};

/** The two stored fields for a `tax_default`, or what is wrong with it. */
function taxFields(
  tax: TaxDefaultInput,
): { ok: true; fields: TaxFields } | { ok: false; message: string } {
  const implied = impliedBps(tax.treatment);
  if (tax.treatment === "partial") {
    if (tax.percent === undefined)
      return { ok: false, message: "A partial treatment needs its percent." };
    if (tax.percent <= 0 || tax.percent >= 10_000)
      return {
        ok: false,
        message: "A partial percent must be above 0 and below 100.",
      };
    return {
      ok: true,
      fields: {
        defaultTaxTreatment: "partial",
        defaultTaxPercentageBps: tax.percent,
      },
    };
  }
  if (tax.percent !== undefined && tax.percent !== (implied ?? null))
    return {
      ok: false,
      message: `${tax.treatment} sets its own percent; send percent only with partial.`,
    };
  return {
    ok: true,
    fields: {
      defaultTaxTreatment: tax.treatment,
      defaultTaxPercentageBps: implied ?? null,
    },
  };
}

// --- create -------------------------------------------------------------------

type CreatePlan = { path: string; item: CreateItem; tax?: TaxFields };

function planCreates(refs: Refs, items: CreateItem[]): CreatePlan[] {
  return items.flatMap((item, i) => {
    const path = `create[${i}]`;
    let tax: TaxFields | undefined;
    if (item.tax_default) {
      const fields = taxFields(item.tax_default);
      if (!fields.ok) {
        refs.invalid(
          `${path}.tax_default`,
          fields.message,
          "Fix tax_default: partial needs a percent above 0 and below 100.",
        );
        return [];
      }
      tax = fields.fields;
    }
    return [{ path, item, tax }];
  });
}

function runCreate(ctx: AppContext, plan: CreatePlan): AppResult<Value> {
  const { item } = plan;
  const created = createAccount(ctx, {
    name: item.name,
    type: typeCodec.code(item.type)! as AccountTypeCode,
    ...(item.code !== undefined ? { code: item.code } : {}),
    ...(item.sub_type !== undefined
      ? { subType: subTypeCodec.code(item.sub_type)! as AccountSubTypeCode }
      : {}),
    ...(plan.tax ?? {}),
  });
  if (!created.ok) return created;
  const row = accountRow(ctx.db, created.value.account.id)!;
  return ok({
    id: row.id,
    account: labelOf(row),
    type: enumLabel(AccountTypeLabels, row.type),
    sub_type: enumLabel(AccountSubTypeLabels, row.subType),
    tax_default: row.type === AccountType.Expense ? taxDefaultOf(row) : null,
    v: created.value.version,
  });
}

// --- update -------------------------------------------------------------------

type UpdatePlan = {
  path: string;
  account: AccountBrief;
  item: UpdateItem;
  tax?: TaxFields;
};

function planUpdates(refs: Refs, items: UpdateItem[]): UpdatePlan[] {
  return items.flatMap((item, i) => {
    const path = `update[${i}]`;
    const account = refs.account(item.account, `${path}.account`, {
      includeArchived: true,
    });
    if (Object.values(item.set).every((value) => value === undefined))
      refs.invalid(
        `${path}.set`,
        "Nothing to change.",
        "Send at least one of name, code, sub_type, archived, tax_default in set.",
      );
    let tax: TaxFields | undefined;
    if (item.set.tax_default) {
      const fields = taxFields(item.set.tax_default);
      if (!fields.ok)
        refs.invalid(
          `${path}.set.tax_default`,
          fields.message,
          "Fix tax_default: partial needs a percent above 0 and below 100.",
        );
      else tax = fields.fields;
    }
    return account ? [{ path, account, item, tax }] : [];
  });
}

function runUpdate(ctx: AppContext, plan: UpdatePlan): AppResult<Value> {
  const { set } = plan.item;
  const id = plan.account.id;
  const before = accountRow(ctx.db, id);
  const updated = updateAccount(
    ctx,
    id,
    {
      ...(set.name !== undefined ? { name: set.name } : {}),
      ...(set.code !== undefined ? { code: set.code } : {}),
      ...(set.sub_type !== undefined
        ? { subType: subTypeCodec.code(set.sub_type)! as AccountSubTypeCode }
        : {}),
      ...(set.archived !== undefined ? { active: !set.archived } : {}),
      ...(plan.tax ?? {}),
    },
    plan.item.expected_version,
  );
  if (!updated.ok) return updated;
  const row = accountRow(ctx.db, id)!;
  const changes = before
    ? changesBetween(accountFacts(before), accountFacts(row))
    : undefined;

  // A new default reaches only new lines. Say so, and say what it left
  // unclassified, to a caller who may apply it.
  let note: string | undefined;
  let fillable: number | undefined;
  if (set.tax_default !== undefined) {
    note =
      "Only new lines on this account capture this default. Saved entries are unchanged.";
    const overview = accountTaxOverview(ctx, id);
    if (
      overview.ok &&
      overview.value.hasResolvedDefault &&
      overview.value.eligibleCount > 0
    ) {
      fillable = overview.value.eligibleCount;
      note += ` ${fillable} unclassified entries could be filled with it: only if the user wants that, use apply_tax_default (dry run first).`;
    }
  } else if (changes && Object.keys(changes).length === 0)
    note = "Nothing changed: the account already had these values.";
  return ok({
    id,
    account: labelOf(row),
    changes,
    unclassified_fillable: fillable,
    note,
    v: updated.value.version,
  });
}

// --- delete -------------------------------------------------------------------

type DeletePlan = { account: AccountBrief; version: string };

function runDelete(ctx: AppContext, plan: DeletePlan): AppResult<Value> {
  const deleted = deleteAccount(ctx, plan.account.id, plan.version);
  if (!deleted.ok) return deleted;
  return ok({ id: plan.account.id, account: briefLabel(plan.account) });
}

// --- set_opening_balance --------------------------------------------------------

type OpeningPlan = {
  account: AccountBrief;
  date: string;
  amountMinor: number;
  expectedVersion?: string;
};

function runOpening(
  ctx: AppContext,
  plan: OpeningPlan,
  tool: string,
): AppResult<Value> {
  const id = plan.account.id;
  const label = briefLabel(plan.account);
  const existing = openingBalanceFor(ctx.db, id);
  // Which ability this is depends on what the account has now, so it is
  // decided here, as the operation decides it.
  const check =
    existing === null
      ? "opening_balance_create"
      : plan.amountMinor === 0
        ? "opening_balance_clear"
        : "opening_balance_change";
  const short = missingForActions(ctx.locals, "change_accounts", [check]);
  if (short.length)
    return fail("FORBIDDEN", actionRefusal(tool, short).message);

  let expected = plan.expectedVersion;
  if (expected === undefined) {
    if (existing)
      return {
        ...fail(
          "CONFLICT",
          `${label} already has an opening balance of ${money(existing.amountMinor)} dated ${existing.date}. To replace or remove it, send expected_version: the opening balance record's v (current_version here).`,
        ),
        currentVersion: openingBalanceVersion(ctx.db, id),
      };
    // None yet: it must still be none when this saves.
    expected = ABSENT;
  }
  const saved = setOpeningBalance(
    ctx,
    id,
    { date: plan.date, amountMinor: plan.amountMinor },
    expected,
  );
  if (!saved.ok) return saved;
  const { recordId } = saved.value;
  const record =
    recordId === null
      ? undefined
      : ctx.db
          .select({ no: ledgerRecords.recordNumber })
          .from(ledgerRecords)
          .where(eq(ledgerRecords.id, recordId))
          .get();
  return ok({
    id,
    account: label,
    currency: mainCurrency(ctx.db),
    ...(recordId === null
      ? {
          removed: existing !== null,
          note:
            existing === null
              ? "The account had no opening balance, so nothing changed."
              : undefined,
        }
      : {
          date: plan.date,
          amount: money(plan.amountMinor),
          record: { id: recordId, no: record?.no ?? `#${recordId}` },
          v: recordVersion(ctx.db, recordId),
        }),
    previous: existing
      ? { date: existing.date, amount: money(existing.amountMinor) }
      : undefined,
  });
}

// --- set_default ----------------------------------------------------------------

type DefaultPlan = {
  purpose: DefaultAccountPurposeCode;
  account: AccountBrief;
  expectedVersion?: string;
};

function runDefault(ctx: AppContext, plan: DefaultPlan): AppResult<Value> {
  const changed = setAccountDefault(
    ctx,
    { purpose: plan.purpose, accountId: plan.account.id },
    plan.expectedVersion,
  );
  if (!changed.ok) return changed;
  const previous =
    changed.value.previousAccountId === null
      ? undefined
      : accountRow(ctx.db, changed.value.previousAccountId);
  return ok({
    purpose: enumLabel(DefaultAccountPurposeLabels, changed.value.purpose),
    account: briefLabel(plan.account),
    previous: previous ? labelOf(previous) : undefined,
    unchanged:
      changed.value.previousAccountId === changed.value.accountId
        ? true
        : undefined,
    v: changed.value.version,
  });
}

// --- apply_tax_default ----------------------------------------------------------

type ApplyPlan = {
  account: AccountBrief;
  reason: string;
  revision?: string;
};

/** What the app's preview calls each group of lines it leaves alone. */
const PROTECTED_WORDS = {
  resolved: "already_classified",
  individual: "individual_decisions",
  closed: "closed_months",
  voided: "voided",
  readOnly: "read_only",
  ambiguous: "unclear",
} as const;

function runApply(
  ctx: AppContext,
  plan: ApplyPlan,
  tool: string,
): AppResult<Value> | ItemFailure {
  const id = plan.account.id;
  const label = briefLabel(plan.account);

  if (isDryRun()) {
    const previewed = previewAccountTaxDefault(ctx, id, {
      reason: plan.reason,
    });
    if (!previewed.ok) return previewed;
    const p = previewed.value;
    const counts = Object.fromEntries(
      (Object.keys(PROTECTED_WORDS) as (keyof typeof PROTECTED_WORDS)[])
        .filter((key) => p.protected[key] > 0)
        .map((key) => [PROTECTED_WORDS[key], p.protected[key]]),
    );
    return ok({
      id,
      account: label,
      currency: mainCurrency(ctx.db),
      default: {
        treatment: p.treatment.treatment,
        percent:
          p.treatment.percentageBps === null
            ? undefined
            : percentText(p.treatment.percentageBps),
      },
      eligible: p.eligibleCount,
      protected: counts,
      // What an apply with this revision would fill: at most 200 lines.
      this_call: {
        lines: p.selectedCount,
        records: p.recordCount,
        from: p.dateFrom,
        to: p.dateTo,
        expense: money(p.expenseMinor),
        refunds: money(p.refundMinor),
        deductible: money(p.deductibleMinor),
        add_back: money(p.addBackMinor),
      },
      remaining: p.remainingCount,
      revision: p.revision,
      revision_current:
        plan.revision === undefined ? undefined : plan.revision === p.revision,
      apply:
        p.selectedCount > 0
          ? {
              tool,
              args: {
                apply_tax_default: [
                  {
                    account: id,
                    reason: plan.reason,
                    revision: p.revision,
                  },
                ],
              },
            }
          : undefined,
      note:
        p.selectedCount === 0
          ? "Nothing to apply: no unclassified entry is eligible."
          : "Dry run: nothing was changed. Show the user this, and apply only if they agree.",
    });
  }

  const applied = applyAccountTaxDefault(ctx, id, {
    reason: plan.reason,
    revision: plan.revision,
  });
  // Its only CONFLICT is a stale revision, and it has no current version to
  // retry with: a new dry run gives the new revision.
  if (!applied.ok)
    return applied.code === "CONFLICT"
      ? {
          ...applied,
          fix: "Run it again with dry_run to get the current revision.",
        }
      : applied;
  const { updatedLineCount, updatedRecordCount, remainingCount } =
    applied.value;
  return ok({
    id,
    account: label,
    updated_lines: updatedLineCount,
    updated_records: updatedRecordCount,
    remaining: remainingCount,
    note:
      remainingCount > 0
        ? `${remainingCount} unclassified entries remain. For the next batch, run a dry run again for a new revision.`
        : undefined,
  });
}

// --- the tool -----------------------------------------------------------------

const changeAccounts = defineWriteTool({
  base: "change_accounts",
  title: "Change accounts",
  description: DESCRIPTION,
  input: changeAccountsInput,
  annotations: {
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  requirements: CHANGE_ACCOUNTS.requirements,
  actions: CHANGE_ACCOUNTS.actions,
  handler: async (ctx, args: ChangeAccountsArgs, meta) => {
    const refused = refuseActions(ctx, meta, "change_accounts", args);
    if (refused) return refused;
    const call = batchCall(meta, args, {
      create: args.create,
      update: args.update,
      delete: args.delete,
      set_opening_balance: args.set_opening_balance,
      set_default: args.set_default,
      apply_tax_default: args.apply_tax_default,
    });
    // Before any reference is resolved: a deleted account no longer
    // resolves, and its retry must replay, not miss.
    const replay = storedReplay<Value>(ctx, call);
    if (replay) return batchReply(replay, meta);
    if (
      !args.create?.length &&
      !args.update?.length &&
      !args.delete?.length &&
      !args.set_opening_balance?.length &&
      !args.set_default?.length &&
      !args.apply_tax_default?.length
    )
      return nothingToDo(
        "create, update, delete, set_opening_balance, set_default or apply_tax_default",
      );

    const { dryRun } = call;
    const refs = new Refs(ctx, meta);
    const creates = planCreates(refs, args.create ?? []);
    const updates = planUpdates(refs, args.update ?? []);
    const deletes = (args.delete ?? []).flatMap((item, i): DeletePlan[] => {
      const account = refs.account(item.account, `delete[${i}].account`, {
        includeArchived: true,
      });
      return account ? [{ account, version: item.expected_version }] : [];
    });
    const openings = (args.set_opening_balance ?? []).flatMap(
      (item, i): OpeningPlan[] => {
        const account = refs.account(
          item.account,
          `set_opening_balance[${i}].account`,
          { includeArchived: true },
        );
        return account
          ? [
              {
                account,
                date: item.date,
                amountMinor: item.amount,
                expectedVersion: item.expected_version,
              },
            ]
          : [];
      },
    );
    const defaults = (args.set_default ?? []).flatMap(
      (item, i): DefaultPlan[] => {
        const account = refs.account(item.account, `set_default[${i}].account`);
        return account
          ? [
              {
                purpose: purposeCodec.code(
                  item.purpose,
                )! as DefaultAccountPurposeCode,
                account,
                expectedVersion: item.expected_version,
              },
            ]
          : [];
      },
    );
    const applies = (args.apply_tax_default ?? []).flatMap(
      (item, i): ApplyPlan[] => {
        const path = `apply_tax_default[${i}]`;
        const account = refs.account(item.account, `${path}.account`, {
          includeArchived: true,
        });
        // Applying is the step that changes saved entries, and it is only
        // ever done with what a dry run showed.
        if (!dryRun && item.revision === undefined)
          refs.invalid(
            `${path}.revision`,
            "A revision is needed to apply a tax default to existing entries.",
            "Send this call with dry_run: true to get the revision, show the user the result, then send the call again with that revision.",
          );
        return account && (dryRun || item.revision !== undefined)
          ? [{ account, reason: item.reason, revision: item.revision }]
          : [];
      },
    );
    const missed = refs.failure();
    if (missed) return missed;

    const result = await runBatch<Value>(ctx, {
      ...call,
      items: [
        ...creates.map((plan) => ({
          action: "create",
          label: `${plan.path} ${plan.item.name}`,
          run: (c: AppContext) => runCreate(c, plan),
        })),
        ...updates.map((plan) => ({
          action: "update",
          label: `${plan.path} ${briefLabel(plan.account)}`,
          run: (c: AppContext) => runUpdate(c, plan),
        })),
        ...deletes.map((plan, i) => ({
          action: "delete",
          label: `delete[${i}] ${briefLabel(plan.account)}`,
          run: (c: AppContext) => runDelete(c, plan),
        })),
        ...openings.map((plan, i) => ({
          action: "set_opening_balance",
          label: `set_opening_balance[${i}] ${briefLabel(plan.account)}`,
          run: (c: AppContext) => runOpening(c, plan, meta.name),
        })),
        ...defaults.map((plan, i) => ({
          action: "set_default",
          label: `set_default[${i}] ${briefLabel(plan.account)}`,
          run: (c: AppContext) => runDefault(c, plan),
        })),
        ...applies.map((plan, i) => ({
          action: "apply_tax_default",
          label: `apply_tax_default[${i}] ${briefLabel(plan.account)}`,
          run: (c: AppContext) => runApply(c, plan, meta.name),
        })),
      ],
    });
    return batchReply(result, meta);
  },
});

/** The accounts write tools, in listing order. */
export const accountsWriteTools: readonly ToolDefinition[] = [changeAccounts];
