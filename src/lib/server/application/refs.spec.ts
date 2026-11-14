import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AccountType,
  DefaultAccountPurpose,
  StatementDirection,
  StatementExtractionState,
  type AccountTypeCode,
} from "$lib/enums.js";
import * as schema from "../db/schema.js";
import { isMoneyPotAccount } from "../ledger/account-type.js";
import { resolveError } from "../mcp/resolve.js";
import { accountDefaultId } from "../services/account-defaults.js";
import { createAccount } from "../services/accounts.js";
import { releaseBook, resultValue } from "./__fixtures__/release-book.js";
import { createLegacyReimbursement } from "./__fixtures__/legacy-reimbursement.js";
import { updateAccount } from "./accounts.js";
import { preparePaymentCorrection } from "./payment-corrections.js";
import { createRecord } from "./records.js";
import {
  lineRef,
  resolveAccount,
  resolveBankLine,
  resolveContact,
  resolveOpenItem,
  resolvePaymentMovement,
  resolveRecord,
  resolveSettlement,
  resolveStatement,
  similarity,
  statementRef,
  type Resolved,
} from "./refs.js";

/**
 * The reference resolvers, against a migrated in-memory book (`releaseBook`),
 * never `db/client.ts`.
 */

type Book = ReturnType<typeof releaseBook>;
let book: Book;
beforeEach(() => {
  book = releaseBook();
});
afterEach(() => book.raw.close());

const base = { date: "2026-03-01", currency: "MYR", exchangeRate: 1 };

function account(name: string, type: AccountTypeCode, subType?: number) {
  return resultValue(
    createAccount(book.db, 1, { name, type, subType: subType as never }),
  );
}

function contact(legalName: string, registrationNo?: string) {
  return book.db
    .insert(schema.contacts)
    .values({ legalName, entityType: 2, registrationNo })
    .returning()
    .get()!.id;
}

function expense(
  description: string,
  amount = 12.5,
  extra: { paidFromAccountId?: number | null; contactId?: number } = {},
) {
  return resultValue(
    createRecord(book.ctx, {
      ...base,
      kind: "expense",
      amount,
      description,
      categoryAccountId: book.expense,
      paidFromAccountId: book.bank,
      ...extra,
    }),
  ).record;
}

/** The miss, or a failed assertion naming what resolved instead. */
function miss<T>(result: Resolved<T>) {
  if (result.ok) throw new Error(`Expected a miss, got id ${result.id}.`);
  return result;
}

const ids = (result: Resolved<unknown>) =>
  miss(result).candidates.map((c) => c.id);

describe("similarity", () => {
  it("ranks a typo close and an unrelated name far", () => {
    expect(similarity("advertsing", "advertising")).toBeGreaterThan(0.6);
    expect(similarity("acme", "acme sdn bhd")).toBeGreaterThan(0.5);
    expect(similarity("rent", "advertising")).toBeLessThan(0.3);
    expect(similarity("", "rent")).toBe(0);
  });

  it("ignores legal forms and filler words, which say nothing of which business", () => {
    // Below the 0.3 a candidate needs; 0.5 with "trading sdn bhd" counted.
    expect(
      similarity("abc trading sdn bhd", "xyz holdings sdn bhd"),
    ).toBeLessThan(0.3);
    expect(similarity("the abc company", "xyz co")).toBeLessThan(0.3);
    expect(similarity("abc m sdn bhd", "xyz pte ltd")).toBeLessThan(0.3);
    // The same business under two legal forms is as alike as can be.
    expect(similarity("acme sdn bhd", "acme berhad")).toBe(1);
    // Names without legal forms are compared as before.
    expect(similarity("grab malaysia", "grabcar")).toBeGreaterThanOrEqual(0.3);
    expect(similarity("tenaga nasional berhad", "tnb")).toBeLessThan(0.3);
  });

  it("compares names made only of legal forms as they are", () => {
    expect(
      similarity("holdings berhad", "abc holdings berhad"),
    ).toBeGreaterThan(0.5);
    expect(similarity("trading company", "holdings group")).toBeLessThan(0.3);
  });
});

