import { describe, expect, it } from "vitest";
import { DocumentType } from "$lib/enums.js";
import {
  checkProfile,
  type ImportProfileDraft,
  type ProfileSection,
  type TableLayout,
  type RowCondition,
} from "$lib/import-profile-schema.js";
import {
  IGNORED_LINES_MAX,
  ImportMode,
  ignoredSummary,
} from "$lib/import-reading.js";
import { numberDocumentLines } from "../extraction/document-text.js";
import {
  buildXlsx,
  walletReportFixture,
  type FixtureCell,
} from "../extraction/spreadsheet/__fixtures__/build-xlsx.js";
import { readCsv } from "../extraction/spreadsheet/csv.js";
import { renderWorkbook } from "../extraction/spreadsheet/render.js";
import { readXlsx } from "../extraction/spreadsheet/xlsx.js";
import type { Workbook } from "../extraction/spreadsheet/types.js";
import { previewTable } from "./table-preview.js";
import { DocumentLimitError } from "./document-reader.js";
import { savedReadingProfile } from "./profile-compiler.js";
import {
  WALLET_HEADERS,
  orderSections,
  walletLayout,
  walletWorkbook,
  withdrawalSection,
} from "./__fixtures__/wallet-table.js";
import {
  TableReadError,
  columnsReadingId,
  findTable,
  parseTableAmount,
  parseTableDate,
  readFromColumns,
  readTable,
  withoutTableRows,
} from "./table-reader.js";

/**
 * Reading a spreadsheet's table from its columns, by code (006 FR-053 to
 * FR-056). Every workbook is built in memory, and every value is made up:
 * the wallet report's shape, never its figures.
 */

const BANK = 41;
const EVERY = ImportMode.EveryTransaction;

function draft(
  sections: ProfileSection[],
  layout: TableLayout = walletLayout(),
): ImportProfileDraft {
  return {
    name: "Wallet report",
    description: "A marketplace wallet report.",
    phrases: [],
    instructions: "",
    mode: EVERY,
    statedTotalLabels: {},
    accountId: 40,
    layout,
    sections,
  };
}

const full = () => draft([...orderSections(), withdrawalSection(BANK)]);
const withdrawalsOnly = () =>
  draft([withdrawalSection(BANK)], walletLayout({ statedTotalLabels: {} }));

function read(workbook: Workbook, profile: ImportProfileDraft) {
  // The profile the tests read with is one the shared check accepts.
  const checked = checkProfile(profile);
  if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
  const saved = { id: 7, ...checked.profile };
  const reading = savedReadingProfile(saved);
  return readFromColumns(
    workbook,
    {
      name: saved.name,
      mode: saved.mode,
      layout: saved.layout!,
      sections: saved.sections,
    },
    reading,
    { today: "2026-10-02", mainCurrency: "MYR", schemaId: "columns:test" },
  );
}

/** A small workbook: headings in row 1, then these rows. */
function small(rows: (FixtureCell[] | null)[], headers = WALLET_HEADERS) {
  return readXlsx(
    buildXlsx({ sheets: [{ name: "Report", rows: [headers, ...rows] }] }),
  );
}

function row(
  over: Partial<Record<(typeof WALLET_HEADERS)[number], FixtureCell>> = {},
): FixtureCell[] {
  const values: Record<string, FixtureCell> = {
    Date: "2026-03-10 09:00:00",
    "Transaction Type": "Order Income",
    Description: "Income from order",
    "Order ID": "O1",
    "Money Direction": "Money In",
    Amount: { raw: "10.00" },
    Status: "Transaction Completed",
    "Balance After Transactions": { raw: "100.00" },
    ...over,
  };
  return WALLET_HEADERS.map((heading) => values[heading]);
}

const noTotals = walletLayout({
  statedTotalLabels: {},
  documentDateLabel: null,
});

