import { eq } from "drizzle-orm";
import { accountDefaults, accounts } from "./schema.js";
import {
  AccountRole,
  AccountSubType,
  AccountType,
  DefaultAccountPurpose,
  ExpenseSubType,
  LiabilitySubType,
  RevenueSubType,
  type AccountRoleCode,
  type AccountSubTypeCode,
  type AccountTypeCode,
  type DefaultAccountPurposeCode,
} from "$lib/enums.js";
import { generateRanks } from "../ledger/rank.js";
import { getSetting, setSetting, SETTING_KEYS } from "../settings.js";
import type { LedgerDb } from "../ledger/types.js";

type SeedAccount = {
  code: number;
  name: string;
  type: AccountTypeCode;
  /**
   * Set for every seeded row whose classification is unambiguous from its
   * name. Left unset (needs review, for Asset/Liability) on "Marketplace
   * Clearing" (FR-004) and "Loans" — a loan's name alone doesn't say
   * short- vs long-term, so it's left needs-review rather than guessed, the
   * same way Marketplace Clearing is.
   */
  subType?: AccountSubTypeCode;
};

/** The useful default chart every fresh installation starts with (FR-055). */
export const DEFAULT_CHART: readonly SeedAccount[] = [
  {
    code: 1000,
    name: "Cash",
    type: AccountType.Asset,
    subType: AccountSubType.Cash,
  },
  {
    code: 1100,
    name: "Bank",
    type: AccountType.Asset,
    subType: AccountSubType.Bank,
  },
  {
    code: 1200,
    name: "Accounts Receivable",
    type: AccountType.Asset,
    subType: AccountSubType.Receivable,
  },
  {
    code: 1300,
    name: "Inventory",
    type: AccountType.Asset,
    subType: AccountSubType.Inventory,
  },
  // Needs review: not one of the four recognizable defaults (FR-004).
  { code: 1400, name: "Marketplace Clearing", type: AccountType.Asset },
  {
    code: 2000,
    name: "Accounts Payable",
    type: AccountType.Liability,
    subType: LiabilitySubType.AccountsPayable,
  },
  // Needs review: "Loans" doesn't say short- vs long-term.
  { code: 2100, name: "Loans", type: AccountType.Liability },
  { code: 3000, name: "Owner's Equity", type: AccountType.Equity },
  { code: 3100, name: "Retained Earnings", type: AccountType.Equity },
  {
    code: 4000,
    name: "Product Sales",
    type: AccountType.Revenue,
    subType: RevenueSubType.OperatingRevenue,
  },
  {
    code: 4100,
    name: "Other Revenue",
    type: AccountType.Revenue,
    subType: RevenueSubType.OtherRevenue,
  },
  {
    code: 5000,
    name: "Cost of Goods Sold",
    type: AccountType.Expense,
    subType: ExpenseSubType.CostOfGoodsSold,
  },
  {
    code: 5100,
    name: "Advertising",
    type: AccountType.Expense,
    subType: ExpenseSubType.OperatingExpense,
  },
  {
    code: 5200,
    name: "Packaging",
    type: AccountType.Expense,
    subType: ExpenseSubType.OperatingExpense,
  },
  {
    code: 5300,
    name: "Shipping",
    type: AccountType.Expense,
    subType: ExpenseSubType.OperatingExpense,
  },
  {
    code: 5400,
    name: "Software",
    type: AccountType.Expense,
    subType: ExpenseSubType.OperatingExpense,
  },
  {
    code: 5500,
    name: "Utilities",
    type: AccountType.Expense,
    subType: ExpenseSubType.OperatingExpense,
  },
  {
    code: 5900,
    name: "Other Expenses",
    type: AccountType.Expense,
    subType: ExpenseSubType.OtherExpense,
  },
] as const;

const INITIAL_DEFAULT_CODES: Readonly<
  Record<
    Exclude<
      DefaultAccountPurposeCode,
      typeof DefaultAccountPurpose.ReimbursementsPayable
    >,
    number
  >
> = {
  [DefaultAccountPurpose.Receivable]: 1200,
  [DefaultAccountPurpose.Payable]: 2000,
  [DefaultAccountPurpose.OpeningBalances]: 3000,
  [DefaultAccountPurpose.SalesRevenue]: 4000,
  [DefaultAccountPurpose.UncategorisedExpense]: 5900,
  [DefaultAccountPurpose.EverydayTransaction]: 1100,
  [DefaultAccountPurpose.UncategorisedIncome]: 4100,
};

// Transitional only: the explicit conversion later retires the role column.
function compatibilityRole(type: AccountTypeCode): AccountRoleCode {
  switch (type) {
    case AccountType.Asset:
      return AccountRole.Bank;
    case AccountType.Liability:
      return AccountRole.Payable;
    case AccountType.Equity:
      return AccountRole.OpeningBalances;
    case AccountType.Revenue:
      return AccountRole.IncomeCategory;
    case AccountType.Expense:
      return AccountRole.ExpenseCategory;
  }
}

export function seedAccounts(db: LedgerDb): void {
  const ranks = generateRanks(DEFAULT_CHART.length);
  const idsByCode = new Map<number, number>();

  DEFAULT_CHART.forEach((seed, index) => {
    const existing = db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.code, seed.code))
      .get();
    const id =
      existing?.id ??
      db
        .insert(accounts)
        .values({
          role: compatibilityRole(seed.type),
          type: seed.type,
          subType: seed.subType ?? null,
          code: seed.code,
          name: seed.name,
          rank: ranks[index],
        })
        .returning({ id: accounts.id })
        .get()!.id;
    idsByCode.set(seed.code, id);
  });

  for (const [purposeText, code] of Object.entries(INITIAL_DEFAULT_CODES)) {
    const purpose = Number(purposeText) as DefaultAccountPurposeCode;
    db.insert(accountDefaults)
      .values({ purpose, accountId: idsByCode.get(code)! })
      .onConflictDoNothing({ target: accountDefaults.purpose })
      .run();
  }

  // Compatibility for composers not yet switched to the saved default table.
  if (getSetting(db, SETTING_KEYS.ledgerDefaultAccountId) === null) {
    const everydayCode =
      INITIAL_DEFAULT_CODES[DefaultAccountPurpose.EverydayTransaction];
    setSetting(
      db,
      SETTING_KEYS.ledgerDefaultAccountId,
      String(idsByCode.get(everydayCode)!),
    );
  }
}
