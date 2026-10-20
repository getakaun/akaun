// Test-only: a made-up marketplace wallet report of any size, and the table
// layout and sections that read it from its columns (006 S4.5). The shape
// follows the real report (a heading block, the summary totals, the table's
// headings at row 18, one row per transaction); every value is invented.
// A profile made of these reads Every transaction: give it that mode, as the
// layout's stated total labels are kept under it. Nothing in the app imports
// this file.
import type {
  ProfileSection,
  TableLayout,
} from "$lib/import-profile-schema.js";
import {
  buildXlsx,
  type FixtureCell,
} from "../../extraction/spreadsheet/__fixtures__/build-xlsx.js";

export const WALLET_HEADERS = [
  "Date",
  "Transaction Type",
  "Description",
  "Order ID",
  "Money Direction",
  "Amount",
  "Status",
  "Balance After Transactions",
];

/** How many rows of each kind the made-up report lists. */
export interface WalletCounts {
  orderIn: number;
  orderOut: number;
  adjustIn: number;
  adjustOut: number;
  /** Withdrawals that went through. */
  withdrawals: number;
  /** Withdrawals still "Processing". */
  processing: number;
}

/** The real report's mix: 736 rows, 10 of them withdrawals, one processing. */
export const REPORT_COUNTS: WalletCounts = {
  orderIn: 717,
  orderOut: 2,
  adjustIn: 6,
  adjustOut: 1,
  withdrawals: 9,
  processing: 1,
};

export interface WalletWorkbook {
  xlsx: Buffer;
  /** Whole cents. */
  moneyInMinor: number;
  moneyOutMinor: number;
  rows: number;
  /** Excel row number of the headings. */
  headerRow: number;
}

function money(minor: number): { raw: string } {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  return {
    raw: `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`,
  };
}

/**
 * A wallet report with these many rows of each kind, newest first, with
 * made-up amounts that are the same on every run. The summary block states
 * the true totals of money in and out.
 */
export function walletWorkbook(
  counts: WalletCounts = REPORT_COUNTS,
): WalletWorkbook {
  type Row = {
    type: string;
    desc: string;
    ref: string;
    minor: number;
    status: string;
  };
  const rows: Row[] = [];
  for (let i = 0; i < counts.orderIn; i++) {
    rows.push({
      type: "Order Income",
      desc: `Income from Order #T${i}`,
      ref: `T${String(i).padStart(5, "0")}`,
      minor: 100 + ((i * 37) % 2400),
      status: "Transaction Completed",
    });
  }
  for (let i = 0; i < counts.orderOut; i++) {
    rows.push({
      type: "Order Income",
      desc: `Refund for Order #R${i}`,
      ref: `R${String(i).padStart(5, "0")}`,
      minor: -(55 + i * 10),
      status: "Transaction Completed",
    });
  }
  for (let i = 0; i < counts.adjustIn; i++) {
    rows.push({
      type: "Adjustment",
      desc: `Compensation ${i}`,
      ref: `J${i}`,
      minor: 230 + i * 11,
      status: "Transaction Completed",
    });
  }
  for (let i = 0; i < counts.adjustOut; i++) {
    rows.push({
      type: "Adjustment",
      desc: `Shipping fee adjustment ${i}`,
      ref: `K${i}`,
      minor: -(310 + i),
      status: "Transaction Completed",
    });
  }
  for (let i = 0; i < counts.withdrawals + counts.processing; i++) {
    rows.push({
      type: "Withdrawals",
      desc: "Withdrawal to bank",
      ref: "",
      minor: -(50_000 + i * 1_000),
      status: i < counts.processing ? "Processing" : "Transaction Completed",
    });
  }
  // Mixed in date order, the way the report lists them.
  const ordered = rows
    .map((row, index) => ({ row, key: (index * 7919) % rows.length }))
    .sort((a, b) => a.key - b.key)
    .map(({ row }) => row);

  let balance = 10_000;
  const transactions: FixtureCell[][] = ordered.map((row, index) => {
    balance += row.minor;
    const day = 29 - Math.floor((index * 28) / Math.max(ordered.length, 1));
    const second = String(index % 60).padStart(2, "0");
    return [
      `2026-03-${String(day).padStart(2, "0")} 10:${String(index % 60).padStart(2, "0")}:${second}`,
      row.type,
      row.desc,
      row.ref,
      row.minor < 0 ? "Money Out" : "Money In",
      money(row.minor),
      row.status,
      money(balance),
    ];
  });
  const moneyInMinor = rows
    .filter((row) => row.minor > 0)
    .reduce((sum, row) => sum + row.minor, 0);
  const moneyOutMinor = rows
    .filter((row) => row.minor < 0)
    .reduce((sum, row) => sum + row.minor, 0);
  const blank = ["", "", "", "", "", "", "", ""];
  const sheetRows: (FixtureCell[] | null)[] = [
    ["Report", "", "", "", "", "", "", ""],
    blank,
    blank,
    blank,
    ["Account Info", "", "", "", "", "", "", ""],
    ["Username (Seller)", "example.shop", "", ""],
    ["From", "2026-03-01", "", ""],
    ["To", "2026-03-29", "", ""],
    ["** A note about the export."],
    null,
    ["Summary", "", "", "", "$", "Currency", "No. of Transactions", ""],
    ["Total Money In", "", "", "", money(moneyInMinor), "MYR", { raw: "1" }],
    ["Total Money Out", "", "", "", money(moneyOutMinor), "MYR", { raw: "1" }],
    null,
    null,
    ["Transaction Details", "", "", "", "", "", "", ""],
    null,
    WALLET_HEADERS,
    ...transactions,
  ];
  return {
    xlsx: buildXlsx({
      sheets: [{ name: "Transaction Report", rows: sheetRows }],
    }),
    moneyInMinor,
    moneyOutMinor,
    rows: transactions.length,
    headerRow: 18,
  };
}

