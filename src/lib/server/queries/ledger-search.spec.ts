import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import {
  AccountSubType,
  AccountType,
  DefaultAccountPurpose,
  LedgerRecordKind,
  type AccountSubTypeCode,
  type AccountTypeCode,
} from "$lib/enums.js";
import * as schema from "../db/schema.js";
import {
  displaySignForAccountType,
  isCategoryAccount,
} from "../ledger/account-type.js";
import type { RecordListFilters } from "../ledger/types.js";
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
  aggregateRecords,
  listRecords,
  NO_CONTACT_KEY,
  type RecordGroup,
} from "./ledger.js";
import { unresolvedTaxLines } from "./tax-review.js";

/**
 * The MCP search filters on `RecordListFilters` and `aggregateRecords`, over
 * a small book built on `releaseBook` (in memory, never `db/client.ts`).
 *
 * Every figure below is main-currency cents, worked out by hand from the
 * records `seed` writes. The one foreign record is 50.00 USD at 4.5.
 */

type Book = ReturnType<typeof releaseBook>;
let book: Book | undefined;
afterEach(() => {
  book?.raw.close();
  book = undefined;
});

function seed() {
  book = releaseBook();
  const { db, ctx, bank, expense } = book;
  const account = (
    name: string,
    type: AccountTypeCode,
    subType?: AccountSubTypeCode,
  ) => resultValue(createAccount(db, 1, { name, type, subType })).id;
  const savings = account("Savings", AccountType.Asset, AccountSubType.Bank);
  const meals = account("Meals", AccountType.Expense);
  const uncategorisedExpense = account(
    "Uncategorised expense",
    AccountType.Expense,
  );
  const sales = account("Sales", AccountType.Revenue);
  const uncategorisedIncome = account(
    "Uncategorised income",
    AccountType.Revenue,
  );
  db.insert(schema.accountDefaults)
    .values([
      {
        purpose: DefaultAccountPurpose.UncategorisedExpense,
        accountId: uncategorisedExpense,
      },
      {
        purpose: DefaultAccountPurpose.UncategorisedIncome,
        accountId: uncategorisedIncome,
      },
    ])
    .run();
  const contact = (legalName: string) =>
    db
      .insert(schema.contacts)
      .values({ legalName, entityType: 2 })
      .returning()
      .get()!.id;
  const acme = contact("Acme Supplies");
  const beta = contact("Beta Traders");
  const gamma = contact("Gamma Client");

  const myr = { currency: "MYR", exchangeRate: 1 };
  const write = (input: Parameters<typeof createRecord>[1]) =>
    resultValue(createRecord(ctx, input)).record;
  const setTax = (
    recordId: number,
    accountId: number,
    taxClassification: typeof schema.ledgerMovements.$inferInsert.taxClassification,
  ) =>
    db
      .update(schema.ledgerMovements)
      .set({ taxClassification })
      .where(
        and(
          eq(schema.ledgerMovements.recordId, recordId),
          eq(schema.ledgerMovements.accountId, accountId),
        ),
      )
      .run();

  // Ordinary expenses defaults to 100% deductible; Meals has no default, so
  // its new lines are unclassified.
  const e1 = write({
    ...myr,
    kind: "expense",
    date: "2026-01-05",
    amount: 100,
    description: "Printer paper",
    categoryAccountId: expense,
    paidFromAccountId: bank,
    contactId: acme,
  });
  const e2 = write({
    kind: "expense",
    date: "2026-01-20",
    amount: 50,
    currency: "USD",
    exchangeRate: 4.5,
    description: "Client lunch abroad",
    categoryAccountId: meals,
    paidFromAccountId: bank,
    contactId: beta,
  });
  const e3 = write({
    ...myr,
    kind: "expense",
    date: "2026-02-03",
    amount: 80,
    description: "Unknown card charge",
    categoryAccountId: uncategorisedExpense,
    paidFromAccountId: bank,
    taxOverrides: [
      {
        accountId: uncategorisedExpense,
        occurrence: 0,
        percentageBps: null,
        treatment: "requires_review",
        reason: "Receipt not found yet",
      },
    ],
  });
  const i1 = write({
    ...myr,
    kind: "income",
    date: "2026-02-10",
    amount: 300,
    description: "Consulting",
    categoryAccountId: sales,
    receivedIntoAccountId: bank,
    contactId: gamma,
  });
  const i2 = write({
    ...myr,
    kind: "income",
    date: "2026-03-01",
    amount: 40,
    description: "Unknown deposit",
    categoryAccountId: uncategorisedIncome,
    receivedIntoAccountId: bank,
  });
  const t1 = write({
    ...myr,
    kind: "transfer",
    date: "2026-03-02",
    amount: 500,
    description: "To savings",
    fromAccountId: bank,
    toAccountId: savings,
  });
  const j1 = write({
    ...myr,
    kind: "journal",
    date: "2026-03-15",
    amount: 100,
    description: "Supplies and team lunch",
    contactId: acme,
    movements: [
      { accountId: expense, amountMinor: 6000 },
      { accountId: meals, amountMinor: 4000 },
      { accountId: bank, amountMinor: -10000 },
    ],
  });
  const v1 = write({
    ...myr,
    kind: "expense",
    date: "2026-03-20",
    amount: 70,
    description: "Entered twice",
    categoryAccountId: expense,
    paidFromAccountId: bank,
    contactId: beta,
  });
  const reversal = resultValue(
    voidRecord(ctx, v1.id, {
      reason: "Entered twice by mistake.",
      expectedVersion: resultValue(prepareVoidRecord(ctx, v1.id)).version,
    }),
  ).reversal;
  const e4 = write({
    ...myr,
    kind: "expense",
    date: "2026-04-01",
    amount: 30,
    description: "Old taxi fare",
    categoryAccountId: meals,
    paidFromAccountId: bank,
    contactId: beta,
  });
  // A historical line: no saved classification at all.
  setTax(e4.id, meals, null);
  const e5 = write({
    ...myr,
    kind: "expense",
    date: "2026-04-02",
    amount: 60,
    description: "Phone bill",
    categoryAccountId: meals,
    paidFromAccountId: bank,
    contactId: acme,
    taxOverrides: [
      {
        accountId: meals,
        occurrence: 0,
        percentageBps: 5000,
        treatment: "partial",
        reason: "Half business use",
      },
    ],
  });
  const e6 = write({
    ...myr,
    kind: "expense",
    date: "2026-04-03",
    amount: 20,
    description: "Parking",
    categoryAccountId: meals,
    paidFromAccountId: bank,
    contactId: gamma,
  });
  // A saved treatment with no percentage, which `needsTaxReview` flags.
  setTax(e6.id, meals, {
    percentageBps: null,
    source: "override",
    treatment: "partial",
    reason: "Legacy row",
    classifiedBy: 1,
    classifiedAt: "2026-04-03T00:00:00.000Z",
    provenance: "line_override",
  });
  const bill = write({
    ...myr,
    kind: "expense",
    date: "2026-04-10",
    amount: 20,
    description: "Courier bill",
    categoryAccountId: expense,
    paidFromAccountId: null,
    contactId: beta,
  });
  const batch = write({
    ...myr,
    kind: "payment",
    date: "2026-04-12",
    amount: 20,
    description: "Batch payment",
    direction: "we-pay",
    paidFromAccountId: bank,
    contactId: beta,
    settlements: [
      {
        owedMovementId: bill.movements.find((m) => m.accountId !== expense)!.id,
        amountMinor: 2000,
      },
    ],
  });
  // A batch payment names no single contact: Beta is reached only through
  // what it settled.
  db.update(schema.ledgerRecords)
    .set({ contactId: null })
    .where(eq(schema.ledgerRecords.id, batch.id))
    .run();
  db.insert(schema.recordAttachments)
    .values([
      {
        recordId: e1.id,
        filename: "records/2026/01/paper.pdf",
        displayName: "paper.pdf",
      },
      {
        recordId: i1.id,
        filename: "records/2026/02/consulting.pdf",
        displayName: "consulting.pdf",
      },
    ])
    .run();

  const ids = (filters: RecordListFilters) =>
    listRecords(db, { ...filters, limit: 1000 })
      .records.map((r) => r.id)
      .sort((a, b) => a - b);
  const sorted = (...records: { id: number }[]) =>
    records.map((r) => r.id).sort((a, b) => a - b);

  return {
    db,
    ids,
    sorted,
    accounts: {
      bank,
      savings,
      expense,
      meals,
      uncategorisedExpense,
      sales,
      uncategorisedIncome,
      payable: bill.movements.find((m) => m.accountId !== expense)!.accountId,
    },
    contacts: { acme, beta, gamma },
    records: { e1, e2, e3, i1, i2, t1, j1, v1, reversal, e4, e5, e6 },
    bill,
    batch,
  };
}

