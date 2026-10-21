import { createAccount } from "./accounts.js";
import { AccountType } from "$lib/enums.js";
import { isContraRevenueAccount } from "$lib/account-classification.js";
import { asc, eq, inArray } from "drizzle-orm";
import {
  AccountSubType,
  DefaultAccountPurpose,
  DefaultAccountPurposeTypes,
  type DefaultAccountPurposeCode,
} from "$lib/enums.js";
import type {
  AccountDefaultInput,
  AccountDefaultView,
} from "$lib/components/accounts/account-types.js";
import { recordAudit } from "../audit.js";
import { accountDefaults } from "../db/schema.js";
import type { LedgerDb, Refusable } from "../ledger/types.js";
import { listAccounts } from "../queries/accounts.js";

export const ACCOUNT_DEFAULT_PURPOSES = [
  DefaultAccountPurpose.Receivable,
  DefaultAccountPurpose.Payable,
  DefaultAccountPurpose.OpeningBalances,
  DefaultAccountPurpose.SalesRevenue,
  DefaultAccountPurpose.UncategorisedExpense,
  DefaultAccountPurpose.EverydayTransaction,
  DefaultAccountPurpose.UncategorisedIncome,
] as const satisfies readonly DefaultAccountPurposeCode[];

function invalidReason(purpose: DefaultAccountPurposeCode): string {
  return `Choose an active posting account of the required type for saved default ${purpose}.`;
}

function accountViews(db: LedgerDb) {
  return listAccounts(db, { includeArchived: true });
}

const TRANSACTION_SUBTYPES = new Set<number>([
  AccountSubType.Cash,
  AccountSubType.Bank,
  AccountSubType.Wallet,
  AccountSubType.Card,
  AccountSubType.Clearing,
]);

function matchesPurpose(
  purpose: DefaultAccountPurposeCode,
  account: Pick<ReturnType<typeof accountViews>[number], "type" | "subType">,
): boolean {
  if (account.type !== DefaultAccountPurposeTypes[purpose]) return false;
  switch (purpose) {
    case DefaultAccountPurpose.SalesRevenue:
    case DefaultAccountPurpose.UncategorisedIncome:
      return !isContraRevenueAccount(account);
    case DefaultAccountPurpose.Payable:
    case DefaultAccountPurpose.ReimbursementsPayable:
      return account.subType === AccountSubType.AccountsPayable;
    case DefaultAccountPurpose.Receivable:
      return account.subType === AccountSubType.Receivable;
    case DefaultAccountPurpose.EverydayTransaction:
      return (
        account.subType !== null && TRANSACTION_SUBTYPES.has(account.subType)
      );
    default:
      return true;
  }
}

function toDefaultAccount(account: ReturnType<typeof accountViews>[number]) {
  return {
    id: account.id,
    code: account.code ?? account.id,
    name: account.name,
    type: account.type,
    subType: account.subType,
    active: account.active ?? false,
    postingEligible: account.postingEligible ?? false,
  };
}

/** Returns all six purposes, including empty or subsequently invalid choices. */
export function getAccountDefaults(db: LedgerDb): AccountDefaultView[] {
  const saved = new Map(
    db
      .select()
      .from(accountDefaults)
      .orderBy(asc(accountDefaults.purpose))
      .all()
      .map((row) => [row.purpose, row.accountId]),
  );
  const accounts = new Map(
    accountViews(db).map((account) => [account.id, account]),
  );

  return ACCOUNT_DEFAULT_PURPOSES.map((purpose) => {
    const rawAccount = accounts.get(saved.get(purpose) ?? -1) ?? null;
    const account = rawAccount ? toDefaultAccount(rawAccount) : null;
    const valid =
      account !== null &&
      matchesPurpose(purpose, account) &&
      account.postingEligible === true;
    return {
      purpose,
      requiredType: DefaultAccountPurposeTypes[purpose],
      account,
      valid,
    };
  });
}

