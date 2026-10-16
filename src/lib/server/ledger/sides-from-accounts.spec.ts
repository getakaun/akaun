import { describe, expect, it } from "vitest";
import {
  AccountRole,
  AccountSubType,
  AccountType,
  LedgerRecordKind,
} from "$lib/enums.js";
import {
  sidesFromAccounts,
  type SidesInput,
  type SidesContext,
} from "./sides-from-accounts.js";

/**
 * Principle V: a wrong kind is silent. Nothing on screen says "this was filed
 * as a transfer" — it simply appears in the wrong place on a report months
 * later, which is why every row of the derivation table (data-model.md §5) is
 * pinned here, over fixed type codes and saved default IDs with no database.
 *
 * The module builds **no movements**. It answers "which of the seven shapes did
 * the user just describe?" and hands that to `entry-builder.ts`, which stays
 * the single enforcement point of the zero-sum rule (research.md R-02).
 */

const ACCOUNTS = {
  bank: {
    id: 1,
    type: AccountType.Asset,
    role: AccountRole.Bank,
    subType: AccountSubType.Bank,
    archived: false,
  },
  cash: {
    id: 2,
    type: AccountType.Asset,
    role: AccountRole.Cash,
    subType: AccountSubType.Cash,
    archived: false,
  },
  fuel: {
    id: 3,
    type: AccountType.Expense,
    role: AccountRole.ExpenseCategory,
    subType: null,
    archived: false,
  },
  sales: {
    id: 4,
    type: AccountType.Revenue,
    role: AccountRole.IncomeCategory,
    subType: null,
    archived: false,
  },
  savings: {
    id: 5,
    type: AccountType.Asset,
    role: AccountRole.Bank,
    subType: AccountSubType.Bank,
    archived: false,
  },
  payable: {
    id: 6,
    type: AccountType.Liability,
    role: AccountRole.Payable,
    subType: null,
    archived: false,
  },
  receivable: {
    id: 7,
    type: AccountType.Asset,
    role: AccountRole.Receivable,
    subType: AccountSubType.Receivable,
    archived: false,
  },
  opening: {
    id: 8,
    type: AccountType.Equity,
    role: AccountRole.OpeningBalances,
    subType: null,
    archived: false,
  },
  capital: {
    id: 9,
    type: AccountType.Equity,
    role: AccountRole.PartnerCapital,
    subType: null,
    archived: false,
  },
  archived: {
    id: 10,
    type: AccountType.Expense,
    role: AccountRole.ExpenseCategory,
    subType: null,
    archived: true,
  },
  paper: {
    id: 11,
    type: AccountType.Expense,
    role: AccountRole.ExpenseCategory,
    subType: null,
    archived: false,
  },
  // An asset the business keeps, chosen on the form beside the categories.
  equipment: {
    id: 12,
    type: AccountType.Asset,
    role: AccountRole.Equipment,
    subType: AccountSubType.Equipment,
    archived: false,
  },
};

function ctx(overrides: Partial<SidesContext> = {}): SidesContext {
  return {
    accountById: (id: number) =>
      Object.values(ACCOUNTS).find((a) => a.id === id) ?? null,
    canAdjust: true,
    receivableAccountId: ACCOUNTS.receivable.id,
    payableAccountId: ACCOUNTS.payable.id,
    openingBalancesAccountId: ACCOUNTS.opening.id,
    ...overrides,
  };
}

function input(
  fromAccountId: number,
  toAccountId: number,
  extra: Partial<SidesInput> = {},
): SidesInput {
  return {
    fromAccountId,
    toAccountId,
    amountMinor: 10_000,
    contactId: null,
    ...extra,
  };
}

