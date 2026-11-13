import { afterEach, describe, expect, it } from "vitest";
import {
  AccountType,
  DefaultAccountPurpose,
  type AccountTypeCode,
} from "$lib/enums.js";
import * as schema from "../db/schema.js";
import { createAccount } from "../services/accounts.js";
import {
  releaseBook,
  resultValue,
} from "../application/__fixtures__/release-book.js";
import {
  createRecord,
  prepareVoidRecord,
  voidRecord,
} from "../application/records.js";
import {
  CATEGORY_HISTORY_MAX_RECORDS,
  categoryHistory,
  descriptionTokens,
} from "./category-history.js";

/**
 * `categoryHistory` over a small book built on `releaseBook` (in memory, never
 * `db/client.ts`). Money never matters to this read, so every amount is the
 * same.
 */

type Book = ReturnType<typeof releaseBook>;
let book: Book | undefined;
afterEach(() => {
  book?.raw.close();
  book = undefined;
});

function seed() {
  book = releaseBook();
  const { db, ctx, bank } = book;
  const account = (name: string, type: AccountTypeCode) =>
    resultValue(createAccount(db, 1, { name, type })).id;
  const transport = account("Transport", AccountType.Expense);
  const meals = account("Meals", AccountType.Expense);
  const stationery = account("Stationery", AccountType.Expense);
  const uncategorised = account("Uncategorised expense", AccountType.Expense);
  const sales = account("Sales", AccountType.Revenue);
  db.insert(schema.accountDefaults)
    .values({
      purpose: DefaultAccountPurpose.UncategorisedExpense,
      accountId: uncategorised,
    })
    .run();
  const contact = (legalName: string) =>
    db
      .insert(schema.contacts)
      .values({ legalName, entityType: 2 })
      .returning()
      .get()!.id;
  const grab = contact("Grab Malaysia");
  const staples = contact("Staples Office");

  const expense = (
    date: string,
    description: string,
    categoryAccountId: number,
    contactId?: number,
  ) =>
    resultValue(
      createRecord(ctx, {
        kind: "expense",
        date,
        amount: 10,
        currency: "MYR",
        exchangeRate: 1,
        description,
        categoryAccountId,
        paidFromAccountId: bank,
        contactId,
      }),
    ).record;

  // Grab: four rides on Transport, one meal, one still uncategorised.
  const rides = [
    expense("2026-01-10", "Grab ride KL", transport, grab),
    expense("2026-02-14", "Grab ride Bangsar", transport, grab),
    expense("2026-03-09", "GRAB*RIDE 4410PJ MY", transport, grab),
    expense("2026-04-21", "Grab ride airport", transport, grab),
  ];
  const food = expense("2026-03-30", "Grab food delivery", meals, grab);
  const unsorted = expense(
    "2026-05-02",
    "GRAB*RIDE 8821KL MY",
    uncategorised,
    grab,
  );
  // No contact at all: only the description can link these.
  const noContactRide = expense(
    "2026-05-03",
    "Grab ride KL Sentral",
    transport,
  );
  const paper = expense("2026-02-01", "Printer paper", stationery, staples);
  const unrelated = expense("2026-02-02", "Hotel KL stay", meals);
  return {
    ...book,
    transport,
    meals,
    stationery,
    uncategorised,
    sales,
    grab,
    staples,
    expense,
    rides,
    food,
    unsorted,
    noContactRide,
    paper,
    unrelated,
  };
}

function voidIt(recordId: number) {
  const { ctx } = book!;
  return resultValue(
    voidRecord(ctx, recordId, {
      reason: "Entered twice by mistake.",
      expectedVersion: resultValue(prepareVoidRecord(ctx, recordId)).version,
    }),
  );
}

describe("descriptionTokens", () => {
  it("drops digits, dates, asterisks and the country code", () => {
    expect(descriptionTokens("GRAB*RIDE 8821KL MY")).toEqual([
      "grab",
      "ride",
      "kl",
    ]);
    expect(descriptionTokens("Grab ride KL")).toEqual(["grab", "ride", "kl"]);
    expect(
      descriptionTokens("Invoice 12/03/2026 from ACME Sdn Bhd 14 Mar"),
    ).toEqual(["invoice", "from", "acme"]);
  });

  it("strips a leading card prefix and a masked card number", () => {
    expect(descriptionTokens("POS DEBIT CARD XXXX1234 SHELL KL")).toEqual([
      "shell",
      "kl",
    ]);
    expect(descriptionTokens("Visa purchase - Shell PJ")).toEqual([
      "shell",
      "pj",
    ]);
  });

  it("never strips a description down to nothing", () => {
    expect(descriptionTokens("Debit card")).toEqual(["card"]);
    expect(descriptionTokens("12345")).toEqual([]);
  });
});