describe("parseTableAmount", () => {
  const ok = (text: string, separator: "." | "," = ".") => {
    const result = parseTableAmount(text, separator);
    return result.ok ? result.minor : result.reason;
  };

  it("reads exact decimals in whole cents, with every way of writing a minus", () => {
    expect(ok("12.50")).toBe(1250);
    expect(ok("0.10")).toBe(10);
    expect(ok("-10228.11")).toBe(-1022811);
    expect(ok("(12.50)")).toBe(-1250);
    expect(ok("\u221212.50")).toBe(-1250);
    expect(ok("12.50-")).toBe(-1250);
    expect(ok("+3")).toBe(300);
    expect(ok("4.810")).toBe(481);
  });

  it("reads thousands and currencies, by the layout's decimal separator", () => {
    expect(ok("1,234.56")).toBe(123456);
    expect(ok("1.234,56", ",")).toBe(123456);
    expect(ok("1 234,5", ",")).toBe(123450);
    expect(ok("1'234.56")).toBe(123456);
    expect(ok("RM 12.50")).toBe(1250);
    expect(ok("-RM12.50")).toBe(-1250);
    expect(ok("MYR -12.50")).toBe(-1250);
    expect(ok("12.50 MYR")).toBe(1250);
    // A very large figure keeps every cent: it is never a binary number.
    expect(ok("98765432109.87")).toBe(9876543210987);
  });

  it("refuses what it cannot read exactly, rather than guess", () => {
    // A decimal comma in a file whose separator is a point is not 1,250.
    expect(ok("12,50")).toBe("is not an amount");
    expect(ok("1,23,456.00")).toBe("is not an amount");
    expect(ok("4.815")).toMatch(/more than two decimal places/);
    expect(ok("abc")).toBe("is not an amount");
    expect(ok("--1")).toBe("is not an amount");
    expect(ok("(-1)")).toBe("is not an amount");
    expect(ok("1.2.3")).toBe("is not an amount");
    expect(ok("  ")).toBe("is empty");
  });

  it("takes only a plain currency as the letters around a figure", () => {
    // Debit and credit marks would lose the sign; a suffix, its multiplier.
    for (const text of [
      "5.00 DR",
      "5.00 CR",
      "DR 5.00",
      "12.5k",
      "1.2M",
      "e5",
      "x12",
      "USD12.00abc",
      "rm 12.50",
      "RM MYR 12.50",
      "12.50 MYR RM",
      "MYRS 12.50",
    ]) {
      expect(ok(text), text).toBe("is not an amount");
    }
    expect(ok("$12.50")).toBe(1250);
    expect(ok("US$ 12.50")).toBe(1250);
    expect(ok("\u20ac-3")).toBe(-300);
    expect(ok("RM 12.50 -")).toBe(-1250);
    expect(ok("RM 1.00 MYR")).toBe(100);
  });

  it("refuses a code that is not the currency the amounts are in", () => {
    expect(parseTableAmount("USD 12.00", ".", "MYR")).toEqual({
      ok: false,
      reason: "is in USD, not MYR",
    });
    expect(parseTableAmount("12.00 MYR", ".", "MYR")).toEqual({
      ok: true,
      minor: 1200,
    });
    // A symbol, or RM, says too little to refuse.
    expect(parseTableAmount("$12.00", ".", "MYR")).toEqual({
      ok: true,
      minor: 1200,
    });
  });
});

describe("parseTableDate", () => {
  it("takes a date cell as it is, and text by the layout's format", () => {
    expect(
      parseTableDate(
        { kind: "date", text: "2026-09-29 08:47:57" },
        "DD/MM/YYYY",
      ),
    ).toBe("2026-09-29");
    expect(
      parseTableDate(
        { kind: "string", text: "2026-09-29 08:47:57" },
        "YYYY-MM-DD",
      ),
    ).toBe("2026-09-29");
    expect(
      parseTableDate(
        { kind: "string", text: "2026-09-29T08:47:57" },
        "YYYY-MM-DD",
      ),
    ).toBe("2026-09-29");
    expect(
      parseTableDate({ kind: "string", text: "29/09/2026" }, "DD/MM/YYYY"),
    ).toBe("2026-09-29");
    expect(
      parseTableDate(
        { kind: "string", text: "9/5/2026 9:05 PM" },
        "MM/DD/YYYY",
      ),
    ).toBe("2026-09-05");
    expect(
      parseTableDate({ kind: "string", text: "05.09.2026" }, "DD.MM.YYYY"),
    ).toBe("2026-09-05");
  });

  it("refuses a date that is not real, not in the format, or only a number", () => {
    expect(
      parseTableDate({ kind: "string", text: "31/02/2026" }, "DD/MM/YYYY"),
    ).toBeNull();
    expect(
      parseTableDate({ kind: "string", text: "2026-09-29" }, "DD/MM/YYYY"),
    ).toBeNull();
    expect(
      parseTableDate({ kind: "string", text: "29 Sep 2026" }, "YYYY-MM-DD"),
    ).toBeNull();
    expect(
      parseTableDate(
        { kind: "number", raw: "46294", value: 46294 },
        "YYYY-MM-DD",
      ),
    ).toBeNull();
    expect(
      parseTableDate({ kind: "date", text: "08:47:57" }, "YYYY-MM-DD"),
    ).toBeNull();
    expect(parseTableDate(null, "YYYY-MM-DD")).toBeNull();
  });
});

