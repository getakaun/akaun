import { describe, expect, it } from "vitest";
import { AccountSubType, AccountType, DocumentType } from "$lib/enums.js";
import {
  describeReading,
  readingProgressLabel,
  hasProfileChoice,
  readAsOfJob,
  readCategoryAccountId,
  isTransferRow,
  itemSides,
  keepsReadAccount,
  readingLabel,
  receiptSides,
  reviewRowFrom,
  transferChoices,
  type ReviewOptions,
} from "./review-card.js";

// The review card hides a review note once the reviewer has picked another
// category. It tells that by comparing the category side of the card with
// what the card started with, so the two must agree for both kinds.
const options = {
  allAccounts: [],
  categoryAccounts: [
    { id: 10, name: "Fees", type: AccountType.Expense },
    { id: 20, name: "Sales", type: AccountType.Revenue },
  ],
  payableAccountId: 1,
  receivableAccountId: 2,
  uncategorisedAccountId: 3,
  uncategorisedIncomeAccountId: 4,
} as unknown as ReviewOptions;

describe("readCategoryAccountId", () => {
  it("is the category an expense card starts with on its target side", () => {
    const row = reviewRowFrom({ documentType: DocumentType.Expense });
    expect(readCategoryAccountId(row, options)).toBe(3);
    expect(receiptSides(row, options).target).toBe(3);

    const read = reviewRowFrom({
      documentType: DocumentType.Expense,
      categoryAccountId: 10,
    });
    expect(readCategoryAccountId(read, options)).toBe(10);
  });

  it("is the category an income card starts with on its source side", () => {
    const row = reviewRowFrom({ documentType: DocumentType.Income });
    expect(readCategoryAccountId(row, options)).toBe(4);
    expect(receiptSides(row, options).source).toBe(4);

    const read = reviewRowFrom({
      documentType: DocumentType.Income,
      category: "Sales",
    });
    expect(readCategoryAccountId(read, options)).toBe(20);
  });
});

describe("a transfer's two accounts (FR-058)", () => {
  it("runs from the document's account to the other one, or back", () => {
    const out = reviewRowFrom({
      documentType: DocumentType.TransferOut,
      accountId: 5,
      counterAccountId: 6,
    });
    expect(out.documentType).toBe("transfer_out");
    expect(isTransferRow(out)).toBe(true);
    expect(receiptSides(out, options)).toEqual({ source: 5, target: 6 });
    expect(itemSides(out, options)).toEqual({ source: 5, target: 6 });

    const back = reviewRowFrom({
      documentType: DocumentType.TransferIn,
      accountId: 5,
      counterAccountId: 6,
    });
    expect(itemSides(back, options)).toEqual({ source: 6, target: 5 });
    expect(isTransferRow(reviewRowFrom({ documentType: 1 }))).toBe(false);
  });

  it("starts a one-item profile card on the account its reading chose (FR-008)", () => {
    const row = reviewRowFrom({
      documentType: DocumentType.Income,
      accountId: 9,
    });
    // The standard reading starts an income on Accounts receivable, as before.
    expect(receiptSides(row, options).target).toBe(2);
    expect(receiptSides(row, options, true).target).toBe(9);
    const expense = reviewRowFrom({
      documentType: DocumentType.Expense,
      accountId: 9,
    });
    expect(receiptSides(expense, options).source).toBe(1);
    expect(receiptSides(expense, options, true).source).toBe(9);
    expect(keepsReadAccount({ readAs: "profile" })).toBe(true);
    expect(keepsReadAccount({ readAs: "receipt", readHow: "chosen" })).toBe(
      false,
    );
  });

  it("offers either side every money account but the other side", () => {
    const withAccounts = {
      ...options,
      transferAccounts: [{ id: 5 }, { id: 6 }, { id: 7 }],
    } as unknown as ReviewOptions;
    expect(transferChoices(withAccounts, 6).map((a) => a.id)).toEqual([5, 7]);
  });
});