describe("categoryHistory byContact", () => {
  it("gives counts, the last date and up to three examples, most used first", () => {
    const s = seed();
    const result = categoryHistory(s.db, { contactId: s.grab });
    expect(result.entries).toHaveLength(1);
    const [entry] = result.entries;
    expect(entry.recordId).toBeNull();
    expect(entry.contactId).toBe(s.grab);
    expect(entry.similarDescriptions).toEqual([]);

    // Equal counts fall back to the most recent use.
    expect(entry.byContact.map((row) => row.name)).toEqual([
      "Transport",
      "Uncategorised expense",
      "Meals",
    ]);
    const [transport, uncategorised, meals] = entry.byContact;
    expect(transport).toMatchObject({
      categoryAccountId: s.transport,
      type: AccountType.Expense,
      count: 4,
      lastDate: "2026-04-21",
      isUncategorisedDefault: false,
    });
    // Three of the four, newest first.
    expect(transport.examples).toEqual([
      {
        recordId: s.rides[3].id,
        date: "2026-04-21",
        description: "Grab ride airport",
      },
      {
        recordId: s.rides[2].id,
        date: "2026-03-09",
        description: "GRAB*RIDE 4410PJ MY",
      },
      {
        recordId: s.rides[1].id,
        date: "2026-02-14",
        description: "Grab ride Bangsar",
      },
    ]);
    expect(meals).toMatchObject({ count: 1, lastDate: "2026-03-30" });
    expect(meals.examples).toEqual([
      {
        recordId: s.food.id,
        date: "2026-03-30",
        description: "Grab food delivery",
      },
    ]);
    // Shown, not hidden — and flagged.
    expect(uncategorised).toMatchObject({
      categoryAccountId: s.uncategorised,
      count: 1,
      isUncategorisedDefault: true,
    });
  });

  it("does not count other contacts' records", () => {
    const s = seed();
    const [entry] = categoryHistory(s.db, { contactId: s.staples }).entries;
    expect(entry.byContact).toHaveLength(1);
    expect(entry.byContact[0]).toMatchObject({
      categoryAccountId: s.stationery,
      count: 1,
    });
  });

  it("honours limit", () => {
    const s = seed();
    const [entry] = categoryHistory(s.db, {
      contactId: s.grab,
      limit: 1,
    }).entries;
    expect(entry.byContact.map((row) => row.name)).toEqual(["Transport"]);
  });
});

describe("categoryHistory similarDescriptions", () => {
  it("matches GRAB*RIDE 8821KL MY with Grab ride KL, best overlap first", () => {
    const s = seed();
    const [entry] = categoryHistory(s.db, {
      description: "GRAB*RIDE 8821KL MY",
    }).entries;
    expect(entry.byContact).toEqual([]);
    const names = entry.similarDescriptions.map((row) => row.name);
    // Transport shares grab+ride(+kl); Meals only grab (food) or kl (hotel).
    expect(names[0]).toBe("Transport");
    expect(names).toContain("Meals");
    expect(names).not.toContain("Stationery");

    const transport = entry.similarDescriptions[0];
    // Five Transport rides share "grab" and "ride"; the two that also say "KL"
    // share three words and lead the examples, then the newest of the rest.
    expect(transport.count).toBe(5);
    expect(transport.overlap).toBe(3);
    expect(transport.examples.map((e) => e.description)).toEqual([
      "Grab ride KL Sentral",
      "Grab ride KL",
      "Grab ride airport",
    ]);
    const meals = entry.similarDescriptions.find(
      (row) => row.name === "Meals",
    )!;
    expect(meals.overlap).toBe(1);
    expect(meals.count).toBe(2); // Grab food delivery, Hotel KL stay
    // Ranked by overlap, then frequency.
    const overlaps = entry.similarDescriptions.map((row) => row.overlap!);
    expect(overlaps).toEqual([...overlaps].sort((a, b) => b - a));
  });

  it("marks the uncategorised default", () => {
    const s = seed();
    const [entry] = categoryHistory(s.db, {
      description: "Grab ride KL",
    }).entries;
    const row = entry.similarDescriptions.find(
      (r) => r.categoryAccountId === s.uncategorised,
    )!;
    expect(row.isUncategorisedDefault).toBe(true);
    expect(row.count).toBe(1);
  });

  it("returns nothing for a description with no significant words", () => {
    const s = seed();
    const [entry] = categoryHistory(s.db, { description: "12345 ***" }).entries;
    expect(entry.similarDescriptions).toEqual([]);
    expect(entry.byContact).toEqual([]);
  });

  it("gives one entry for a contact and a description together", () => {
    const s = seed();
    const result = categoryHistory(s.db, {
      contactId: s.grab,
      description: "Printer paper",
    });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].byContact[0].name).toBe("Transport");
    expect(result.entries[0].similarDescriptions.map((r) => r.name)).toEqual([
      "Stationery",
    ]);
  });
});