describe("findTable", () => {
  it("finds the headings in any row, ignoring case and spacing", () => {
    const workbook = readXlsx(walletReportFixture().xlsx);
    const found = findTable(workbook, walletLayout().headers);
    expect(found?.sheet.rows[found.headerAt].number).toBe(18);
    expect(found?.columns.get("amount")).toBe(5);
    expect(
      findTable(workbook, ["  DATE ", "money   direction"]),
    ).not.toBeNull();
  });

  it("reads a visible sheet's table before a hidden sheet's", () => {
    const workbook = readXlsx(
      buildXlsx({
        sheets: [
          { name: "Old", state: "hidden", rows: [["Date", "Amount"]] },
          { name: "Report", rows: [["Note"], ["Date", "Amount"]] },
        ],
      }),
    );
    expect(findTable(workbook, ["Date", "Amount"])?.sheet.name).toBe("Report");
  });

  it("finds nothing when a heading is missing", () => {
    const workbook = readXlsx(walletReportFixture().xlsx);
    expect(findTable(workbook, ["Date", "Fee"])).toBeNull();
  });
});

describe("readFromColumns", () => {
  it("reads every row of the wallet report into one item each, with no AI (FR-055)", () => {
    const fixture = walletReportFixture();
    const workbook = readXlsx(fixture.xlsx);
    const reading = read(workbook, full());

    expect(reading.items).toHaveLength(fixture.transactions);
    expect(reading.items.map((item) => [item.sectionKey, item.kind])).toEqual([
      ["orders", DocumentType.Income],
      ["orders", DocumentType.Income],
      ["withdrawals", DocumentType.TransferOut],
      ["adjustments", DocumentType.Expense],
      ["orders", DocumentType.Expense],
      ["adjustments", DocumentType.Income],
      ["withdrawals", DocumentType.TransferOut],
      ["orders", DocumentType.Income],
    ]);
    // The control total compares the rows with Total Money In plus Total
    // Money Out, both read beside their labels and added up in code.
    expect(reading.notes.statedTotal).toEqual({
      minor: 5415 + fixture.moneyOutCents,
      currency: "MYR",
    });
    expect(reading.controlTotal).toEqual({ matches: true, differenceMinor: 0 });
    expect(reading.notes.method).toBe("columns");
    expect(reading.notes.ignoredCount).toBe(0);
    expect(reading.notes.ignored).toEqual([]);
    expect(reading.counterparty).toBe("Example Marketplace");
    expect(reading.currency).toBe("MYR");
    // The document's date is the one printed beside "To".
    expect(reading.date).toBe("2026-03-29");
  });

  it("keeps each row's own date and reference, never the document's (FR-062)", () => {
    const reading = read(readXlsx(walletReportFixture().xlsx), full());
    const [first, , withdrawal] = reading.items;
    expect(first).toMatchObject({
      description: "Income from Order #A1",
      amountMinor: 1250,
      amount: 12.5,
      date: "2026-03-29",
      reference: "A1",
      counterAccountId: null,
    });
    expect(withdrawal).toMatchObject({
      reference: "",
      date: "2026-03-28",
      amountMinor: 10000,
      counterAccountId: BANK,
    });
  });

  it("keeps withdrawals without profile review flags", () => {
    const reading = read(readXlsx(walletReportFixture().xlsx), full());
    expect(reading.items.filter((item) => item.reviewNote)).toHaveLength(0);
    expect(
      reading.items.some((item) => item.kind === DocumentType.TransferOut),
    ).toBe(true);
  });

  it("gives each item the line its row has in the numbered text (FR-051)", () => {
    const workbook = readXlsx(walletReportFixture().xlsx);
    const numbered = numberDocumentLines(renderWorkbook(workbook).pages);
    const byLine = new Map(
      numbered
        .split("\n")
        .map((line) => /^L(\d+)│(.*)$/.exec(line))
        .filter((match) => match !== null)
        .map((match) => [Number(match[1]), match[2]]),
    );
    for (const item of read(workbook, full()).items) {
      expect(item.sourceLine).not.toBeNull();
      expect(byLine.get(item.sourceLine!)).toContain(item.description);
    }
  });

  it("leaves out and counts the rows no section takes, with no control total when none is named", () => {
    const reading = read(
      readXlsx(walletReportFixture().xlsx),
      withdrawalsOnly(),
    );
    expect(reading.items.map((item) => item.kind)).toEqual([
      DocumentType.TransferOut,
      DocumentType.TransferOut,
    ]);
    expect(reading.notes.ignoredCount).toBe(6);
    // As a reviewer finds the row in Excel, cut to the kept length.
    expect(reading.notes.ignored[0]).toMatch(
      /^Row 19: 2026-03-29 10:15:02 \| Order Income \| Income from Order #A1 \| A1 \| Money In \| 12\.50 \| Transaction Completed/,
    );
    expect(reading.notes.statedTotal).toBeNull();
    expect(reading.controlTotal).toBeNull();
  });

  it("reads a report the size of the real one: 736 rows, 10 withdrawals, one still processing", () => {
    const report = walletWorkbook();
    const workbook = readXlsx(report.xlsx);
    expect(report.rows).toBe(736);

    const all = read(workbook, full());
    expect(all.items).toHaveLength(736);
    const transfers = all.items.filter(
      (item) => item.kind === DocumentType.TransferOut,
    );
    expect(transfers).toHaveLength(10);
    expect(all.items.length - transfers.length).toBe(726);
    expect(all.items.filter((item) => item.reviewNote)).toHaveLength(0);
    expect(all.notes.statedTotal?.minor).toBe(
      report.moneyInMinor + report.moneyOutMinor,
    );
    expect(all.controlTotal).toEqual({ matches: true, differenceMinor: 0 });

    const withdrawals = read(workbook, withdrawalsOnly());
    expect(withdrawals.items).toHaveLength(10);
    expect(withdrawals.items.filter((item) => item.reviewNote)).toHaveLength(0);
    expect(withdrawals.notes.ignoredCount).toBe(726);
    expect(withdrawals.notes.ignored).toHaveLength(IGNORED_LINES_MAX);
    expect(ignoredSummary(withdrawals.notes)).toBe(
      "Ignored 726 lines (20 shown)",
    );
    expect(withdrawals.controlTotal).toBeNull();
  });

  it("counts the item limit after the rows no section takes are left out (FR-010)", () => {
    const report = walletWorkbook({
      orderIn: 1001,
      orderOut: 0,
      adjustIn: 0,
      adjustOut: 0,
      withdrawals: 3,
      processing: 0,
    });
    const workbook = readXlsx(report.xlsx);
    expect(read(workbook, withdrawalsOnly()).items).toHaveLength(3);
    expect(() => read(workbook, full())).toThrow(DocumentLimitError);
    expect(() => read(workbook, full())).toThrow(
      /1,004 rows fit its sections, and the limit is 1,000/,
    );
  });

  it("fails, naming the row, when a row fits two sections", () => {
    const sections = orderSections();
    sections[1].rows!.where = [
      { column: "Transaction Type", op: "contains", value: "income" },
    ];
    expect(() =>
      read(readXlsx(walletReportFixture().xlsx), draft(sections)),
    ).toThrow(
      'Row 19 fits the row rules of more than one section: "Order income" and "Adjustments". Change the rules so that each row fits one section only.',
    );
  });

  it("fails, naming the row and column, for an amount or a date it cannot read", () => {
    const profile = draft(orderSections(), noTotals);
    expect(() =>
      read(small([row(), row({ Amount: "twelve" })]), profile),
    ).toThrow(
      new TableReadError(
        'Row 3, column F ("Amount"): "twelve" is not an amount.',
      ),
    );
    expect(() => read(small([row({ Amount: "" })]), profile)).toThrow(
      'Row 2, column F ("Amount") is empty: every row a section takes needs an amount.',
    );
    expect(() => read(small([row({ Date: "31/02/2026" })]), profile)).toThrow(
      'Row 2, column A ("Date"): "31/02/2026" is not a date written as YYYY-MM-DD.',
    );
    expect(() =>
      read(small([row({ "Money Direction": "Pending" })]), profile),
    ).toThrow(
      'Row 2, column E ("Money Direction"): "Pending" is neither an inflow value (Money In) nor an outflow value (Money Out).',
    );
  });

  it("does not check the date or amount of a row no section takes", () => {
    const reading = read(
      small([row(), row({ "Transaction Type": "Other", Amount: "n/a" })]),
      draft(orderSections(), noTotals),
    );
    expect(reading.items).toHaveLength(1);
    expect(reading.notes.ignoredCount).toBe(1);
  });

  it("gives the amount its sign from the direction column", () => {
    const reading = read(
      small([
        row({ Amount: { raw: "5.00" }, "Money Direction": "Money Out" }),
        row({ Amount: { raw: "-7.00" }, "Money Direction": "money in" }),
      ]),
      draft(orderSections(), noTotals),
    );
    expect(reading.items.map((item) => [item.kind, item.amountMinor])).toEqual([
      [DocumentType.Expense, 500],
      [DocumentType.Income, 700],
    ]);
  });

  it("ends the table at the first blank row, and still finds the totals below it", () => {
    const workbook = small(
      [
        row(),
        row({ Amount: { raw: "2.00" } }),
        ["", "", ""],
        row({ Amount: "not read" }),
        null,
        ["Total Money In", "", { raw: "12.00" }],
      ],
      WALLET_HEADERS,
    );
    const reading = read(
      workbook,
      draft(
        orderSections(),
        walletLayout({
          documentDateLabel: null,
          statedTotalLabels: { every_transaction: ["Total Money In"] },
        }),
      ),
    );
    expect(reading.items.map((item) => item.amountMinor)).toEqual([1000, 200]);
    expect(reading.controlTotal).toEqual({ matches: true, differenceMinor: 0 });
  });

  it("ends the table at a row the file leaves out", () => {
    const workbook = readXlsx(
      buildXlsx({
        sheets: [
          {
            name: "Report",
            rows: [WALLET_HEADERS, row(), row()],
            rowNumbers: [1, 2, 4],
          },
        ],
      }),
    );
    expect(read(workbook, draft(orderSections(), noTotals)).items).toHaveLength(
      1,
    );
  });

  it("keeps only the rows of a listed fee type, by their values (FR-034)", () => {
    const sections: ProfileSection[] = [
      {
        ...orderSections()[0],
        key: "lines",
        name: "Lines",
        feeTypes: [
          {
            key: "orders",
            name: "Orders",
            description: "",
            categoryAccountId: 12,
            values: ["Order Income"],
          },
          {
            key: "adjustments",
            name: "Adjustments",
            description: "",
            categoryAccountId: null,
            values: ["Adjustment", "Correction"],
          },
        ],
        rows: {
          where: [],

          feeTypeColumn: "Transaction Type",
        },
      },
    ];
    const reading = read(
      small([
        row(),
        row({ "Transaction Type": "correction" }),
        row({ "Transaction Type": "Withdrawals" }),
      ]),
      draft(sections, noTotals),
    );
    expect(
      reading.items.map((item) => [item.feeType, item.categoryCandidates]),
    ).toEqual([
      ["orders", [12]],
      ["adjustments", []],
    ]);
    expect(reading.notes.ignoredCount).toBe(1);
  });

  it("fails when the table, or a label it needs, is not there", () => {
    const workbook = small([row()]);
    expect(() =>
      read(
        readXlsx(
          buildXlsx({
            sheets: [
              { name: "Summary", rows: [["Total"]] },
              { name: "Notes", rows: [["Date"]] },
            ],
          }),
        ),
        draft(orderSections(), noTotals),
      ),
    ).toThrow(
      /No sheet has a row with all of its headings: "Date", "Transaction Type"/,
    );
    expect(() =>
      read(
        readXlsx(
          buildXlsx({
            sheets: [{ name: "Report", rows: [["Date", "Amount"]] }],
          }),
        ),
        draft(orderSections(), noTotals),
      ),
    ).toThrow(/^The table of the import profile "Wallet report" was not found/);
    expect(() =>
      read(
        workbook,
        draft(orderSections(), walletLayout({ documentDateLabel: null })),
      ),
    ).toThrow(
      'The label "Total Money In" of the stated total was not found on the sheet "Report".',
    );
  });

  it("reads a CSV file with decimal commas when told its separator", () => {
    const csv = [
      "Date;Transaction Type;Description;Order ID;Money Direction;Amount;Status;Balance After Transactions",
      "29/03/2026;Order Income;Order 1;A1;Money In;1.234,50;Transaction Completed;0",
      "28/03/2026;Order Income;Order 2;A2;Money Out;-0,75;Transaction Completed;0",
    ].join("\n");
    const reading = read(
      readCsv(Buffer.from(csv), { delimiter: ";" }),
      draft(
        orderSections(),
        walletLayout({
          dateFormat: "DD/MM/YYYY",
          decimalSeparator: ",",
          csvDelimiter: ";",
          documentDateLabel: null,
          statedTotalLabels: {},
        }),
      ),
    );
    expect(
      reading.items.map((item) => [item.date, item.kind, item.amountMinor]),
    ).toEqual([
      ["2026-03-29", DocumentType.Income, 123450],
      ["2026-03-28", DocumentType.Expense, 75],
    ]);
  });

  it("names what it read by the layout and the sections it reads", () => {
    const saved = { id: 7, ...full() };
    const id = columnsReadingId(saved);
    expect(id).toMatch(/^columns:7:[0-9a-f]{64}$/);
    expect(columnsReadingId({ ...saved, layout: noTotals })).not.toBe(id);
    // A legacy section in the other mode is not read, so it is not named.
    const legacy = {
      ...saved,
      sections: [
        ...saved.sections,
        { ...withdrawalSection(BANK), key: "old", mode: ImportMode.Summary },
      ],
    };
    expect(columnsReadingId(legacy)).toBe(id);
  });

  it("reads the table only, never a model's answer: the envelope it gives is code's own", () => {
    const { envelope, ignoredCount } = readTable(
      readXlsx(walletReportFixture().xlsx),
      {
        name: "Wallet report",
        mode: EVERY,
        layout: walletLayout(),
        sections: full().sections,
      },
    );
    expect(ignoredCount).toBe(0);
    expect(envelope.stated_total_minor).toBe(5415 - 30415);
    expect(
      envelope.sections.withdrawals.map((line) => line.amount_minor),
    ).toEqual([-10000, -20000]);
  });
});

