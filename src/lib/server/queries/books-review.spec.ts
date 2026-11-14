import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EntityType,
  StatementDirection,
  StatementExtractionState,
} from "$lib/enums.js";
import { monthEndFor } from "$lib/closing.js";
import { addDaysISO, localToday } from "$lib/local-date.js";
import * as schema from "../db/schema.js";
import { buildEvalBook, type EvalBook } from "../mcp/__fixtures__/eval-book.js";
import {
  releaseBook,
  resultValue,
} from "../application/__fixtures__/release-book.js";
import { closingReview, previewClosing } from "../application/closing.js";
import { createRecord } from "../application/records.js";
import { localsFor } from "../permissions/test-locals.js";
import { TOOL_REQUIREMENTS_V2 } from "../mcp/requirements/index.js";
import { storageFiles } from "./duplicate-records.js";
import { invoiceSummary } from "./invoices.js";
import { setExtractedText } from "./ledger.js";
import {
  BOOKS_REVIEW_CHECKS,
  descriptionProblems,
  findDuplicateContacts,
  loadAttention,
  reviewBooks,
  type BooksReview,
  type BooksReviewCheck,
} from "./books-review.js";

// Each book is a database under os.tmpdir() (or in memory); nothing here
// imports db/client.ts. Run with the MCP preload to prove it:
//   bun test --preload ./scripts/mcp-test-preload.ts src/lib/server/queries/books-review.spec.ts

/** The real clock: the book's upcoming invoice is issued on it. */
const TODAY = localToday();
const SLOW = 60_000;
const everything = () => true;

const sha256 = (path: string) =>
  existsSync(path)
    ? createHash("sha256").update(readFileSync(path)).digest("hex")
    : null;

/**
 * Tests that share one evaluation book (variant A), built when the first of
 * them starts and released when the last finishes. Each leaves it as it was.
 */
let shared: Promise<EvalBook> | undefined;
let pending = 0;
function onBook(name: string, check: (book: EvalBook) => void) {
  pending += 1;
  it(
    name,
    async () => {
      const book = await (shared ??= buildEvalBook({
        dir: mkdtempSync(join(tmpdir(), "akaun-books-review-")),
        variant: "A",
        today: TODAY,
      }));
      try {
        check(book);
      } finally {
        pending -= 1;
        if (pending === 0) {
          book.raw.close();
          rmSync(book.dir, { recursive: true, force: true });
        }
      }
    },
    SLOW,
  );
}

function finding(review: BooksReview, check: BooksReviewCheck) {
  return review.findings.find((f) => f.check === check);
}

/** The ids an item list points at, of one ref type. */
function refs(
  review: BooksReview,
  check: BooksReviewCheck,
  type = "record",
): (number | string)[] {
  return (finding(review, check)?.items ?? []).flatMap((item) =>
    item.ref?.type === type ? [item.ref.id] : [],
  );
}

