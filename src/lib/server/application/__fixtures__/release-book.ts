import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../db/schema.js";
import { migrateBook } from "../../db/migrate-book.js";
import type { LedgerDb } from "../../ledger/types.js";
import {
  AccountType,
  AccountSubType,
  DefaultAccountPurpose,
} from "$lib/enums.js";
import { createAccount } from "../../services/accounts.js";
import { localsFor, grantGroup } from "../../permissions/test-locals.js";
import { setSetting, SETTING_KEYS } from "../../settings.js";
import { createRecord } from "../records.js";
import { registerFixedAsset } from "../fixed-assets.js";
import {
  approveDepreciationProfile,
  previewDepreciationProfile,
} from "../depreciation.js";

export function resultValue<T>(
  result: { ok: true; value: T } | { ok: false; reason: string },
): T {
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}

/** Only callers supplying an explicit disposable path may use an on-disk book. */
export function releaseBook(path = ":memory:", onQuery?: () => void) {
  const raw = new Database(path);
  migrateBook(raw);
  raw.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  const db = drizzle(raw, {
    schema,
    logger: onQuery ? { logQuery: onQuery } : undefined,
  }) as LedgerDb;
  db.insert(schema.users)
    .values({
      id: 1,
      username: "Release owner",
      email: "release@test",
      passwordHash: "fixture",
    })
    .run();
  grantGroup(db, {
    name: "Fixture administrators",
    userIds: [1],
    grants: [],
    superuser: true,
  });
  const ctx = { db, locals: localsFor([], { superuser: true }) };
  function account(
    name: string,
    type: 1 | 2 | 3 | 4 | 5,
    subType?: number,
    tax?: number,
  ) {
    return resultValue(
      createAccount(db, 1, {
        name,
        type,
        subType: subType as never,
        defaultTaxPercentageBps: tax,
      }),
    ).id;
  }
  const bank = account("Bank", AccountType.Asset, AccountSubType.Bank);
  const cost = account(
    "Equipment",
    AccountType.Asset,
    AccountSubType.FixedAsset,
  );
  const accum = account(
    "Accumulated depreciation",
    AccountType.Asset,
    AccountSubType.OtherNonCurrentAsset,
  );
  const depreciationExpense = account(
    "Depreciation expense",
    AccountType.Expense,
  );
  const expense = account(
    "Ordinary expenses",
    AccountType.Expense,
    undefined,
    10000,
  );
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
  setSetting(db, SETTING_KEYS.taxJurisdiction, "MY");
  function asset(mode: "review" | "auto" = "review") {
    const record = resultValue(
      createRecord(ctx, {
        kind: "expense",
        date: "2025-01-01",
        amount: 12000,
        currency: "MYR",
        exchangeRate: 1,
        description: "Release fixture equipment",
        categoryAccountId: cost,
        paidFromAccountId: bank,
      }),
    ).record;
    const stored = resultValue(
      registerFixedAsset(ctx, {
        name: "Equipment",
        assetType: "Equipment",
        inServiceDate: "2025-01-01",
        sourceMovementId: record.movements.find((m) => m.accountId === cost)!
          .id,
      }),
    );
    const settings = {
      startMonth: "2025-01",
      months: 36,
      residualMinor: 0,
      expenseAccountId: depreciationExpense,
      accumulatedAccountId: accum,
      mode,
      reason: "Release fixture approved schedule",
    };
    const preview = resultValue(
      previewDepreciationProfile(ctx, stored.id, settings),
    );
    resultValue(
      approveDepreciationProfile(ctx, stored.id, {
        settings,
        expectedVersion: preview.version,
      }),
    );
    // Simulate authority granted before the historical month, solely in this fixture.
    if (mode === "auto")
      raw.exec("UPDATE depreciation_approvals SET future_from_month='2025-01'");
    return stored;
  }
  return {
    raw,
    db,
    ctx,
    bank,
    cost,
    accum,
    expense,
    depreciationExpense,
    asset,
  };
}
