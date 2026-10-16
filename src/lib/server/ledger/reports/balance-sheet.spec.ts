import { describe, expect, it } from "vitest";
import {
  AccountRole,
  AccountSubType,
  AccountType,
  LiabilitySubType,
  type AccountRoleCode,
  type AccountSubTypeCode,
} from "$lib/enums.js";
import { balanceSheet } from "./balance-sheet.js";
import { profitLoss } from "./profit-loss.js";
import { accountTypeFor } from "../account-type.js";
import type { AccountTotal, BalanceSheetSection, Minor } from "../types.js";

/** A dated side of a record, so a test can ask "what did it look like then?". */
type DatedMovement = {
  date: string;
  accountId: number;
  accountName: string;
  role: AccountRoleCode;
  amountMinor: Minor;
};

/**
 * Stands in for `queries/reports.ts`. The report module never sees dates — the
 * query narrows first — so the fixture does the narrowing the same way.
 */
function totalsIn(
  movements: DatedMovement[],
  dateFrom: string | null,
  dateTo: string,
): AccountTotal[] {
  const byAccount = new Map<number, AccountTotal>();
  for (const m of movements) {
    if (dateFrom !== null && m.date < dateFrom) continue;
    if (m.date > dateTo) continue;
    const existing = byAccount.get(m.accountId);
    if (existing) existing.amountMinor += m.amountMinor;
    else
      byAccount.set(m.accountId, {
        accountId: m.accountId,
        code: m.accountId,
        accountName: m.accountName,
        type: accountTypeFor(m.role),
        role: m.role,
        subType: null,
        contactId: null,
        amountMinor: m.amountMinor,
      });
  }
  return [...byAccount.values()];
}

const BANK = 1;
const RECEIVABLE = 2;
const PAYABLE = 3;
const CAPITAL = 4;
const DRAWINGS = 5;
const CONSULTING = 6;
const SOFTWARE = 7;

/**
 * Two months of a very small business.
 *
 * January: a partner puts 2,000 in, 1,500 comes in from a client, 400 goes out
 * on software. February: the partner takes 300 back out, a 250 supplier bill
 * arrives unpaid, and 600 is invoiced but not yet collected.
 */
const MOVEMENTS: DatedMovement[] = [
  m("2026-01-05", BANK, "Bank", AccountRole.Bank, 200_000),
  m(
    "2026-01-05",
    CAPITAL,
    "Alex — money put in",
    AccountRole.PartnerCapital,
    -200_000,
  ),
  m("2026-01-20", BANK, "Bank", AccountRole.Bank, 150_000),
  m(
    "2026-01-20",
    CONSULTING,
    "Consulting",
    AccountRole.IncomeCategory,
    -150_000,
  ),
  m("2026-01-25", SOFTWARE, "Software", AccountRole.ExpenseCategory, 40_000),
  m("2026-01-25", BANK, "Bank", AccountRole.Bank, -40_000),
  m(
    "2026-02-10",
    DRAWINGS,
    "Alex — money taken out",
    AccountRole.PartnerDrawings,
    30_000,
  ),
  m("2026-02-10", BANK, "Bank", AccountRole.Bank, -30_000),
  m("2026-02-15", SOFTWARE, "Software", AccountRole.ExpenseCategory, 25_000),
  m("2026-02-15", PAYABLE, "Money we owe", AccountRole.Payable, -25_000),
  m(
    "2026-02-20",
    CONSULTING,
    "Consulting",
    AccountRole.IncomeCategory,
    -60_000,
  ),
  m(
    "2026-02-20",
    RECEIVABLE,
    "Money owed to us",
    AccountRole.Receivable,
    60_000,
  ),
];

function m(
  date: string,
  accountId: number,
  accountName: string,
  role: AccountRoleCode,
  amountMinor: Minor,
): DatedMovement {
  return { date, accountId, accountName, role, amountMinor };
}

function sumOf(section: BalanceSheetSection): Minor {
  return section.lines.reduce((sum, l) => sum + l.amountMinor, 0);
}