describe("reviewBooks on the evaluation book", () => {
  onBook("finds every planted problem, and none of the decoys", (book) => {
    const { plants, records } = book.manifest;
    const review = reviewBooks(
      book.db,
      { can: everything, perCheck: 50, today: TODAY },
      { files: storageFiles(book.storageRoot) },
    );

    // P1: one supplier under three names, one under two; the lookalikes stay apart.
    const groups = finding(review, "duplicate_contacts")!.items.map((item) =>
      [item.ref!.id, ...(item.related ?? []).map((r) => r.id)].sort(),
    );
    expect(groups).toContainEqual([...plants.duplicateContacts.grab].sort());
    expect(groups).toContainEqual([...plants.duplicateContacts.tnb].sort());
    for (const lookalike of plants.duplicateContacts.lookalikesNotDuplicates)
      expect(groups.flat()).not.toContain(lookalike);

    // P2: both doubles, by their file; the unpaid copy is the one named first.
    const duplicates = finding(review, "duplicate_records")!;
    expect(duplicates).toMatchObject({ severity: "high", count: 2 });
    const claim = duplicates.items.find((item) =>
      item.related?.some((r) => r.id === plants.doubleClaims.reimbursedCopy),
    )!;
    expect(claim.ref).toEqual({
      type: "record",
      id: plants.doubleClaims.unpaidCopy,
    });
    expect(claim.summary).toContain("same_file");
    expect(claim.summary).toContain("reimbursed");
    const twice = duplicates.items.find(
      (item) =>
        item.ref?.id === plants.doubleClaims.enteredTwice[0] ||
        item.ref?.id === plants.doubleClaims.enteredTwice[1],
    )!;
    expect([twice.ref!.id, ...twice.related!.map((r) => r.id)].sort()).toEqual(
      [...plants.doubleClaims.enteredTwice].sort(),
    );
    expect(twice.summary).toContain("same_file");
    const listed = duplicates.items.flatMap((item) => [
      item.ref!.id,
      ...(item.related ?? []).map((r) => r.id),
    ]);
    for (const { record } of plants.bankStatement.decoyPair)
      expect(listed).not.toContain(record);

    // P3: every statement line is still to match, oldest first.
    const bank = finding(review, "unmatched_bank")!;
    expect(bank).toMatchObject({
      severity: "medium",
      count: Object.keys(book.manifest.lines).length,
    });
    const lines = refs(review, "unmatched_bank", "line");
    for (const { line } of [
      ...plants.bankStatement.matches,
      ...plants.bankStatement.noRecord,
    ])
      expect(lines).toContain(line);
    const dates = bank.items.map((item) => item.summary.slice(0, 10));
    expect(dates).toEqual([...dates].sort());
    expect(bank.next).toEqual({
      tool: "get_bank_reconciliation",
      args: { account: plants.bankStatement.account },
    });

    // P5: the expensed laptop; the cheaper printer stays an expense.
    expect(refs(review, "capitalisation")).toEqual([
      plants.expensedEquipment.record,
    ]);

    // P9: exactly the messy descriptions.
    const messy = refs(review, "descriptions");
    expect(messy).toHaveLength(plants.messyDescriptions.length);
    expect(new Set(messy)).toEqual(new Set(plants.messyDescriptions));

    // P11: the lines no tax treatment covers, which stop a close.
    expect(finding(review, "tax_unresolved")!.severity).toBe("high");
    expect(new Set(refs(review, "tax_unresolved"))).toEqual(
      new Set(plants.tax.unclassifiedRecords),
    );

    // P12: the overdue invoice, not the paid or the upcoming one.
    expect(refs(review, "overdue_invoices", "invoice")).toEqual([
      plants.receivables.overdue,
    ]);

    // The bills entered on the uncategorised default, and the rest.
    expect(new Set(refs(review, "uncategorised"))).toEqual(
      new Set(plants.uncategorised.expected.map((e) => e.record)),
    );
    expect(refs(review, "unpaid_bills")).toContain(
      plants.misallocatedPayment.intendedBill,
    );
    expect(refs(review, "unallocated_credits")).toEqual([
      plants.freightLeftOut.payment,
    ]);
    expect(review.clean).toEqual(["depreciation_due"]);
    expect(review.skipped).toEqual([]);

    // Closed June is left to the person who would reopen it.
    const missing = refs(review, "missing_evidence");
    expect(missing).toContain(records.workspaceJul);
    expect(missing).not.toContain(records.workspaceJun);
    expect(finding(review, "missing_evidence")!.note).toContain(
      book.manifest.closedThrough,
    );

    // Most severe first, then the largest count; every tool is registered.
    const rank = { high: 0, medium: 1, low: 2 };
    const order = review.findings.map((f) => [rank[f.severity], -f.count]);
    expect(order).toEqual(
      [...order].sort((a, b) => a[0] - b[0] || a[1] - b[1]),
    );
    const tools = Object.keys(TOOL_REQUIREMENTS_V2);
    for (const f of review.findings) {
      if (f.next) expect(tools).toContain(f.next.tool);
      if (f.fixWith) expect(tools).toContain(f.fixWith);
    }
  });

  onBook("finds the audited month's one missing receipt", (book) => {
    const { audit } = book.manifest.plants;
    const period = {
      from: `${audit.month}-01`,
      to: monthEndFor(audit.month)!,
    };
    const review = reviewBooks(book.db, {
      can: everything,
      today: TODAY,
      period,
      checks: ["missing_evidence"],
    });
    expect(review.findings).toHaveLength(1);
    expect(refs(review, "missing_evidence")).toEqual([audit.missingReceipt]);
    expect(finding(review, "missing_evidence")!.next).toEqual({
      tool: "search_records",
      args: {
        kinds: ["expense", "income"],
        has_attachment: false,
        min: "10.00",
        period: `${period.from}..${period.to}`,
      },
    });
  });

  onBook(
    "month_end: the next month's closing checks, then what the other checks count",
    (book) => {
      const { closedThrough, records } = book.manifest;
      const from = addDaysISO(closedThrough, 1);
      const end = monthEndFor(from.slice(0, 7))!;
      const review = reviewBooks(book.db, {
        can: everything,
        today: TODAY,
        checks: ["month_end"],
      });
      const monthEnd = finding(review, "month_end")!;
      expect(monthEnd.severity).toBe("high");
      expect(monthEnd.items[0]).toMatchObject({
        ref: { type: "record", id: records.membershipJul },
      });
      expect(monthEnd.items[0].summary).toMatch(/^Blocks the close/);
      expect(monthEnd.next).toEqual({
        tool: "get_report",
        args: { report: "trial_balance", as_at: end },
      });

      // The extracted review is what the Close month screen shows.
      const owner = {
        db: book.db,
        locals: localsFor([], { superuser: true, userId: book.ownerId }),
      };
      const preview = previewClosing(owner, { monthEnd: end });
      expect(preview.ok && preview.value).toEqual(closingReview(book.db, end));
      expect(monthEnd.counts!.tax_unresolved).toBe(
        closingReview(book.db, end).taxReview.unresolvedLineCount,
      );

      // Each count is that check's own count over the same dates.
      const month = reviewBooks(book.db, {
        can: everything,
        today: TODAY,
        period: { from, to: end },
        perCheck: 0,
      });
      expect(Object.keys(monthEnd.counts!).sort()).toEqual(
        BOOKS_REVIEW_CHECKS.filter(
          (c) => c !== "month_end" && c !== "duplicate_contacts",
        ).sort(),
      );
      for (const [check, count] of Object.entries(monthEnd.counts!))
        expect([check, count]).toEqual([
          check,
          finding(month, check as BooksReviewCheck)?.count ?? 0,
        ]);
    },
  );

  onBook("leaves a closed month to the person who would reopen it", (book) => {
    const { closedThrough } = book.manifest;
    const review = reviewBooks(book.db, {
      can: everything,
      today: TODAY,
      period: { from: `${closedThrough.slice(0, 7)}-01`, to: closedThrough },
      checks: ["uncategorised", "unpaid_bills", "month_end"],
    });
    expect(review.findings).toEqual([]);
    expect(review.clean).toEqual(["unpaid_bills"]);
    expect(review.skipped.map((s) => [s.check, s.needs])).toEqual([
      ["uncategorised", []],
      ["month_end", []],
    ]);
  });

  onBook(
    "can() hides each area's checks, and lists them as skipped",
    (book) => {
      const noBank = reviewBooks(book.db, {
        can: (area) => area !== "reconciliation",
        today: TODAY,
        perCheck: 0,
      });
      expect(noBank.findings.map((f) => f.check)).not.toContain(
        "unmatched_bank",
      );
      expect(noBank.clean).not.toContain("unmatched_bank");
      expect(noBank.skipped).toEqual([
        {
          check: "unmatched_bank",
          needs: ["reconciliation"],
          reason: expect.any(String),
        },
      ]);
      expect(finding(noBank, "month_end")!.counts).not.toHaveProperty(
        "unmatched_bank",
      );

      const recordsOnly = reviewBooks(book.db, {
        can: (area) => area === "records",
        today: TODAY,
        perCheck: 0,
      });
      expect(recordsOnly.skipped.map((s) => [s.check, s.needs])).toEqual([
        ["duplicate_contacts", ["contacts"]],
        ["unmatched_bank", ["reconciliation"]],
        ["overdue_invoices", ["invoices"]],
        ["depreciation_due", ["accounts"]],
        ["month_end", ["reports"]],
      ]);

      const nothing = reviewBooks(book.db, { can: () => false, today: TODAY });
      expect(nothing.findings).toEqual([]);
      expect(nothing.clean).toEqual([]);
      expect(nothing.skipped.map((s) => s.check)).toEqual([
        ...BOOKS_REVIEW_CHECKS,
      ]);
    },
  );

  onBook("caps the items of each finding, never its count", (book) => {
    const counts = (review: BooksReview) =>
      review.findings.map((f) => [f.check, f.count]);
    const none = reviewBooks(book.db, {
      can: everything,
      today: TODAY,
      perCheck: 0,
    });
    const one = reviewBooks(book.db, {
      can: everything,
      today: TODAY,
      perCheck: 1,
    });
    const most = reviewBooks(book.db, {
      can: everything,
      today: TODAY,
      perCheck: 500,
    });
    for (const f of none.findings) expect(f.items).toEqual([]);
    for (const f of one.findings) expect(f.items).toHaveLength(1);
    for (const f of most.findings)
      expect(f.items.length).toBe(Math.min(f.count, 50));
    expect(counts(one)).toEqual(counts(none));
    expect(counts(most)).toEqual(counts(none));
    // The default is ten.
    const plain = reviewBooks(book.db, { can: everything, today: TODAY });
    expect(finding(plain, "missing_evidence")!.items).toHaveLength(10);
  });

  onBook(
    "only reads: it runs read-only and leaves the file as it was",
    (book) => {
      const files = [
        book.databasePath,
        `${book.databasePath}-wal`,
        `${book.databasePath}-shm`,
      ];
      const before = files.map(sha256);
      book.raw.exec("PRAGMA query_only = ON");
      try {
        const review = reviewBooks(
          book.db,
          { can: everything, today: TODAY, perCheck: 50 },
          { files: storageFiles(book.storageRoot) },
        );
        expect(review.findings.length).toBeGreaterThan(0);
      } finally {
        book.raw.exec("PRAGMA query_only = OFF");
      }
      expect(files.map(sha256)).toEqual(before);
    },
  );

  onBook("loadAttention reads the database it is given", (book) => {
    const pipeline = {
      invoices: invoiceSummary(book.db, { from: TODAY, to: TODAY }, TODAY),
      quotations: null,
    };
    const all = loadAttention(
      book.db,
      localsFor([], { superuser: true }),
      TODAY,
      null,
      pipeline,
    );
    expect(all.map((item) => item.key)).toEqual([
      "overdue-invoices",
      "unpaid-bills",
      "unmatched",
    ]);
    expect(all.find((item) => item.key === "unmatched")!.target).toEqual({
      screen: "reconcile",
      accountId: book.manifest.plants.bankStatement.account,
    });
    const noBank = loadAttention(
      book.db,
      localsFor(["records.read", "invoices.read"]),
      TODAY,
      null,
      pipeline,
    );
    expect(noBank.map((item) => item.key)).toEqual([
      "overdue-invoices",
      "unpaid-bills",
    ]);
  });

  it("rejects a period that ends before it starts", () => {
    const base = releaseBook();
    try {
      expect(() =>
        reviewBooks(base.db, {
          can: everything,
          period: { from: "2026-03-01", to: "2026-02-01" },
        }),
      ).toThrow(RangeError);
      expect(() =>
        reviewBooks(base.db, {
          can: everything,
          period: { from: null, to: "2026-02-30" },
        }),
      ).toThrow(RangeError);
    } finally {
      base.raw.close();
    }
  });
});

