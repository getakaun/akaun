import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { AccountType } from "$lib/enums.js";
import { DEFAULT_CURRENCY } from "$lib/currency.js";
import { monthEndFor } from "$lib/closing.js";
import { localToday } from "$lib/local-date.js";
import {
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
  depreciationRuns,
  depreciationPostings,
  ledgerRecords,
  ledgerMovements,
} from "../db/schema.js";
import {
  assetSchedule,
  assetDepreciationBasis,
  depreciationTotal,
} from "../queries/depreciation.js";
import { fixedAssetRegister } from "../queries/fixed-assets.js";
import {
  createRecord as createJournal,
  type DeferredEmits,
} from "../services/ledger.js";
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
  const version = hash({
    asset,
    profiles: schedule.profiles,
    history: schedule.history,
  });
  return { asset, ...schedule, version };
}
export function readAssetDepreciation(ctx: AppContext, id: number) {
  const denied = requirePermissions(ctx, ASSET_READ_PERMISSIONS);
  if (denied) return denied;
  return readTransaction(ctx, () => {
    const state = assetState(ctx, id);
    const asAt = localToday();
    const postedMinor = depreciationTotal(ctx.db, id, asAt);
    return {
      ...state,
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
    !account.archivedAt &&
    !account.mergedIntoAccountId
  );
}
function prepare(ctx: AppContext, id: number, settings: DepreciationSettings) {
  const state = assetState(ctx, id);
  const { asset, profiles, history, rows } = state;
  if (asset.reviewReason)
    refuse("Resolve the asset's review issues before approving depreciation.");
  if (
    settings.startMonth <
    (asset.inServiceDate ?? asset.acquisitionDate).slice(0, 7)
  )
    refuse("Depreciation cannot start before the asset is available for use.");
  assertDatesOpen(ctx.db, [monthEndFor(settings.startMonth)!]);
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
  const ledgerAccumulated = -ctx.db
    .select({
      amount: sql<number>`coalesce(sum(${ledgerMovements.amountMinor}), 0)`,
    })
    .from(ledgerMovements)
    .where(eq(ledgerMovements.accountId, settings.accumulatedAccountId))
    .get()!.amount;
  const knownAccumulated = registered
    .filter(
      (row) =>
        row.accumulatedDepreciationAccountId === settings.accumulatedAccountId,
    )
    .reduce((sum, row) => sum + BigInt(row.accumulatedDepreciationMinor), 0n);
  if (
    !Number.isSafeInteger(ledgerAccumulated) ||
    BigInt(ledgerAccumulated) !== knownAccumulated
  )
    refuse(
      "Reconcile existing manual depreciation on the selected accumulated-depreciation account before approving a schedule. It cannot be allocated automatically.",
    );
  if (
    !accountValid(ctx, settings.expenseAccountId, AccountType.Expense) ||
    !accountValid(ctx, settings.accumulatedAccountId, AccountType.Asset) ||
    settings.accumulatedAccountId === asset.assetAccountId ||
    registered.some(
      (row) => row.assetAccountId === settings.accumulatedAccountId,
    )
  )
    refuse(
      "Choose an active depreciation Expense account and a separate Asset account for accumulated depreciation, unused as registered cost.",
    );
  if (
    asset.accumulatedDepreciationAccountId &&
    asset.accumulatedDepreciationAccountId !== settings.accumulatedAccountId
  )
    refuse(
      "Use the asset's existing accumulated-depreciation account. Correct its mapping separately before approval.",
    );
  if (
    profiles.some(
      (profile) =>
        profile.accumulatedAccountId !== settings.accumulatedAccountId,
    ) &&
    history.length
  )
    refuse(
      "Keep the accumulated-depreciation account used by posted history; transferring historical balances requires a separate reviewed adjustment.",
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
    const settings = parsed.data.settings;
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
function monthly(ctx: AppContext, month: string, automatic = false) {
  const register = fixedAssetRegister(ctx.db, "9999-12-31");
  const boundary = closedThrough(ctx.db);
  const end = monthEndFor(month)!;
  const unpostedMonths = new Set<string>();
  const rows = register.assets.flatMap((asset) => {
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
        (row.profile.mode !== "auto" || row.profile.approvedBy !== actor(ctx)))
    )
      return [];
    const automationWarning =
      row.profile.mode === "auto" &&
      !canAll(automationLocals(ctx, row.profile.approvedBy), DEPRECIATION_WRITE)
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
        !accountValid(ctx, row.profile.expenseAccountId, AccountType.Expense) ||
        !accountValid(ctx, row.profile.accumulatedAccountId, AccountType.Asset)
      )
        blocked = "Review the depreciation account mappings.";
      else if (
        register.depreciationReconciliation.find(
          (account) => account.accountId === row.profile.accumulatedAccountId,
        )?.differenceMinor
      )
        blocked =
          "Reconcile unallocated manual depreciation before posting further charges.";
      else if (
        schedule.rows.some(
          (earlier) =>
            earlier.month < month &&
            earlier.amountMinor > 0 &&
            earlier.status === "Unposted",
        )
      )
        blocked = "Post earlier due months first.";
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
  return write(ctx, (emits) => {
    const preview = monthly(ctx, parsed.data.month, automatic);
    const due = preview.rows.filter(
      (row) => row.status === "Unposted" && row.amountMinor > 0,
    );
    if (!due.length) return { runId: null, recordId: null, posted: 0 };
    if (preview.version !== parsed.data.expectedVersion)
      refuse(
        "The depreciation preview changed. Review the month again before posting.",
      );
    if (!automatic && due.some((row) => row.blocked))
      refuse("Resolve the listed exceptions before posting this month.");
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
        reason:
          "Book depreciation; capital allowances are reviewed separately.",
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
