import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { eq } from "drizzle-orm";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import * as schema from "../db/schema.js";
import type { LedgerDb } from "../ledger/types.js";
import {
  AccountType,
  AccountSubType,
  DefaultAccountPurpose,
  Role,
} from "$lib/enums.js";
import { localToday } from "$lib/local-date.js";
import { straightLineSchedule, shiftMonth } from "$lib/depreciation.js";
import { createAccount } from "../services/accounts.js";
import {
  createRecord,
  updateRecord,
  deleteRecord,
  voidRecord,
} from "./records.js";
import {
  registerFixedAsset,
  readFixedAssets,
  updateFixedAsset,
} from "./fixed-assets.js";
import { assetDetailsSchema } from "$lib/fixed-assets.js";
import { localsFor, grantGroup } from "../permissions/test-locals.js";
import { setSetting, SETTING_KEYS } from "../settings.js";
import { assetSchedule, depreciationTotal } from "../queries/depreciation.js";
import { recordVersion } from "./version.js";
import { getRecord } from "../queries/ledger.js";
import { checkIntegrity } from "../ledger/integrity.js";
import { integrityInputs } from "../queries/ledger.js";
import { previewClosing } from "./closing.js";
import {
  previewDepreciationProfile,
  approveDepreciationProfile,
  previewDepreciationMonth,
  postDepreciationMonth,
  stopDepreciation,
  reverseDepreciationRun,
  readAssetDepreciation,
  runAutomaticDepreciation,
  DEPRECIATION_WRITE,
  previewAssetCatchUp,
  postAssetCatchUp,
  linkManualDepreciation,
  unlinkManualDepreciation,
} from "./depreciation.js";
import {
  accountTotalsByRanges,
  balanceSheetReport,
  cashBalancesAsAt,
  cashFlowReport,
  cashOnHandAsAt,
  partnerStatementReport,
  profitLossReport,
} from "../queries/reports.js";
import {
  cashBridge,
  monthlySeries,
  netMarginPct,
  topLinesWithOther,
} from "../queries/dashboard.js";
import {
  balanceSheetCsv,
  cashFlowCsv,
  profitLossCsv,
} from "../ledger/reports/csv.js";
import { expenseTaxReport } from "../queries/expense-tax-report.js";
import type { AppResult } from "./result.js";

let raw: Database;
let db: LedgerDb;
let bank: number;
let cost: number;
let accum: number;
let expense: number;
const grants = [
  ...DEPRECIATION_WRITE,
  "records.update",
  "records.delete",
  "records.void",
  "accounts.close",
  "accounts.reopen",
  "reports.read",
];
const ctx = () => ({ db, locals: localsFor(grants) });
function value<T>(result: AppResult<T>): T {
  if (!result.ok) throw Error(result.reason);
  return result.value;
}
function account(name: string, type: 1 | 2 | 3 | 4 | 5, subType?: number) {
  const result = createAccount(db, 1, {
    name,
    type,
    subType: subType as never,
  });
  if (!result.ok) throw Error(result.reason);
  return result.value.id;
}
function asset() {
  const record = value(
    createRecord(ctx(), {
      kind: "expense",
      date: "2025-01-01",
      amount: 12000,
      currency: "MYR",
      exchangeRate: 1,
      description: "Laptop",
      categoryAccountId: cost,
      paidFromAccountId: bank,
    }),
  ).record;
  const stored = value(
    registerFixedAsset(ctx(), {
      name: "Laptop",
      assetType: "Computer equipment",
      inServiceDate: "2025-01-01",
      sourceMovementId: record.movements.find((m) => m.accountId === cost)!.id,
    }),
  );
  return { record, stored };
}
const settings = (overrides = {}) => ({
  startMonth: "2025-01",
  months: 36,
  residualMinor: 0,
  expenseAccountId: expense,
  accumulatedAccountId: accum,
  mode: "review" as const,
  reason: "Approved depreciation policy",
  ...overrides,
});
function approve(id: number, overrides = {}) {
  const input = settings(overrides);
  const preview = value(previewDepreciationProfile(ctx(), id, input));
  return value(
    approveDepreciationProfile(ctx(), id, {
      settings: input,
      expectedVersion: preview.version,
    }),
  );
}
function post(month: string) {
  const preview = value(previewDepreciationMonth(ctx(), month));
  return value(
    postDepreciationMonth(ctx(), { month, expectedVersion: preview.version }),
  );
}
beforeEach(() => {
  raw = new Database(":memory:");
  db = drizzle(raw, { schema }) as LedgerDb;
  migrate(db, { migrationsFolder: "drizzle" });
  raw.exec("PRAGMA foreign_keys=ON");
  db.insert(schema.users)
    .values({ id: 1, username: "u", email: "u@test", passwordHash: "x" })
    .run();
  bank = account("Bank", AccountType.Asset, AccountSubType.Bank);
  cost = account(
    "Computer equipment",
    AccountType.Asset,
    AccountSubType.FixedAsset,
  );
  accum = account(
    "Accumulated depreciation",
    AccountType.Asset,
    AccountSubType.OtherNonCurrentAsset,
  );
  expense = account("Depreciation expense", AccountType.Expense);
  const receivable = account(
    "Receivable",
    AccountType.Asset,
    AccountSubType.Receivable,
  );
  const payable = account(
    "Payable",
    AccountType.Liability,
    AccountSubType.AccountsPayable,
  );
  const equity = account("Opening equity", AccountType.Equity);
  db.insert(schema.accountDefaults)
    .values([
      { purpose: DefaultAccountPurpose.Receivable, accountId: receivable },
      { purpose: DefaultAccountPurpose.Payable, accountId: payable },
      { purpose: DefaultAccountPurpose.OpeningBalances, accountId: equity },
    ])
    .run();
  setSetting(db, SETTING_KEYS.currencyCode, "MYR");
});
afterEach(() => raw.close());