describe("depreciation_due", () => {
  it("lists a registered asset whose months went unposted", () => {
    const base = releaseBook();
    try {
      const asset = base.asset();
      const review = reviewBooks(base.db, {
        can: everything,
        today: "2025-06-15",
        checks: ["depreciation_due"],
      });
      expect(finding(review, "depreciation_due")).toMatchObject({
        severity: "low",
        count: 1,
        items: [
          {
            ref: { type: "asset", id: asset.id },
            summary: expect.stringContaining("5 months"),
          },
        ],
        next: {
          tool: "get_report",
          args: { report: "fixed_assets", as_at: "2025-06-15" },
        },
        fixWith: "manage_fixed_assets",
      });
      // Without accounts read, the asset register is not read at all.
      const hidden = reviewBooks(base.db, {
        can: (area) => area !== "accounts",
        today: "2025-06-15",
        checks: ["depreciation_due"],
      });
      expect(hidden.findings).toEqual([]);
      expect(hidden.skipped[0].needs).toEqual(["accounts"]);
    } finally {
      base.raw.close();
    }
  });
});

describe("findDuplicateContacts", () => {
  it("links a registration number in another contact's file, but not a name every file carries", () => {
    const base = releaseBook();
    try {
      const contact = (legalName: string, registrationNo?: string) =>
        base.db
          .insert(schema.contacts)
          .values({
            legalName,
            entityType: EntityType.Business,
            registrationNo: registrationNo ?? null,
          })
          .returning()
          .get()!.id;
      const bill = (contactId: number, text: string) => {
        const record = resultValue(
          createRecord(base.ctx, {
            kind: "expense",
            date: "2026-03-02",
            amount: 25,
            currency: "MYR",
            exchangeRate: 1,
            description: "Office supplies",
            categoryAccountId: base.expense,
            paidFromAccountId: base.bank,
            contactId,
          }),
        ).record;
        setExtractedText(base.db, record.id, text);
      };
      const company = contact("Sinar Bekalan Sdn Bhd", "201901012345");
      const brand = contact("SinarMart");
      // The business itself, kept as a contact: every bill names it.
      const business = contact("Hijau Kotak Trading Sdn Bhd");
      bill(brand, "SinarMart\nCompany Reg. No. 201901012345\nReceipt");
      for (const name of [
        "Alpha Supplies",
        "Beta Paper",
        "Gamma Ink",
        "Delta Tape",
      ])
        bill(
          contact(name),
          `${name}\nInvoice\nBill to: Hijau Kotak Trading Sdn Bhd`,
        );

      const groups = findDuplicateContacts(base.db);
      expect(groups).toEqual([
        {
          signals: ["registration_no_in_documents"],
          contacts: [
            expect.objectContaining({ id: company, records: 0 }),
            expect.objectContaining({ id: brand, records: 1 }),
          ],
          keepReason: "it has a registration number",
        },
      ]);
      expect(groups.flatMap((g) => g.contacts.map((c) => c.id))).not.toContain(
        business,
      );
    } finally {
      base.raw.close();
    }
  });
});

