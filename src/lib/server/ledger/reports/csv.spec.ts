import { describe, expect, it } from "vitest";
import {
  AccountRole,
  AccountSubType,
  AccountType,
  LedgerRecordKind,
} from "$lib/enums.js";
import {
  accountHistoryCsv,
  balanceSheetCsv,
  partnerStatementCsv,
  profitLossCsv,
  toCsv,
} from "./csv.js";
import type {
  AccountHistoryReport,
  BalanceSheetReport,
  PartnerStatementReport,
  ProfitLossReport,
} from "../types.js";

/** The document split back into its lines, so a test can talk about rows. */
function lines(csv: string): string[] {
  return csv.split("\r\n");
}

describe("the shape of the document", () => {
  it("puts the columns first, in the order they were given", () => {
    const csv = toCsv({
      columns: ["Section", "Account", "Amount"],
      rows: [["Revenue", "Consulting", 1500]],
    });
    expect(lines(csv)[0]).toBe("Section,Account,Amount");
  });

  it("writes one line per row, in the order they were given", () => {
    const csv = toCsv({
      columns: ["A", "B"],
      rows: [
        ["one", 1],
        ["two", 2],
      ],
    });
    expect(lines(csv)).toEqual(["A,B", "one,1", "two,2"]);
  });

  it("writes a table with no rows as just its columns", () => {
    expect(toCsv({ columns: ["A", "B"], rows: [] })).toBe("A,B");
  });
});

describe("escaping", () => {
  it("quotes a field containing a comma", () => {
    const csv = toCsv({ columns: ["A"], rows: [["Tan, Alex"]] });
    expect(lines(csv)[1]).toBe('"Tan, Alex"');
  });

  it("doubles a quote inside a field, and quotes the field", () => {
    const csv = toCsv({ columns: ["A"], rows: [['She said "yes"']] });
    expect(lines(csv)[1]).toBe('"She said ""yes"""');
  });

  it("quotes a field containing a line break, keeping it inside the field", () => {
    const csv = toCsv({ columns: ["A", "B"], rows: [["one\ntwo", "next"]] });
    expect(csv).toBe('A,B\r\n"one\ntwo",next');
  });

  it("quotes a field containing a carriage return", () => {
    const csv = toCsv({ columns: ["A"], rows: [["one\r\ntwo"]] });
    expect(csv).toBe('A\r\n"one\r\ntwo"');
  });

  it("quotes a field with leading or trailing spaces, so they survive", () => {
    const csv = toCsv({ columns: ["A"], rows: [["  padded  "]] });
    expect(lines(csv)[1]).toBe('"  padded  "');
  });

  it("writes an empty field for nothing at all", () => {
    const csv = toCsv({ columns: ["A", "B", "C"], rows: [[null, "", null]] });
    expect(lines(csv)[1]).toBe(",,");
  });
});

describe("text a spreadsheet would run as a formula", () => {
  it.each(["=SUM(A1:A9)", "+1+1", "-2+3", "@SUM(A1)"])(
    "defuses %s so it opens as text, not as a calculation",
    (dangerous) => {
      const csv = toCsv({ columns: ["A"], rows: [[dangerous]] });
      expect(lines(csv)[1]).toBe(`'${dangerous}`);
    },
  );

  it("defuses a leading tab too", () => {
    const csv = toCsv({ columns: ["A"], rows: [["\t=1+1"]] });
    expect(lines(csv)[1]).toBe('"\'\t=1+1"');
  });

  it("leaves a real negative number alone, so it still adds up", () => {
    // Only text can carry a formula. Prefixing -30.00 would turn every amount a
    // business is out of pocket into a word the spreadsheet refuses to sum.
    const csv = toCsv({ columns: ["Amount"], rows: [[-30.5]] });
    expect(lines(csv)[1]).toBe("-30.5");
  });

  it("leaves ordinary text alone", () => {
    const csv = toCsv({ columns: ["A"], rows: [["Consulting"]] });
    expect(lines(csv)[1]).toBe("Consulting");
  });
});