describe("what the business owns, owes, and what the owners have in it", () => {
  const sheet = balanceSheet({
    asAt: "2026-02-28",
    totals: totalsIn(MOVEMENTS, null, "2026-02-28"),
  });

  it("balances: what it owns equals what it owes plus the owners' stake", () => {
    expect(sheet.owned.totalMinor).toBe(
      sheet.owed.totalMinor + sheet.ownersStake.totalMinor,
    );
    expect(sheet.balances).toBe(true);
    expect(sheet.differenceMinor).toBe(0);
  });

  it("counts the bank and what customers still owe as things it owns", () => {
    expect(sheet.owned.lines.map((l) => l.accountId).sort()).toEqual([
      BANK,
      RECEIVABLE,
    ]);
    expect(sheet.owned.totalMinor).toBe(340_000);
  });

  it("shows what it owes as a positive figure, not as a negative", () => {
    expect(sheet.owed.lines).toHaveLength(1);
    expect(sheet.owed.lines[0].amountMinor).toBe(25_000);
    expect(sheet.owed.totalMinor).toBe(25_000);
  });

  it("keeps no category account on the balance sheet", () => {
    const everyLine = [
      ...sheet.owned.lines,
      ...sheet.owed.lines,
      ...sheet.ownersStake.lines,
    ];
    expect(everyLine.map((l) => l.accountId)).not.toContain(CONSULTING);
    expect(everyLine.map((l) => l.accountId)).not.toContain(SOFTWARE);
  });

  it("adds every section up from its own lines, so the page adds up on screen", () => {
    expect(sumOf(sheet.owned)).toBe(sheet.owned.totalMinor);
    expect(sumOf(sheet.owed)).toBe(sheet.owed.totalMinor);
    expect(sumOf(sheet.ownersStake)).toBe(sheet.ownersStake.totalMinor);
  });

  it("echoes the date it was drawn up at", () => {
    expect(sheet.asAt).toBe("2026-02-28");
  });
});

describe("fixed types", () => {
  it("classifies direct fixed types and uses their normal display signs", () => {
    const sheet = balanceSheet({
      asAt: "2026-03-31",
      totals: [
        {
          ...totalsIn(
            [m("2026-03-01", 81, "Custom asset", AccountRole.Bank, 900)],
            null,
            "2026-03-31",
          )[0],
          type: AccountType.Asset,
        },
        {
          ...totalsIn(
            [m("2026-03-01", 82, "Custom liability", AccountRole.Bank, -400)],
            null,
            "2026-03-31",
          )[0],
          type: AccountType.Liability,
        },
        {
          ...totalsIn(
            [m("2026-03-01", 83, "Custom equity", AccountRole.Bank, -500)],
            null,
            "2026-03-31",
          )[0],
          type: AccountType.Equity,
        },
      ],
    });
    expect(
      sheet.owned.lines.find((line) => line.accountId === 81)?.amountMinor,
    ).toBe(900);
    expect(
      sheet.owed.lines.find((line) => line.accountId === 82)?.amountMinor,
    ).toBe(400);
    expect(
      sheet.ownersStake.lines.find((line) => line.accountId === 83)
        ?.amountMinor,
    ).toBe(500);
  });

  it("gives each account its own line, with the section total the plain sum", () => {
    const sheet = balanceSheet({
      asAt: "2026-03-31",
      totals: [
        {
          accountId: 91,
          code: 1010,
          accountName: "Bank",
          type: AccountType.Asset,
          role: AccountRole.Bank,
          subType: null,
          contactId: null,
          amountMinor: 700,
        },
        {
          accountId: 92,
          code: 1020,
          accountName: "Cash",
          type: AccountType.Asset,
          role: AccountRole.Bank,
          subType: null,
          contactId: null,
          amountMinor: 300,
        },
        {
          accountId: 93,
          code: 2000,
          accountName: "Payable",
          type: AccountType.Liability,
          role: AccountRole.Payable,
          subType: null,
          contactId: null,
          amountMinor: -1_000,
        },
      ],
    });
    expect(sheet.owned.lines.map((line) => line.accountId).sort()).toEqual([
      91, 92,
    ]);
    expect(sheet.owned.totalMinor).toBe(1_000);
  });
});