describe("resolveRecord", () => {
  it("finds a record by its id, its number in any case, and #id", () => {
    const record = expense("Fuel");
    const number = record.recordNumber!;
    expect(number).toMatch(/^EX\d{8}-\d{3}$/);
    for (const ref of [
      record.id,
      number,
      number.toLowerCase(),
      `  ${number}  `,
      `#${record.id}`,
    ])
      expect(resolveRecord(book.ctx, ref)).toMatchObject({
        ok: true,
        id: record.id,
        value: { recordNumber: number, description: "Fuel" },
      });
  });

  it("offers the records numbered alike for a wrong number", () => {
    const first = expense("Fuel");
    const second = expense("Toll");
    const wrong = first.recordNumber!.replace(/\d{3}$/, "999");
    const result = miss(resolveRecord(book.ctx, wrong));
    expect(result.kind).toBe("not_found");
    expect(result.message).toBe(`No record is numbered "${wrong}".`);
    expect(result.candidates.map((c) => c.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
    expect(result.candidates[0].detail).toMatch(/^2026-03-01 expense: /);
  });

  it("never reads digits as an id, but offers the record with that id", () => {
    const record = expense("Fuel");
    const result = miss(resolveRecord(book.ctx, String(record.id)));
    expect(result.kind).toBe("not_found");
    expect(result.message).toContain("send the id as a number");
    expect(result.candidates[0].id).toBe(record.id);
  });

  it("finds nothing to offer for an id that does not exist", () => {
    expect(resolveRecord(book.ctx, 999_999)).toEqual({
      ok: false,
      kind: "not_found",
      message: "No record has id 999999.",
      candidates: [],
    });
    expect(miss(resolveRecord(book.ctx, 0)).kind).toBe("not_found");
  });

  it("is ambiguous when two numbers differ only in case", () => {
    const upper = expense("Upper");
    const lower = expense("Lower");
    for (const [record, number] of [
      [upper, "Ab-1"],
      [lower, "aB-1"],
    ] as const)
      book.db
        .update(schema.ledgerRecords)
        .set({ recordNumber: number })
        .where(eq(schema.ledgerRecords.id, record.id))
        .run();
    expect(resolveRecord(book.ctx, "Ab-1")).toMatchObject({
      ok: true,
      id: upper.id,
    });
    const result = miss(resolveRecord(book.ctx, "AB-1"));
    expect(result.kind).toBe("ambiguous");
    expect(result.candidates.map((c) => c.id).sort()).toEqual(
      [upper.id, lower.id].sort(),
    );
  });
});

describe("resolveAccount", () => {
  let advertising: ReturnType<typeof account>;
  let rent: ReturnType<typeof account>;
  let travel: ReturnType<typeof account>;
  let travelToo: ReturnType<typeof account>;
  let stationery: ReturnType<typeof account>;
  beforeEach(() => {
    advertising = account("Advertising", AccountType.Expense);
    rent = account("Rent", AccountType.Expense);
    travel = account("Travel", AccountType.Expense);
    travelToo = account("TRAVEL", AccountType.Expense);
    stationery = account("Old Stationery", AccountType.Expense);
    resultValue(updateAccount(book.ctx, stationery.id, { active: false }));
  });

  it("finds an account by id, code, name, and code with name", () => {
    const code = advertising.code!;
    for (const ref of [
      advertising.id,
      String(code),
      "advertising",
      "  ADVERTISING ",
      `${code} Advertising`,
      `${code} — advertising`,
      `${code}: Advertising`,
    ])
      expect(resolveAccount(book.ctx, ref)).toEqual({
        ok: true,
        id: advertising.id,
        value: {
          id: advertising.id,
          code,
          name: "Advertising",
          type: AccountType.Expense,
          subType: null,
          archived: false,
        },
      });
  });

  it("refuses a code and a name that belong to two accounts", () => {
    const code = advertising.code!;
    const result = miss(resolveAccount(book.ctx, `${code} Rent`));
    expect(result.kind).toBe("not_found");
    expect(result.message).toBe(
      `Code ${code} is ${code} Advertising, not "Rent". The code and the name must be of the same account.`,
    );
    expect(result.candidates.map((c) => c.id)).toEqual(
      expect.arrayContaining([advertising.id, rent.id]),
    );
    const unknown = miss(resolveAccount(book.ctx, "9999 Rent"));
    expect(unknown.message).toContain("No account has the code 9999.");
    expect(unknown.candidates[0].id).toBe(rent.id);
  });

  it("is ambiguous when two accounts share a name", () => {
    const result = miss(resolveAccount(book.ctx, "travel"));
    expect(result.kind).toBe("ambiguous");
    expect(result.message).toBe(`"travel" matches 2 accounts.`);
    expect(result.candidates).toEqual([
      { id: travel.id, name: `${travel.code} Travel`, detail: "Expense" },
      { id: travelToo.id, name: `${travelToo.code} TRAVEL`, detail: "Expense" },
    ]);
  });

  it("leaves out an archived account and says why", () => {
    const byName = miss(resolveAccount(book.ctx, "old stationery"));
    expect(byName.kind).toBe("not_found");
    expect(byName.message).toBe(
      `Account ${stationery.code} Old Stationery is archived, so it is not offered for new entries.`,
    );
    expect(byName.candidates.map((c) => c.id)).not.toContain(stationery.id);
    expect(miss(resolveAccount(book.ctx, stationery.id)).message).toContain(
      "is archived",
    );
    expect(
      resolveAccount(book.ctx, "Old Stationery", { includeArchived: true }),
    ).toMatchObject({ ok: true, id: stationery.id, value: { archived: true } });
  });

  it("leaves out an account of another kind and says what is needed", () => {
    const equipment = miss(
      resolveAccount(book.ctx, "Equipment", {
        where: isMoneyPotAccount,
        wanted: "a money account",
      }),
    );
    expect(equipment.message).toMatch(
      /^Account \d+ Equipment is an asset account, and this needs a money account\.$/,
    );
    expect(
      miss(
        resolveAccount(book.ctx, "Advertising", { types: [AccountType.Asset] }),
      ).message,
    ).toContain("is an expense account, which cannot be used here.");
    expect(
      resolveAccount(book.ctx, "bank", { where: isMoneyPotAccount }),
    ).toMatchObject({ ok: true, id: book.bank });
  });

  it("offers close names and never uses one", () => {
    const result = miss(resolveAccount(book.ctx, "Advertsing"));
    expect(result.message).toBe(`No account is named "Advertsing".`);
    expect(result.candidates[0]).toEqual({
      id: advertising.id,
      name: `${advertising.code} Advertising`,
      detail: "Expense",
    });
    // The archived namesake is not offered.
    expect(ids(resolveAccount(book.ctx, "Stationery"))).not.toContain(
      stationery.id,
    );
  });

  it("reads a number as an id and digits as a code, offering the other", () => {
    const code = advertising.code!;
    const asNumber = miss(resolveAccount(book.ctx, code));
    expect(asNumber.message).toBe(
      `No account has id ${code}. Account ${code} Advertising has the code ${code}: send "${code}" as a string to use a code.`,
    );
    expect(asNumber.candidates.map((c) => c.id)).toEqual([advertising.id]);

    const asDigits = miss(resolveAccount(book.ctx, String(rent.id)));
    expect(asDigits.message).toContain(
      `Account id ${rent.id} is ${rent.code} Rent: send the id as a number to use it.`,
    );
    expect(asDigits.candidates[0].id).toBe(rent.id);

    const nearby = miss(resolveAccount(book.ctx, String(code + 9000)));
    expect(nearby.kind).toBe("not_found");
  });

  it("follows a merged account to the account it was merged into", () => {
    const merged = account("Ads (old)", AccountType.Expense);
    book.db
      .update(schema.accounts)
      .set({ mergedIntoAccountId: advertising.id })
      .where(eq(schema.accounts.id, merged.id))
      .run();
    for (const ref of [merged.id, "Ads (old)", String(merged.code)])
      expect(resolveAccount(book.ctx, ref)).toMatchObject({
        ok: true,
        id: advertising.id,
      });
  });
});

describe("resolveContact", () => {
  let acme: number;
  let beta: number;
  let betaToo: number;
  beforeEach(() => {
    acme = contact("Acme Sdn. Bhd.");
    beta = contact("Beta Supplies");
    betaToo = contact("BETA SUPPLIES", "202001000001");
    book.db
      .insert(schema.contactRoles)
      .values({ contactId: betaToo, role: 2 })
      .run();
  });

  it("finds a contact by id, exact name, and name with its id", () => {
    for (const ref of [
      acme,
      "acme sdn bhd",
      " ACME SDN. BHD. ",
      `Acme Sdn Bhd #${acme}`,
      `#${acme}`,
    ])
      expect(resolveContact(book.ctx, ref)).toEqual({
        ok: true,
        id: acme,
        value: { id: acme, legalName: "Acme Sdn. Bhd.", entityType: 2 },
      });
  });

  it("reads #id alone as the id, and a name ending in #digits as a name", () => {
    const digits = contact(String(beta));
    const shop = contact(`Shop #${acme}`);
    expect(resolveContact(book.ctx, `#${beta}`)).toMatchObject({
      ok: true,
      id: beta,
    });
    expect(resolveContact(book.ctx, String(beta))).toMatchObject({
      ok: true,
      id: digits,
    });
    expect(resolveContact(book.ctx, `shop #${acme}`)).toMatchObject({
      ok: true,
      id: shop,
    });
  });

  it("refuses a name and an id that belong to two contacts", () => {
    const result = miss(resolveContact(book.ctx, `Acme Sdn Bhd #${beta}`));
    expect(result.kind).toBe("not_found");
    expect(result.message).toBe(
      `Contact #${beta} is "Beta Supplies", not "Acme Sdn Bhd". The name and the id must be of the same contact.`,
    );
    expect(result.candidates.map((c) => c.id)).toEqual(
      expect.arrayContaining([beta, acme]),
    );
    expect(miss(resolveContact(book.ctx, "#999999")).message).toBe(
      "No contact has id 999999.",
    );
  });

  it("is ambiguous when two contacts share a name", () => {
    const result = miss(resolveContact(book.ctx, "beta supplies"));
    expect(result.kind).toBe("ambiguous");
    expect(result.candidates).toEqual([
      { id: beta, name: "Beta Supplies" },
      {
        id: betaToo,
        name: "BETA SUPPLIES",
        detail: "Supplier; reg. 202001000001",
      },
    ]);
  });

  it("offers close names and never links one", () => {
    const result = miss(resolveContact(book.ctx, "Acme"));
    expect(result.kind).toBe("not_found");
    expect(result.message).toBe(`No contact is named "Acme".`);
    expect(result.candidates[0].id).toBe(acme);
    expect(miss(resolveContact(book.ctx, 999_999)).message).toBe(
      "No contact has id 999999.",
    );
  });

  it("offers no contact that shares only a legal form, and still the same business", () => {
    const xyz = contact("XYZ Holdings Sdn Bhd");
    const grab = contact("GrabCar");
    const tnb = contact("Tenaga Nasional Berhad");
    expect(ids(resolveContact(book.ctx, "ABC Trading Sdn Bhd"))).toEqual([]);
    expect(ids(resolveContact(book.ctx, "Grab Malaysia"))).toContain(grab);
    // An abbreviation is no near match, but the exact name still resolves.
    expect(ids(resolveContact(book.ctx, "TNB"))).not.toContain(tnb);
    expect(resolveContact(book.ctx, "tenaga nasional berhad.")).toMatchObject({
      ok: true,
      id: tnb,
    });
    // Another legal form of a name is offered first, never used.
    const other = miss(resolveContact(book.ctx, "XYZ Holdings Berhad"));
    expect(other.candidates[0].id).toBe(xyz);
  });
});

describe("what a payment settles", () => {
  let supplier: number;
  let payable: number;
  let receivable: number;
  beforeEach(() => {
    supplier = contact("Supplier");
    payable = accountDefaultId(book.db, DefaultAccountPurpose.Payable)!;
    receivable = accountDefaultId(book.db, DefaultAccountPurpose.Receivable)!;
  });

  const bill = (amount = 50) =>
    expense("Bill", amount, { paidFromAccountId: null, contactId: supplier });
  const owedLine = (record: ReturnType<typeof bill>) =>
    record.movements.find((m) => m.accountId === payable)!;
  const pay = (owedMovementId: number, amountMinor: number) =>
    resultValue(
      createRecord(book.ctx, {
        ...base,
        date: "2026-03-05",
        kind: "payment",
        amount: amountMinor / 100,
        description: "Payment",
        paidFromAccountId: book.bank,
        contactId: supplier,
        direction: "we-pay",
        settlements: [{ owedMovementId, amountMinor }],
      }),
    ).record;

  it("finds an unpaid bill's line on the payable account", () => {
    const record = bill();
    expect(resolveOpenItem(book.ctx, record.id)).toEqual({
      ok: true,
      id: owedLine(record).id,
      value: {
        movementId: owedLine(record).id,
        recordId: record.id,
        accountId: payable,
        amountMinor: -5000,
        settledMinor: 0,
        outstandingMinor: 5000,
        contactId: supplier,
      },
    });
  });

  it("says a record paid straight from the bank has nothing owed", () => {
    const record = expense("Paid at once");
    const result = miss(resolveOpenItem(book.ctx, record.id));
    expect(result.kind).toBe("not_found");
    expect(result.message).toBe(
      `Record ${record.recordNumber} has nothing owed: none of its lines is on the receivable or payable accounts, so no payment can settle it.`,
    );
    expect(miss(resolveOpenItem(book.ctx, 999_999)).message).toBe(
      "No record has id 999999.",
    );
  });

  it("is ambiguous on two owed lines, and the account picks one", () => {
    // An adjustment: its extra sides are taken as typed, so they balance by hand.
    const split = resultValue(
      createRecord(book.ctx, {
        ...base,
        amount: 50,
        description: "Two owed lines",
        fromAccountId: payable,
        toAccountId: book.expense,
        extraSides: [
          { accountId: receivable, amountMinor: 1000 },
          { accountId: book.depreciationExpense, amountMinor: -1000 },
        ],
        contactId: supplier,
      }),
    ).record;
    const result = miss(resolveOpenItem(book.ctx, split.id));
    expect(result.kind).toBe("ambiguous");
    expect(result.candidates.map((c) => c.id).sort()).toEqual(
      [payable, receivable].sort(),
    );
    expect(result.candidates.find((c) => c.id === receivable)!.detail).toBe(
      "10.00, 10.00 outstanding",
    );
    expect(
      resolveOpenItem(book.ctx, split.id, { accountId: receivable }),
    ).toMatchObject({
      ok: true,
      value: { accountId: receivable, amountMinor: 1000 },
    });
    expect(
      miss(resolveOpenItem(book.ctx, split.id, { accountId: book.bank }))
        .candidates,
    ).toHaveLength(2);
  });

  it("finds a payment's line and its allocation to a bill", () => {
    const record = bill();
    const payment = pay(owedLine(record).id, 5000);
    const side = payment.movements.find((m) => m.accountId === payable)!;
    expect(resolvePaymentMovement(book.ctx, payment.id)).toMatchObject({
      ok: true,
      id: side.id,
      value: {
        accountId: payable,
        amountMinor: 5000,
        settledMinor: 5000,
        outstandingMinor: 0,
      },
    });
    const settlement = book.db.select().from(schema.settlements).get()!;
    expect(resolveSettlement(book.ctx, payment.id, record.id)).toEqual({
      ok: true,
      id: settlement.id,
      value: {
        id: settlement.id,
        paymentMovementId: side.id,
        owedMovementId: owedLine(record).id,
        amountMinor: 5000,
      },
    });
    expect(
      miss(resolvePaymentMovement(book.ctx, expense("Cash").id)).message,
    ).toContain("cannot pay anything off");
  });

  it("misses a reversed allocation, and one that never was, offering what the payment settles", () => {
    const record = bill();
    const other = bill(20);
    const payment = pay(owedLine(record).id, 5000);
    const wrong = miss(resolveSettlement(book.ctx, payment.id, other.id));
    expect(wrong.message).toBe(
      `Record ${payment.recordNumber} has no active allocation to record ${other.recordNumber}.`,
    );
    expect(wrong.candidates.map((c) => c.id)).toEqual([record.id]);

    book.db
      .update(schema.settlements)
      .set({ reversedAt: new Date().toISOString() })
      .run();
    expect(miss(resolveSettlement(book.ctx, payment.id, record.id)).kind).toBe(
      "not_found",
    );
  });

  it("finds a group reimbursement's expense as the funding payment shows it", () => {
    const owner = contact("Owner");
    const first = bill(30);
    const second = bill(10);
    const group = createLegacyReimbursement(book.ctx, {
      contactId: owner,
      personallyPaid: true,
      date: "2026-03-10",
      description: "Reimbursement",
      reference: "",
      remark: "",
      items: [
        { owedMovementId: owedLine(first).id, amountMinor: 3000 },
        { owedMovementId: owedLine(second).id, amountMinor: 1000 },
      ],
      cashMinor: 4000,
      paidFromAccountId: book.bank,
      credits: [],
    });
    if (!group.ok) throw new Error(group.reason);
    const payment = group.value.payment!;
    const paymentLine = resolvePaymentMovement(book.ctx, payment.id);
    if (!paymentLine.ok) throw new Error(paymentLine.message);
    const shown = preparePaymentCorrection(book.ctx, paymentLine.id);
    if (!shown.ok) throw new Error(shown.reason);

    const found = resolveSettlement(book.ctx, payment.id, second.id);
    if (!found.ok) throw new Error(found.message);
    expect(found.value).toMatchObject({
      amountMinor: 1000,
      reimbursementGroupId: group.value.groupId,
    });
    expect(shown.value.allocations.map((a) => a.id)).toContain(found.id);

    // The expenses stand in for the group's funding row, as on the screen.
    const funding = miss(
      resolveSettlement(book.ctx, payment.id, group.value.payable.id),
    );
    expect(funding.candidates.map((c) => c.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
  });
});

describe("bank lines and statements", () => {
  function statement() {
    const statementId = book.db
      .insert(schema.bankStatements)
      .values({
        originalFilename: "march.pdf",
        storedFilePath: "reconciliation/march.pdf",
        extractionState: StatementExtractionState.Ready,
        uploadedBy: 1,
        accountId: book.bank,
      })
      .returning()
      .get()!.id;
    const lineId = book.db
      .insert(schema.bankStatementLines)
      .values({
        statementId,
        date: "2026-03-02",
        description: "Card purchase",
        amount: 12.5,
        direction: StatementDirection.Out,
      })
      .returning()
      .get()!.id;
    return { statementId, lineId };
  }

  it("writes L and S references and reads them back", () => {
    expect(lineRef(123)).toBe("L123");
    expect(statementRef(7)).toBe("S7");
    const { statementId, lineId } = statement();
    for (const ref of [lineId, lineRef(lineId), `l${lineId}`, ` ${lineId} `])
      expect(resolveBankLine(book.ctx, ref)).toMatchObject({
        ok: true,
        id: lineId,
        value: {
          statementId,
          accountId: book.bank,
          amount: 12.5,
          direction: StatementDirection.Out,
        },
      });
    for (const ref of [
      statementId,
      statementRef(statementId),
      `s${statementId}`,
    ])
      expect(resolveStatement(book.ctx, ref)).toMatchObject({
        ok: true,
        id: statementId,
        value: { accountId: book.bank, originalFilename: "march.pdf" },
      });
  });

  it("says which kind a wrong tag names, and what a missing one is", () => {
    const { statementId, lineId } = statement();
    expect(
      miss(resolveBankLine(book.ctx, statementRef(statementId))).message,
    ).toBe(
      `S${statementId} names a bank statement. Write a bank line as L123.`,
    );
    expect(miss(resolveStatement(book.ctx, lineRef(lineId))).message).toBe(
      `L${lineId} names a bank line. Write a bank statement as S7.`,
    );
    expect(miss(resolveBankLine(book.ctx, "X1")).message).toBe(
      `"X1" is not a bank line reference. Write a bank line as L123.`,
    );
    expect(miss(resolveBankLine(book.ctx, 999_999)).message).toBe(
      "No bank line is L999999.",
    );
    expect(miss(resolveStatement(book.ctx, "S999999")).message).toBe(
      "No bank statement is S999999.",
    );
    expect(miss(resolveBankLine(book.ctx, 0)).kind).toBe("not_found");
  });
});

describe("a miss goes straight to resolveError", () => {
  it("keeps the candidates an agent can choose from", () => {
    const result = miss(resolveAccount(book.ctx, "Ordinary expense"));
    const error = resolveError(result, {
      what: "account",
      ref: "Ordinary expense",
      path: "records[0].category",
    });
    expect(error.code).toBe("NOT_FOUND");
    expect(error.path).toBe("records[0].category");
    expect(error.candidates?.[0]).toMatchObject({
      id: book.expense,
      name: expect.stringMatching(/^\d+ Ordinary expenses$/),
      detail: "Expense",
    });

    const twins = [contact("Twin Trading"), contact("TWIN TRADING")];
    const both = resolveError(miss(resolveContact(book.ctx, "twin trading")), {
      what: "contact",
      ref: "twin trading",
    });
    expect(both.code).toBe("AMBIGUOUS");
    expect(both.candidates?.map((c) => c.id)).toEqual(twins);
  });
});
