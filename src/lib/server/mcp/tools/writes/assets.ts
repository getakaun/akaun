import { z } from "zod";
import { eq } from "drizzle-orm";
import { LedgerRecordKind, AccountType } from "$lib/enums.js";
import { isAccumulatedDepreciationAccount } from "$lib/depreciation.js";
import { assetNumber } from "$lib/fixed-assets.js";
import { accounts, depreciationRuns, fixedAssets } from "../../../db/schema.js";
import { canAll } from "../../../permissions.js";
import { runBatch } from "../../../application/batch.js";
import type { AppContext } from "../../../application/context.js";
import {
  approveDepreciationProfile,
  postAssetCatchUp,
  postDepreciationMonth,
  previewAssetCatchUp,
  previewDepreciationMonth,
  previewDepreciationProfile,
  reverseDepreciationRun,
  stopDepreciation,
} from "../../../application/depreciation.js";
import {
  registerFixedAsset,
  updateFixedAsset,
} from "../../../application/fixed-assets.js";
import {
  changeRecord,
  type RecordChange,
} from "../../../application/record-routing.js";
import {
  similarity,
  type AccountBrief,
  type RecordBrief,
  type Resolved,
} from "../../../application/refs.js";
import { fail, ok, type AppResult } from "../../../application/result.js";
import { checkVersion, recordVersion } from "../../../application/version.js";
import {
  isCategoryAccount,
  isFixedAssetAccount,
} from "../../../ledger/account-type.js";
import { parseMinor } from "../../../ledger/money.js";
import type { LedgerDb } from "../../../ledger/types.js";
import { normalizeName } from "../../../queries/contacts.js";
import {
  assetLedgerLines,
  type FixedAsset,
} from "../../../queries/fixed-assets.js";
import { getRecord } from "../../../queries/ledger.js";
import { batchToolResult } from "../../batch-result.js";
import { envelopePayload, toolResult } from "../../envelope.js";
import { dateInput, mainCurrency, money, moneyInput } from "../../format.js";
import { resolveError } from "../../resolve.js";
import { defineWriteTool, type ToolDefinition } from "../../registry.js";
import { MANAGE_FIXED_ASSETS } from "../../requirements/index.js";
import {
  batchControls,
  idempotencyOf,
  nothingToDo,
  recordNo,
  refInput,
  refuseActions,
  Refs,
  SPLIT_CALL,
} from "./payments.js";

/**
 * The fixed-asset write tool: `manage_fixed_assets`.
 *
 * Every rule lives in `application/fixed-assets.ts`, `application/depreciation.ts`
 * and the record router (`changeRecord`); an item here resolves its references
 * before the batch opens, then calls those operations in order. `capitalise` is
 * two of them in one item savepoint: the category move (allowed on a settled
 * record, as any category change is), then `registerFixedAsset` for the line it
 * made. If either refuses, neither is kept.
 *
 * Depreciation posts journals, so those actions need `records.adjust`; the
 * operations ask for it themselves (`DEPRECIATION_WRITE`), and the requirement
 * entry asks first, so a token without it is told which scope to add.
 */

// --- input ---------------------------------------------------------------------

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

const monthInput = z
  .string()
  .regex(MONTH, "Use a month as YYYY-MM, e.g. 2026-09.")
  .describe("A calendar month, YYYY-MM.");

/** A percent, "0" to "100", as basis points. */
const percentInput = z
  .union([z.string(), z.number()])
  .transform((value, ctx) => {
    const parsed = parseMinor(value, 2);
    if (!parsed.ok || parsed.minor < 0 || parsed.minor > 10_000) {
      ctx.addIssue({
        code: "custom",
        message: 'The percent must be between 0 and 100, e.g. "80".',
      });
      return z.NEVER;
    }
    return parsed.minor;
  })
  .describe('Share used for the business, 0 to 100, e.g. "80".');

const lineInput = z
  .number()
  .int()
  .min(0)
  .max(49)
  .describe(
    "Which line, counting from 0. Omit it when the record has one such line.",
  );

const assetDetails = {
  name: z.string().trim().min(1).max(200),
  type: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe('Kind of asset, e.g. "Computer equipment". Default "Other".'),
  description: z.string().trim().max(2000).optional(),
  serial_number: z.string().trim().max(200).optional(),
  start: dateInput
    .optional()
    .describe("Date it goes into service. Default: the purchase date."),
  residual: moneyInput
    .optional()
    .describe(
      'Value left at the end of its life, e.g. "500.00". Default none.',
    ),
  business_use: percentInput.optional(),
  document_reference: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .describe("The supporting invoice or agreement."),
  expense_account: refInput
    .optional()
    .describe("The expense account depreciation is charged to."),
  accumulated_account: refInput
    .optional()
    .describe(
      "The non-current asset account that holds accumulated depreciation. Not the cost account.",
    ),
};

const lifeMonths = z
  .number()
  .int()
  .min(1)
  .max(1200)
  .describe("Useful life in months, for straight-line depreciation.");