describe("the accumulated result carried forward", () => {
  it("carries everything the business has made up to that date", () => {
    const sheet = balanceSheet({
      asAt: "2026-02-28",
      totals: totalsIn(MOVEMENTS, null, "2026-02-28"),
    });
    // 2,100 earned less 650 spent, over both months.
    expect(sheet.accumulatedResultMinor).toBe(145_000);
  });

  it("puts it into what the owners have in it as its own line", () => {
    const sheet = balanceSheet({
      asAt: "2026-02-28",
      totals: totalsIn(MOVEMENTS, null, "2026-02-28"),
    });
    const line = sheet.ownersStake.lines.find(
      (l) => l.amountMinor === sheet.accumulatedResultMinor,
    );
    expect(line).toBeDefined();
    expect(sheet.ownersStake.totalMinor).toBe(315_000);
  });

  it("carries January's result forward into a sheet drawn up in February", () => {
    const january = balanceSheet({
      asAt: "2026-01-31",
      totals: totalsIn(MOVEMENTS, null, "2026-01-31"),
    });
    const february = balanceSheet({
      asAt: "2026-02-28",
      totals: totalsIn(MOVEMENTS, null, "2026-02-28"),
    });
    expect(january.accumulatedResultMinor).toBe(110_000);
    expect(february.accumulatedResultMinor).toBeGreaterThan(
      january.accumulatedResultMinor,
    );
  });

  it("still balances at the earlier date", () => {
    const january = balanceSheet({
      asAt: "2026-01-31",
      totals: totalsIn(MOVEMENTS, null, "2026-01-31"),
    });
    expect(january.balances).toBe(true);
    expect(january.owned.totalMinor).toBe(
      january.owed.totalMinor + january.ownersStake.totalMinor,
    );
  });
});

describe("the result for a period agrees with the profit and loss for it (SC-007)", () => {
  it("matches, taking one balance sheet from the next", () => {
    const openingSheet = balanceSheet({
      asAt: "2026-01-31",
      totals: totalsIn(MOVEMENTS, null, "2026-01-31"),
    });
    const closingSheet = balanceSheet({
      asAt: "2026-02-28",
      totals: totalsIn(MOVEMENTS, null, "2026-02-28"),
    });
    const february = profitLoss({
      dateFrom: "2026-02-01",
      dateTo: "2026-02-28",
      totals: totalsIn(MOVEMENTS, "2026-02-01", "2026-02-28"),
    });

    expect(
      closingSheet.accumulatedResultMinor - openingSheet.accumulatedResultMinor,
    ).toBe(february.resultMinor);
    expect(february.resultMinor).toBe(35_000);
  });

  it("matches for the very first period, where there is nothing to carry forward", () => {
    const january = balanceSheet({
      asAt: "2026-01-31",
      totals: totalsIn(MOVEMENTS, null, "2026-01-31"),
    });
    const januaryResult = profitLoss({
      dateFrom: "2026-01-01",
      dateTo: "2026-01-31",
      totals: totalsIn(MOVEMENTS, "2026-01-01", "2026-01-31"),
    });
    expect(january.accumulatedResultMinor).toBe(januaryResult.resultMinor);
  });
});

describe("money a partner took out", () => {
  it("reduces what the owners have in it", () => {
    const sheet = balanceSheet({
      asAt: "2026-02-28",
      totals: totalsIn(MOVEMENTS, null, "2026-02-28"),
    });
    const drawings = sheet.ownersStake.lines.find(
      (l) => l.accountId === DRAWINGS,
    );
    const putIn = sheet.ownersStake.lines.find((l) => l.accountId === CAPITAL);
    expect(putIn?.amountMinor).toBe(200_000);
    expect(drawings?.amountMinor).toBe(-30_000);
  });
});

describe("the same inputs twice", () => {
  it("give the same answer", () => {
    const input = {
      asAt: "2026-02-28",
      totals: totalsIn(MOVEMENTS, null, "2026-02-28"),
    };
    expect(balanceSheet(input)).toEqual(balanceSheet(input));
  });

  it("give the same totals whatever order the accounts arrive in", () => {
    const totals = totalsIn(MOVEMENTS, null, "2026-02-28");
    const forwards = balanceSheet({ asAt: "2026-02-28", totals });
    const backwards = balanceSheet({
      asAt: "2026-02-28",
      totals: [...totals].reverse(),
    });
    expect(backwards.owned.totalMinor).toBe(forwards.owned.totalMinor);
    expect(backwards.owed.totalMinor).toBe(forwards.owed.totalMinor);
    expect(backwards.ownersStake.totalMinor).toBe(
      forwards.ownersStake.totalMinor,
    );
    expect(backwards.accumulatedResultMinor).toBe(
      forwards.accumulatedResultMinor,
    );
  });
});