/** The wallet report's table layout. */
export function walletLayout(over: Partial<TableLayout> = {}): TableLayout {
  return {
    headers: [...WALLET_HEADERS],
    columns: {
      date: "Date",
      description: "Description",
      amount: "Amount",
      reference: "Order ID",
    },
    dateFormat: "YYYY-MM-DD",
    direction: {
      column: "Money Direction",
      in: ["Money In"],
      out: ["Money Out"],
    },
    decimalSeparator: ".",
    csvDelimiter: null,
    counterparty: "Example Marketplace",
    currency: "MYR",
    documentDateLabel: "To",
    statedTotalLabels: {
      every_transaction: ["Total Money In", "Total Money Out"],
    },
    ...over,
  };
}

/** The withdrawals to the bank, each flagged while it is not completed. */
export function withdrawalSection(bankId: number): ProfileSection {
  return {
    key: "withdrawals",
    name: "Withdrawals",
    description: "Each withdrawal to the bank.",
    kind: "transfer",
    fixedCategoryAccountId: null,
    feeTypes: [],
    extras: null,
    counterAccountId: bankId,
    rows: {
      where: [
        {
          column: "Transaction Type",
          op: "is_one_of",
          values: ["Withdrawals", "Withdrawal"],
        },
      ],

      feeTypeColumn: null,
    },
  };
}

/** Every other row: order income and adjustments, income or expense by sign. */
export function orderSections(
  categories: { orders?: number | null; adjustments?: number | null } = {},
): ProfileSection[] {
  return [
    {
      key: "orders",
      name: "Order income",
      description: "Each order paid into the wallet, and each refund.",
      kind: "by_sign",
      fixedCategoryAccountId: categories.orders ?? null,
      feeTypes: [],
      extras: null,
      rows: {
        where: [
          { column: "Transaction Type", op: "is", value: "Order Income" },
        ],

        feeTypeColumn: null,
      },
    },
    {
      key: "adjustments",
      name: "Adjustments",
      description: "Each adjustment the marketplace made.",
      kind: "by_sign",
      fixedCategoryAccountId: categories.adjustments ?? null,
      feeTypes: [],
      extras: null,
      rows: {
        where: [{ column: "Transaction Type", op: "is", value: "Adjustment" }],

        feeTypeColumn: null,
      },
    },
  ];
}