describe("the notes under the table", () => {
  const csv = toCsv({
    columns: ["A"],
    rows: [["one"]],
    notes: [
      "Covers 2026-01-01 to 2026-01-31.",
      "Invoices sent before then are missing.",
    ],
  });

  it("puts a blank line between the table and the notes", () => {
    expect(lines(csv)[2]).toBe("");
  });

  it("writes each note on its own line, as one quoted cell", () => {
    expect(lines(csv)[3]).toBe('"Covers 2026-01-01 to 2026-01-31."');
    expect(lines(csv)[4]).toBe('"Invoices sent before then are missing."');
  });

  it("adds nothing when there are no notes", () => {
    expect(toCsv({ columns: ["A"], rows: [["one"]], notes: [] })).toBe(
      "A\r\none",
    );
  });
});

// ---------------------------------------------------------------------------
// Turning each report into a table
// ---------------------------------------------------------------------------

const PROFIT_LOSS: ProfitLossReport = {
  dateFrom: "2026-01-01",
  dateTo: "2026-01-31",
  income: [{ accountId: 1, accountName: "Consulting", amountMinor: 150_000 }],
  totalIncomeMinor: 150_000,
  expenses: [{ accountId: 2, accountName: "Software", amountMinor: 4_500 }],
  totalExpensesMinor: 4_500,
  resultMinor: 145_500,
  subtotals: [
    { label: "Gross profit", amountMinor: 150_000 },
    { label: "Operating income", amountMinor: 145_500 },
  ],
  notes: ["Invoices sent before 2026-01-01 are not included."],
};

describe("the profit and loss as a table", () => {
  const table = profitLossCsv(PROFIT_LOSS);

  it("names its columns in plain words, in a fixed order", () => {
    expect(table.columns).toEqual(["Section", "Account", "Amount"]);
  });

  it("puts money coming in first, then money going out, then what is left", () => {
    expect(table.rows.map((r) => r[0])).toEqual([
      "Revenue",
      "Revenue",
      "Expenses",
      "Expenses",
      "Net profit (loss)",
    ]);
  });

  it("writes amounts as ordinary decimals a spreadsheet can add", () => {
    expect(table.rows[0]).toEqual(["Revenue", "Consulting", 1500]);
    expect(table.rows[4]).toEqual(["Net profit (loss)", "Net profit", 1455]);
  });

  it("says what period it covers, and carries the report's own notes", () => {
    expect(table.notes?.[0]).toMatch(/2026-01-01/);
    expect(table.notes).toContain(
      "Invoices sent before 2026-01-01 are not included.",
    );
  });
});

const BALANCE_SHEET: BalanceSheetReport = {
  asAt: "2026-02-28",
  owned: {
    lines: [{ accountId: 1, accountName: "Bank", amountMinor: 340_000 }],
    totalMinor: 340_000,
  },
  owed: {
    lines: [{ accountId: 3, accountName: "Money we owe", amountMinor: 25_000 }],
    totalMinor: 25_000,
  },
  ownersStake: {
    lines: [
      {
        accountId: 4,
        accountName: "Alex — money put in",
        amountMinor: 200_000,
      },
      {
        accountId: 5,
        accountName: "Alex — money taken out",
        amountMinor: -30_000,
      },
      {
        accountId: 0,
        accountName: "Current earnings",
        amountMinor: 145_000,
      },
    ],
    totalMinor: 315_000,
  },
  accumulatedResultMinor: 145_000,
  balances: true,
  differenceMinor: 0,
  notes: [],
};

describe("the balance sheet as a table", () => {
  const table = balanceSheetCsv(BALANCE_SHEET);

  it("names its columns in plain words, in a fixed order", () => {
    expect(table.columns).toEqual(["Section", "Account", "Amount"]);
  });

  it("runs owns, then owes, then what the owners have in it, each with a total", () => {
    expect(table.rows.map((r) => r[0])).toEqual([
      "Assets",
      "Assets",
      "Liabilities",
      "Liabilities",
      "Equity",
      "Equity",
      "Equity",
      "Equity",
    ]);
    expect(table.rows[1]).toEqual(["Assets", "Total", 3400]);
  });

  it("says the date it was drawn up at", () => {
    expect(table.notes?.[0]).toMatch(/2026-02-28/);
  });
});