describe("describeReading", () => {
  it("says which profile read a document and whether it was chosen or detected", () => {
    const profile = { name: "Shopee statement" };
    expect(
      describeReading({ readAs: "profile", readHow: "chosen", profile }),
    ).toBe("Read with “Shopee statement” (chosen)");
    // Auto-detect keeps "auto" as what the uploader chose (006 US9, FR-041).
    expect(
      describeReading({ readAs: "auto", readHow: "detected", profile }),
    ).toBe("Read with “Shopee statement” (detected)");
    expect(describeReading({ readAs: "auto", readHow: "standard" })).toBe(
      "Single record (auto-detect)",
    );
  });

  it("says the standard reading and several items, and how each was picked", () => {
    expect(describeReading({ readAs: "receipt", readHow: "chosen" })).toBe(
      "Single record (chosen)",
    );
    expect(describeReading({ readAs: "items", readHow: "chosen" })).toBe(
      "Multiple records (chosen)",
    );
    // A row from before 006 has neither column, and was read as a receipt.
    expect(describeReading({ readAs: null, readHow: null })).toBe(
      "Single record",
    );
    // A profile reading whose copy is missing still says it was a profile.
    expect(describeReading({ readAs: "profile", readHow: "chosen" })).toBe(
      "Read with an import profile (chosen)",
    );
  });

  it("names the mode it was read in after the profile, Summary too (FR-002)", () => {
    const every = { name: "Wallet report", mode: "every_transaction" };
    expect(
      describeReading({ readAs: "profile", readHow: "chosen", profile: every }),
    ).toBe("Read with “Wallet report” (chosen) · Every transaction");
    expect(
      describeReading({ readAs: "auto", readHow: "detected", profile: every }),
    ).toBe("Read with “Wallet report” (detected) · Every transaction");
    // A Summary profile says Summary as well: every profile reads one mode,
    // and the copy kept with the reading names it.
    expect(
      describeReading({
        readAs: "profile",
        readHow: "chosen",
        profile: { name: "Wallet report", mode: "summary" },
      }),
    ).toBe("Read with “Wallet report” (chosen) · Summary");
  });

  it("says when a spreadsheet was read from its columns (FR-041)", () => {
    const every = { name: "Wallet report", mode: "every_transaction" };
    const notes = (method?: string) =>
      JSON.stringify({
        statedTotal: null,
        itemsTotalMinor: 0,
        ignored: [],
        ...(method ? { method } : {}),
      });
    expect(
      describeReading({
        readAs: "auto",
        readHow: "detected",
        profile: every,
        extractionNotes: notes("columns"),
      }),
    ).toBe(
      "Read with “Wallet report” (detected) · Every transaction · read from columns",
    );
    // An AI reading says nothing more than it did.
    expect(
      describeReading({
        readAs: "profile",
        readHow: "chosen",
        profile: every,
        extractionNotes: notes(),
      }),
    ).toBe("Read with “Wallet report” (chosen) · Every transaction");
    // A long document the AI read in parts says so (FR-043).
    expect(
      describeReading({
        readAs: "profile",
        readHow: "chosen",
        profile: every,
        extractionNotes: notes("ai_pieces"),
      }),
    ).toBe(
      "Read with “Wallet report” (chosen) · Every transaction · read in parts",
    );
    // Read by the AI in one call, in Every transaction mode: nothing more.
    expect(
      describeReading({
        readAs: "profile",
        readHow: "chosen",
        profile: every,
        extractionNotes: notes("ai"),
      }),
    ).toBe("Read with “Wallet report” (chosen) · Every transaction");
  });
});

describe("readingProgressLabel", () => {
  it("names the part being read and how many there are (US8 AS2)", () => {
    expect(readingProgressLabel({ progressDone: 2, progressTotal: 25 })).toBe(
      "Reading part 3 of 25",
    );
    expect(readingProgressLabel({ progressDone: 0, progressTotal: 2 })).toBe(
      "Reading part 1 of 2",
    );
    // Every part read: the last one is what it is finishing.
    expect(readingProgressLabel({ progressDone: 25, progressTotal: 25 })).toBe(
      "Reading part 25 of 25",
    );
  });

  it("says nothing for a document read in one call, or not counted", () => {
    expect(
      readingProgressLabel({ progressDone: 0, progressTotal: 1 }),
    ).toBeNull();
    expect(
      readingProgressLabel({ progressDone: null, progressTotal: null }),
    ).toBeNull();
    expect(readingProgressLabel({})).toBeNull();
  });
});