describe("categoryHistory recordIds", () => {
  it("describes each record and never counts the record itself", () => {
    const s = seed();
    const result = categoryHistory(s.db, {
      recordIds: [s.unsorted.id, s.noContactRide.id],
    });
    expect(result.missingRecordIds).toEqual([]);
    expect(result.skippedRecordIds).toEqual([]);
    expect(result.entries.map((e) => e.recordId)).toEqual([
      s.unsorted.id,
      s.noContactRide.id,
    ]);

    const [sorted, ride] = result.entries;
    expect(sorted.contactId).toBe(s.grab);
    // The record is on the uncategorised default itself, and is the only
    // record there: excluded, so that category has no history at all.
    expect(sorted.byContact.map((r) => r.name)).toEqual(["Transport", "Meals"]);
    expect(
      sorted.similarDescriptions.find(
        (r) => r.categoryAccountId === s.uncategorised,
      ),
    ).toBeUndefined();
    // The same Grab rides are found by description too.
    expect(sorted.similarDescriptions[0].name).toBe("Transport");

    // No contact: nothing by contact, but the description still finds rides.
    expect(ride.contactId).toBeNull();
    expect(ride.byContact).toEqual([]);
    expect(ride.similarDescriptions[0]).toMatchObject({ name: "Transport" });
    expect(
      ride.similarDescriptions[0].examples.map((e) => e.recordId),
    ).not.toContain(s.noContactRide.id);
  });

  it("reports ids that do not exist and ids past the limit", () => {
    const s = seed();
    const ids = Array.from(
      { length: CATEGORY_HISTORY_MAX_RECORDS + 2 },
      (_, i) => 9000 + i,
    );
    const result = categoryHistory(s.db, {
      recordIds: [s.unsorted.id, ...ids],
    });
    // The real record plus 49 phantom ids are described; two ids are left over.
    expect(result.entries.map((e) => e.recordId)).toEqual([s.unsorted.id]);
    expect(result.missingRecordIds).toHaveLength(
      CATEGORY_HISTORY_MAX_RECORDS - 1,
    );
    expect(result.skippedRecordIds).toEqual(ids.slice(-3));
  });

  it("dedupes repeated ids", () => {
    const s = seed();
    const result = categoryHistory(s.db, {
      recordIds: [s.unsorted.id, s.unsorted.id],
    });
    expect(result.entries).toHaveLength(1);
  });
});

describe("categoryHistory void pairs", () => {
  it("excludes a voided record and its reversal from every list", () => {
    const s = seed();
    const before = categoryHistory(s.db, {
      contactId: s.grab,
      description: "Grab food",
    }).entries[0];
    const mistake = s.expense(
      "2026-05-10",
      "Grab food entered twice",
      s.meals,
      s.grab,
    );
    const { reversal } = voidIt(mistake.id);

    const after = categoryHistory(s.db, {
      contactId: s.grab,
      description: "Grab food",
    }).entries[0];
    // Neither the voided expense nor its reversal changes a count, a last
    // date or an example.
    expect(after).toEqual({ ...before });
    const allExamples = [...after.byContact, ...after.similarDescriptions]
      .flatMap((row) => row.examples)
      .map((example) => example.recordId);
    expect(allExamples).not.toContain(mistake.id);
    expect(allExamples).not.toContain(reversal.id);
  });
});

describe("categoryHistory is read-only", () => {
  it("changes no row", () => {
    const s = seed();
    const changes = () =>
      (
        s.raw.query("SELECT total_changes() AS n").get() as {
          n: number;
        }
      ).n;
    const before = changes();
    categoryHistory(s.db, {
      recordIds: [s.unsorted.id],
      contactId: s.grab,
      description: "Grab ride",
    });
    expect(changes()).toBe(before);
  });
});
