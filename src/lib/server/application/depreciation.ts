import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { AccountType, AccountSubType, LedgerRecordKind } from "$lib/enums.js";
import { DEFAULT_CURRENCY } from "$lib/currency.js";
import { monthEndFor } from "$lib/closing.js";
import { localToday } from "$lib/local-date.js";
import {
  isAccumulatedDepreciationAccount,
  depreciationMonth,
  depreciationProfileSchema,
  straightLineSchedule,
  type DepreciationSettings,
} from "$lib/depreciation.js";
import {
  accounts,
  users,
  fixedAssets,
  depreciationProfiles,
  depreciationApprovals,
  depreciationAllocations,
  depreciationRuns,
  depreciationPostings,
  ledgerRecords,
  ledgerMovements,
} from "../db/schema.js";
import {
  assetSchedule,
  manualDepreciation,
  assetDepreciationBasis,
  depreciationTotal,
} from "../queries/depreciation.js";
import { fixedAssetRegister } from "../queries/fixed-assets.js";
import {
  createRecord as createJournal,
  type DeferredEmits,
} from "../services/ledger.js";
import { inVoidPair } from "../queries/void-state.js";
import { recordAudit } from "../audit.js";
import { actor, requirePermissions, type AppContext } from "./context.js";
import { ok, fail, invalid, type AppResult } from "./result.js";
import { withClosingRefusal } from "./closing-refusal.js";
import { assertDatesOpen, closedThrough } from "../closing/policy.js";
import { fixedAssetEvents, ASSET_READ_PERMISSIONS } from "./fixed-assets.js";
import { getSetting, SETTING_KEYS } from "../settings.js";
import { canAll, resolveAccess } from "../permissions.js";