describe("the running-balance check", () => {
  const withBalance = (over: Partial<TableLayout> = {}) =>
    walletLayout({ balanceColumn: "Balance After Transactions", ...over });

  it("finds the balance following row to row, newest first", () => {
    const reading = read(
      readXlsx(walletReportFixture().xlsx),
      draft([...orderSections(), withdrawalSection(BANK)], withBalance()),
    );
    expect(reading.notes.balance).toEqual({
      matches: true,
      message:
        "The running balance in “Balance After Transactions” follows from row to row, so no row between the first and the last is missing.",
    });
  });

  it("finds it following oldest first too, over rows no section takes", () => {
    const reading = read(
      readXlsx(walletWorkbook().xlsx),
      draft([withdrawalSection(BANK)], withBalance({ statedTotalLabels: {} })),
    );
    expect(reading.items).toHaveLength(10);
    expect(reading.notes.balance?.matches).toBe(true);
  });

  it("names the first row where it breaks, as a note that holds nothing back", () => {
    const reading = read(
      small([
        row({
          Amount: { raw: "10.00" },
          "Balance After Transactions": { raw: "130.00" },
        }),
        // A row of 20.00 is missing here: the balance moves by 30.00.
        row({
          Amount: { raw: "10.00" },
          "Balance After Transactions": { raw: "100.00" },
        }),
        row({
          Amount: { raw: "5.00" },
          "Balance After Transactions": { raw: "90.00" },
        }),
      ]),
      draft(
        orderSections(),
        withBalance({ statedTotalLabels: {}, documentDateLabel: null }),
      ),
    );
    expect(reading.items).toHaveLength(3);
    expect(reading.items.every((item) => item.reviewNote === null)).toBe(true);
    expect(reading.notes.balance).toEqual({
      matches: false,
      message:
        "The running balance in “Balance After Transactions” does not follow at row 2: the balance moves by 30.00, but the row's amount is 10.00. A row may be missing from the export or changed; compare the items with the spreadsheet.",
    });
  });

  it("says it could not check a balance it cannot read, and still reads the rows", () => {
    const reading = read(
      small([row(), row({ "Balance After Transactions": "pending" })]),
      draft(
        orderSections(),
        withBalance({ statedTotalLabels: {}, documentDateLabel: null }),
      ),
    );
    expect(reading.items).toHaveLength(2);
    expect(reading.notes.balance?.matches).toBe(false);
    expect(reading.notes.balance?.message).toMatch(
      /could not be checked: Row 3, column H \("Balance After Transactions"\): "pending" is not an amount\./,
    );
  });

  it("checks nothing with no balance column, or a single row", () => {
    expect(
      read(readXlsx(walletReportFixture().xlsx), full()).notes.balance,
    ).toBeUndefined();
    expect(
      read(
        small([row()]),
        draft(
          orderSections(),
          withBalance({ statedTotalLabels: {}, documentDateLabel: null }),
        ),
      ).notes.balance,
    ).toBeUndefined();
  });

  it("leaves out a legacy section saved in the other mode (FR-032)", () => {
    // Saved when each section had its own mode, it would take the same rows
    // as the withdrawals; read in the profile's mode, it is not read at all.
    const { envelope } = readTable(readXlsx(walletReportFixture().xlsx), {
      name: "Wallet report",
      mode: EVERY,
      layout: walletLayout(),
      sections: [
        ...full().sections,
        { ...withdrawalSection(BANK), key: "old", mode: ImportMode.Summary },
      ],
    });
    expect(Object.keys(envelope.sections)).not.toContain("old");
    expect(envelope.sections.withdrawals).toHaveLength(2);
  });

  it("says where it found the table, for a preview", () => {
    const report = walletWorkbook();
    const found = readTable(readXlsx(report.xlsx), {
      name: "Wallet",
      mode: EVERY,
      layout: walletLayout(),
      sections: full().sections,
    }).found;
    expect(found).toEqual({
      sheet: "Transaction Report",
      headerRow: report.headerRow,
      rows: report.rows,
    });
  });
});