const capitaliseInput = z
  .object({
    record: refInput.describe(
      "The expense that bought the asset: id or number, e.g. EXP-2026-0042.",
    ),
    line: lineInput.optional(),
    to_account: refInput.describe(
      "The fixed-asset account the line moves to: id, code or name.",
    ),
    expected_version: z
      .string()
      .min(1)
      .describe("The record's v, from when it was read."),
    asset: z.object({ ...assetDetails, life_months: lifeMonths }).strict(),
  })
  .strict();

const registerInput = z.object({
  record: refInput
    .optional()
    .describe(
      "A purchase already booked to a fixed-asset account: id or number.",
    ),
  line: lineInput.optional(),
  existing: z
    .object({
      account: refInput.describe("The fixed-asset cost account."),
      acquired: dateInput.describe("Purchase date."),
      cost: moneyInput.describe('Original cost, e.g. "4999.00".'),
      opening_as_at: dateInput.describe(
        "The month-end the opening figures are as at.",
      ),
      brought_forward_depreciation: moneyInput
        .optional()
        .describe("Depreciation already charged by then. Default none."),
      opening_record: refInput
        .optional()
        .describe("An opening-balance record that holds the cost."),
    })
    .strict()
    .optional()
    .describe(
      "For an asset owned before the books began, instead of record. Needs document_reference or opening_record.",
    ),
  asset: z
    .object({ ...assetDetails, life_months: lifeMonths.optional() })
    .strict(),
});

const updateInput = z.object({
  asset: refInput.describe("The asset: id, number (FA-0003) or exact name."),
  expected_version: z
    .string()
    .min(1)
    .describe("The asset's v, from when it was read."),
  reason: z.string().trim().min(1).max(1000),
  set: z
    .object({
      ...assetDetails,
      name: assetDetails.name.optional(),
      life_months: lifeMonths.optional(),
    })
    .strict()
    .describe("Only the fields to change."),
});

const expectedOptional = z
  .string()
  .min(1)
  .optional()
  .describe(
    "Optional. A dry run reports v; send it back to be sure nothing changed in between.",
  );

const approveInput = z.object({
  asset: refInput.describe("The asset: id, number or exact name."),
  start_month: monthInput
    .optional()
    .describe("First month charged. Default: the month it goes into service."),
  months: lifeMonths.optional().describe("Default: the asset's life_months."),
  residual: moneyInput.optional().describe("Default: the asset's residual."),
  expense_account: refInput
    .optional()
    .describe("Default: the asset's expense_account."),
  accumulated_account: refInput
    .optional()
    .describe("Default: the asset's accumulated_account."),
  reason: z.string().trim().min(1).max(1000),
  post_history: z
    .boolean()
    .optional()
    .describe("Also post the months already past. Default false."),
  expected_version: expectedOptional,
});

const postInput = z.object({
  month: monthInput
    .optional()
    .describe("Post this month for every asset that is due."),
  asset: refInput
    .optional()
    .describe("Catch this one asset up on every month already past."),
  expected_version: expectedOptional,
});

const stopInput = z.object({
  asset: refInput.describe("The asset: id, number or exact name."),
  month: monthInput.describe("The first month that is no longer charged."),
  reason: z.string().trim().min(1).max(1000),
  expected_version: expectedOptional,
});

const reverseInput = z.object({
  record: refInput.describe(
    "The depreciation journal to reverse: id or number, from the post result.",
  ),
  month: monthInput
    .optional()
    .describe(
      "A completed month, on or after the original run's, whose end the reversal is dated. Default: the run's month.",
    ),
  reason: z.string().trim().min(10).max(1000),
});

const manageInput = z.object({
  capitalise: z.array(capitaliseInput).max(50, SPLIT_CALL).optional(),
  register: z.array(registerInput.strict()).max(50, SPLIT_CALL).optional(),
  update: z.array(updateInput.strict()).max(50, SPLIT_CALL).optional(),
  approve: z.array(approveInput.strict()).max(50, SPLIT_CALL).optional(),
  post_depreciation: z.array(postInput.strict()).max(50, SPLIT_CALL).optional(),
  stop: z.array(stopInput.strict()).max(50, SPLIT_CALL).optional(),
  reverse_run: z.array(reverseInput.strict()).max(50, SPLIT_CALL).optional(),
  ...batchControls,
});
type ManageArgs = z.output<typeof manageInput>;
type AssetDetails = z.output<typeof registerInput>["asset"];

const MANAGE_DESCRIPTION = `Register fixed assets and run their depreciation. To turn an expense that bought equipment into an asset, use capitalise: it moves the expense line to a fixed-asset account and registers the asset in one step, even when the bill is already paid. Use register for a purchase already booked to a fixed-asset account, or (existing) for an asset owned before the books began.

- capitalise[]: record (id or number), expected_version (the record's v), line (from 0, when it has several category lines), to_account, asset {name, life_months, start, residual, type, expense_account, accumulated_account}.
- register[], update[] (expected_version = the asset's v, and reason).
- approve[]: sets the straight-line schedule from the asset's own details.
- post_depreciation[]: {month} posts every asset due that month, {asset} catches one asset up. stop[], reverse_run[] (record = the depreciation journal).

Name assets by id, number (FA-0003) or exact name. Amounts are decimal strings in the main currency; months are YYYY-MM.

Depreciation posts journals: approve, post_depreciation and stop need the adjust permission, reverse_run also void. Only completed, open months can be posted. There, expected_version is optional: a dry run reports v, and sending it back confirms nothing moved.

dry_run: true first, show the result, save only after the user agrees. Up to 50 items per call, saved together or not at all. idempotency_key makes a retry return the first result.`;