export const DEPRECIATION_WRITE = [
  ...ASSET_READ_PERMISSIONS,
  "accounts.update",
  "records.create",
  "records.adjust",
] as const;
const formatMinor = (minor: number) => (minor / 100).toFixed(2);
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
class Refusal extends Error {}
function refuse(message: string): never {
  throw new Refusal(message);
}
function write<T>(
  ctx: AppContext,
  action: (emits: DeferredEmits) => T,
): AppResult<T> {
  const emits: DeferredEmits = [];
  try {
    const result = withClosingRefusal(() =>
      ctx.db.transaction(() => ok(action(emits)), { behavior: "immediate" }),
    );
    if (result.ok) {
      for (const emit of emits) emit();
      fixedAssetEvents.emit("assets-refresh", {});
    }
    return result;
  } catch (error) {
    if (error instanceof Refusal) return fail("REFUSED", error.message);
    throw error;
  }
}
function assetState(ctx: AppContext, id: number) {
  const asset = fixedAssetRegister(ctx.db, "9999-12-31").assets.find(
    (row) => row.id === id,
  );
  if (!asset) return refuse("That asset no longer exists.");
  const schedule = assetSchedule(ctx.db, id);
  const allocations = manualDepreciation(ctx.db, id);
  const version = hash({
    today: localToday(),
    closedThrough: closedThrough(ctx.db),
    allocations,
    asset,
    profiles: schedule.profiles,
    history: schedule.history,
  });
  return { asset, ...schedule, allocations, version };
}
export function readAssetDepreciation(ctx: AppContext, id: number) {
  const denied = requirePermissions(ctx, ASSET_READ_PERMISSIONS);
  if (denied) return denied;
  return readTransaction(ctx, () => {
    const state = assetState(ctx, id);
    const asAt = localToday();
    const postedMinor = depreciationTotal(ctx.db, id, asAt);
    const nextDue = state.rows.find(
      (r) =>
        r.status === "Unposted" &&
        r.amountMinor > 0 &&
        monthEndFor(r.month)! < asAt,
    );
    const nextRow = nextDue
      ? monthly(ctx, nextDue.month, false, id).rows[0]
      : null;
    return {
      ...state,
      hasDue: !!nextDue,
      postingIssue: nextRow?.blocked ?? nextRow?.automationWarning ?? null,
      defaults: accountDefaults(ctx, state.asset.assetAccountId),
      manualCandidates: manualCandidates(ctx),
      reconciliation: reconciliation(
        ctx,
        state.asset.accumulatedDepreciationAccountId,
      ),
      historyReview: state.rows.filter((row) => {
        const approval = ctx.db
          .select()
          .from(depreciationApprovals)
          .where(eq(depreciationApprovals.profileId, row.profile.id))
          .get();
        return (
          row.status === "Unposted" &&
          row.amountMinor > 0 &&
          monthEndFor(row.month)! < localToday() &&
          (!approval || row.month < approval.futureFromMonth)
        );
      }),
      asAt,
      postedMinor,
      scheduleReviewReason:
        state.profiles.at(-1) &&
        state.profiles.at(-1)!.basis !== assetDepreciationBasis(state.asset)
          ? "The asset's financial basis changed. Review and approve its remaining schedule before posting."
          : null,
      accumulatedMinor: state.asset.broughtForwardDepMinor + postedMinor,
      nbvMinor:
        state.asset.costMinor -
        state.asset.broughtForwardDepMinor -
        postedMinor,
      canConfigure: canAll(ctx.locals, DEPRECIATION_WRITE),
      canReverse: canAll(ctx.locals, [...DEPRECIATION_WRITE, "records.void"]),
    };
  });
}
function readTransaction<T>(ctx: AppContext, read: () => T): AppResult<T> {
  try {
    return withClosingRefusal(() => ctx.db.transaction(() => ok(read())));
  } catch (error) {
    if (error instanceof Refusal) return fail("REFUSED", error.message);
    throw error;
  }
}
function accountValid(ctx: AppContext, id: number, type: number) {
  const account = ctx.db
    .select()
    .from(accounts)
    .where(eq(accounts.id, id))
    .get();
  return (
    account &&
    account.type === type &&
    (type !== AccountType.Asset || isAccumulatedDepreciationAccount(account)) &&
    !account.archivedAt &&
    !account.mergedIntoAccountId
  );
}
function accountDefaults(ctx: AppContext, costId: number) {
  const approved = ctx.db
    .select({
      profile: depreciationProfiles,
      costId: fixedAssets.assetAccountId,
    })
    .from(depreciationProfiles)
    .innerJoin(fixedAssets, eq(fixedAssets.id, depreciationProfiles.assetId))
    .all()
    .sort((a, b) => b.profile.id - a.profile.id);
  const mapped = approved.find(
    (row) =>
      row.costId === costId &&
      accountValid(ctx, row.profile.accumulatedAccountId, AccountType.Asset),
  );
  const expense = approved.find((row) =>
    accountValid(ctx, row.profile.expenseAccountId, AccountType.Expense),
  );
  return {
    expenseAccountId:
      mapped &&
      accountValid(ctx, mapped.profile.expenseAccountId, AccountType.Expense)
        ? mapped.profile.expenseAccountId
        : (expense?.profile.expenseAccountId ?? null),
    accumulatedAccountId: mapped?.profile.accumulatedAccountId ?? null,
  };
}
function reconciliation(ctx: AppContext, accountId: number | null) {
  if (!accountId) return null;
  const account = ctx.db
    .select()
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .get();
  const ledgerMinor = -ctx.db
    .select({
      amount: sql<number>`coalesce(sum(${ledgerMovements.amountMinor}), 0)`,
    })
    .from(ledgerMovements)
    .where(eq(ledgerMovements.accountId, accountId))
    .get()!.amount;
  const explained = fixedAssetRegister(ctx.db, "9999-12-31")
    .assets.filter((a) => a.accumulatedDepreciationAccountId === accountId)
    .reduce((sum, a) => sum + BigInt(a.accumulatedDepreciationMinor), 0n);
  return {
    accountId,
    name: account?.name ?? "Missing account",
    ledgerMinor,
    explainedMinor: Number(explained),
    differenceMinor: Number(BigInt(ledgerMinor) - explained),
  };
}
function reconciliationMessage(ctx: AppContext, accountId: number) {
  const r = reconciliation(ctx, accountId)!;
  return `Reconcile existing manual depreciation on ${r.name}: ledger ${formatMinor(r.ledgerMinor)}, explained by assets ${formatMinor(r.explainedMinor)}, difference ${formatMinor(r.differenceMinor)}. Review and link existing journals on the asset before approving; do not post them again.`;
}
function manualCandidates(ctx: AppContext) {
  const chart = ctx.db.select().from(accounts).all();
  const allocated = ctx.db.select().from(depreciationAllocations).all();
  return ctx.db
    .select()
    .from(ledgerRecords)
    .where(
      sql`${ledgerRecords.kind} = ${LedgerRecordKind.Journal} AND ${ledgerRecords.date} <= ${localToday()} AND NOT ${inVoidPair(ledgerRecords.id)}`,
    )
    .all()
    .filter(
      (r) =>
        r.kind === LedgerRecordKind.Journal &&
        !r.legacyKind?.startsWith("asset-depreciation") &&
        r.date <= localToday(),
    )
    .flatMap((record) => {
      const totals = new Map<number, bigint>();
      for (const m of ctx.db
        .select()
        .from(ledgerMovements)
        .where(eq(ledgerMovements.recordId, record.id))
        .all())
        totals.set(
          m.accountId,
          (totals.get(m.accountId) ?? 0n) + BigInt(m.amountMinor),
        );
      const expenses = chart.filter(
        (a) => a.type === AccountType.Expense && (totals.get(a.id) ?? 0n) > 0n,
      );
      const contras = chart.filter(
        (a) =>
          a.type === AccountType.Asset &&
          (a.subType === AccountSubType.OtherNonCurrentAsset ||
            a.subType === AccountSubType.FixedAsset) &&
          (totals.get(a.id) ?? 0n) < 0n,
      );
      return expenses.flatMap((expense) =>
        contras.flatMap((contra) => {
          const usedExpense = allocated
            .filter(
              (a) =>
                a.recordId === record.id && a.expenseAccountId === expense.id,
            )
            .reduce((n, a) => n + BigInt(a.amountMinor), 0n);
          const usedContra = allocated
            .filter(
              (a) =>
                a.recordId === record.id &&
                a.accumulatedAccountId === contra.id,
            )
            .reduce((n, a) => n + BigInt(a.amountMinor), 0n);
          const expenseRemaining = totals.get(expense.id)! - usedExpense;
          const contraRemaining = -totals.get(contra.id)! - usedContra;
          const availableMinor = Number(
            [
              expenseRemaining,
              contraRemaining,
              BigInt(Number.MAX_SAFE_INTEGER),
            ].reduce((a, b) => (a < b ? a : b)),
          );
          return availableMinor > 0
            ? [
                {
                  key: `${record.id}-${expense.id}-${contra.id}`,
                  recordId: record.id,
                  date: record.date,
                  description: record.description,
                  expenseAccountId: expense.id,
                  accumulatedAccountId: contra.id,
                  expenseName: expense.name,
                  accumulatedName: contra.name,
                  availableMinor,
                },
              ]
            : [];
        }),
      );
    });
}
function prepare(ctx: AppContext, id: number, input: DepreciationSettings) {
  const settings = input;
  const state = assetState(ctx, id);
  const { asset, profiles, history, rows } = state;
  if (asset.reviewReason)
    refuse("Resolve the asset's review issues before approving depreciation.");
  if (
    settings.startMonth <
    (asset.inServiceDate ?? asset.acquisitionDate).slice(0, 7)
  )
    refuse("Depreciation cannot start before the asset is available for use.");

  if (
    history.some(
      ({ posting, run }) =>
        posting.month >= settings.startMonth ||
        (run.reversedOn && run.reversedOn.slice(0, 7) >= settings.startMonth),
    )
  )
    refuse(
      "Changes in estimates must start after every previously posted period, including reversed periods.",
    );
  if (
    rows.some(
      (row) =>
        row.month < settings.startMonth &&
        row.amountMinor > 0 &&
        row.status === "Unposted",
    )
  )
    refuse(
      "Post or explicitly stop earlier unposted depreciation before changing the remaining schedule.",
    );
  if (
    state.allocations.some(
      (a) =>
        settings.startMonth <= a.throughMonth ||
        settings.startMonth <= a.recordDate.slice(0, 7),
    )
  )
    refuse(
      "Start the remaining schedule after all linked manual depreciation periods and journal dates.",
    );
  if (asset.openingAsAt) {
    if (
      asset.openingAsAt !== monthEndFor(asset.openingAsAt.slice(0, 7)) ||
      settings.startMonth <= asset.openingAsAt.slice(0, 7)
    )
      refuse(
        "Confirm a month-end opening balance, then start depreciation in a later month. Never depreciate the opening period twice.",
      );
    if (!profiles.length) {
      const register = fixedAssetRegister(ctx.db, asset.openingAsAt);
      const cost = register.costReconciliation.find(
        (row) => row.accountId === asset.assetAccountId,
      );
      const dep = register.depreciationReconciliation.find(
        (row) => row.accountId === asset.accumulatedDepreciationAccountId,
      );
      if (cost?.differenceMinor || dep?.differenceMinor)
        refuse(
          "Reconcile the existing asset's opening ledger balances before enabling depreciation.",
        );
    }
  }
  const registered = fixedAssetRegister(ctx.db, "9999-12-31").assets;
  if (
    settings.accumulatedAccountId &&
    reconciliation(ctx, settings.accumulatedAccountId)!.differenceMinor
  )
    refuse(reconciliationMessage(ctx, settings.accumulatedAccountId));
  if (
    !accountValid(ctx, settings.expenseAccountId, AccountType.Expense) ||
    !accountValid(ctx, settings.accumulatedAccountId, AccountType.Asset) ||
    settings.accumulatedAccountId === asset.assetAccountId ||
    registered.some(
      (row) => row.assetAccountId === settings.accumulatedAccountId,
    )
  )
    refuse(
      "Choose an active depreciation Expense account and a separate non-current Asset account for accumulated depreciation, unused as registered cost. Cash, bank and current-asset accounts cannot be used.",
    );
  if (
    asset.accumulatedDepreciationAccountId &&
    asset.accumulatedDepreciationAccountId !== settings.accumulatedAccountId
  )
    refuse(
      "Use the asset's existing accumulated depreciation account. Correct its mapping separately before approval.",
    );
  if (
    profiles.some(
      (profile) =>
        profile.accumulatedAccountId !== settings.accumulatedAccountId,
    ) &&
    history.length
  )
    refuse(
      "Keep the accumulated depreciation account used by posted history; transferring historical balances requires a separate reviewed adjustment.",
    );
  if (settings.mode === "auto" && (ctx.locals.credential || ctx.locals.oauth))
    refuse(
      "Approve unattended posting from a signed-in browser session, not a delegated credential.",
    );
  const posted = depreciationTotal(ctx.db, id, `${settings.startMonth}-01`);
  const baseNbvMinor = asset.costMinor - asset.broughtForwardDepMinor - posted;
  if (baseNbvMinor <= settings.residualMinor)
    refuse("Residual value must be below the remaining net book value.");
  const schedule = straightLineSchedule(
    baseNbvMinor,
    settings.residualMinor,
    settings.startMonth,
    settings.months,
  );
  return {
    state,
    settings,
    baseNbvMinor,
    schedule,
    version: hash({
      version: state.version,
      settings,
      baseNbvMinor,
      closedThrough: closedThrough(ctx.db),
    }),
  };
}
export function previewDepreciationProfile(
  ctx: AppContext,
  id: number,
  input: unknown,
) {
  const denied = requirePermissions(ctx, DEPRECIATION_WRITE);
  if (denied) return denied;
  const parsed = depreciationProfileSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  return readTransaction(ctx, () => {
    const prepared = prepare(ctx, id, parsed.data);
    return {
      version: prepared.version,
      schedule: prepared.schedule,
      baseNbvMinor: prepared.baseNbvMinor,
      history: historicalPreview(ctx, prepared.schedule),
    };
  });
}
export function approveDepreciationProfile(
  ctx: AppContext,
  id: number,
  input: unknown,
) {
  const denied = requirePermissions(ctx, DEPRECIATION_WRITE);
  if (denied) return denied;
  const parsed = z
    .object({
      settings: depreciationProfileSchema,
      postHistory: z.boolean().default(false),
      expectedVersion: z.string().min(1),
    })
    .strict()
    .safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  return write(ctx, (emits) => {
    const prepared = prepare(ctx, id, parsed.data.settings);
    if (prepared.version !== parsed.data.expectedVersion)
      refuse(
        "The asset, schedule or closing boundary changed. Preview again before approving.",
      );
    const settings = { ...prepared.settings };
    const profile = ctx.db
      .insert(depreciationProfiles)
      .values({
        assetId: id,
        startMonth: settings.startMonth,
        months: settings.months,
        baseNbvMinor: prepared.baseNbvMinor,
        residualMinor: settings.residualMinor,
        expenseAccountId: settings.expenseAccountId,
        accumulatedAccountId: settings.accumulatedAccountId,
        mode: settings.mode,
        basis: assetDepreciationBasis(prepared.state.asset),
        approvedBy: actor(ctx),
        reason: settings.reason,
      })
      .returning()
      .get();
    ctx.db
      .update(fixedAssets)
      .set({
        accumulatedDepreciationAccountId: settings.accumulatedAccountId,
        bookMethod: "straight_line",
        usefulLifeMonths: settings.months,
        residualMinor: settings.residualMinor,
        depreciationExpenseAccountId: settings.expenseAccountId,
        revision: prepared.state.asset.revision + 1,
        updatedBy: actor(ctx),
      })
      .where(eq(fixedAssets.id, id))
      .run();
    ctx.db
      .insert(depreciationApprovals)
      .values({
        profileId: profile.id,
        futureFromMonth: localToday().slice(0, 7),
      })
      .run();
    if (parsed.data.postHistory) postAssetHistory(ctx, id, emits);
    recordAudit(ctx.db, {
      userId: actor(ctx),
      recordType: "fixed_asset",
      recordId: id,
      action: "update",
      changes: [
        {
          field: "depreciationProfile",
          before: prepared.state.profiles.at(-1) ?? null,
          after: profile,
        },
        { field: "reason", before: null, after: settings.reason },
      ],
      deferredEmits: emits,
    });
    return profile;
  });
}
function monthly(
  ctx: AppContext,
  month: string,
  automatic = false,
  assetId?: number,
) {
  const register = fixedAssetRegister(ctx.db, "9999-12-31");
  const boundary = closedThrough(ctx.db);
  const end = monthEndFor(month)!;
  const unpostedMonths = new Set<string>();
  const rows = register.assets
    .filter((a) => assetId === undefined || a.id === assetId)
    .flatMap((asset) => {
      const schedule = assetSchedule(ctx.db, asset.id);
      for (const pending of schedule.rows)
        if (
          pending.status === "Unposted" &&
          pending.amountMinor > 0 &&
          monthEndFor(pending.month)! < localToday() &&
          (!automatic ||
            (pending.profile.mode === "auto" &&
              pending.profile.approvedBy === actor(ctx)))
        )
          unpostedMonths.add(pending.month);
      const row = schedule.rows.find((item) => item.month === month);
      if (
        !row ||
        (automatic &&
          (row.profile.mode !== "auto" ||
            row.profile.approvedBy !== actor(ctx)))
      )
        return [];
      const futureFrom = ctx.db
        .select()
        .from(depreciationApprovals)
        .where(eq(depreciationApprovals.profileId, row.profile.id))
        .get()?.futureFromMonth;
      const historyApprovalNeeded = !futureFrom || month < futureFrom;
      const automationWarning =
        row.profile.mode === "auto" &&
        !canAll(
          automationLocals(ctx, row.profile.approvedBy),
          DEPRECIATION_WRITE,
        )
          ? "Auto-post paused: approval permissions changed. Review the profile or post manually with current authority."
          : null;
      let blocked: string | null = null;
      if (row.status === "Unposted" && row.amountMinor > 0) {
        if (end >= localToday())
          blocked = "Only completed calendar months can be posted.";
        else if (boundary && end <= boundary)
          blocked = "Month closed — reopen before posting.";
        else if (asset.reviewReason) blocked = asset.reviewReason;
        else if (row.profile.basis !== assetDepreciationBasis(asset))
          blocked =
            "The asset's financial basis changed. Approve a prospective schedule before posting.";
        else if (
          row.profile.accumulatedAccountId !==
            asset.accumulatedDepreciationAccountId ||
          !accountValid(
            ctx,
            row.profile.expenseAccountId,
            AccountType.Expense,
          ) ||
          !accountValid(
            ctx,
            row.profile.accumulatedAccountId,
            AccountType.Asset,
          )
        )
          blocked = "Review the depreciation account mappings.";
        else if (
          register.depreciationReconciliation.find(
            (account) => account.accountId === row.profile.accumulatedAccountId,
          )?.differenceMinor
        )
          blocked = reconciliationMessage(
            ctx,
            row.profile.accumulatedAccountId,
          );
        else if (
          schedule.rows.some(
            (earlier) =>
              earlier.month < month &&
              earlier.amountMinor > 0 &&
              earlier.status === "Unposted",
          )
        )
          blocked = "Post earlier due months first.";
        if (automatic && historyApprovalNeeded)
          blocked =
            "History needs review — approve missed months on the asset before automatic posting.";
        if (
          automatic &&
          !canAll(
            automationLocals(ctx, row.profile.approvedBy),
            DEPRECIATION_WRITE,
          )
        )
          blocked =
            "Automatic approval is no longer authorised. Review the profile.";
      }
      return [
        {
          assetId: asset.id,
          name: asset.name,
          assetVersion: asset.version,
          ...row,
          blocked,
          automationWarning,
        },
      ];
    });
  const due = rows.filter(
    (row) => row.status === "Unposted" && row.amountMinor > 0,
  );
  const eligible = due.filter((row) => !row.blocked);
  const totalMinor = Number(
    eligible.reduce((sum, row) => sum + BigInt(row.amountMinor), 0n),
  );
  if (!Number.isSafeInteger(totalMinor))
    refuse("The batch exceeds safe integer cents. Post a smaller group.");
  return {
    month,
    unpostedMonths: [...unpostedMonths].sort(),
    rows,
    totalMinor,
    dueCount: due.length,
    version: hash({ month, rows, boundary }),
    canPost: canAll(ctx.locals, DEPRECIATION_WRITE),
    canReverse: canAll(ctx.locals, [...DEPRECIATION_WRITE, "records.void"]),
  };
}
export function previewDepreciationMonth(ctx: AppContext, month: string) {
  const denied = requirePermissions(ctx, ASSET_READ_PERMISSIONS);
  if (denied) return denied;
  const parsed = depreciationMonth.safeParse(month);
  if (!parsed.success) return invalid(parsed.error);
  return readTransaction(ctx, () => monthly(ctx, month));
}
export function postDepreciationMonth(
  ctx: AppContext,
  input: unknown,
  automatic = false,
) {
  const denied = requirePermissions(ctx, DEPRECIATION_WRITE);
  if (denied) return denied;
  const parsed = z
    .object({ month: depreciationMonth, expectedVersion: z.string().min(1) })
    .strict()
    .safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  return write(ctx, (emits) =>
    postMonth(
      ctx,
      parsed.data.month,
      parsed.data.expectedVersion,
      emits,
      automatic,
    ),
  );
}
function postMonth(
  ctx: AppContext,
  month: string,
  expectedVersion: string | null,
  emits: DeferredEmits,
  automatic = false,
  assetId?: number,
) {
  const preview = monthly(ctx, month, automatic, assetId);
  const due = preview.rows.filter(
    (row) => row.status === "Unposted" && row.amountMinor > 0,
  );
  if (!due.length) return { runId: null, recordId: null, posted: 0 };
  if (expectedVersion !== null && preview.version !== expectedVersion)
    refuse(
      "The depreciation preview changed. Review the month again before posting.",
    );
  if (!automatic && due.some((row) => row.blocked))
    refuse(due.find((row) => row.blocked)!.blocked!);
  const ready = due.filter((row) => !row.blocked);
  if (!ready.length) return { runId: null, recordId: null, posted: 0 };
  const end = monthEndFor(preview.month)!;
  assertDatesOpen(ctx.db, [end]);
  const movements = ready.flatMap((row) => [
    {
      accountId: row.profile.expenseAccountId,
      amountMinor: row.amountMinor,
      label: `Depreciation · ${row.name}`,
    },
    {
      accountId: row.profile.accumulatedAccountId,
      amountMinor: -row.amountMinor,
      label: `Accumulated depreciation · ${row.name}`,
    },
  ]);
  const counts = new Map<number, number>();
  const taxOverrides = ready.map((row) => {
    const accountId = row.profile.expenseAccountId;
    const occurrence = counts.get(accountId) ?? 0;
    counts.set(accountId, occurrence + 1);
    return {
      accountId,
      occurrence,
      percentageBps: 0,
      treatment: "non_deductible" as const,
      reason: "Book depreciation; capital allowances are reviewed separately.",
    };
  });
  const result = createJournal(
    ctx.db,
    actor(ctx),
    {
      kind: "journal",
      date: end,
      description: `Asset depreciation · ${preview.month}`,
      amount: preview.totalMinor / 100,
      currency:
        getSetting(ctx.db, SETTING_KEYS.currencyCode) || DEFAULT_CURRENCY,
      exchangeRate: 1,
      movements,
      taxOverrides,
    },
    emits,
  );
  if (!result.ok) return refuse(result.reason);
  const run = ctx.db
    .insert(depreciationRuns)
    .values({
      month: preview.month,
      recordId: result.value.id,
      createdBy: actor(ctx),
    })
    .returning()
    .get();
  ctx.db
    .update(ledgerRecords)
    .set({ legacyKind: "asset-depreciation", legacyId: run.id })
    .where(eq(ledgerRecords.id, run.recordId))
    .run();
  for (const row of ready) {
    ctx.db
      .insert(depreciationPostings)
      .values({
        assetId: row.assetId,
        month: preview.month,
        profileId: row.profile.id,
        runId: run.id,
        amountMinor: row.amountMinor,
      })
      .run();
    recordAudit(ctx.db, {
      userId: actor(ctx),
      recordType: "fixed_asset",
      recordId: row.assetId,
      action: "update",
      changes: [
        {
          field: "postedDepreciation",
          before: null,
          after: {
            month: preview.month,
            amountMinor: row.amountMinor,
            recordId: run.recordId,
            profileId: row.profile.id,
          },
        },
      ],
      deferredEmits: emits,
    });
  }
  return { runId: run.id, recordId: run.recordId, posted: ready.length };
}
function historicalPreview(
  ctx: AppContext,
  rows: { month: string; amountMinor: number }[],
) {
  const boundary = closedThrough(ctx.db);
  const missed = rows.filter(
    (r) => r.amountMinor > 0 && monthEndFor(r.month)! < localToday(),
  );
  return {
    count: missed.length,
    from: missed[0]?.month ?? null,
    through: missed.at(-1)?.month ?? null,
    totalMinor: Number(missed.reduce((n, r) => n + BigInt(r.amountMinor), 0n)),
    closedMonths: missed
      .filter((r) => boundary && monthEndFor(r.month)! <= boundary)
      .map((r) => r.month),
  };
}
function postAssetHistory(ctx: AppContext, id: number, emits: DeferredEmits) {
  const state = assetState(ctx, id);
  const rows = state.rows.filter((r) => r.status === "Unposted");
  const history = historicalPreview(ctx, rows);
  if (history.closedMonths.length)
    refuse(
      `Historical months are closed: ${history.closedMonths.join(", ")}. Save setup and review history after reopening; nothing was posted.`,
    );
  let posted = 0;
  for (const row of rows
    .filter((r) => r.amountMinor > 0 && monthEndFor(r.month)! < localToday())
    .sort((a, b) => a.month.localeCompare(b.month)))
    posted += postMonth(ctx, row.month, null, emits, false, id).posted;
  return { posted };
}
export function previewAssetCatchUp(ctx: AppContext, id: number) {
  const denied = requirePermissions(ctx, DEPRECIATION_WRITE);
  if (denied) return denied;
  return readTransaction(ctx, () => {
    const state = assetState(ctx, id);
    return {
      version: state.version,
      history: historicalPreview(
        ctx,
        state.rows.filter((r) => r.status === "Unposted"),
      ),
      months: state.rows
        .filter(
          (r) =>
            r.status === "Unposted" &&
            r.amountMinor > 0 &&
            monthEndFor(r.month)! < localToday(),
        )
        .map((r) => ({
          month: r.month,
          amountMinor: r.amountMinor,
          blocked: (() => {
            const reason = monthly(ctx, r.month, false, id).rows[0]?.blocked;
            // This one-asset batch handles chronological dependencies itself.
            return reason === "Post earlier due months first."
              ? null
              : (reason ?? null);
          })(),
        })),
    };
  });
}
export function postAssetCatchUp(ctx: AppContext, id: number, input: unknown) {
  const denied = requirePermissions(ctx, DEPRECIATION_WRITE);
  if (denied) return denied;
  const parsed = z
    .object({ expectedVersion: z.string().min(1) })
    .strict()
    .safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  return write(ctx, (emits) => {
    if (assetState(ctx, id).version !== parsed.data.expectedVersion)
      refuse("The asset changed. Review missed months again.");
    return postAssetHistory(ctx, id, emits);
  });
}
export function linkManualDepreciation(
  ctx: AppContext,
  id: number,
  input: unknown,
) {
  const denied = requirePermissions(ctx, DEPRECIATION_WRITE);
  if (denied) return denied;
  const parsed = z
    .object({
      candidateKey: z.string(),
      amountMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      fromMonth: depreciationMonth,
      throughMonth: depreciationMonth,
      reason: z.string().trim().min(1).max(1000),
      expectedVersion: z.string(),
    })
    .strict()
    .safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  return write(ctx, (emits) => {
    const state = assetState(ctx, id);
    const data = parsed.data;
    if (state.version !== data.expectedVersion)
      refuse("The asset changed. Reload before linking history.");
    if (state.history.length)
      refuse(
        "Link manual history before engine postings. Reverse dependent runs and review the opening balance before changing existing posted history.",
      );
    const candidate = manualCandidates(ctx).find(
      (c) => c.key === data.candidateKey,
    );
    if (!candidate || data.amountMinor > candidate.availableMinor)
      refuse(
        "The journal changed or that amount is already allocated. Reload and review it again.",
      );
    if (
      data.fromMonth > data.throughMonth ||
      data.throughMonth > candidate.date.slice(0, 7) ||
      data.fromMonth <
        (state.asset.inServiceDate ?? state.asset.acquisitionDate).slice(0, 7)
    )
      refuse(
        "Choose covered months between the in-service month and the journal month.",
      );
    if (
      state.asset.openingAsAt &&
      (candidate.date <= state.asset.openingAsAt ||
        data.fromMonth <= state.asset.openingAsAt.slice(0, 7))
    )
      refuse(
        "Opening depreciation is already included. Only link journals and periods after the opening date.",
      );
    if (
      state.allocations.some(
        (a) =>
          data.fromMonth <= a.throughMonth && data.throughMonth >= a.fromMonth,
      )
    )
      refuse("Those months already have linked manual depreciation.");
    const registered = fixedAssetRegister(ctx.db, "9999-12-31").assets;
    if (
      registered.some(
        (a) => a.assetAccountId === candidate.accumulatedAccountId,
      ) ||
      (state.asset.accumulatedDepreciationAccountId &&
        state.asset.accumulatedDepreciationAccountId !==
          candidate.accumulatedAccountId)
    )
      refuse(
        "Use the asset's separate accumulated depreciation account, not a cost account.",
      );
    if (data.amountMinor > state.asset.netBookValueMinor)
      refuse("The allocation exceeds this asset's remaining book value.");
    const allocation = ctx.db
      .insert(depreciationAllocations)
      .values({
        assetId: id,
        recordId: candidate.recordId,
        expenseAccountId: candidate.expenseAccountId,
        accumulatedAccountId: candidate.accumulatedAccountId,
        amountMinor: data.amountMinor,
        fromMonth: data.fromMonth,
        throughMonth: data.throughMonth,
        recordDate: candidate.date,
        approvedBy: actor(ctx),
        reason: data.reason,
      })
      .returning()
      .get();
    for (const profile of state.profiles)
      ctx.db
        .update(depreciationProfiles)
        .set({ stoppedFrom: profile.startMonth })
        .where(eq(depreciationProfiles.id, profile.id))
        .run();
    ctx.db
      .update(fixedAssets)
      .set({
        accumulatedDepreciationAccountId: candidate.accumulatedAccountId,
        depreciationExpenseAccountId: candidate.expenseAccountId,
        revision: state.asset.revision + 1,
        updatedBy: actor(ctx),
      })
      .where(eq(fixedAssets.id, id))
      .run();
    recordAudit(ctx.db, {
      userId: actor(ctx),
      recordType: "fixed_asset",
      recordId: id,
      action: "update",
      changes: [
        { field: "linkedManualDepreciation", before: null, after: allocation },
      ],
      deferredEmits: emits,
    });
    return allocation;
  });
}
export function unlinkManualDepreciation(
  ctx: AppContext,
  id: number,
  input: unknown,
) {
  const denied = requirePermissions(ctx, DEPRECIATION_WRITE);
  if (denied) return denied;
  const parsed = z
    .object({
      allocationId: z.number().int().positive(),
      expectedVersion: z.string(),
    })
    .strict()
    .safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  return write(ctx, (emits) => {
    const state = assetState(ctx, id);
    if (state.version !== parsed.data.expectedVersion)
      refuse("The asset changed. Reload before removing history.");
    if (state.history.length)
      refuse(
        "Posted runs depend on this history. Review and reverse dependent runs before changing its opening basis.",
      );
    const allocation = state.allocations.find(
      (a) => a.id === parsed.data.allocationId,
    );
    if (!allocation) refuse("That allocation no longer exists.");
    ctx.db
      .delete(depreciationAllocations)
      .where(eq(depreciationAllocations.id, allocation.id))
      .run();
    for (const profile of state.profiles)
      ctx.db
        .update(depreciationProfiles)
        .set({ stoppedFrom: profile.startMonth })
        .where(eq(depreciationProfiles.id, profile.id))
        .run();
    recordAudit(ctx.db, {
      userId: actor(ctx),
      recordType: "fixed_asset",
      recordId: id,
      action: "update",
      changes: [
        { field: "linkedManualDepreciation", before: allocation, after: null },
      ],
      deferredEmits: emits,
    });
    return { removed: true };
  });
}
export function stopDepreciation(ctx: AppContext, id: number, input: unknown) {
  const denied = requirePermissions(ctx, DEPRECIATION_WRITE);
  if (denied) return denied;
  const parsed = z
    .object({
      month: depreciationMonth,
      reason: z.string().trim().min(1).max(1000),
      expectedVersion: z.string(),
    })
    .strict()
    .safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  return write(ctx, (emits) => {
    const state = assetState(ctx, id);
    if (state.version !== parsed.data.expectedVersion)
      refuse("The asset changed. Refresh before stopping depreciation.");
    if (!state.profiles.length) refuse("This asset has no approved schedule.");
    assertDatesOpen(ctx.db, [monthEndFor(parsed.data.month)!]);
    if (state.history.some(({ posting }) => posting.month >= parsed.data.month))
      refuse(
        "Stop after posted periods. Reverse a posted run if a correction is needed.",
      );
    for (const profile of state.profiles)
      if (!profile.stoppedFrom || profile.stoppedFrom > parsed.data.month)
        ctx.db
          .update(depreciationProfiles)
          .set({ stoppedFrom: parsed.data.month })
          .where(eq(depreciationProfiles.id, profile.id))
          .run();
    recordAudit(ctx.db, {
      userId: actor(ctx),
      recordType: "fixed_asset",
      recordId: id,
      action: "update",
      changes: [
        {
          field: "depreciationStoppedFrom",
          before: state.profiles.at(-1)?.stoppedFrom ?? null,
          after: parsed.data.month,
        },
        { field: "reason", before: null, after: parsed.data.reason },
      ],
      deferredEmits: emits,
    });
    return { stoppedFrom: parsed.data.month };
  });
}
export function reverseDepreciationRun(
  ctx: AppContext,
  runId: number,
  input: unknown,
) {
  const denied = requirePermissions(ctx, [
    ...DEPRECIATION_WRITE,
    "records.void",
  ]);
  if (denied) return denied;
  if (!Number.isSafeInteger(runId) || runId <= 0)
    return fail("INVALID_INPUT", "Choose a valid depreciation run.");
  const parsed = z
    .object({
      month: depreciationMonth,
      reason: z.string().trim().min(10).max(1000),
    })
    .strict()
    .safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  return write(ctx, (emits) => {
    const run = ctx.db
      .select()
      .from(depreciationRuns)
      .where(eq(depreciationRuns.id, runId))
      .get();
    if (!run || run.reversalRecordId)
      refuse("This run is missing or already reversed.");
    const date = monthEndFor(parsed.data.month)!;
    if (parsed.data.month < run.month || date >= localToday())
      refuse(
        "Choose a completed correction month on or after the original run.",
      );
    assertDatesOpen(ctx.db, [date]);
    const postings = ctx.db
      .select()
      .from(depreciationPostings)
      .where(eq(depreciationPostings.runId, runId))
      .all();
    const all = ctx.db.select().from(depreciationPostings).all();
    if (
      postings.some((posting) =>
        all.some(
          (other) =>
            other.assetId === posting.assetId &&
            other.month > posting.month &&
            !ctx.db
              .select()
              .from(depreciationRuns)
              .where(eq(depreciationRuns.id, other.runId))
              .get()?.reversalRecordId,
        ),
      )
    )
      refuse("Reverse later runs for these assets first.");
    const profiles = ctx.db.select().from(depreciationProfiles).all();
    const movements = postings.flatMap((posting) => {
      const profile = profiles.find((p) => p.id === posting.profileId)!;
      return [
        {
          accountId: profile.expenseAccountId,
          amountMinor: -posting.amountMinor,
        },
        {
          accountId: profile.accumulatedAccountId,
          amountMinor: posting.amountMinor,
        },
      ];
    });
    const total = Number(
      postings.reduce((sum, row) => sum + BigInt(row.amountMinor), 0n),
    );
    const counts = new Map<number, number>();
    const taxOverrides = postings.map((posting) => {
      const accountId = profiles.find(
        (p) => p.id === posting.profileId,
      )!.expenseAccountId;
      const occurrence = counts.get(accountId) ?? 0;
      counts.set(accountId, occurrence + 1);
      return {
        accountId,
        occurrence,
        percentageBps: 0,
        treatment: "non_deductible" as const,
        reason:
          "Reversal of book depreciation; capital allowances are separate.",
      };
    });
    const result = createJournal(
      ctx.db,
      actor(ctx),
      {
        kind: "journal",
        date,
        description: `Reverse depreciation · ${run.month}`,
        amount: total / 100,
        currency:
          getSetting(ctx.db, SETTING_KEYS.currencyCode) || DEFAULT_CURRENCY,
        exchangeRate: 1,
        movements,
        taxOverrides,
        remark: parsed.data.reason,
      },
      emits,
    );
    if (!result.ok) refuse(result.reason);
    ctx.db
      .update(ledgerRecords)
      .set({ legacyKind: "asset-depreciation-reversal", legacyId: run.id })
      .where(eq(ledgerRecords.id, result.value.id))
      .run();
    ctx.db
      .update(depreciationRuns)
      .set({ reversalRecordId: result.value.id, reversedOn: date })
      .where(eq(depreciationRuns.id, runId))
      .run();
    for (const posting of postings) {
      for (const profile of profiles.filter(
        (p) => p.assetId === posting.assetId,
      ))
        if (!profile.stoppedFrom || profile.stoppedFrom > run.month)
          ctx.db
            .update(depreciationProfiles)
            .set({ stoppedFrom: run.month })
            .where(eq(depreciationProfiles.id, profile.id))
            .run();
      recordAudit(ctx.db, {
        userId: actor(ctx),
        recordType: "fixed_asset",
        recordId: posting.assetId,
        action: "update",
        changes: [
          {
            field: "reversedDepreciation",
            before: { runId, recordId: run.recordId },
            after: {
              reversalRecordId: result.value.id,
              date,
              stoppedFrom: run.month,
            },
          },
          { field: "reason", before: null, after: parsed.data.reason },
        ],
        deferredEmits: emits,
      });
    }
    return { recordId: result.value.id };
  });
}
function automationLocals(ctx: AppContext, userId: number): App.Locals {
  const user =
    ctx.db.select().from(users).where(eq(users.id, userId)).get() ?? null;
  return { user, ...resolveAccess(ctx.db, userId) } as App.Locals;
}
/** Startup/timer catch-up; approvals and current grants are checked again for every month. */
export function runAutomaticDepreciation(ctx: Pick<AppContext, "db">) {
  const profiles = ctx.db
    .select()
    .from(depreciationProfiles)
    .where(eq(depreciationProfiles.mode, "auto"))
    .all();
  const months = new Set<string>();
  for (const assetId of new Set(profiles.map((profile) => profile.assetId)))
    for (const row of assetSchedule(ctx.db, assetId).rows)
      if (
        row.profile.mode === "auto" &&
        row.status === "Unposted" &&
        row.amountMinor > 0 &&
        monthEndFor(row.month)! < localToday()
      )
        months.add(row.month);
  const results: { month: string; result: AppResult<unknown> }[] = [];
  for (const month of [...months].sort()) {
    // Grouping by approver keeps each unattended journal within that person's grants.
    for (const userId of new Set(
      profiles.map((profile) => profile.approvedBy),
    )) {
      const context = {
        db: ctx.db,
        locals: automationLocals(ctx as AppContext, userId),
      };
      if (!canAll(context.locals, DEPRECIATION_WRITE)) continue;
      const preview = monthly(context, month, true);
      // Each automatic run must contain only profiles approved by its acting user.
      if (
        !preview.rows.some(
          (row) =>
            row.profile.approvedBy === userId &&
            row.status === "Unposted" &&
            !row.blocked,
        )
      )
        continue;
      results.push({
        month,
        result: postDepreciationMonth(
          context,
          { month, expectedVersion: preview.version },
          true,
        ),
      });
    }
  }
  return results;
}