describe("withoutTableRows (FR-057)", () => {
  it("cuts the table's rows from the text, keeping every other line's number", () => {
    const workbook = readXlsx(walletReportFixture().xlsx);
    const profile = {
      name: "Wallet report",
      mode: EVERY,
      layout: walletLayout(),
      sections: orderSections(),
    };
    for (const section of profile.sections) {
      section.rows!.filter = [
        { column: "Status", op: "is", value: "No matches" },
      ];
    }
    const table = readTable(workbook, profile);
    expect(table.ignoredCount).toBe(table.found.rows);
    const { pages } = renderWorkbook(workbook);
    const numbered = numberDocumentLines(pages);
    const cut = withoutTableRows(numbered, table.dataLines);

    expect(table.dataLines).toHaveLength(table.found.rows);
    expect(cut).not.toContain("Income from Order #A1");
    expect(cut).toContain("Transaction Type");
    const kept = numbered
      .split("\n")
      .filter(
        (line) =>
          !table.dataLines.some((n) =>
            line.startsWith(`L${String(n).padStart(4, "0")}│`),
          ),
      );
    // Every line outside the table is there, with its own number, and one
    // mark stands where the rows were.
    expect(cut.split("\n").filter((line) => !line.startsWith("["))).toEqual(
      kept,
    );
    expect(cut.match(/^\[.*left out here\]$/gm)).toEqual([
      `[${table.dataLines.length} rows of the table, read by code, left out here]`,
    ]);
  });

  it("leaves the text as it is when the table has no rows", () => {
    expect(withoutTableRows("L0001│a\nL0002│b", [])).toBe("L0001│a\nL0002│b");
  });
});