describe("books that do not add up", () => {
  it("says so, and by how much", () => {
    // A movement whose other side went missing — 100 of it.
    const broken = totalsIn(MOVEMENTS, null, "2026-02-28").map((t) =>
      t.accountId === BANK ? { ...t, amountMinor: t.amountMinor + 10_000 } : t,
    );
    const sheet = balanceSheet({ asAt: "2026-02-28", totals: broken });
    expect(sheet.balances).toBe(false);
    expect(sheet.differenceMinor).toBe(10_000);
  });

  it("warns the reader in plain words before they send it to anyone", () => {
    const broken = totalsIn(MOVEMENTS, null, "2026-02-28").map((t) =>
      t.accountId === BANK ? { ...t, amountMinor: t.amountMinor + 10_000 } : t,
    );
    const sheet = balanceSheet({ asAt: "2026-02-28", totals: broken });
    expect(
      sheet.notes.some((n) => /out of balance/i.test(n)),
    ).toBe(true);
  });
});

describe("a sheet drawn up over history the app never kept", () => {
  it("says so in plain words", () => {
    const sheet = balanceSheet({
      asAt: "2026-02-28",
      totals: totalsIn(MOVEMENTS, null, "2026-02-28"),
      trackingStartedOn: "2026-01-01",
    });
    expect(sheet.notes).toHaveLength(1);
    expect(sheet.notes[0]).toMatch(/invoice/i);
  });

  it("says nothing when there is no upgrade date to compare against", () => {
    const sheet = balanceSheet({
      asAt: "2026-02-28",
      totals: totalsIn(MOVEMENTS, null, "2026-02-28"),
    });
    expect(sheet.notes).toEqual([]);
  });
});

function totalOf(
  accountId: number,
  code: number,
  accountName: string,
  type: (typeof AccountType)[keyof typeof AccountType],
  amountMinor: Minor,
  subType: AccountSubTypeCode | null,
): AccountTotal {
  return {
    accountId,
    code,
    accountName,
    type,
    role: AccountRole.Bank,
    subType,
    contactId: null,
    amountMinor,
  };
}

describe("Current / Non-current subsections", () => {
  it("splits assets into current, non-current (equipment) and needs review", () => {
    const sheet = balanceSheet({
      asAt: "2026-03-31",
      totals: [
        totalOf(101, 1000, "Bank", AccountType.Asset, 500_00, AccountSubType.Bank),
        totalOf(102, 1500, "Van", AccountType.Asset, 900_00, AccountSubType.Equipment),
        totalOf(103, 1400, "Clearing", AccountType.Asset, 100_00, null),
      ],
    });
    const bySubsection = (label: string) =>
      sheet.owned.subsections?.find((s) => s.label === label);
    expect(bySubsection("Current")?.lines.map((l) => l.accountId)).toEqual([
      101,
    ]);
    expect(bySubsection("Non-current")?.lines.map((l) => l.accountId)).toEqual(
      [102],
    );
    expect(bySubsection("Unclassified")?.lines.map((l) => l.accountId)).toEqual(
      [103],
    );
    const subsectionTotal = (sheet.owned.subsections ?? []).reduce(
      (sum, s) => sum + s.totalMinor,
      0,
    );
    expect(subsectionTotal).toBe(sheet.owned.totalMinor);
  });

  it("splits liabilities into current, non-current (long-term loan) and needs review", () => {
    const sheet = balanceSheet({
      asAt: "2026-03-31",
      totals: [
        totalOf(
          201,
          2000,
          "Accounts Payable",
          AccountType.Liability,
          -25_000,
          LiabilitySubType.AccountsPayable,
        ),
        totalOf(
          202,
          2200,
          "Long-term Loan",
          AccountType.Liability,
          -500_000,
          LiabilitySubType.LongTermLoan,
        ),
        totalOf(
          203,
          2100,
          "Loans",
          AccountType.Liability,
          -10_000,
          null,
        ),
      ],
    });
    const bySubsection = (label: string) =>
      sheet.owed.subsections?.find((s) => s.label === label);
    expect(bySubsection("Current")?.lines.map((l) => l.accountId)).toEqual([
      201,
    ]);
    expect(bySubsection("Non-current")?.lines.map((l) => l.accountId)).toEqual(
      [202],
    );
    expect(bySubsection("Unclassified")?.lines.map((l) => l.accountId)).toEqual(
      [203],
    );
    const subsectionTotal = (sheet.owed.subsections ?? []).reduce(
      (sum, s) => sum + s.totalMinor,
      0,
    );
    expect(subsectionTotal).toBe(sheet.owed.totalMinor);
  });

  it("gives owners' stake no subsections at all", () => {
    const sheet = balanceSheet({
      asAt: "2026-02-28",
      totals: totalsIn(MOVEMENTS, null, "2026-02-28"),
    });
    expect(sheet.ownersStake.subsections).toBeUndefined();
  });
});