function validateReplacement(
  db: LedgerDb,
  values: readonly AccountDefaultInput[],
): Refusable<readonly AccountDefaultInput[]> {
  if (
    values.length !== ACCOUNT_DEFAULT_PURPOSES.length ||
    new Set(values.map((value) => value.purpose)).size !==
      ACCOUNT_DEFAULT_PURPOSES.length ||
    ACCOUNT_DEFAULT_PURPOSES.some(
      (purpose) => !values.some((value) => value.purpose === purpose),
    )
  ) {
    return {
      ok: false,
      reason: "Save one account for each required purpose.",
    };
  }

  const accounts = new Map(
    accountViews(db).map((account) => [account.id, account]),
  );
  for (const value of values) {
    const account = accounts.get(value.accountId);
    if (
      !account ||
      !matchesPurpose(value.purpose, account) ||
      account.postingEligible !== true
    ) {
      return { ok: false, reason: invalidReason(value.purpose) };
    }
  }
  return { ok: true, value: values };
}

/** Validates the complete set first, then replaces it in one transaction. */
export function replaceAccountDefaults(
  db: LedgerDb,
  actingUserId: number,
  values: readonly AccountDefaultInput[],
): Refusable<AccountDefaultView[]> {
  const checked = validateReplacement(db, values);
  if (!checked.ok) return checked;

  const before = new Map(
    getAccountDefaults(db).map((value) => [
      value.purpose,
      value.account?.id ?? null,
    ]),
  );
  db.transaction((tx) => {
    tx.delete(accountDefaults)
      .where(inArray(accountDefaults.purpose, [...ACCOUNT_DEFAULT_PURPOSES]))
      .run();
    tx.insert(accountDefaults)
      .values(
        checked.value.map((value) => ({
          ...value,
          updatedBy: actingUserId,
          updatedAt: new Date().toISOString(),
        })),
      )
      .run();

    for (const value of checked.value) {
      const previousAccountId = before.get(value.purpose) ?? null;
      if (previousAccountId === value.accountId) continue;
      recordAudit(tx, {
        recordType: "account",
        recordId: value.accountId,
        userId: actingUserId,
        action: "update",
        changes: [
          {
            field: `savedDefault:${value.purpose}`,
            before: previousAccountId,
            after: value.accountId,
          },
        ],
      });
    }
  });
  return { ok: true, value: getAccountDefaults(db) };
}

/** Revalidates a saved choice at the point an automatic write will use it. */
export function requireAccountDefault(
  db: LedgerDb,
  purpose: DefaultAccountPurposeCode,
): Refusable<number> {
  // Optional compatibility default for records created by the earlier redesign.
  // It is no longer required or created for the ordinary Accounts payable flow.
  if (purpose === DefaultAccountPurpose.ReimbursementsPayable) {
    const id = accountDefaultId(db, purpose);
    const account = accountViews(db).find((account) => account.id === id);
    return account &&
      matchesPurpose(purpose, account) &&
      account.postingEligible
      ? { ok: true, value: account.id }
      : { ok: false, reason: invalidReason(purpose) };
  }
  const value = getAccountDefaults(db).find((item) => item.purpose === purpose);
  if (!value?.valid || !value.account) {
    return { ok: false, reason: invalidReason(purpose) };
  }
  return { ok: true, value: value.account.id };
}

export function accountDefaultId(
  db: LedgerDb,
  purpose: DefaultAccountPurposeCode,
): number | null {
  return (
    db
      .select({ accountId: accountDefaults.accountId })
      .from(accountDefaults)
      .where(eq(accountDefaults.purpose, purpose))
      .get()?.accountId ?? null
  );
}

/** Seed configuration only; never reclassifies existing records or balances. */
export function ensureReimbursementsPayableAccount(
  db: LedgerDb,
  actingUserId: number | null = null,
): Refusable<number> {
  const existing = db
    .select()
    .from(accountDefaults)
    .where(
      eq(accountDefaults.purpose, DefaultAccountPurpose.ReimbursementsPayable),
    )
    .get();
  if (existing)
    return requireAccountDefault(
      db,
      DefaultAccountPurpose.ReimbursementsPayable,
    );
  return db.transaction(() => {
    const created = createAccount(
      db,
      actingUserId,
      {
        name: "Reimbursements payable",
        type: AccountType.Liability,
        subType: AccountSubType.AccountsPayable,
      },
      [],
    );
    if (!created.ok) return created;
    db.insert(accountDefaults)
      .values({
        purpose: DefaultAccountPurpose.ReimbursementsPayable,
        accountId: created.value.id,
      })
      .run();
    return { ok: true, value: created.value.id } as const;
  });
}