describe("record search filters", () => {
  it("finds paid records with paid: true, and leaves them out of paid: false", () => {
    // `NOT ${stillOwed}` without brackets read as `(NOT notVoided) AND EXISTS`,
    // so paid: true matched nothing at all.
    const { ids, records, bill } = seed();
    const paid = ids({ paid: true });
    expect(paid).toContain(bill.id);
    expect(paid).toContain(records.e1.id);
    expect(ids({ paid: false })).not.toContain(bill.id);
  });

  it("selects records with and without an attachment", () => {
    const { ids, sorted, records, bill, batch } = seed();
    const { e1, e2, e3, i1, i2, t1, j1, e4, e5, e6 } = records;
    expect(ids({ hasAttachment: true })).toEqual(sorted(e1, i1));
    expect(ids({ hasAttachment: false })).toEqual(
      sorted(e2, e3, i2, t1, j1, e4, e5, e6, bill, batch),
    );
  });

  it("bounds the main-currency figure from the sides, not the typed decimal", () => {
    const { ids, sorted, records, bill, batch } = seed();
    const { e1, e2, i1, t1, j1, e6 } = records;
    // 50.00 USD at 4.5 is 225.00 MYR: in by its main figure, out by its typed one.
    expect(ids({ minMainMinor: 20000 })).toEqual(sorted(e2, i1, t1));
    expect(ids({ amountMin: 200 })).toEqual(sorted(i1, t1));
    // Inclusive bounds. The journal's figure is its two category lines.
    expect(ids({ minMainMinor: 10000, maxMainMinor: 10000 })).toEqual(
      sorted(e1, j1),
    );
    expect(ids({ maxMainMinor: 2000 })).toEqual(sorted(e6, bill, batch));
    expect(ids({ minMainMinor: 2001, maxMainMinor: 2999 })).toEqual([]);
  });

  it("matches tax treatments on expense lines, with unreviewed lines as unclassified", () => {
    const { db, ids, sorted, records, bill } = seed();
    const { e1, e2, e3, j1, e4, e5, e6 } = records;
    expect(ids({ taxTreatment: ["ordinary_deductible"] })).toEqual(
      sorted(e1, j1, bill),
    );
    // e4 has no saved classification; e6 has a treatment but no percentage.
    expect(ids({ taxTreatment: ["unclassified"] })).toEqual(
      sorted(e2, j1, e4, e6),
    );
    expect(ids({ taxTreatment: ["requires_review"] })).toEqual(sorted(e3));
    expect(ids({ taxTreatment: ["partial"] })).toEqual(sorted(e5));
    expect(ids({ taxTreatment: ["non_deductible"] })).toEqual([]);
    expect(ids({ taxTreatment: [] })).toEqual([]);

    // The two review values select what the month-end tax check flags.
    const unresolved = [
      ...new Set(
        unresolvedTaxLines(db, null, "2026-12-31").map((l) => l.recordId),
      ),
    ].sort((a, b) => a - b);
    expect(ids({ taxTreatment: ["unclassified", "requires_review"] })).toEqual(
      unresolved,
    );
    expect(unresolved).toEqual(sorted(e2, e3, j1, e4, e6));
  });

  it("finds lines on the uncategorised default accounts, as they are saved", () => {
    const { db, ids, sorted, records, accounts, bill, batch } = seed();
    const { e1, e2, e3, i1, i2, t1, j1, e4, e5, e6 } = records;
    expect(ids({ uncategorised: true })).toEqual(sorted(e3, i2));
    expect(ids({ uncategorised: false })).toEqual(
      sorted(e1, e2, i1, t1, j1, e4, e5, e6, bill, batch),
    );

    db.update(schema.accountDefaults)
      .set({ accountId: accounts.meals })
      .where(
        eq(
          schema.accountDefaults.purpose,
          DefaultAccountPurpose.UncategorisedExpense,
        ),
      )
      .run();
    expect(ids({ uncategorised: true })).toEqual(
      sorted(e2, i2, j1, e4, e5, e6),
    );
  });

  it("matches any of several accounts", () => {
    const { ids, sorted, records, accounts } = seed();
    const { i2, t1 } = records;
    expect(ids({ accountIds: [accounts.savings] })).toEqual(sorted(t1));
    expect(
      ids({ accountIds: [accounts.savings, accounts.uncategorisedIncome] }),
    ).toEqual(sorted(i2, t1));
    expect(
      ids({ accountId: accounts.bank, accountIds: [accounts.savings] }),
    ).toEqual(sorted(t1));
    expect(ids({ accountIds: [] })).toEqual([]);
  });

  it("matches any of several contacts by the single-contact rule, batch payments included", () => {
    const { ids, sorted, records, contacts, bill, batch } = seed();
    const { e2, i1, e4, e6 } = records;
    const beta = sorted(e2, e4, bill, batch);
    expect(ids({ contactId: contacts.beta })).toEqual(beta);
    expect(ids({ contactIds: [contacts.beta] })).toEqual(beta);
    expect(ids({ contactIds: [contacts.gamma, contacts.beta] })).toEqual(
      sorted(e2, i1, e4, e6, bill, batch),
    );
    expect(ids({ contactIds: [] })).toEqual([]);
  });

  it("combines the new filters with the existing ones", () => {
    const { ids, sorted, records } = seed();
    const { e2, e4, e6 } = records;
    expect(
      ids({
        kind: LedgerRecordKind.Expense,
        taxTreatment: ["unclassified"],
        hasAttachment: false,
        dateFrom: "2026-01-01",
        dateTo: "2026-04-30",
      }),
    ).toEqual(sorted(e2, e4, e6));
  });
});