// --- references ----------------------------------------------------------------

function assetCandidate(row: { id: number; name: string }) {
  return { id: row.id, name: `${assetNumber(row.id)} ${row.name}` };
}

/**
 * A registered asset by id, number (`FA-0003`, `#3`) or exact name (ignoring
 * case and punctuation). Anything else is a miss with the nearest names; a
 * close name is never used on its own.
 */
function resolveAsset(
  ctx: AppContext,
  ref: number | string,
): Resolved<FixedAsset> {
  const rows = ctx.db.select().from(fixedAssets).all();
  const byId = (id: number): Resolved<FixedAsset> => {
    const hit = rows.find((row) => row.id === id);
    return hit
      ? { ok: true, id: hit.id, value: hit }
      : {
          ok: false,
          kind: "not_found",
          message: `No asset has id ${id}.`,
          candidates: rows.slice(-5).reverse().map(assetCandidate),
        };
  };
  if (typeof ref === "number") return byId(ref);
  const text = ref.trim();
  const numbered = /^(?:FA-0*|#)(\d+)$/i.exec(text);
  if (numbered) return byId(Number(numbered[1]));
  const wanted = normalizeName(text);
  const exact = rows.filter((row) => normalizeName(row.name) === wanted);
  if (exact.length === 1) return { ok: true, id: exact[0].id, value: exact[0] };
  if (exact.length > 1)
    return {
      ok: false,
      kind: "ambiguous",
      message: `More than one asset is named "${text}".`,
      candidates: exact.slice(0, 5).map(assetCandidate),
    };
  const near = rows
    .map((row) => ({
      row,
      score: similarity(wanted, normalizeName(row.name)),
    }))
    .filter((entry) => entry.score >= 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((entry) => assetCandidate(entry.row));
  return {
    ok: false,
    kind: "not_found",
    message: `No asset is named "${text}".`,
    candidates: near,
  };
}

const ASSET_READ = ["accounts.read", "records.read"] as const;

/** Resolves the asset references of one call, collecting every miss with the others. */
function assetOf(
  refs: Refs,
  ref: number | string,
  path: string,
): FixedAsset | undefined {
  const result = resolveAsset(refs.ctx, ref);
  if (result.ok) return result.value;
  const readable = canAll(refs.ctx.locals, [...ASSET_READ]);
  refs.errors.push(
    resolveError(readable ? result : { kind: "not_found", candidates: [] }, {
      what: "asset",
      ref,
      path,
      lookup: readable ? refs.meta.nameOf("get_report") : undefined,
    }),
  );
  return undefined;
}

type Accounts = {
  expense?: AccountBrief;
  accumulated?: AccountBrief;
};

/** The two optional accounts an asset names. `false` when one missed (recorded). */
function assetAccounts(
  refs: Refs,
  details: {
    expense_account?: number | string;
    accumulated_account?: number | string;
  },
  path: string,
): Accounts | false {
  const out: Accounts = {};
  let missed = false;
  if (details.expense_account !== undefined) {
    out.expense = refs.account(
      details.expense_account,
      `${path}.expense_account`,
      { types: [AccountType.Expense], wanted: "an expense account" },
    );
    missed ||= !out.expense;
  }
  if (details.accumulated_account !== undefined) {
    out.accumulated = refs.account(
      details.accumulated_account,
      `${path}.accumulated_account`,
      {
        where: isAccumulatedDepreciationAccount,
        wanted: "a non-current asset account for accumulated depreciation",
      },
    );
    missed ||= !out.accumulated;
  }
  return missed ? false : out;
}

// --- plans ---------------------------------------------------------------------

type CapitalisePlan = {
  path: string;
  record: RecordBrief;
  line?: number;
  toAccount: AccountBrief;
  expectedVersion: string;
  asset: AssetDetails;
  accounts: Accounts;
};

type RegisterPlan = {
  path: string;
  record?: RecordBrief;
  line?: number;
  existing?: {
    account: AccountBrief;
    acquired: string;
    costMinor: number;
    openingAsAt: string;
    broughtForwardMinor?: number;
    openingRecord?: RecordBrief;
  };
  asset: AssetDetails;
  accounts: Accounts;
};

type UpdatePlan = {
  path: string;
  asset: FixedAsset;
  expectedVersion: string;
  reason: string;
  set: z.output<typeof updateInput>["set"];
  accounts: Accounts;
};

type ApprovePlan = {
  path: string;
  asset: FixedAsset;
  item: z.output<typeof approveInput>;
  accounts: Accounts;
};

type PostPlan = {
  path: string;
  month?: string;
  asset?: FixedAsset;
  expectedVersion?: string;
};

type StopPlan = {
  path: string;
  asset: FixedAsset;
  month: string;
  reason: string;
  expectedVersion?: string;
};

type ReversePlan = {
  path: string;
  record: RecordBrief;
  month?: string;
  reason: string;
};

function planCapitalise(
  refs: Refs,
  items: NonNullable<ManageArgs["capitalise"]>,
): CapitalisePlan[] {
  return items.flatMap((item, i) => {
    const path = `capitalise[${i}]`;
    const record = refs.record(item.record, `${path}.record`);
    const toAccount = refs.account(item.to_account, `${path}.to_account`, {
      where: isFixedAssetAccount,
      wanted: "a fixed-asset account",
    });
    const accountsFound = assetAccounts(refs, item.asset, `${path}.asset`);
    return record && toAccount && accountsFound
      ? [
          {
            path,
            record,
            line: item.line,
            toAccount,
            expectedVersion: item.expected_version,
            asset: item.asset,
            accounts: accountsFound,
          },
        ]
      : [];
  });
}

function planRegister(
  refs: Refs,
  items: NonNullable<ManageArgs["register"]>,
): RegisterPlan[] {
  return items.flatMap((item, i) => {
    const path = `register[${i}]`;
    if ((item.record === undefined) === (item.existing === undefined)) {
      refs.invalid(
        path,
        "Name a purchase record or describe an existing asset, not both and not neither.",
        "Send record (a purchase already booked to a fixed-asset account), or existing, not both.",
      );
      return [];
    }
    const accountsFound = assetAccounts(refs, item.asset, `${path}.asset`);
    let record: RecordBrief | undefined;
    let existing: RegisterPlan["existing"];
    if (item.record !== undefined) {
      record = refs.record(item.record, `${path}.record`);
      if (!record) return [];
    } else if (item.existing) {
      const e = item.existing;
      const account = refs.account(e.account, `${path}.existing.account`, {
        where: isFixedAssetAccount,
        wanted: "a fixed-asset cost account",
      });
      const openingRecord =
        e.opening_record === undefined
          ? undefined
          : refs.record(e.opening_record, `${path}.existing.opening_record`);
      if (!account || (e.opening_record !== undefined && !openingRecord))
        return [];
      existing = {
        account,
        acquired: e.acquired,
        costMinor: e.cost,
        openingAsAt: e.opening_as_at,
        broughtForwardMinor: e.brought_forward_depreciation,
        openingRecord,
      };
    }
    return accountsFound
      ? [
          {
            path,
            record,
            line: item.line,
            existing,
            asset: item.asset,
            accounts: accountsFound,
          },
        ]
      : [];
  });
}

function planUpdate(
  refs: Refs,
  items: NonNullable<ManageArgs["update"]>,
): UpdatePlan[] {
  return items.flatMap((item, i) => {
    const path = `update[${i}]`;
    const asset = assetOf(refs, item.asset, `${path}.asset`);
    const accountsFound = assetAccounts(refs, item.set, `${path}.set`);
    if (Object.values(item.set).every((value) => value === undefined)) {
      refs.invalid(
        `${path}.set`,
        "Name at least one field to change.",
        "Add the fields to set, e.g. set: {name: ...}.",
      );
      return [];
    }
    return asset && accountsFound
      ? [
          {
            path,
            asset,
            expectedVersion: item.expected_version,
            reason: item.reason,
            set: item.set,
            accounts: accountsFound,
          },
        ]
      : [];
  });
}

function planApprove(
  refs: Refs,
  items: NonNullable<ManageArgs["approve"]>,
): ApprovePlan[] {
  return items.flatMap((item, i) => {
    const path = `approve[${i}]`;
    const asset = assetOf(refs, item.asset, `${path}.asset`);
    const accountsFound = assetAccounts(refs, item, path);
    return asset && accountsFound
      ? [{ path, asset, item, accounts: accountsFound }]
      : [];
  });
}

function planPost(
  refs: Refs,
  items: NonNullable<ManageArgs["post_depreciation"]>,
): PostPlan[] {
  return items.flatMap((item, i): PostPlan[] => {
    const path = `post_depreciation[${i}]`;
    if ((item.month === undefined) === (item.asset === undefined)) {
      refs.invalid(
        path,
        "Say which month to post, or which asset to catch up, not both and not neither.",
        "Send month (YYYY-MM) to post a month for every asset due, or asset to catch one asset up.",
      );
      return [];
    }
    if (item.asset === undefined)
      return [
        { path, month: item.month, expectedVersion: item.expected_version },
      ];
    const asset = assetOf(refs, item.asset, `${path}.asset`);
    return asset
      ? [{ path, asset, expectedVersion: item.expected_version }]
      : [];
  });
}

function planStop(
  refs: Refs,
  items: NonNullable<ManageArgs["stop"]>,
): StopPlan[] {
  return items.flatMap((item, i) => {
    const path = `stop[${i}]`;
    const asset = assetOf(refs, item.asset, `${path}.asset`);
    return asset
      ? [
          {
            path,
            asset,
            month: item.month,
            reason: item.reason,
            expectedVersion: item.expected_version,
          },
        ]
      : [];
  });
}

function planReverse(
  refs: Refs,
  items: NonNullable<ManageArgs["reverse_run"]>,
): ReversePlan[] {
  return items.flatMap((item, i) => {
    const path = `reverse_run[${i}]`;
    const record = refs.record(item.record, `${path}.record`);
    return record
      ? [{ path, record, month: item.month, reason: item.reason }]
      : [];
  });
}

// --- output --------------------------------------------------------------------

type Value = Record<string, unknown>;

/** `"1500 Office Equipment"`: how an agent reads an account. */
function accountLabel(db: LedgerDb, id: number | null): string | undefined {
  if (id === null) return undefined;
  const row = db
    .select({ code: accounts.code, name: accounts.name })
    .from(accounts)
    .where(eq(accounts.id, id))
    .get();
  return row ? `${row.code ?? id} ${row.name}` : `#${id}`;
}

function getAsset(db: LedgerDb, id: number): FixedAsset | undefined {
  return db.select().from(fixedAssets).where(eq(fixedAssets.id, id)).get();
}

/** An asset as an agent reads it. `v` is what `update` asks as expected_version. */
function assetView(db: LedgerDb, row: FixedAsset): Value {
  return {
    id: row.id,
    no: assetNumber(row.id),
    name: row.name,
    type: row.assetType,
    cost: money(row.costMinor),
    account: accountLabel(db, row.assetAccountId),
    acquired: row.acquisitionDate,
    in_service: row.inServiceDate ?? undefined,
    life_months: row.usefulLifeMonths ?? undefined,
    residual: row.residualMinor === null ? undefined : money(row.residualMinor),
    expense_account: accountLabel(db, row.depreciationExpenseAccountId),
    accumulated_account: accountLabel(db, row.accumulatedDepreciationAccountId),
    v: String(row.revision),
  };
}

/** The fields `registerFixedAsset` and `updateFixedAsset` share, from the tool's input. */
function detailFields(details: Partial<AssetDetails>, accounts_: Accounts) {
  return {
    ...(details.name !== undefined ? { name: details.name } : {}),
    ...(details.type !== undefined ? { assetType: details.type } : {}),
    ...(details.description !== undefined
      ? { description: details.description }
      : {}),
    ...(details.serial_number !== undefined
      ? { serialNumber: details.serial_number }
      : {}),
    ...(details.start !== undefined ? { inServiceDate: details.start } : {}),
    ...(details.life_months !== undefined
      ? { bookMethod: "straight_line", usefulLifeMonths: details.life_months }
      : {}),
    ...(details.residual !== undefined
      ? { residualMinor: details.residual }
      : {}),
    ...(details.business_use !== undefined
      ? { businessUseBps: details.business_use }
      : {}),
    ...(details.document_reference !== undefined
      ? { documentReference: details.document_reference }
      : {}),
    ...(accounts_.expense
      ? { depreciationExpenseAccountId: accounts_.expense.id }
      : {}),
    ...(accounts_.accumulated
      ? { accumulatedDepreciationAccountId: accounts_.accumulated.id }
      : {}),
  };
}

// --- items ---------------------------------------------------------------------

function runCapitalise(
  ctx: AppContext,
  plan: CapitalisePlan,
): AppResult<Value> {
  const before = getRecord(ctx.db, plan.record.id);
  if (!before) return fail("NOT_FOUND", "That record no longer exists.");
  if (before.kind !== LedgerRecordKind.Expense)
    return fail(
      "REFUSED",
      `${recordNo(plan.record)} is not an expense. Only an expense can be capitalised; to register a purchase already booked to a fixed-asset account, use register.`,
    );
  const lines = before.movements.filter((m) =>
    isCategoryAccount({ type: m.accountType, subType: m.accountSubType }),
  );
  if (lines.length === 0)
    return fail("REFUSED", `${recordNo(plan.record)} has no category line.`);
  let index = plan.line;
  if (index === undefined) {
    if (lines.length > 1)
      return fail(
        "INVALID_INPUT",
        `${recordNo(plan.record)} has ${lines.length} category lines (${lines
          .map(
            (m, n) =>
              `${n}: ${accountLabel(ctx.db, m.accountId)} ${money(Math.abs(m.amountMinor))}`,
          )
          .join("; ")}). Say which one with line.`,
      );
    index = 0;
  }
  const target = lines[index];
  if (!target)
    return fail(
      "INVALID_INPUT",
      `${recordNo(plan.record)} has ${lines.length} category line${lines.length === 1 ? "" : "s"}, so line ${index} does not exist. Lines count from 0.`,
    );

  const from = accountLabel(ctx.db, target.accountId);
  const version = plan.expectedVersion;
  let movementId: number | undefined;
  if (target.accountId === plan.toAccount.id) {
    // Already there: nothing to move. The version still has to be current.
    const stale = checkVersion(recordVersion(ctx.db, plan.record.id), version);
    if (stale) return stale;
    movementId = target.id;
  } else {
    const change: RecordChange =
      lines.length === 1
        ? { categoryAccountId: plan.toAccount.id }
        : {
            lines: lines.map((m, n) => ({
              accountId: n === index ? plan.toAccount.id : m.accountId,
              amountMinor: Math.abs(m.amountMinor),
              ...(m.label ? { label: m.label } : {}),
            })),
          };
    const changed = changeRecord(ctx, {
      recordId: plan.record.id,
      expectedVersion: version,
      change,
    });
    if (!changed.ok) return changed;
    const afterLines = changed.value.record.movements.filter((m) =>
      isCategoryAccount({ type: m.accountType, subType: m.accountSubType }),
    );
    const moved = afterLines.filter(
      (m) =>
        m.accountId === plan.toAccount.id &&
        Math.abs(m.amountMinor) === Math.abs(target.amountMinor),
    );
    movementId = (
      moved.find((m) => afterLines.indexOf(m) === index) ?? moved[0]
    )?.id;
  }
  if (movementId === undefined)
    return fail(
      "REFUSED",
      "The line could not be found after it was moved. Nothing was saved.",
    );

  const registered = registerFixedAsset(ctx, {
    ...detailFields(plan.asset, plan.accounts),
    assetType: plan.asset.type ?? "Other",
    inServiceDate: plan.asset.start ?? null,
    sourceMovementId: movementId,
  });
  if (!registered.ok) return registered;
  return ok({
    asset: assetView(ctx.db, registered.value),
    record: {
      id: plan.record.id,
      no: recordNo(plan.record),
      v: recordVersion(ctx.db, plan.record.id),
    },
    moved:
      target.accountId === plan.toAccount.id
        ? undefined
        : { from, to: accountLabel(ctx.db, plan.toAccount.id) },
  });
}

/** The movement of a record's n-th fixed-asset purchase line, or why there is none. */
function purchaseLine(
  ctx: AppContext,
  record: RecordBrief,
  line: number | undefined,
): AppResult<number> {
  const contra = new Set(
    ctx.db
      .select({ id: fixedAssets.accumulatedDepreciationAccountId })
      .from(fixedAssets)
      .all()
      .flatMap((row) => (row.id === null ? [] : [row.id])),
  );
  const candidates = assetLedgerLines(ctx.db).filter(
    (row) =>
      row.recordId === record.id &&
      isFixedAssetAccount(row) &&
      !contra.has(row.accountId) &&
      row.amountMinor > 0 &&
      !row.voided,
  );
  if (candidates.length === 0)
    return fail(
      "REFUSED",
      `${recordNo(record)} has no line in a fixed-asset account. To turn an expense into an asset, use capitalise.`,
    );
  if (line === undefined) {
    if (candidates.length > 1)
      return fail(
        "INVALID_INPUT",
        `${recordNo(record)} has ${candidates.length} fixed-asset lines (${candidates
          .map(
            (row, n) =>
              `${n}: ${accountLabel(ctx.db, row.accountId)} ${money(row.amountMinor)}`,
          )
          .join("; ")}). Say which one with line.`,
      );
    return ok(candidates[0].movementId);
  }
  const picked = candidates[line];
  return picked
    ? ok(picked.movementId)
    : fail(
        "INVALID_INPUT",
        `${recordNo(record)} has ${candidates.length} fixed-asset line${candidates.length === 1 ? "" : "s"}, so line ${line} does not exist. Lines count from 0.`,
      );
}

function runRegister(ctx: AppContext, plan: RegisterPlan): AppResult<Value> {
  let source: Record<string, unknown>;
  if (plan.record) {
    const movement = purchaseLine(ctx, plan.record, plan.line);
    if (!movement.ok) return movement;
    source = { sourceMovementId: movement.value };
  } else {
    const e = plan.existing!;
    source = {
      sourceMovementId: null,
      assetAccountId: e.account.id,
      acquisitionDate: e.acquired,
      costMinor: e.costMinor,
      openingAsAt: e.openingAsAt,
      ...(e.broughtForwardMinor !== undefined
        ? { broughtForwardDepMinor: e.broughtForwardMinor }
        : {}),
      ...(e.openingRecord ? { openingRecordId: e.openingRecord.id } : {}),
    };
  }
  const registered = registerFixedAsset(ctx, {
    ...detailFields(plan.asset, plan.accounts),
    assetType: plan.asset.type ?? "Other",
    inServiceDate: plan.asset.start ?? null,
    ...source,
  });
  if (!registered.ok) return registered;
  return ok({ asset: assetView(ctx.db, registered.value) });
}

function runUpdate(ctx: AppContext, plan: UpdatePlan): AppResult<Value> {
  const before = getAsset(ctx.db, plan.asset.id);
  if (!before) return fail("NOT_FOUND", "That asset no longer exists.");
  const set = plan.set;
  // The operation replaces every detail it is given, defaults included, so
  // the fields left out here must be sent back as they are.
  const updated = updateFixedAsset(ctx, plan.asset.id, {
    name: before.name,
    assetType: before.assetType,
    description: before.description,
    serialNumber: before.serialNumber,
    inServiceDate: before.inServiceDate,
    businessUseBps: before.businessUseBps,
    documentReference: before.documentReference,
    bookMethod: before.bookMethod,
    usefulLifeMonths: before.usefulLifeMonths,
    residualMinor: before.residualMinor,
    depreciationExpenseAccountId: before.depreciationExpenseAccountId,
    ...detailFields(set, plan.accounts),
    expectedVersion: plan.expectedVersion,
    reason: plan.reason,
  });
  if (!updated.ok) return updated;
  return ok({
    asset: assetView(ctx.db, updated.value),
    changed: Object.keys(set).filter(
      (key) => (set as Record<string, unknown>)[key] !== undefined,
    ),
  });
}

function runApprove(ctx: AppContext, plan: ApprovePlan): AppResult<Value> {
  const { item } = plan;
  const asset = getAsset(ctx.db, plan.asset.id);
  if (!asset) return fail("NOT_FOUND", "That asset no longer exists.");
  const months = item.months ?? asset.usefulLifeMonths;
  const expenseAccountId =
    plan.accounts.expense?.id ?? asset.depreciationExpenseAccountId;
  const accumulatedAccountId =
    plan.accounts.accumulated?.id ?? asset.accumulatedDepreciationAccountId;
  const missing = [
    months === null && "months (or set life_months on the asset)",
    expenseAccountId === null && "expense_account",
    accumulatedAccountId === null && "accumulated_account",
  ].filter(Boolean);
  if (
    months === null ||
    expenseAccountId === null ||
    accumulatedAccountId === null
  )
    return fail(
      "INVALID_INPUT",
      `${assetNumber(asset.id)} needs ${missing.join(", ")} before depreciation can be approved. Send it here, or save it on the asset with update.`,
    );
  const settings = {
    startMonth:
      item.start_month ??
      (asset.inServiceDate ?? asset.acquisitionDate).slice(0, 7),
    months,
    residualMinor: item.residual ?? asset.residualMinor ?? 0,
    expenseAccountId,
    accumulatedAccountId,
    mode: "review" as const,
    reason: item.reason,
  };
  const preview = previewDepreciationProfile(ctx, asset.id, settings);
  if (!preview.ok) return preview;
  const approved = approveDepreciationProfile(ctx, asset.id, {
    settings,
    postHistory: item.post_history ?? false,
    expectedVersion: item.expected_version ?? preview.value.version,
  });
  if (!approved.ok) return approved;
  const schedule = preview.value.schedule;
  return ok({
    asset: assetView(ctx.db, getAsset(ctx.db, asset.id) ?? asset),
    schedule: {
      start_month: settings.startMonth,
      months: schedule.length,
      last_month: schedule.at(-1)?.month,
      monthly: schedule[0] ? money(schedule[0].amountMinor) : undefined,
      base: money(preview.value.baseNbvMinor),
      residual: money(settings.residualMinor),
    },
    v: item.expected_version ?? preview.value.version,
  });
}

function runPostMonth(ctx: AppContext, plan: PostPlan): AppResult<Value> {
  const month = plan.month!;
  const preview = previewDepreciationMonth(ctx, month);
  if (!preview.ok) return preview;
  const version = plan.expectedVersion ?? preview.value.version;
  const posted = postDepreciationMonth(ctx, {
    month,
    expectedVersion: version,
  });
  if (!posted.ok) return posted;
  const due = preview.value.rows.filter(
    (row) => row.status === "Unposted" && row.amountMinor > 0 && !row.blocked,
  );
  const record =
    posted.value.recordId === null
      ? undefined
      : getRecord(ctx.db, posted.value.recordId);
  return ok({
    month,
    posted: posted.value.posted,
    total: posted.value.posted ? money(preview.value.totalMinor) : undefined,
    assets: posted.value.posted
      ? due.map((row) => ({
          id: row.assetId,
          no: assetNumber(row.assetId),
          name: row.name,
          amount: money(row.amountMinor),
        }))
      : undefined,
    record: record
      ? {
          id: record.id,
          no: record.recordNumber ?? `#${record.id}`,
          date: record.date,
          v: recordVersion(ctx.db, record.id),
        }
      : undefined,
    note: posted.value.posted
      ? undefined
      : `Nothing was due for ${month}: no asset has an unposted charge that month.`,
    v: version,
  });
}

function runPostAsset(ctx: AppContext, plan: PostPlan): AppResult<Value> {
  const asset = plan.asset!;
  const preview = previewAssetCatchUp(ctx, asset.id);
  if (!preview.ok) return preview;
  const version = plan.expectedVersion ?? preview.value.version;
  const posted = postAssetCatchUp(ctx, asset.id, { expectedVersion: version });
  if (!posted.ok) return posted;
  const months = preview.value.months.slice(0, posted.value.posted);
  return ok({
    asset: assetView(ctx.db, getAsset(ctx.db, asset.id) ?? asset),
    months_posted: posted.value.posted,
    months: months.map((m) => ({
      month: m.month,
      amount: money(m.amountMinor),
    })),
    note: posted.value.posted
      ? undefined
      : `${assetNumber(asset.id)} has no past month left to post.`,
    v: version,
  });
}

function runStop(ctx: AppContext, plan: StopPlan): AppResult<Value> {
  const preview = previewAssetCatchUp(ctx, plan.asset.id);
  if (!preview.ok) return preview;
  const version = plan.expectedVersion ?? preview.value.version;
  const stopped = stopDepreciation(ctx, plan.asset.id, {
    month: plan.month,
    reason: plan.reason,
    expectedVersion: version,
  });
  if (!stopped.ok) return stopped;
  return ok({
    asset: assetView(ctx.db, getAsset(ctx.db, plan.asset.id) ?? plan.asset),
    stopped_from: stopped.value.stoppedFrom,
    v: version,
  });
}

function runReverse(ctx: AppContext, plan: ReversePlan): AppResult<Value> {
  const run = ctx.db
    .select()
    .from(depreciationRuns)
    .where(eq(depreciationRuns.recordId, plan.record.id))
    .get();
  if (!run)
    return fail(
      "REFUSED",
      `${recordNo(plan.record)} is not a depreciation run. Name the journal that post_depreciation returned.`,
    );
  const month = plan.month ?? run.month;
  const reversed = reverseDepreciationRun(ctx, run.id, {
    month,
    reason: plan.reason,
  });
  if (!reversed.ok) return reversed;
  const reversal = getRecord(ctx.db, reversed.value.recordId);
  return ok({
    reversed: {
      id: plan.record.id,
      no: recordNo(plan.record),
      month: run.month,
    },
    reversal: reversal
      ? {
          id: reversal.id,
          no: reversal.recordNumber ?? `#${reversal.id}`,
          date: reversal.date,
          v: recordVersion(ctx.db, reversal.id),
        }
      : undefined,
  });
}

// --- the tool ------------------------------------------------------------------

/** A success with the book's main currency on top: every figure here is in it. */
function withCurrency(db: LedgerDb, out: ReturnType<typeof batchToolResult>) {
  if (out.isError) return out;
  const payload = envelopePayload(out);
  return payload ? toolResult({ ...payload, currency: mainCurrency(db) }) : out;
}

const manageFixedAssets = defineWriteTool({
  base: "manage_fixed_assets",
  title: "Manage fixed assets",
  description: MANAGE_DESCRIPTION,
  input: manageInput,
  annotations: {
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  requirements: MANAGE_FIXED_ASSETS.requirements,
  actions: MANAGE_FIXED_ASSETS.actions,
  handler: async (ctx, args, meta) => {
    const refused = refuseActions(ctx, meta, "manage_fixed_assets", args);
    if (refused) return refused;
    if (
      !args.capitalise?.length &&
      !args.register?.length &&
      !args.update?.length &&
      !args.approve?.length &&
      !args.post_depreciation?.length &&
      !args.stop?.length &&
      !args.reverse_run?.length
    )
      return nothingToDo(
        "capitalise, register, update, approve, post_depreciation, stop or reverse_run",
      );

    const refs = new Refs(ctx, meta);
    const capitalise = args.capitalise
      ? planCapitalise(refs, args.capitalise)
      : [];
    const register = args.register ? planRegister(refs, args.register) : [];
    const update = args.update ? planUpdate(refs, args.update) : [];
    const approve = args.approve ? planApprove(refs, args.approve) : [];
    const post = args.post_depreciation
      ? planPost(refs, args.post_depreciation)
      : [];
    const stop = args.stop ? planStop(refs, args.stop) : [];
    const reverse = args.reverse_run ? planReverse(refs, args.reverse_run) : [];
    const missed = refs.failure();
    if (missed) return missed;

    const result = await runBatch<Value>(ctx, {
      tool: meta.name,
      dryRun: args.dry_run ?? false,
      items: [
        ...capitalise.map((plan) => ({
          action: "capitalise",
          label: `${plan.path} ${recordNo(plan.record)}`,
          run: (c: AppContext) => runCapitalise(c, plan),
        })),
        ...register.map((plan) => ({
          action: "register",
          label: plan.path,
          run: (c: AppContext) => runRegister(c, plan),
        })),
        ...update.map((plan) => ({
          action: "update",
          label: `${plan.path} ${assetNumber(plan.asset.id)}`,
          run: (c: AppContext) => runUpdate(c, plan),
        })),
        ...approve.map((plan) => ({
          action: "approve",
          label: `${plan.path} ${assetNumber(plan.asset.id)}`,
          run: (c: AppContext) => runApprove(c, plan),
        })),
        ...post.map((plan) => ({
          action: "post_depreciation",
          label: `${plan.path} ${plan.month ?? assetNumber(plan.asset!.id)}`,
          run: (c: AppContext) =>
            plan.month !== undefined
              ? runPostMonth(c, plan)
              : runPostAsset(c, plan),
        })),
        ...stop.map((plan) => ({
          action: "stop",
          label: `${plan.path} ${assetNumber(plan.asset.id)}`,
          run: (c: AppContext) => runStop(c, plan),
        })),
        ...reverse.map((plan) => ({
          action: "reverse_run",
          label: `${plan.path} ${recordNo(plan.record)}`,
          run: (c: AppContext) => runReverse(c, plan),
        })),
      ],
      idempotency: idempotencyOf(args, {
        capitalise: args.capitalise,
        register: args.register,
        update: args.update,
        approve: args.approve,
        post_depreciation: args.post_depreciation,
        stop: args.stop,
        reverse_run: args.reverse_run,
      }),
    });
    return withCurrency(
      ctx.db,
      batchToolResult(result, {
        requestId: meta.requestId,
        formatValue: (value) => value,
      }),
    );
  },
});

/** The assets write tools, in listing order. */
export const assetsWriteTools: readonly ToolDefinition[] = [manageFixedAssets];