describe("approved monthly book depreciation", () => {
  it("handles final cents, tiny balances and safe-integer bases without depreciating below residual", () => {
    const rows = straightLineSchedule(1200000, 0, "2025-01", 36);
    expect(rows[0].amountMinor).toBe(33333);
    expect(rows.at(-1)?.amountMinor).toBe(33345);
    for (const [base, residual, months] of [
      [16, 0, 10],
      [1, 0, 36],
      [Number.MAX_SAFE_INTEGER, 12345, 1200],
      [100, 100, 3],
    ]) {
      const schedule = straightLineSchedule(base, residual, "2025-01", months);
      expect(
        schedule.reduce((sum, row) => sum + BigInt(row.amountMinor), 0n),
      ).toBe(BigInt(base) - BigInt(residual));
      expect(
        schedule.every(
          (row) =>
            row.amountMinor >= 0 && Number.isSafeInteger(row.amountMinor),
        ),
      ).toBe(true);
      expect(schedule.at(-1)?.projectedNbvMinor).toBe(residual);
    }
  });
  it("previews without financial writes, approves explicitly, posts a balanced journal with tax classification, and retries safely", () => {
    const { stored } = asset();
    const recordsBefore = db.select().from(schema.ledgerRecords).all();
    const preview = value(
      previewDepreciationProfile(ctx(), stored.id, settings()),
    );
    expect(preview.schedule).toHaveLength(36);
    expect(db.select().from(schema.ledgerRecords).all()).toEqual(recordsBefore);
    approve(stored.id);
    expect(db.select().from(schema.ledgerRecords).all()).toEqual(recordsBefore);
    const month = value(previewDepreciationMonth(ctx(), "2025-01"));
    const run = value(
      postDepreciationMonth(ctx(), {
        month: "2025-01",
        expectedVersion: month.version,
      }),
    );
    const journal = getRecord(db, run.recordId!)!;
    expect(journal.movements.reduce((sum, m) => sum + m.amountMinor, 0)).toBe(
      0,
    );
    expect(
      journal.movements.find((m) => m.accountId === expense)?.amountMinor,
    ).toBe(33333);
    expect(
      journal.movements.find((m) => m.accountId === accum)?.amountMinor,
    ).toBe(-33333);
    expect(
      journal.movements.find((m) => m.accountId === expense)?.taxClassification,
    ).toMatchObject({ percentageBps: 0, treatment: "non_deductible" });
    expect(
      value(
        postDepreciationMonth(ctx(), {
          month: "2025-01",
          expectedVersion: month.version,
        }),
      ).posted,
    ).toBe(0);
    expect(db.select().from(schema.depreciationPostings).all()).toHaveLength(1);
    expect(depreciationTotal(db, stored.id, "2025-01-30")).toBe(0);
    expect(depreciationTotal(db, stored.id, "2025-01-31")).toBe(33333);
    expect(checkIntegrity(integrityInputs(db)).ok).toBe(true);
    expect(
      value(readFixedAssets(ctx(), "2025-01-31")).depreciationReconciliation[0]
        .differenceMinor,
    ).toBe(0);
  });
  it("rejects stale previews, future months, closed periods, skipped months and unreviewed source changes", () => {
    const { stored, record } = asset();
    approve(stored.id);
    expect(
      postDepreciationMonth(ctx(), {
        month: "2025-02",
        expectedVersion: value(previewDepreciationMonth(ctx(), "2025-02"))
          .version,
      }).ok,
    ).toBe(false);
    const jan = value(previewDepreciationMonth(ctx(), "2025-01"));
    value(updateRecord(ctx(), record.id, { amount: 13000 }));
    expect(
      postDepreciationMonth(ctx(), {
        month: "2025-01",
        expectedVersion: jan.version,
      }).ok,
    ).toBe(false);
    expect(
      value(previewDepreciationMonth(ctx(), "2025-01")).rows[0].blocked,
    ).toContain("Source");
    setSetting(db, SETTING_KEYS.accountingClosedThrough, "2025-01-31");
    expect(
      postDepreciationMonth(ctx(), {
        month: "2025-01",
        expectedVersion: value(previewDepreciationMonth(ctx(), "2025-01"))
          .version,
      }).ok,
    ).toBe(false);
    expect(value(previewDepreciationMonth(ctx(), "9999-01")).rows).toHaveLength(
      0,
    );
    expect(db.select().from(schema.depreciationPostings).all()).toEqual([]);
  });
  it("uses effective future versions and remaining NBV without rewriting posted amounts", () => {
    const { stored } = asset();
    approve(stored.id);
    post("2025-01");
    const movements = db.select().from(schema.ledgerMovements).all();
    approve(stored.id, {
      startMonth: "2025-02",
      months: 12,
      residualMinor: 10000,
      reason: "Revised remaining life",
    });
    expect(
      assetSchedule(db, stored.id).rows.find((row) => row.month === "2025-01")
        ?.amountMinor,
    ).toBe(33333);
    expect(
      assetSchedule(db, stored.id).rows.find((row) => row.month === "2025-02")
        ?.amountMinor,
    ).toBe(96388);
    expect(db.select().from(schema.ledgerMovements).all()).toEqual(movements);
    expect(
      previewDepreciationProfile(
        ctx(),
        stored.id,
        settings({ startMonth: "2025-01" }),
      ).ok,
    ).toBe(false);
    post("2025-02");
    expect(depreciationTotal(db, stored.id, "2025-02-28")).toBe(129721);
  });
  it("allows revising an approved but wholly unposted profile at the same start month", () => {
    const { stored } = asset();
    approve(stored.id);
    approve(stored.id, { months: 12 });
    expect(assetSchedule(db, stored.id).profiles).toHaveLength(2);
    expect(assetSchedule(db, stored.id).rows).toHaveLength(12);
    post("2025-01");
    expect(depreciationTotal(db, stored.id, "2025-01-31")).toBe(100000);
  });
  it("keeps generated records immutable through ordinary record APIs and stops future charges explicitly", () => {
    const { stored } = asset();
    approve(stored.id);
    const run = post("2025-01");
    expect(
      updateRecord(ctx(), run.recordId!, { description: "Overwrite" }).ok,
    ).toBe(false);
    expect(deleteRecord(ctx(), run.recordId!).ok).toBe(false);
    expect(
      voidRecord(ctx(), run.recordId!, {
        reason: "Use normal void route",
        expectedVersion: recordVersion(db, run.recordId!),
      }).ok,
    ).toBe(false);
    expect(getRecord(db, run.recordId!)?.locked).toBe(true);
    const state = value(readAssetDepreciation(ctx(), stored.id));
    value(
      stopDepreciation(ctx(), stored.id, {
        month: "2025-02",
        reason: "Stop pending disposal review",
        expectedVersion: state.version,
      }),
    );
    expect(assetSchedule(db, stored.id).rows).toHaveLength(1);
    expect(depreciationTotal(db, stored.id, "2025-12-31")).toBe(33333);
  });
  it("reverses into an open month while preserving closed history, keeps a retry tombstone and requires explicit resumption", () => {
    const { stored } = asset();
    approve(stored.id);
    const run = post("2025-01");
    const original = db.select().from(schema.ledgerRecords).all();
    setSetting(db, SETTING_KEYS.accountingClosedThrough, "2025-01-31");
    expect(
      reverseDepreciationRun(ctx(), run.runId!, {
        month: "2025-01",
        reason: "Correct erroneous depreciation",
      }).ok,
    ).toBe(false);
    const reversal = value(
      reverseDepreciationRun(ctx(), run.runId!, {
        month: "2025-02",
        reason: "Correct erroneous depreciation",
      }),
    );
    expect(
      db.select().from(schema.ledgerRecords).all().slice(0, original.length),
    ).toEqual(original);
    expect(depreciationTotal(db, stored.id, "2025-01-31")).toBe(33333);
    expect(depreciationTotal(db, stored.id, "2025-02-28")).toBe(0);
    expect(
      value(readFixedAssets(ctx(), "2025-02-28")).depreciationReconciliation[0]
        .differenceMinor,
    ).toBe(0);
    expect(
      reverseDepreciationRun(ctx(), run.runId!, {
        month: "2025-02",
        reason: "Repeat the same correction",
      }).ok,
    ).toBe(false);
    expect(
      assetSchedule(db, stored.id).rows.every((row) => row.month < "2025-02"),
    ).toBe(true);
    expect(updateRecord(ctx(), reversal.recordId, { amount: 1 }).ok).toBe(
      false,
    );
    expect(checkIntegrity(integrityInputs(db)).ok).toBe(true);
  });
  it("rolls back a whole batch if any audit write fails", () => {
    const { stored } = asset();
    approve(stored.id);
    const before = db.select().from(schema.ledgerRecords).all();
    raw.exec(
      "CREATE TRIGGER fail_dep_audit BEFORE INSERT ON audit_log WHEN NEW.record_type='fixed_asset' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END",
    );
    expect(() => post("2025-01")).toThrow("audit unavailable");
    expect(db.select().from(schema.ledgerRecords).all()).toEqual(before);
    expect(db.select().from(schema.depreciationPostings).all()).toEqual([]);
    expect(db.select().from(schema.depreciationRuns).all()).toEqual([]);
  });
  it("honours permission ceilings and does not enable unattended posting from delegated credentials", () => {
    const { stored } = asset();
    const narrow = {
      db,
      locals: localsFor(grants, {
        credential: ["accounts.read", "accounts.update", "records.read"],
      }),
    };
    expect(previewDepreciationProfile(narrow, stored.id, settings()).ok).toBe(
      false,
    );
    const delegated = {
      db,
      locals: {
        ...localsFor(grants),
        credential: { kind: "pat" as const, tokenId: 1 },
      },
    };
    expect(
      previewDepreciationProfile(
        delegated,
        stored.id,
        settings({ mode: "auto" }),
      ).ok,
    ).toBe(false);
    expect(db.select().from(schema.depreciationProfiles).all()).toEqual([]);
  });
  it("catches up unattended only under current approval grants, without duplicates on restart", () => {
    const { stored } = asset();
    grantGroup(db, {
      name: "Depreciation approver",
      userIds: [1],
      grants: [...grants],
    });
    const profile = approve(stored.id, { mode: "auto", months: 2 });
    runAutomaticDepreciation({ db });
    expect(db.select().from(schema.depreciationPostings).all()).toHaveLength(0);
    // Simulate a profile approved before these months began: only that future
    // authority, not today's setup approval, allows an unattended catch-up.
    db.update(schema.depreciationApprovals)
      .set({ futureFromMonth: "2025-01" })
      .where(eq(schema.depreciationApprovals.profileId, profile.id))
      .run();
    runAutomaticDepreciation({ db });
    expect(db.select().from(schema.depreciationPostings).all()).toHaveLength(2);
    expect(depreciationTotal(db, stored.id, "2025-02-28")).toBe(1200000);
    runAutomaticDepreciation({ db });
    expect(db.select().from(schema.depreciationRuns).all()).toHaveLength(2);
  });
  it("leaves missed automatic months visible when grants are revoked or the month closes", () => {
    const { stored } = asset();
    const group = grantGroup(db, {
      name: "Approver",
      userIds: [1],
      grants: [...grants],
    });
    const profile = approve(stored.id, { mode: "auto", months: 2 });
    db.update(schema.depreciationApprovals)
      .set({ futureFromMonth: "2025-01" })
      .where(eq(schema.depreciationApprovals.profileId, profile.id))
      .run();
    db.delete(schema.userGroups).where(eq(schema.userGroups.userId, 1)).run();
    runAutomaticDepreciation({ db });
    expect(db.select().from(schema.depreciationPostings).all()).toEqual([]);
    db.insert(schema.userGroups).values({ userId: 1, groupId: group }).run();
    setSetting(db, SETTING_KEYS.accountingClosedThrough, "2025-01-31");
    runAutomaticDepreciation({ db });
    expect(db.select().from(schema.depreciationPostings).all()).toEqual([]);
    expect(value(previewDepreciationMonth(ctx(), "2025-01")).dueCount).toBe(1);
  });
  it("groups multiple assets into one journal and refuses partial manual batches with exceptions", () => {
    const first = asset();
    const second = asset();
    approve(first.stored.id);
    approve(second.stored.id);
    const run = post("2025-01");
    expect(run.posted).toBe(2);
    expect(db.select().from(schema.depreciationRuns).all()).toHaveLength(1);
    const record = getRecord(db, run.recordId!)!;
    expect(
      record.movements
        .filter((m) => m.accountId === expense)
        .every((m) => m.taxClassification?.percentageBps === 0),
    ).toBe(true);
    const closing = value(previewClosing(ctx(), { monthEnd: "2025-01-31" }));
    expect(closing.taxReview.ok).toBe(true);
    value(updateRecord(ctx(), second.record.id, { amount: 14000 }));
    const preview = value(previewDepreciationMonth(ctx(), "2025-02"));
    expect(
      postDepreciationMonth(ctx(), {
        month: "2025-02",
        expectedVersion: preview.version,
      }).ok,
    ).toBe(false);
    expect(db.select().from(schema.depreciationPostings).all()).toHaveLength(2);
  });
  it("enforces the posting key in SQL and does not let metadata updates bypass prospective estimate approval", () => {
    const { stored } = asset();
    const profile = approve(stored.id);
    const run = post("2025-01");
    expect(() =>
      db
        .insert(schema.depreciationPostings)
        .values({
          assetId: stored.id,
          month: "2025-01",
          runId: run.runId!,
          profileId: profile.id,
          amountMinor: 33333,
        })
        .run(),
    ).toThrow();
    const current = value(readFixedAssets(ctx(), "9999-12-31")).assets[0];
    expect(
      updateFixedAsset(ctx(), stored.id, {
        ...assetDetailsSchema.parse(current),
        usefulLifeMonths: 12,
        expectedVersion: current.version,
        reason: "Bypass schedule approval",
      }).ok,
    ).toBe(false);
    expect(
      updateFixedAsset(ctx(), stored.id, {
        ...assetDetailsSchema.parse(current),
        accumulatedDepreciationAccountId: null,
        expectedVersion: current.version,
        reason: "Drop posted account mapping",
      }).ok,
    ).toBe(false);
    const futureAsset = asset();
    const futureMonth = shiftMonth(localToday().slice(0, 7), 1);
    approve(futureAsset.stored.id, { startMonth: futureMonth, months: 1 });
    const future = value(previewDepreciationMonth(ctx(), futureMonth));
    expect(
      future.rows.find((row) => row.assetId === futureAsset.stored.id)?.blocked,
    ).toContain("completed");
    expect(
      postDepreciationMonth(ctx(), {
        month: futureMonth,
        expectedVersion: future.version,
      }).ok,
    ).toBe(false);
  });
  it("keeps same-month reversal history visible and never automatically restarts gaps after a later correction", () => {
    const { stored } = asset();
    grantGroup(db, { name: "Approver", userIds: [1], grants: [...grants] });
    approve(stored.id, { mode: "auto" });
    const run = post("2025-01");
    value(
      reverseDepreciationRun(ctx(), run.runId!, {
        month: "2025-06",
        reason: "Correct erroneous original schedule",
      }),
    );
    runAutomaticDepreciation({ db });
    expect(db.select().from(schema.depreciationPostings).all()).toHaveLength(1);
    expect(assetSchedule(db, stored.id).rows[0].status).toBe("Reversed");
    expect(
      previewDepreciationProfile(
        ctx(),
        stored.id,
        settings({ startMonth: "2025-02" }),
      ).ok,
    ).toBe(false);
    approve(stored.id, { startMonth: "2025-07", months: 12 });
    expect(
      assetSchedule(db, stored.id).rows.find((row) => row.month === "2025-07")
        ?.amountMinor,
    ).toBe(100000);
  });
  it("preserves the original schedule row when a run is reversed in its own open month", () => {
    const { stored } = asset();
    approve(stored.id);
    const run = post("2025-01");
    value(
      reverseDepreciationRun(ctx(), run.runId!, {
        month: "2025-01",
        reason: "Correct this month immediately",
      }),
    );
    const rows = assetSchedule(db, stored.id).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("Reversed");
    expect(
      value(previewDepreciationMonth(ctx(), "2025-01")).rows[0].status,
    ).toBe("Reversed");
    expect(depreciationTotal(db, stored.id, "2025-01-31")).toBe(0);
  });
  it("requires reconciled month-end legacy openings and depreciates only the remaining balance", () => {
    const legacy = value(
      registerFixedAsset(ctx(), {
        name: "Existing machine",
        assetType: "Machinery",
        inServiceDate: "2023-01-01",
        sourceMovementId: null,
        acquisitionDate: "2023-01-01",
        assetAccountId: cost,
        costMinor: 1200000,
        openingAsAt: "2024-12-31",
        broughtForwardDepMinor: 400000,
        accumulatedDepreciationAccountId: accum,
        documentReference: "Accountant opening schedule",
      }),
    );
    expect(
      previewDepreciationProfile(ctx(), legacy.id, settings({ months: 24 })).ok,
    ).toBe(false);
    const equity = db
      .select()
      .from(schema.accounts)
      .all()
      .find((a) => a.type === AccountType.Equity)!;
    value(
      createRecord(ctx(), {
        kind: "journal",
        date: "2024-12-31",
        description: "Existing opening balances",
        amount: 12000,
        currency: "MYR",
        exchangeRate: 1,
        movements: [
          { accountId: cost, amountMinor: 1200000 },
          { accountId: accum, amountMinor: -400000 },
          { accountId: equity.id, amountMinor: -800000 },
        ],
      }),
    );
    expect(
      profitLossReport(db, "2024-01-01", "2024-12-31").totalExpensesMinor,
    ).toBe(0);
    expect(balanceSheetReport(db, "2024-12-31").owned.totalMinor).toBe(800000);
    expect(cashFlowReport(db, "2024-01-01", "2024-12-31").netChangeMinor).toBe(
      0,
    );
    const profile = approve(legacy.id, { months: 24 });
    expect(profile.baseNbvMinor).toBe(800000);
    post("2025-01");
    const assetView = value(readFixedAssets(ctx(), "2025-01-31")).assets[0];
    expect(assetView.accumulatedDepreciationMinor).toBe(433333);
    expect(assetView.netBookValueMinor).toBe(766667);
    expect(
      profitLossReport(db, "2025-01-01", "2025-01-31").totalExpensesMinor,
    ).toBe(33333);
    expect(balanceSheetReport(db, "2025-01-31").owned.totalMinor).toBe(766667);
    expect(
      value(readFixedAssets(ctx(), "2025-01-31")).depreciationReconciliation[0]
        .differenceMinor,
    ).toBe(0);
  });
  it("attributes unattended runs to each approver without mixing their profile approvals", () => {
    const first = asset();
    const second = asset();
    db.insert(schema.users)
      .values({
        id: 2,
        username: "second",
        email: "second@test",
        passwordHash: "x",
      })
      .run();
    grantGroup(db, { name: "Approvers", userIds: [1, 2], grants: [...grants] });
    approve(first.stored.id, { mode: "auto", months: 1 });
    const other = { db, locals: localsFor(grants, { userId: 2 }) };
    const input = settings({ mode: "auto", months: 1 });
    const preview = value(
      previewDepreciationProfile(other, second.stored.id, input),
    );
    value(
      approveDepreciationProfile(other, second.stored.id, {
        settings: input,
        expectedVersion: preview.version,
      }),
    );
    db.update(schema.depreciationApprovals)
      .set({ futureFromMonth: "2025-01" })
      .run();
    runAutomaticDepreciation({ db });
    const runs = db.select().from(schema.depreciationRuns).all();
    expect(runs.map((run) => run.createdBy).sort()).toEqual([1, 2]);
    expect(db.select().from(schema.depreciationPostings).all()).toHaveLength(2);
  });
  it("requires renewed approval if an unused accumulated-depreciation mapping is changed", () => {
    const { stored } = asset();
    approve(stored.id);
    const current = value(readFixedAssets(ctx(), "9999-12-31")).assets[0];
    value(
      updateFixedAsset(ctx(), stored.id, {
        ...assetDetailsSchema.parse(current),
        accumulatedDepreciationAccountId: null,
        expectedVersion: current.version,
        reason: "Review the unused contra mapping",
      }),
    );
    const preview = value(previewDepreciationMonth(ctx(), "2025-01"));
    expect(preview.rows[0].blocked).toContain("mappings");
    expect(
      postDepreciationMonth(ctx(), {
        month: "2025-01",
        expectedVersion: preview.version,
      }).ok,
    ).toBe(false);
    approve(stored.id);
    expect(post("2025-01").posted).toBe(1);
  });
  it("warns at month close about approved but unposted depreciation", () => {
    const { stored } = asset();
    approve(stored.id);
    const preview = value(previewClosing(ctx(), { monthEnd: "2025-01-31" }));
    expect(
      preview.warnings.some((warning) => warning.id === "depreciation-due"),
    ).toBe(true);
  });
  it("pauses schedules around unallocated manual depreciation instead of charging twice", () => {
    const { stored } = asset();
    const manual = value(
      createRecord(ctx(), {
        kind: "journal",
        date: "2025-01-31",
        description: "Manual depreciation",
        amount: 100,
        currency: "MYR",
        exchangeRate: 1,
        movements: [
          { accountId: expense, amountMinor: 10000 },
          { accountId: accum, amountMinor: -10000 },
        ],
      }),
    ).record;
    expect(previewDepreciationProfile(ctx(), stored.id, settings()).ok).toBe(
      false,
    );
    const managed = previewDepreciationProfile(
      { db, locals: localsFor([...grants, "accounts.create"]) },
      stored.id,
      settings({ accumulatedAccountId: null }),
    );
    expect(managed.ok).toBe(false);
    if (!managed.ok) expect(managed.code).toBe("INVALID_INPUT");
    value(
      voidRecord(ctx(), manual.id, {
        reason: "Replace manual depreciation with approved schedule",
        expectedVersion: recordVersion(db, manual.id),
      }),
    );
    approve(stored.id);
    post("2025-01");
    value(
      createRecord(ctx(), {
        kind: "journal",
        date: "2025-02-28",
        description: "Another manual adjustment",
        amount: 100,
        currency: "MYR",
        exchangeRate: 1,
        movements: [
          { accountId: expense, amountMinor: 10000 },
          { accountId: accum, amountMinor: -10000 },
        ],
      }),
    );
    const preview = value(previewDepreciationMonth(ctx(), "2025-02"));
    expect(preview.rows[0].blocked).toContain("manual depreciation");
    expect(
      postDepreciationMonth(ctx(), {
        month: "2025-02",
        expectedVersion: preview.version,
      }).ok,
    ).toBe(false);
  });
  it("requires explicit existing posting accounts even with account creation permission", () => {
    const first = asset();
    const creator = { db, locals: localsFor([...grants, "accounts.create"]) };
    const count = db.select().from(schema.accounts).all().length;
    for (const overrides of [
      { accumulatedAccountId: null },
      { accumulatedAccountId: undefined },
      { accumulatedAccountId: 0 },
      { accumulatedAccountId: 999999 },
      { expenseAccountId: null },
      { expenseAccountId: 999999 },
    ]) {
      const input = settings(overrides);
      expect(
        previewDepreciationProfile(creator, first.stored.id, input).ok,
      ).toBe(false);
      expect(
        approveDepreciationProfile(creator, first.stored.id, {
          settings: input,
          expectedVersion: "old-preview",
        }).ok,
      ).toBe(false);
    }
    expect(db.select().from(schema.accounts).all()).toHaveLength(count);
    expect(db.select().from(schema.depreciationProfiles).all()).toHaveLength(0);
    // Setup works without accounts.create when both accounts are selected.
    const preview = value(
      previewDepreciationProfile(ctx(), first.stored.id, settings()),
    );
    const profile = value(
      approveDepreciationProfile(ctx(), first.stored.id, {
        settings: settings(),
        expectedVersion: preview.version,
      }),
    );
    expect(profile.accumulatedAccountId).toBe(accum);
    expect(db.select().from(schema.accounts).all()).toHaveLength(count);
    const second = asset();
    const state = value(readAssetDepreciation(ctx(), second.stored.id));
    expect(state.defaults).toEqual({
      expenseAccountId: expense,
      accumulatedAccountId: accum,
    });
    // Defaults help the UI preselect accounts; requests must still include a selection.
    expect(
      previewDepreciationProfile(
        creator,
        second.stored.id,
        settings({ accumulatedAccountId: null }),
      ).ok,
    ).toBe(false);
    approve(second.stored.id);
    expect(db.select().from(schema.accounts).all()).toHaveLength(count);
  });
  it("posts historical catch-up only after explicit consent, only for the selected asset, and never a future month", () => {
    const first = asset();
    const second = asset();
    approve(second.stored.id, { months: 2 });
    const input = settings({ months: 2, mode: "auto" });
    const preview = value(
      previewDepreciationProfile(ctx(), first.stored.id, input),
    );
    expect(preview.history).toMatchObject({
      count: 2,
      from: "2025-01",
      through: "2025-02",
      totalMinor: 1200000,
      closedMonths: [],
    });
    value(
      approveDepreciationProfile(ctx(), first.stored.id, {
        settings: input,
        expectedVersion: preview.version,
        postHistory: true,
      }),
    );
    const posted = db.select().from(schema.depreciationPostings).all();
    expect(posted).toHaveLength(2);
    expect(posted.every((p) => p.assetId === first.stored.id)).toBe(true);
    expect(
      value(readAssetDepreciation(ctx(), second.stored.id)).historyReview,
    ).toHaveLength(2);
    const later = value(previewAssetCatchUp(ctx(), second.stored.id));
    expect(
      value(
        postAssetCatchUp(ctx(), second.stored.id, {
          expectedVersion: later.version,
        }),
      ).posted,
    ).toBe(2);
    expect(
      postAssetCatchUp(ctx(), second.stored.id, {
        expectedVersion: later.version,
      }).ok,
    ).toBe(false);
    expect(db.select().from(schema.depreciationPostings).all()).toHaveLength(4);
    const future = asset();
    approve(future.stored.id, {
      startMonth: shiftMonth(localToday().slice(0, 7), 1),
      months: 1,
    });
    expect(
      value(previewAssetCatchUp(ctx(), future.stored.id)).history.count,
    ).toBe(0);
  });
  it("saves a historical setup across closed months but refuses the whole catch-up without changing accounts", () => {
    const { stored } = asset();
    setSetting(db, SETTING_KEYS.accountingClosedThrough, "2025-01-31");
    const creator = { db, locals: localsFor([...grants, "accounts.create"]) };
    const input = settings({ months: 2 });
    const count = db.select().from(schema.accounts).all().length;
    const preview = value(
      previewDepreciationProfile(creator, stored.id, input),
    );
    expect(preview.history.closedMonths).toEqual(["2025-01"]);
    expect(
      approveDepreciationProfile(creator, stored.id, {
        settings: input,
        expectedVersion: preview.version,
        postHistory: true,
      }).ok,
    ).toBe(false);
    expect(db.select().from(schema.accounts).all()).toHaveLength(count);
    expect(db.select().from(schema.depreciationProfiles).all()).toHaveLength(0);
    value(
      approveDepreciationProfile(creator, stored.id, {
        settings: input,
        expectedVersion: preview.version,
      }),
    );
    const review = value(previewAssetCatchUp(ctx(), stored.id));
    expect(
      postAssetCatchUp(ctx(), stored.id, { expectedVersion: review.version })
        .ok,
    ).toBe(false);
    expect(db.select().from(schema.depreciationRuns).all()).toHaveLength(0);
    setSetting(db, SETTING_KEYS.accountingClosedThrough, "");
    expect(
      value(
        postAssetCatchUp(ctx(), stored.id, {
          expectedVersion: value(previewAssetCatchUp(ctx(), stored.id)).version,
        }),
      ).posted,
    ).toBe(2);
  });
  it("rolls back every historical month if a later catch-up journal fails", () => {
    const { stored } = asset();
    approve(stored.id, { months: 2 });
    raw.exec(
      "CREATE TRIGGER refuse_feb BEFORE INSERT ON depreciation_runs WHEN NEW.month = '2025-02' BEGIN SELECT RAISE(ABORT, 'simulated later failure'); END",
    );
    const before = db.select().from(schema.ledgerRecords).all().length;
    const review = value(previewAssetCatchUp(ctx(), stored.id));
    expect(() =>
      postAssetCatchUp(ctx(), stored.id, { expectedVersion: review.version }),
    ).toThrow();
    expect(db.select().from(schema.depreciationPostings).all()).toHaveLength(0);
    expect(db.select().from(schema.depreciationRuns).all()).toHaveLength(0);
    expect(db.select().from(schema.ledgerRecords).all()).toHaveLength(before);
  });
  it("links existing manual journals without ledger writes, reconciles split assets and prevents reuse or overlapping periods", () => {
    const first = asset();
    const second = asset();
    const manual = value(
      createRecord(ctx(), {
        kind: "journal",
        date: "2025-02-28",
        description: "Two assets manual depreciation",
        amount: 200,
        currency: "MYR",
        exchangeRate: 1,
        movements: [
          { accountId: expense, amountMinor: 20000 },
          { accountId: accum, amountMinor: -20000 },
        ],
      }),
    ).record;
    const before = db.select().from(schema.ledgerRecords).all().length;
    function link(id: number, amountMinor: number) {
      const state = value(readAssetDepreciation(ctx(), id));
      return linkManualDepreciation(ctx(), id, {
        candidateKey: state.manualCandidates.find(
          (c) => c.recordId === manual.id,
        )!.key,
        amountMinor,
        fromMonth: "2025-01",
        throughMonth: "2025-02",
        reason: "Allocate existing journal to this asset",
        expectedVersion: state.version,
      });
    }
    const allocation = value(link(first.stored.id, 10000));
    expect(depreciationTotal(db, first.stored.id, "2025-02-27")).toBe(0);
    expect(depreciationTotal(db, first.stored.id, "2025-02-28")).toBe(10000);
    expect(link(first.stored.id, 10000).ok).toBe(false);
    expect(link(second.stored.id, 10001).ok).toBe(false);
    value(link(second.stored.id, 10000));
    expect(
      value(readAssetDepreciation(ctx(), first.stored.id)).reconciliation
        ?.differenceMinor,
    ).toBe(0);
    expect(
      value(readAssetDepreciation(ctx(), second.stored.id)).manualCandidates,
    ).toHaveLength(0);
    expect(db.select().from(schema.ledgerRecords).all()).toHaveLength(before);
    expect(updateRecord(ctx(), manual.id, { amount: 300 }).ok).toBe(false);
    expect(
      voidRecord(ctx(), manual.id, {
        reason: "Should not void allocated history",
        expectedVersion: recordVersion(db, manual.id),
      }).ok,
    ).toBe(false);
    expect(deleteRecord(ctx(), manual.id).ok).toBe(false);
    expect(
      previewDepreciationProfile(ctx(), first.stored.id, settings()).ok,
    ).toBe(false);
    const input = settings({ startMonth: "2025-03" });
    expect(
      value(previewDepreciationProfile(ctx(), first.stored.id, input))
        .baseNbvMinor,
    ).toBe(1190000);
    approve(first.stored.id, { startMonth: "2025-03" });
    post("2025-03");
    expect(
      unlinkManualDepreciation(ctx(), first.stored.id, {
        allocationId: allocation.id,
        expectedVersion: value(readAssetDepreciation(ctx(), first.stored.id))
          .version,
      }).ok,
    ).toBe(false);
  });
  it("can remove a mistaken manual link before posting, stopping dependent forecasts while keeping the original journal", () => {
    const { stored } = asset();
    const manual = value(
      createRecord(ctx(), {
        kind: "journal",
        date: "2025-01-31",
        description: "Manual",
        amount: 100,
        currency: "MYR",
        exchangeRate: 1,
        movements: [
          { accountId: expense, amountMinor: 10000 },
          { accountId: accum, amountMinor: -10000 },
        ],
      }),
    ).record;
    let state = value(readAssetDepreciation(ctx(), stored.id));
    const allocation = value(
      linkManualDepreciation(ctx(), stored.id, {
        candidateKey: state.manualCandidates[0].key,
        amountMinor: 10000,
        fromMonth: "2025-01",
        throughMonth: "2025-01",
        reason: "Existing January charge",
        expectedVersion: state.version,
      }),
    );
    approve(stored.id, { startMonth: "2025-02" });
    state = value(readAssetDepreciation(ctx(), stored.id));
    value(
      unlinkManualDepreciation(ctx(), stored.id, {
        allocationId: allocation.id,
        expectedVersion: state.version,
      }),
    );
    expect(assetSchedule(db, stored.id).rows).toHaveLength(0);
    expect(depreciationTotal(db, stored.id, "2025-12-31")).toBe(0);
    expect(getRecord(db, manual.id)).not.toBeNull();
    expect(
      updateRecord(ctx(), manual.id, {
        description: "Corrected journal description",
      }).ok,
    ).toBe(true);
  });
  it("keeps posted depreciation consistent across reports, dashboard figures, cash and CSV", () => {
    const equity = account("Capital", AccountType.Equity);
    const revenue = account("Sales", AccountType.Revenue);
    const partners = db
      .insert(schema.contacts)
      .values([
        { entityType: 1, legalName: "Partner A" },
        { entityType: 1, legalName: "Partner B" },
      ])
      .returning()
      .all();
    db.insert(schema.contactRoles)
      .values(partners.map((p) => ({ contactId: p.id, role: Role.Partner })))
      .run();
    value(
      createRecord(ctx(), {
        kind: "journal",
        date: "2024-12-31",
        description: "Initial capital",
        amount: 20000,
        currency: "MYR",
        exchangeRate: 1,
        movements: [
          { accountId: bank, amountMinor: 2000000 },
          { accountId: equity, amountMinor: -2000000 },
        ],
      }),
    );
    const { stored } = asset();
    value(
      createRecord(ctx(), {
        kind: "journal",
        date: "2025-01-15",
        description: "Cash sales",
        amount: 2000,
        currency: "MYR",
        exchangeRate: 1,
        movements: [
          { accountId: bank, amountMinor: 200000 },
          { accountId: revenue, amountMinor: -200000 },
        ],
      }),
    );
    const before = {
      pl: profitLossReport(db, "2025-01-01", "2025-01-31"),
      bs: balanceSheetReport(db, "2025-01-31"),
      cf: cashFlowReport(db, "2025-01-01", "2025-01-31"),
    };
    approve(stored.id);
    expect({
      pl: profitLossReport(db, "2025-01-01", "2025-01-31"),
      bs: balanceSheetReport(db, "2025-01-31"),
      cf: cashFlowReport(db, "2025-01-01", "2025-01-31"),
    }).toEqual(before);
    post("2025-01");
    const pl = profitLossReport(db, "2025-01-01", "2025-01-31");
    const bs = balanceSheetReport(db, "2025-01-31");
    const cf = cashFlowReport(db, "2025-01-01", "2025-01-31");
    expect(pl).toMatchObject({
      totalIncomeMinor: 200000,
      totalExpensesMinor: 33333,
      resultMinor: 166667,
    });
    expect(pl.expenses).toContainEqual({
      accountId: expense,
      accountName: "Depreciation expense",
      amountMinor: 33333,
    });
    expect(bs.owned.lines).toContainEqual({
      accountId: cost,
      accountName: "Computer equipment",
      amountMinor: 1200000,
    });
    expect(bs.owned.lines).toContainEqual({
      accountId: accum,
      accountName: "Accumulated depreciation",
      amountMinor: -33333,
    });
    expect(bs.owned.totalMinor).toBe(2166667);
    expect(bs.accumulatedResultMinor).toBe(166667);
    expect(bs.ownersStake.totalMinor).toBe(2166667);
    expect(bs).toMatchObject({ balances: true, differenceMinor: 0 });
    expect(
      bs.owned.subsections?.find((s) => s.label === "Non-current")?.totalMinor,
    ).toBe(1166667);
    expect(cf).toEqual(before.cf);
    expect(cf).toMatchObject({
      openingCashMinor: 2000000,
      closingCashMinor: 1000000,
      netChangeMinor: -1000000,
      ties: true,
      differenceMinor: 0,
    });
    expect(cf.operating.totalMinor).toBe(200000);
    expect(cf.investing.totalMinor).toBe(-1200000);
    expect(cashBridge(pl, cf)).toMatchObject({
      netProfitMinor: 166667,
      operatingMinor: 200000,
      investingMinor: -1200000,
      freeCashFlowMinor: -1000000,
      netChangeMinor: -1000000,
    });
    expect(cf.operating.totalMinor - pl.resultMinor).toBe(33333);
    expect(netMarginPct(pl)).toBe(166667 / 200000);
    expect(topLinesWithOther(pl.expenses, [], 6)).toContainEqual({
      accountId: expense,
      name: "Depreciation expense",
      amountMinor: 33333,
      prevMinor: 0,
    });
    const months = [
      { key: "2025-01", label: "Jan", from: "2025-01-01", to: "2025-01-31" },
      { key: "2025-02", label: "Feb", from: "2025-02-01", to: "2025-02-28" },
    ];
    expect(
      monthlySeries(
        months,
        accountTotalsByRanges(
          db,
          months.map((m) => ({ dateFrom: m.from, dateTo: m.to })),
        ),
      ),
    ).toMatchObject([
      { expensesMinor: 33333, resultMinor: 166667 },
      { expensesMinor: 0, resultMinor: 0 },
    ]);
    expect(
      cashBalancesAsAt(db, ["2024-12-31", "2025-01-30", "2025-01-31"]),
    ).toEqual([2000000, 1000000, 1000000]);
    expect(cashOnHandAsAt(db, "2025-01-31")).toBe(1000000);
    expect(
      profitLossReport(db, "2025-01-01", "2025-01-30").totalExpensesMinor,
    ).toBe(0);
    expect(
      balanceSheetReport(db, "2025-01-30").owned.lines.some(
        (l) => l.accountId === accum,
      ),
    ).toBe(false);
    expect(profitLossCsv(pl).rows).toContainEqual([
      "Expenses",
      "Depreciation expense",
      333.33,
    ]);
    expect(
      balanceSheetCsv(bs).rows.some(
        (row) =>
          row.includes("Accumulated depreciation") && row.includes(-333.33),
      ),
    ).toBe(true);
    expect(cashFlowCsv(cf).rows).toEqual(cashFlowCsv(before.cf).rows);
    expect(expenseTaxReport(db, "2025-01-01", "2025-01-31")).toMatchObject({
      expenseMinor: 33333,
      deductibleMinor: 0,
      addBackMinor: 33333,
      unresolvedLineCount: 0,
    });
    const shares = partnerStatementReport(
      db,
      "2025-01-01",
      "2025-01-31",
    ).partners;
    expect(shares).toHaveLength(2);
    expect(shares.reduce((sum, p) => sum + p.shareOfResultMinor, 0)).toBe(
      pl.resultMinor,
    );
  });
  it("dates catch-up charges and cross-period reversals correctly in every statement", () => {
    const { stored } = asset();
    approve(stored.id, { months: 3 });
    const snapshot = value(previewAssetCatchUp(ctx(), stored.id));
    value(
      postAssetCatchUp(ctx(), stored.id, { expectedVersion: snapshot.version }),
    );
    for (const month of ["2025-01", "2025-02", "2025-03"])
      expect(
        profitLossReport(
          db,
          `${month}-01`,
          month === "2025-02" ? "2025-02-28" : `${month}-31`,
        ).totalExpensesMinor,
      ).toBe(400000);
    expect(
      balanceSheetReport(db, "2025-03-31").owned.lines.find(
        (l) => l.accountId === accum,
      )?.amountMinor,
    ).toBe(-1200000);
    expect(
      value(readFixedAssets(ctx(), "2025-03-31")).assets[0].netBookValueMinor,
    ).toBe(0);
    expect(cashFlowReport(db, "2025-02-01", "2025-03-31")).toMatchObject({
      netChangeMinor: 0,
      ties: true,
    });
    const march = value(previewDepreciationMonth(ctx(), "2025-03")).rows[0];
    const original = profitLossReport(db, "2025-03-01", "2025-03-31");
    setSetting(db, SETTING_KEYS.accountingClosedThrough, "2025-03-31");
    value(
      reverseDepreciationRun(ctx(), march.runId!, {
        month: "2025-04",
        reason: "Correct depreciation without changing closed March",
      }),
    );
    expect(profitLossReport(db, "2025-03-01", "2025-03-31")).toEqual(original);
    expect(profitLossReport(db, "2025-04-01", "2025-04-30")).toMatchObject({
      totalExpensesMinor: -400000,
      resultMinor: 400000,
    });
    expect(
      balanceSheetReport(db, "2025-04-30").owned.lines.find(
        (l) => l.accountId === accum,
      )?.amountMinor,
    ).toBe(-800000);
    expect(balanceSheetReport(db, "2025-04-30").balances).toBe(true);
    expect(
      value(readFixedAssets(ctx(), "2025-04-30")).assets[0].netBookValueMinor,
    ).toBe(400000);
    expect(cashFlowReport(db, "2025-04-01", "2025-04-30")).toMatchObject({
      netChangeMinor: 0,
      ties: true,
    });
    expect(expenseTaxReport(db, "2025-04-01", "2025-04-30")).toMatchObject({
      expenseMinor: -400000,
      deductibleMinor: 0,
      addBackMinor: -400000,
    });
  });
  it("linking manual depreciation does not count it a second time in reports or the dashboard", () => {
    const { stored } = asset();
    const journal = value(
      createRecord(ctx(), {
        kind: "journal",
        date: "2025-01-31",
        description: "Existing depreciation",
        amount: 100,
        currency: "MYR",
        exchangeRate: 1,
        movements: [
          { accountId: expense, amountMinor: 10000 },
          { accountId: accum, amountMinor: -10000 },
        ],
      }),
    ).record;
    const before = {
      pl: profitLossReport(db, "2025-01-01", "2025-01-31"),
      bs: balanceSheetReport(db, "2025-01-31"),
      cf: cashFlowReport(db, "2025-01-01", "2025-01-31"),
    };
    const state = value(readAssetDepreciation(ctx(), stored.id));
    value(
      linkManualDepreciation(ctx(), stored.id, {
        candidateKey: state.manualCandidates.find(
          (c) => c.recordId === journal.id,
        )!.key,
        amountMinor: 10000,
        fromMonth: "2025-01",
        throughMonth: "2025-01",
        reason: "Link the existing charge",
        expectedVersion: state.version,
      }),
    );
    expect({
      pl: profitLossReport(db, "2025-01-01", "2025-01-31"),
      bs: balanceSheetReport(db, "2025-01-31"),
      cf: cashFlowReport(db, "2025-01-01", "2025-01-31"),
    }).toEqual(before);
    approve(stored.id, { startMonth: "2025-02", months: 2 });
    post("2025-02");
    expect(
      profitLossReport(db, "2025-01-01", "2025-02-28").totalExpensesMinor,
    ).toBe(605000);
    expect(
      balanceSheetReport(db, "2025-02-28").owned.lines.find(
        (l) => l.accountId === accum,
      )?.amountMinor,
    ).toBe(-605000);
    expect(
      value(readFixedAssets(ctx(), "2025-02-28")).assets[0].netBookValueMinor,
    ).toBe(595000);
    expect(cashFlowReport(db, "2025-02-01", "2025-02-28")).toMatchObject({
      netChangeMinor: 0,
      ties: true,
    });
  });
  it("rejects cash, bank and current-asset contra mappings so non-cash depreciation cannot alter cash reports", () => {
    const { stored } = asset();
    for (const subType of [
      AccountSubType.Cash,
      AccountSubType.Bank,
      AccountSubType.Receivable,
      AccountSubType.OtherCurrentAsset,
    ]) {
      const id = account(
        `Incorrect contra ${subType}`,
        AccountType.Asset,
        subType,
      );
      const preview = previewDepreciationProfile(
        ctx(),
        stored.id,
        settings({ accumulatedAccountId: id }),
      );
      expect(preview.ok).toBe(false);
      if (!preview.ok) expect(preview.reason).toContain("non-current");
      const registration = registerFixedAsset(ctx(), {
        name: "Older machine",
        assetType: "Machinery",
        inServiceDate: "2023-01-01",
        sourceMovementId: null,
        acquisitionDate: "2023-01-01",
        assetAccountId: cost,
        costMinor: 1200000,
        openingAsAt: "2024-12-31",
        broughtForwardDepMinor: 10000,
        accumulatedDepreciationAccountId: id,
        documentReference: "Accountant schedule",
      });
      expect(registration.ok).toBe(false);
      if (!registration.ok)
        expect(registration.reason).toContain("non-current");
    }
    approve(stored.id);
    // A later chart edit must pause the existing schedule too.
    db.update(schema.accounts)
      .set({ subType: AccountSubType.Bank })
      .where(eq(schema.accounts.id, accum))
      .run();
    const preview = value(previewDepreciationMonth(ctx(), "2025-01"));
    expect(preview.rows[0].blocked).toContain("mapping");
    expect(
      postDepreciationMonth(ctx(), {
        month: "2025-01",
        expectedVersion: preview.version,
      }).ok,
    ).toBe(false);
    expect(db.select().from(schema.depreciationPostings).all()).toHaveLength(0);
    const cashBefore = cashFlowReport(db, "2025-01-01", "2025-01-31");
    db.update(schema.accounts)
      .set({ subType: AccountSubType.OtherNonCurrentAsset })
      .where(eq(schema.accounts.id, accum))
      .run();
    expect(post("2025-01").posted).toBe(1);
    expect(cashFlowReport(db, "2025-01-01", "2025-01-31")).toEqual(cashBefore);
  });
});