describe("aggregateRecords", () => {
  const group = (
    key: number | string,
    label: string,
    totalMinor: number,
    count: number,
  ): RecordGroup => ({ key: String(key), label, totalMinor, count });

  it("totals each category's lines, turned so spending and earning read positive", () => {
    const { db, accounts: a } = seed();
    expect(aggregateRecords(db, {}, "category")).toEqual({
      groups: [
        // 225.00 + 40.00 (journal) + 30.00 + 60.00 + 20.00
        group(a.meals, "Meals", 37500, 5),
        group(a.sales, "Sales", 30000, 1),
        // 100.00 + 60.00 (journal) + 20.00; the voided 70.00 is left out
        group(a.expense, "Ordinary expenses", 18000, 3),
        group(a.uncategorisedExpense, "Uncategorised expense", 8000, 1),
        group(a.uncategorisedIncome, "Uncategorised income", 4000, 1),
      ],
      totalMinor: 97500,
      count: 12,
      groupCount: 5,
    });
  });

  it("totals every other account's lines as stored", () => {
    const { db, accounts: a } = seed();
    expect(aggregateRecords(db, {}, "account")).toEqual({
      groups: [
        group(a.bank, "Bank", -79500, 11),
        group(a.savings, "Savings", 50000, 1),
        // The bill and the payment that settled it.
        group(a.payable, "Payable", 0, 2),
      ],
      // The other half of every record's lines: the category lines, unturned.
      totalMinor: -(37500 + 18000 + 8000) + (30000 + 4000),
      count: 12,
      groupCount: 3,
    });
  });

  it("matches a sum over the movements of the listed records", () => {
    const { db } = seed();
    const filters: RecordListFilters = { dateFrom: "2026-01-15" };
    const category = new Map<string, number>();
    const other = new Map<string, number>();
    for (const record of listRecords(db, { ...filters, limit: 1000 }).records) {
      for (const m of record.movements) {
        const account = { type: m.accountType, subType: m.accountSubType };
        const key = String(m.accountId);
        if (isCategoryAccount(account))
          category.set(
            key,
            (category.get(key) ?? 0) +
              m.amountMinor * displaySignForAccountType(m.accountType),
          );
        else other.set(key, (other.get(key) ?? 0) + m.amountMinor);
      }
    }
    const totals = (groups: RecordGroup[]) =>
      new Map(groups.map((g) => [g.key, g.totalMinor]));
    expect(totals(aggregateRecords(db, filters, "category").groups)).toEqual(
      category,
    );
    expect(totals(aggregateRecords(db, filters, "account").groups)).toEqual(
      other,
    );
  });

  it("totals each record's own figure by contact, month and kind", () => {
    const { db, contacts: c } = seed();
    expect(aggregateRecords(db, {}, "contact")).toEqual({
      groups: [
        // The unnamed deposit and card charge, the transfer, the batch payment.
        group(NO_CONTACT_KEY, "No contact", 64000, 4),
        group(c.gamma, "Gamma Client", 32000, 2),
        group(c.beta, "Beta Traders", 27500, 3),
        group(c.acme, "Acme Supplies", 26000, 3),
      ],
      totalMinor: 149500,
      count: 12,
      groupCount: 4,
    });
    expect(aggregateRecords(db, {}, "month")).toEqual({
      groups: [
        group("2026-03", "2026-03", 64000, 3),
        group("2026-02", "2026-02", 38000, 2),
        group("2026-01", "2026-01", 32500, 2),
        group("2026-04", "2026-04", 15000, 5),
      ],
      totalMinor: 149500,
      count: 12,
      groupCount: 4,
    });
    expect(aggregateRecords(db, {}, "kind")).toEqual({
      groups: [
        group("expense", "Expense", 53500, 7),
        group("transfer", "Transfer", 50000, 1),
        group("income", "Income", 34000, 2),
        group("journal", "Journal entry", 10000, 1),
        group("payment", "Payment", 2000, 1),
      ],
      totalMinor: 149500,
      count: 12,
      groupCount: 5,
    });
  });

  it("leaves void pairs out of counts and totals, whatever the voided filter says", () => {
    const { db, ids, records } = seed();
    expect(ids({ voided: "include" })).toEqual(
      expect.arrayContaining([records.v1.id, records.reversal.id]),
    );
    for (const groupBy of [
      "category",
      "account",
      "contact",
      "month",
      "kind",
    ] as const) {
      expect(aggregateRecords(db, { voided: "include" }, groupBy)).toEqual(
        aggregateRecords(db, {}, groupBy),
      );
      expect(aggregateRecords(db, { voided: "only" }, groupBy)).toEqual({
        groups: [],
        totalMinor: 0,
        count: 0,
        groupCount: 0,
      });
    }
  });

  it("totals a foreign-currency record in main currency", () => {
    const { db, accounts: a, records } = seed();
    const only = { minMainMinor: 22500, maxMainMinor: 22500 };
    const [lunch] = listRecords(db, only).records;
    expect(lunch).toMatchObject({
      id: records.e2.id,
      amount: 50,
      currency: "USD",
    });
    expect(aggregateRecords(db, only, "category").groups).toEqual([
      group(a.meals, "Meals", 22500, 1),
    ]);
    expect(aggregateRecords(db, only, "kind").totalMinor).toBe(22500);
  });

  it("applies the filters, and cuts to the limit after sorting", () => {
    const { db, accounts: a } = seed();
    const expenses = aggregateRecords(
      db,
      { kind: LedgerRecordKind.Expense },
      "category",
      { limit: 2 },
    );
    expect(expenses).toEqual({
      groups: [
        group(a.meals, "Meals", 33500, 4),
        group(a.expense, "Ordinary expenses", 12000, 2),
      ],
      // Uncategorised expense's 80.00 is cut from the list, not the total.
      totalMinor: 53500,
      count: 7,
      groupCount: 3,
    });
    expect(
      aggregateRecords(db, { kind: LedgerRecordKind.Expense }, "kind")
        .totalMinor,
    ).toBe(expenses.totalMinor);
    expect(aggregateRecords(db, {}, "kind", { limit: 0 }).groups).toEqual([]);
  });

  it("totals every line of a record a line filter selects, not only the matching line", () => {
    const { db, accounts: a } = seed();
    // The filters read movements too; the totals still cover the whole record.
    expect(
      aggregateRecords(db, { accountIds: [a.savings] }, "account").groups,
    ).toEqual([
      group(a.bank, "Bank", -50000, 1),
      group(a.savings, "Savings", 50000, 1),
    ]);
    expect(
      aggregateRecords(db, { uncategorised: true }, "account").groups,
    ).toEqual([group(a.bank, "Bank", -8000 + 4000, 2)]);
    expect(
      aggregateRecords(
        db,
        { taxTreatment: ["unclassified"], minMainMinor: 10000 },
        "category",
      ).groups,
    ).toEqual([
      // The lunch, and the journal's two lines.
      group(a.meals, "Meals", 22500 + 4000, 2),
      group(a.expense, "Ordinary expenses", 6000, 1),
    ]);
  });
});