describe("descriptionProblems", () => {
  it("flags what the description policy rules out", () => {
    expect(descriptionProblems("")).toEqual(["empty"]);
    expect(descriptionProblems("   ")).toEqual(["empty"]);
    expect(descriptionProblems("POS 4411 SHOPEE*KEDAI")).toEqual(["bank_text"]);
    expect(descriptionProblems("IBG TNB 2209")).toEqual(["bank_text"]);
    expect(descriptionProblems("GRAB*RIDE 8821KL MY")).toEqual(["bank_text"]);
    expect(descriptionProblems("CARD 5521 CANVA* 1029384")).toEqual([
      "bank_text",
      "long_number",
    ]);
    expect(descriptionProblems("Order 20260815")).toEqual(["long_number"]);
    expect(descriptionProblems("Misc")).toEqual(["vague"]);
    expect(descriptionProblems("n/a")).toEqual(["vague"]);
    expect(descriptionProblems("---")).toEqual(["vague"]);
    expect(descriptionProblems("Stationery ".repeat(6).trim())).toEqual([
      "too_long",
    ]);
  });

  it("leaves ordinary descriptions alone", () => {
    for (const fine of [
      "Receipt IV20260901-001",
      "Payment KK-2207",
      "Pos Laju delivery charges",
      "POS Malaysia stamps",
      "Brother HL-L2375DW laser printer",
      "Annual membership 2026/27",
      "MacBook Air 13-inch M4 16GB 512GB",
      "Staff uniforms - warehouse team (10 sets)",
      "a".repeat(60),
    ])
      expect([fine, descriptionProblems(fine)]).toEqual([fine, []]);
  });
});