describe("registered asset depreciation overview", () => {
  const overview = (id: number, asAt: string) =>
    value(readFixedAssets(ctx(), asAt)).assets.find((asset) => asset.id === id)!
      .depreciation;
  it("shows setup, scheduled, pending and posted progress as of the selected date", () => {
    const { stored } = asset();
    expect(overview(stored.id, "2025-01-31")).toMatchObject({
      status: "depreciation-setup",
      dueCount: 0,
      lastPostedMonth: null,
    });
    approve(stored.id, { months: 2, residualMinor: 100000 });
    expect(overview(stored.id, "2025-01-30")).toMatchObject({
      status: "depreciation-scheduled",
      dueCount: 0,
      nextMonth: "2025-01",
      lastPostedMonth: null,
    });
    expect(overview(stored.id, "2025-01-31")).toMatchObject({
      status: "depreciation-pending",
      dueCount: 1,
      firstDueMonth: "2025-01",
      nextMonth: "2025-02",
    });
    expect(overview(stored.id, "2025-02-28").dueCount).toBe(2);
    post("2025-01");
    expect(overview(stored.id, "2025-01-31")).toMatchObject({
      status: "depreciation-current",
      dueCount: 0,
      lastPostedMonth: "2025-01",
      nextMonth: "2025-02",
    });
    expect(overview(stored.id, "2025-02-28")).toMatchObject({
      status: "depreciation-pending",
      dueCount: 1,
      lastPostedMonth: "2025-01",
    });
    post("2025-02");
    expect(overview(stored.id, "2025-02-28")).toMatchObject({
      status: "depreciation-complete",
      dueCount: 0,
      lastPostedMonth: "2025-02",
      nextMonth: null,
    });
    // Later postings do not make a historical reporting date look fully depreciated.
    expect(overview(stored.id, "2025-01-31")).toMatchObject({
      status: "depreciation-current",
      nextMonth: "2025-02",
    });
    expect(overview(stored.id, "2025-01-30")).toMatchObject({
      status: "depreciation-scheduled",
      nextMonth: "2025-01",
      lastPostedMonth: null,
    });
  });
  it("does not turn future scheduled months into pending postings", () => {
    const { stored } = asset();
    const startMonth = shiftMonth(localToday().slice(0, 7), 1);
    approve(stored.id, { startMonth, months: 2 });
    expect(overview(stored.id, "9999-12-31")).toMatchObject({
      status: "depreciation-scheduled",
      dueCount: 0,
      nextMonth: startMonth,
      lastPostedMonth: null,
    });
  });
  it("keeps pending auto-post months and integrity warnings visible", () => {
    const { stored, record } = asset();
    approve(stored.id, { months: 2, mode: "auto" });
    expect(overview(stored.id, "2025-02-28")).toMatchObject({
      status: "depreciation-pending",
      mode: "auto",
      dueCount: 2,
    });
    value(updateRecord(ctx(), record.id, { amount: 13000 }));
    const state = overview(stored.id, "2025-02-28");
    expect(state.status).toBe("depreciation-pending");
    expect(state.reviewReason).toContain("Source");
    expect(state.lastPostedMonth).toBeNull();
  });
  it("shows stopped schedules and reversed charges without claiming full depreciation", () => {
    const { stored } = asset();
    approve(stored.id, { months: 2 });
    const run = post("2025-01");
    value(
      stopDepreciation(ctx(), stored.id, {
        month: "2025-02",
        reason: "Pause further depreciation",
        expectedVersion: value(readAssetDepreciation(ctx(), stored.id)).version,
      }),
    );
    expect(overview(stored.id, "2025-02-28")).toMatchObject({
      status: "depreciation-stopped",
      dueCount: 0,
      lastPostedMonth: "2025-01",
    });
    value(
      reverseDepreciationRun(ctx(), run.runId!, {
        month: "2025-02",
        reason: "Correct the posted amount",
      }),
    );
    const state = overview(stored.id, "2025-02-28");
    expect(state.status).toBe("depreciation-stopped");
    expect(state.lastPostedMonth).toBeNull();
    expect(state.reviewReason).toContain("reversed");
  });
});