const PARTNER_STATEMENT: PartnerStatementReport = {
  dateFrom: "2026-01-01",
  dateTo: "2026-12-31",
  partners: [
    {
      contactId: 1,
      contactName: "Alex Tan",
      contributionsMinor: 500_000,
      shareOfResultMinor: 45_001,
      drawingsMinor: 120_000,
      netMinor: 425_001,
    },
  ],
  notes: ["The result is split equally between the partners."],
};

describe("the partner statement as a table", () => {
  const table = partnerStatementCsv(PARTNER_STATEMENT);

  it("names its columns in plain words, in a fixed order", () => {
    expect(table.columns).toEqual([
      "Partner",
      "Contributions",
      "Share of profit",
      "Drawings",
      "Closing balance",
    ]);
  });

  it("writes one row per partner, with amounts as decimals", () => {
    expect(table.rows).toEqual([["Alex Tan", 5000, 450.01, 1200, 4250.01]]);
  });

  it("carries the report's own notes", () => {
    expect(table.notes).toContain(
      "The result is split equally between the partners.",
    );
  });
});

const ACCOUNT_HISTORY: AccountHistoryReport = {
  account: {
    id: 1,
    role: AccountRole.Bank,
    subType: AccountSubType.Bank,
    name: "Bank",
    contactId: null,
    isSystem: false,
    rank: "a",
    archivedAt: null,
    type: AccountType.Asset,
    balanceMinor: 120_000,
    movementCount: 1,
    canDelete: false,
    cannotDeleteReason: null,
  },
  entries: [
    {
      movementId: 9,
      recordId: 4,
      recordNumber: "EXP-0001",
      date: "2026-01-20",
      kind: LedgerRecordKind.Income,
      description: "Design work",
      contactName: "Acme Sdn Bhd",
      amountMinor: 20_000,
      runningBalanceMinor: 120_000,
    },
  ],
  openingBalanceMinor: 100_000,
  closingBalanceMinor: 120_000,
  total: 1,
  notes: [],
};

describe("an account's history as a table", () => {
  const table = accountHistoryCsv(ACCOUNT_HISTORY);

  it("names its columns in plain words, in a fixed order", () => {
    expect(table.columns).toEqual([
      "Date",
      "Reference",
      "Description",
      "Contact",
      "Amount",
      "Running balance",
    ]);
  });

  it("opens with what the account already held before the first line shown", () => {
    expect(table.rows[0]).toEqual([
      "",
      "",
      "Balance brought forward",
      "",
      null,
      1000,
    ]);
  });

  it("writes one row per movement, with its running balance", () => {
    expect(table.rows[1]).toEqual([
      "2026-01-20",
      "EXP-0001",
      "Design work",
      "Acme Sdn Bhd",
      200,
      1200,
    ]);
  });

  it("says which account it is", () => {
    expect(table.notes?.[0]).toMatch(/Bank/);
  });
});

describe("an exported history reads the same way round as the screen", () => {
  /** The same history, but on an account that accumulates negative. */
  const OWED: AccountHistoryReport = {
    ...ACCOUNT_HISTORY,
    account: {
      ...ACCOUNT_HISTORY.account,
      role: AccountRole.Payable,
      type: AccountType.Liability,
      name: "Money we owe",
    },
    openingBalanceMinor: -100_000,
    entries: [
      { ...ACCOUNT_HISTORY.entries[0], amountMinor: -20_000, runningBalanceMinor: -120_000 },
    ],
    closingBalanceMinor: -120_000,
  };

  const owedTable = accountHistoryCsv(OWED);

  it("shows money we owe as a positive figure, as the screen does", () => {
    // The screen renders this account through `displaySign`, so it reads
    // "we owe 1,200". An export that said -1200.00 for the same rows would be
    // the one thing an export must never do — disagree with what it exported.
    expect(owedTable.rows[0][5]).toBe(1000);
    expect(owedTable.rows[1][4]).toBe(200);
    expect(owedTable.rows[1][5]).toBe(1200);
  });

  it("leaves an account that already reads positive alone", () => {
    // A bank account is stored the way a reader expects, so nothing is flipped
    // — proving the rule is the role's, not a blanket negation.
    const bankTable = accountHistoryCsv(ACCOUNT_HISTORY);
    expect(bankTable.rows[1][4]).toBe(200);
    expect(bankTable.rows[1][5]).toBe(1200);
  });
});