describe("unmatched_bank remainders (review finding 5)", () => {
  it("works a line's remainder out in whole cents, so 0.10 + 0.20 covers 0.30", () => {
    const book = releaseBook();
    try {
      const { db, bank } = book;
      const statementId = db
        .insert(schema.bankStatements)
        .values({
          originalFilename: "may.pdf",
          storedFilePath: "reconciliation/may.pdf",
          extractionState: StatementExtractionState.Ready,
          uploadedBy: 1,
          accountId: bank,
        })
        .returning()
        .get()!.id;
      const line = (amount: number, description: string) =>
        db
          .insert(schema.bankStatementLines)
          .values({
            statementId,
            date: "2026-05-04",
            amount,
            direction: StatementDirection.Out,
            description,
          })
          .returning()
          .get()!.id;
      const allocate = (lineId: number, amounts: number[]) =>
        db
          .insert(schema.reconciliationAllocations)
          .values(
            amounts.map((amount) => ({
              lineId,
              amount,
              itemAmountSnapshot: amount,
            })),
          )
          .run();
      const covered = line(0.3, "COVERED");
      allocate(covered, [0.1, 0.2]);
      const tenths = line(0.7, "TENTHS");
      allocate(tenths, [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1]);
      const partly = line(0.3, "PARTLY");
      allocate(partly, [0.1]);
      const over = line(0.3, "OVER");
      allocate(over, [0.2, 0.2]);

      const review = reviewBooks(db, {
        can: everything,
        perCheck: 50,
        today: "2026-05-10",
      });
      const bankFinding = finding(review, "unmatched_bank")!;
      const byLine = new Map(
        bankFinding.items.map((item) => [item.ref!.id, item.summary]),
      );
      expect([...byLine.keys()].sort()).toEqual([partly, over].sort());
      expect(byLine.get(partly)).toContain("MYR 0.20 still unmatched");
      expect(byLine.get(over)).toContain("matched MYR 0.10 more than the line");
    } finally {
      book.raw.close();
    }
  });
});