describe("readingLabel", () => {
  const detected = {
    readAs: "auto",
    readHow: "detected",
    profile: { name: "Fee notice" },
  };
  const autoStandard = { readAs: "auto", readHow: "standard" };

  it("says nothing of the standard reading while no profile is turned on (FR-003)", () => {
    expect(readingLabel(autoStandard, { profilesEnabled: false })).toBeNull();
    expect(
      readingLabel(autoStandard, { profilesEnabled: false, waiting: true }),
    ).toBeNull();
    expect(
      readingLabel(
        { readAs: "receipt", readHow: "chosen" },
        { profilesEnabled: false },
      ),
    ).toBeNull();
  });

  it("always names a profile or several-items reading (FR-041)", () => {
    expect(readingLabel(detected, { profilesEnabled: false })).toBe(
      "Read with “Fee notice” (detected)",
    );
    expect(
      readingLabel(
        { readAs: "items", readHow: "chosen" },
        { profilesEnabled: false, waiting: true },
      ),
    ).toBe("Multiple records (chosen)");
  });

  it("names the standard reading once profiles exist, and Auto-detect while it waits", () => {
    expect(readingLabel(autoStandard, { profilesEnabled: true })).toBe(
      "Single record (auto-detect)",
    );
    expect(
      readingLabel(autoStandard, { profilesEnabled: true, waiting: true }),
    ).toBe("Auto-detect");
    expect(
      readingLabel(detected, { profilesEnabled: true, waiting: true }),
    ).toBe("Read with “Fee notice” (detected)");
    expect(
      readingLabel(
        { readAs: "receipt", readHow: "chosen" },
        { profilesEnabled: true, waiting: true },
      ),
    ).toBe("Single record (chosen)");
  });
});

describe("readAsOfJob", () => {
  it("names the reading the way an upload and Read again take it", () => {
    expect(readAsOfJob({ readAs: "profile", profileId: "7" })).toBe(
      "profile:7",
    );
    expect(readAsOfJob({ readAs: "auto", profileId: "7" })).toBe("auto");
    expect(readAsOfJob({ readAs: "items", profileId: null })).toBe("items");
    expect(readAsOfJob({ readAs: null, profileId: null })).toBe("receipt");
  });
});

describe("hasProfileChoice", () => {
  it("is true only when a saved profile is among the choices", () => {
    expect(hasProfileChoice([{ value: "auto" }, { value: "receipt" }])).toBe(
      false,
    );
    expect(hasProfileChoice([{ value: "auto" }, { value: "profile:3" }])).toBe(
      true,
    );
  });
});

describe("contra revenue review categories", () => {
  it("restores an outgoing contra category by id or name, but never as an income source", () => {
    const contra = {
      id: 30,
      name: "Discounts",
      type: AccountType.Revenue,
      subType: AccountSubType.ContraOperatingRevenue,
    };
    const choices = {
      ...options,
      categoryAccounts: [...options.categoryAccounts, contra],
    } as ReviewOptions;
    for (const fields of [
      { categoryAccountId: 30 },
      { category: "Discounts" },
    ]) {
      const outgoing = reviewRowFrom({
        documentType: DocumentType.Expense,
        accountId: 5,
        ...fields,
      });
      expect(readCategoryAccountId(outgoing, choices)).toBe(30);
      expect(itemSides(outgoing, choices)).toEqual({ source: 5, target: 30 });
      expect(
        readCategoryAccountId(
          reviewRowFrom({ documentType: DocumentType.Income, ...fields }),
          choices,
        ),
      ).toBe(4);
    }
  });
});