describe("table row filters", () => {
  const profile = (filter: RowCondition[] = []) => {
    const section = orderSections()[0];
    section.rows = { where: [], filter, feeTypeColumn: null };
    return { ...draft([section], noTotals), layout: noTotals };
  };

  it.each([
    [
      { column: "Status", op: "is", value: " completed " },
      "COMPLETED",
      "Processing",
    ],
    [
      { column: "Status", op: "is_not", value: "Processing" },
      "Completed",
      "processing",
    ],
    [
      { column: "Status", op: "is_one_of", values: ["Completed", "Settled"] },
      " settled ",
      "Processing",
    ],
    [
      { column: "Status", op: "contains", value: "completed" },
      "Transaction Completed",
      "Processing",
    ],
    [{ column: "Status", op: "empty" }, "", "Processing"],
    [{ column: "Status", op: "not_empty" }, "Completed", ""],
  ] as [RowCondition, string, string][])(
    "keeps matching rows for %j",
    (condition, kept, skipped) => {
      const result = read(
        small([row({ Status: kept }), row({ Status: skipped })]),
        profile([condition]),
      );
      expect(result.items).toHaveLength(1);
      expect(result.notes.ignoredCount).toBe(1);
    },
  );

  it("combines filters with AND before parsing dates and amounts", () => {
    const result = read(
      small([
        row(),
        row({ Status: "Processing", Date: "invalid", Amount: "invalid" }),
        row({ Description: "Other" }),
      ]),
      profile([
        { column: "Status", op: "contains", value: "Completed" },
        { column: "Description", op: "contains", value: "order" },
      ]),
    );
    expect(result.items).toHaveLength(1);
    expect(result.notes.ignoredCount).toBe(2);
  });

  it("keeps all assigned rows with an empty filter and counts all rejected rows once", () => {
    const workbook = small([row(), row()]);
    expect(read(workbook, profile()).items).toHaveLength(2);
    const result = readTable(
      workbook,
      profile([{ column: "Status", op: "is", value: "Missing" }]),
    );
    expect(Object.values(result.envelope.sections).flat()).toEqual([]);
    expect(result.ignoredCount).toBe(2);
  });

  it("combines section assignment with independent filters and rejects overlaps", () => {
    const sections = orderSections();
    sections[0].rows!.filter = [
      { column: "Status", op: "is", value: "Completed" },
    ];
    sections[1].rows!.filter = [
      { column: "Status", op: "is", value: "Settled" },
    ];
    const workbook = small([
      row({ Status: "Completed" }),
      row({ Status: "Settled", "Transaction Type": "Adjustment" }),
      row({ Status: "Processing" }),
    ]);
    const result = read(workbook, draft(sections, noTotals));
    expect(result.items).toHaveLength(2);
    expect(result.notes.ignoredCount).toBe(1);
    sections[1].rows!.where = [];
    sections[1].rows!.filter = [];
    expect(() => read(workbook, draft(sections, noTotals))).toThrow(
      /more than one section/,
    );
  });

  it("uses the same filtered output and counts in preview and import", () => {
    const input = profile([
      { column: "Status", op: "contains", value: "Completed" },
    ]);
    const rows = [WALLET_HEADERS, row(), row({ Status: "Processing" })];
    const bytes = buildXlsx({ sheets: [{ name: "Report", rows }] });
    const imported = read(readXlsx(bytes), input);
    const preview = previewTable(
      input,
      { bytes, type: "xlsx" },
      { mainCurrency: "MYR", today: "2026-10-02" },
    );
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.preview.itemCount).toBe(imported.items.length);
    expect(preview.preview.ignoredCount).toBe(imported.notes.ignoredCount);
  });
});