describe("sidesFromAccounts — the derivation table", () => {
  it("money pot → expense category is an expense", () => {
    const result = sidesFromAccounts(
      input(ACCOUNTS.bank.id, ACCOUNTS.fuel.id),
      ctx(),
    );
    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toEqual({
      kind: "expense",
      categoryAccountId: ACCOUNTS.fuel.id,
      paidFromAccountId: ACCOUNTS.bank.id,
    });
  });

  // Buying something the business keeps is an ordinary purchase, not a
  // rearrangement of the books: equipment is an asset, so reading `type === Asset`
  // as "holds money" made a laptop look like moving cash between two pots and
  // demanded the Adjustments ability nobody is granted (002 FR-006b, FR-031c).
  it("bank → equipment is an everyday purchase, with no Adjustments ability", () => {
    const result = sidesFromAccounts(
      input(ACCOUNTS.bank.id, ACCOUNTS.equipment.id),
      ctx({ canAdjust: false }),
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toMatchObject({
      kind: "expense",
      categoryAccountId: ACCOUNTS.equipment.id,
      paidFromAccountId: ACCOUNTS.bank.id,
    });
  });

  it("owed → equipment is an everyday purchase somebody else paid for", () => {
    const result = sidesFromAccounts(
      input(ACCOUNTS.payable.id, ACCOUNTS.equipment.id, { contactId: 42 }),
      ctx({ canAdjust: false }),
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toMatchObject({
      kind: "expense",
      categoryAccountId: ACCOUNTS.equipment.id,
      paidFromAccountId: null,
    });
  });

  it("asset → asset is a transfer", () => {
    const result = sidesFromAccounts(
      input(ACCOUNTS.cash.id, ACCOUNTS.savings.id),
      ctx(),
    );
    expect(result.ok && result.value.kind).toBe("transfer");
  });

  it("income category → money pot is income", () => {
    const result = sidesFromAccounts(
      input(ACCOUNTS.sales.id, ACCOUNTS.bank.id),
      ctx(),
    );
    expect(result.ok && result.value).toEqual({
      kind: "income",
      categoryAccountId: ACCOUNTS.sales.id,
      receivedIntoAccountId: ACCOUNTS.bank.id,
    });
  });

  it("money pot → money pot is a transfer", () => {
    const result = sidesFromAccounts(
      input(ACCOUNTS.bank.id, ACCOUNTS.cash.id),
      ctx(),
    );
    expect(result.ok && result.value).toEqual({
      kind: "transfer",
      fromAccountId: ACCOUNTS.bank.id,
      toAccountId: ACCOUNTS.cash.id,
    });
  });

  it("money pot → payable is a payment we make", () => {
    const result = sidesFromAccounts(
      input(ACCOUNTS.bank.id, ACCOUNTS.payable.id, { contactId: 42 }),
      ctx(),
    );
    expect(result.ok && result.value).toEqual({
      kind: "payment",
      paidFromAccountId: ACCOUNTS.bank.id,
      direction: "we-pay",
    });
  });

  it("receivable → money pot is a payment we receive", () => {
    const result = sidesFromAccounts(
      input(ACCOUNTS.receivable.id, ACCOUNTS.bank.id, { contactId: 42 }),
      ctx(),
    );
    expect(result.ok && result.value).toEqual({
      kind: "payment",
      paidFromAccountId: ACCOUNTS.bank.id,
      direction: "we-receive",
    });
  });

  it("payable → expense category is an expense somebody else paid", () => {
    const result = sidesFromAccounts(
      input(ACCOUNTS.payable.id, ACCOUNTS.fuel.id, { contactId: 42 }),
      ctx(),
    );
    expect(result.ok && result.value).toEqual({
      kind: "expense",
      categoryAccountId: ACCOUNTS.fuel.id,
      // Null is what makes it read as owed rather than paid (FR-008).
      paidFromAccountId: null,
    });
  });

  it("opening balances → anything is an opening balance", () => {
    const result = sidesFromAccounts(
      input(ACCOUNTS.opening.id, ACCOUNTS.bank.id),
      ctx(),
    );
    expect(result.ok && result.value).toEqual({
      kind: "opening-balance",
      accountId: ACCOUNTS.bank.id,
    });
  });

  it("any other pair is a journal entry, and its two sides cancel", () => {
    const result = sidesFromAccounts(
      input(ACCOUNTS.capital.id, ACCOUNTS.fuel.id),
      ctx(),
    );
    expect(result.ok && result.value).toEqual({
      kind: "journal",
      movements: [
        { accountId: ACCOUNTS.capital.id, amountMinor: -10_000 },
        { accountId: ACCOUNTS.fuel.id, amountMinor: 10_000 },
      ],
    });
  });

  it("extra sides make it a journal entry whatever the pair", () => {
    const result = sidesFromAccounts(
      input(ACCOUNTS.bank.id, ACCOUNTS.fuel.id, {
        extraSides: [{ accountId: ACCOUNTS.cash.id, amountMinor: -500 }],
      }),
      ctx(),
    );
    expect(result.ok && result.value.kind).toBe("journal");
    // The extra side comes through as typed; whether the whole set cancels is
    // entry-builder.ts's question, not this module's.
    expect(
      result.ok && result.value.kind === "journal" && result.value.movements,
    ).toEqual([
      { accountId: ACCOUNTS.bank.id, amountMinor: -10_000 },
      { accountId: ACCOUNTS.fuel.id, amountMinor: 10_000 },
      { accountId: ACCOUNTS.cash.id, amountMinor: -500 },
    ]);
  });

  it("builds no movements — it returns a RecordCreateSides only", () => {
    const result = sidesFromAccounts(
      input(ACCOUNTS.bank.id, ACCOUNTS.fuel.id),
      ctx(),
    );
    expect(result.ok).toBe(true);
    // An everyday kind states two accounts and lets the builder fill the pair.
    expect(result.ok && "movements" in result.value).toBe(false);
    expect(result.ok && "amountMinor" in result.value).toBe(false);
  });
});

describe("sidesFromAccounts — refusals", () => {
  it("refuses both sides naming the same account", () => {
    const result = sidesFromAccounts(
      input(ACCOUNTS.bank.id, ACCOUNTS.bank.id),
      ctx(),
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe(
      "Money cannot move from an account to itself. Choose two different accounts.",
    );
  });

  it("refuses a payable side with no contact, in the plain sentence", () => {
    const result = sidesFromAccounts(
      input(ACCOUNTS.bank.id, ACCOUNTS.payable.id),
      ctx(),
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("Select the contact for this receivable or payable.");
  });

  it("refuses a receivable side with no contact, in the same sentence", () => {
    const result = sidesFromAccounts(
      input(ACCOUNTS.receivable.id, ACCOUNTS.bank.id),
      ctx(),
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("Select the contact for this receivable or payable.");
  });

  it("refuses an archived account", () => {
    const result = sidesFromAccounts(
      input(ACCOUNTS.bank.id, ACCOUNTS.archived.id),
      ctx(),
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain("no longer in use");
  });

  it("refuses an account that does not exist", () => {
    const result = sidesFromAccounts(input(ACCOUNTS.bank.id, 999), ctx());
    expect(result.ok).toBe(false);
  });

  it("refuses a journal result without the adjustments ability", () => {
    const result = sidesFromAccounts(
      input(ACCOUNTS.capital.id, ACCOUNTS.fuel.id),
      ctx({ canAdjust: false }),
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe(
      "These two accounts need the Adjustments ability. Ask an administrator for it, or choose an everyday account on each line.",
    );
  });

  it("refuses extra sides without the adjustments ability", () => {
    const result = sidesFromAccounts(
      input(ACCOUNTS.bank.id, ACCOUNTS.fuel.id, {
        extraSides: [{ accountId: ACCOUNTS.cash.id, amountMinor: -500 }],
      }),
      ctx({ canAdjust: false }),
    );
    expect(result.ok).toBe(false);
  });

  it("allows an everyday pair without the adjustments ability", () => {
    const result = sidesFromAccounts(
      input(ACCOUNTS.bank.id, ACCOUNTS.fuel.id),
      ctx({ canAdjust: false }),
    );
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// An ordinary bill that spans several categories.
//
// One supplier invoice can cover fuel and paper. That is three sides — two
// categories and one payable — and it used to fall through to `journal`, which
// demanded the `adjustments` ability: the ability that exists because a record
// written that way can make the books say anything. An everyday purchase is not
// that, and should not need it.
//
// The *shape* stays `journal`, because `RecordCreateSides`' expense variant
// holds exactly one `categoryAccountId`. What changes is what it costs to write
// and what it is filed as.
// ---------------------------------------------------------------------------

describe("a bill spanning several categories", () => {
  const petronasBill = () =>
    input(ACCOUNTS.payable.id, ACCOUNTS.fuel.id, {
      contactId: 42,
      extraSides: [{ accountId: ACCOUNTS.paper.id, amountMinor: 3_000 }],
    });

  it("is allowed without the adjustments ability", () => {
    const result = sidesFromAccounts(petronasBill(), ctx({ canAdjust: false }));
    expect(result.ok).toBe(true);
  });

  it("is filed as a purchase, not as an adjustment", () => {
    const result = sidesFromAccounts(petronasBill(), ctx({ canAdjust: false }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected the bill to be allowed");
    expect(result.value.kind).toBe("journal");
    expect(
      result.value.kind === "journal" ? result.value.storedKind : undefined,
    ).toBe(LedgerRecordKind.Expense);
  });

  it("files a multi-category sale as income", () => {
    const result = sidesFromAccounts(
      input(ACCOUNTS.sales.id, ACCOUNTS.bank.id, {
        extraSides: [{ accountId: ACCOUNTS.sales.id, amountMinor: -2_000 }],
      }),
      ctx({ canAdjust: false }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected the sale to be allowed");
    expect(
      result.value.kind === "journal" ? result.value.storedKind : undefined,
    ).toBe(LedgerRecordKind.Income);
  });

  it("still refuses a genuine adjustment without the ability", () => {
    // Partner capital against a category is not a purchase by any reading.
    const result = sidesFromAccounts(
      input(ACCOUNTS.capital.id, ACCOUNTS.fuel.id, {
        extraSides: [{ accountId: ACCOUNTS.cash.id, amountMinor: -500 }],
      }),
      ctx({ canAdjust: false }),
    );
    expect(result.ok).toBe(false);
  });

  it("still refuses when more than one side holds money", () => {
    // Two money pots and a category is not one bill — it is a rearrangement.
    const result = sidesFromAccounts(
      input(ACCOUNTS.bank.id, ACCOUNTS.fuel.id, {
        extraSides: [{ accountId: ACCOUNTS.cash.id, amountMinor: -500 }],
      }),
      ctx({ canAdjust: false }),
    );
    expect(result.ok).toBe(false);
  });

  it("carries no storedKind on a real adjustment", () => {
    const result = sidesFromAccounts(
      input(ACCOUNTS.capital.id, ACCOUNTS.fuel.id, {
        extraSides: [{ accountId: ACCOUNTS.cash.id, amountMinor: -500 }],
      }),
      ctx({ canAdjust: true }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected the adjustment to be allowed");
    expect(
      result.value.kind === "journal" ? result.value.storedKind : undefined,
    ).toBeUndefined();
  });

  it("still needs a contact when a side is owed", () => {
    const result = sidesFromAccounts(
      input(ACCOUNTS.payable.id, ACCOUNTS.fuel.id, {
        extraSides: [{ accountId: ACCOUNTS.savings.id, amountMinor: 3_000 }],
      }),
      ctx({ canAdjust: false }),
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("Select the contact for this receivable or payable.");
  });

  // "Amount" is the bill's whole 100.00 (data-model.md invariant 6: it must
  // equal what the movements add up to on the category side), so the named
  // category — fuel — cannot also keep the full 100.00 once paper has typed a
  // 30.00 share of its own, or the two would never cancel.
  it("gives the named category what the extra sides leave, not the whole amount", () => {
    const result = sidesFromAccounts(petronasBill(), ctx({ canAdjust: false }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected the bill to be allowed");
    expect(result.value.kind === "journal" && result.value.movements).toEqual([
      { accountId: ACCOUNTS.payable.id, amountMinor: -10_000 },
      { accountId: ACCOUNTS.fuel.id, amountMinor: 7_000, label: null },
      { accountId: ACCOUNTS.paper.id, amountMinor: 3_000 },
    ]);
  });

  it("gives the named category its own label, and an extra side keeps its own", () => {
    const result = sidesFromAccounts(
      input(ACCOUNTS.payable.id, ACCOUNTS.fuel.id, {
        contactId: 42,
        extraSides: [
          { accountId: ACCOUNTS.paper.id, amountMinor: 3_000, label: "Paper" },
        ],
        categoryLabel: "Fuel",
      }),
      ctx({ canAdjust: false }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected the bill to be allowed");
    expect(result.value.kind === "journal" && result.value.movements).toEqual([
      { accountId: ACCOUNTS.payable.id, amountMinor: -10_000 },
      { accountId: ACCOUNTS.fuel.id, amountMinor: 7_000, label: "Fuel" },
      { accountId: ACCOUNTS.paper.id, amountMinor: 3_000, label: "Paper" },
    ]);
  });

  it("refuses when the extra sides already account for the whole amount", () => {
    const result = sidesFromAccounts(
      input(ACCOUNTS.payable.id, ACCOUNTS.fuel.id, {
        contactId: 42,
        extraSides: [{ accountId: ACCOUNTS.paper.id, amountMinor: 10_000 }],
      }),
      ctx({ canAdjust: false }),
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(
      /reduce them|increase the total/i,
    );
  });

  it("uses the category's own typed amount instead of the remainder, when given", () => {
    // Whether this actually cancels is entry-builder.ts's question, not this
    // module's (same as an extra side's typed amount) — 50.00 + 30.00 here
    // deliberately does not equal the 100.00 total, and this module still
    // hands it through as typed.
    const result = sidesFromAccounts(
      input(ACCOUNTS.payable.id, ACCOUNTS.fuel.id, {
        contactId: 42,
        extraSides: [{ accountId: ACCOUNTS.paper.id, amountMinor: 3_000 }],
        categoryAmountMinor: 5_000,
      }),
      ctx({ canAdjust: false }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected the bill to be allowed");
    expect(result.value.kind === "journal" && result.value.movements).toEqual([
      { accountId: ACCOUNTS.payable.id, amountMinor: -10_000 },
      { accountId: ACCOUNTS.fuel.id, amountMinor: 5_000, label: null },
      { accountId: ACCOUNTS.paper.id, amountMinor: 3_000 },
    ]);
  });

  it("does not touch the named category on a real adjustment, which balances by hand", () => {
    // Same shape sidesFromAccounts would otherwise "level" — but capital→fuel
    // is not an everyday bill, so the figures stay exactly as typed and it is
    // on the user (and the running difference) to make them cancel.
    const result = sidesFromAccounts(
      input(ACCOUNTS.capital.id, ACCOUNTS.fuel.id, {
        extraSides: [{ accountId: ACCOUNTS.cash.id, amountMinor: -500 }],
      }),
      ctx({ canAdjust: true }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected the adjustment to be allowed");
    expect(result.value.kind === "journal" && result.value.movements).toEqual([
      { accountId: ACCOUNTS.capital.id, amountMinor: -10_000 },
      { accountId: ACCOUNTS.fuel.id, amountMinor: 10_000 },
      { accountId: ACCOUNTS.cash.id, amountMinor: -500 },
    ]);
  });
});
