import { describe, expect, it } from "vitest";
import { AccountType } from "$lib/enums.js";
import { buildMovements } from "./entry-builder.js";
import type { AccountRef, BuildContext, BuildInput, MovementDraft } from "./types.js";

// A small chart of accounts to build against. Special-purpose accounts are
// identified by the saved IDs in CTX, not by retired account roles.
const BANK = 1;
const WALLET = 2;
const GROCERIES = 3;
const SALES = 4;
const RECEIVABLE = 5;
const PAYABLE = 6;
const OPENING = 7;
const LAPTOP = 8;

const REFS: AccountRef[] = [
  { id: BANK, type: AccountType.Asset },
  { id: WALLET, type: AccountType.Asset },
  { id: GROCERIES, type: AccountType.Expense },
  { id: SALES, type: AccountType.Revenue },
  { id: RECEIVABLE, type: AccountType.Asset },
  { id: PAYABLE, type: AccountType.Liability },
  { id: OPENING, type: AccountType.Equity },
  { id: LAPTOP, type: AccountType.Asset },
];

const CTX: BuildContext = {
  accounts: new Map(REFS.map((a) => [a.id, a])),
  receivableAccountId: RECEIVABLE,
  payableAccountId: PAYABLE,
  openingBalancesAccountId: OPENING,
};

function build(input: BuildInput) {
  return buildMovements(input, CTX);
}

/** The movements a successful build produced, or a failing assertion. */
function movementsOf(result: ReturnType<typeof build>): MovementDraft[] {
  expect(result.ok, result.ok ? "" : result.reason).toBe(true);
  return result.ok ? result.value : [];
}

function amountOn(movements: MovementDraft[], accountId: number): number {
  return movements
    .filter((m) => m.accountId === accountId)
    .reduce((sum, m) => sum + m.amountMinor, 0);
}

/** Every kind of record, in the shape each screen hands to the builder. */
const EVERY_KIND: { name: string; input: BuildInput }[] = [
  {
    name: "an expense paid from an account",
    input: {
      kind: "expense",
      amountMinor: 5000,
      contactId: null,
      categoryAccountId: GROCERIES,
      paidFromAccountId: BANK,
    },
  },
  {
    name: "an expense someone else paid",
    input: {
      kind: "expense",
      amountMinor: 5000,
      contactId: 42,
      categoryAccountId: GROCERIES,
      paidFromAccountId: null,
    },
  },
  {
    name: "income received into an account",
    input: {
      kind: "income",
      amountMinor: 100000,
      contactId: null,
      categoryAccountId: SALES,
      receivedIntoAccountId: WALLET,
    },
  },
  {
    name: "a transfer between two accounts",
    input: {
      kind: "transfer",
      amountMinor: 40000,
      contactId: null,
      fromAccountId: WALLET,
      toAccountId: BANK,
    },
  },
  {
    name: "a payment settling what we owe",
    input: {
      kind: "payment",
      amountMinor: 5000,
      contactId: 42,
      paidFromAccountId: BANK,
      direction: "we-pay",
    },
  },
  {
    name: "money received against what is owed to us",
    input: {
      kind: "payment",
      amountMinor: 5000,
      contactId: 42,
      paidFromAccountId: BANK,
      direction: "we-receive",
    },
  },
  {
    name: "issuing an invoice",
    input: {
      kind: "invoice-issue",
      amountMinor: 250000,
      contactId: 42,
      incomeAccountId: SALES,
    },
  },
  {
    name: "an opening balance",
    input: {
      kind: "opening-balance",
      amountMinor: 750000,
      contactId: null,
      accountId: BANK,
    },
  },
  {
    name: "a journal entry",
    input: {
      kind: "journal",
      amountMinor: 0,
      contactId: null,
      movements: [
        { accountId: GROCERIES, amountMinor: 1000 },
        { accountId: BANK, amountMinor: -1000 },
      ],
    },
  },
];

describe("the balance rule, for every kind of record", () => {
  it.each(EVERY_KIND)("$name has movements summing to zero", ({ input }) => {
    const movements = movementsOf(build(input));
    expect(movements.reduce((sum, m) => sum + m.amountMinor, 0)).toBe(0);
  });

  it.each(EVERY_KIND)("$name has at least two sides", ({ input }) => {
    expect(movementsOf(build(input)).length).toBeGreaterThanOrEqual(2);
  });

  it.each(EVERY_KIND)("$name has no side worth nothing", ({ input }) => {
    for (const m of movementsOf(build(input))) {
      expect(m.amountMinor).not.toBe(0);
    }
  });
});

describe("where each kind puts the money", () => {
  it("puts an expense paid from an account against that account", () => {
    const m = movementsOf(
      build({
        kind: "expense",
        amountMinor: 5000,
        contactId: null,
        categoryAccountId: GROCERIES,
        paidFromAccountId: BANK,
      }),
    );
    expect(amountOn(m, GROCERIES)).toBe(5000);
    expect(amountOn(m, BANK)).toBe(-5000);
  });

  it("puts an expense someone else paid against money we owe", () => {
    const m = movementsOf(
      build({
        kind: "expense",
        amountMinor: 5000,
        contactId: 42,
        categoryAccountId: GROCERIES,
        paidFromAccountId: null,
      }),
    );
    expect(amountOn(m, GROCERIES)).toBe(5000);
    expect(amountOn(m, PAYABLE)).toBe(-5000);
  });

  it("books income into the account that received it, out of its category", () => {
    const m = movementsOf(
      build({
        kind: "income",
        amountMinor: 1000000,
        contactId: null,
        categoryAccountId: SALES,
        receivedIntoAccountId: WALLET,
      }),
    );
    expect(amountOn(m, WALLET)).toBe(1000000);
    expect(amountOn(m, SALES)).toBe(-1000000);
  });

  it("touches no category on a transfer, so it is never income or an expense", () => {
    const m = movementsOf(
      build({
        kind: "transfer",
        amountMinor: 400000,
        contactId: null,
        fromAccountId: WALLET,
        toAccountId: BANK,
      }),
    );
    expect(amountOn(m, BANK)).toBe(400000);
    expect(amountOn(m, WALLET)).toBe(-400000);
    expect(amountOn(m, SALES)).toBe(0);
    expect(amountOn(m, GROCERIES)).toBe(0);
  });

  it("puts buying equipment on the equipment account, not on an expense category", () => {
    const m = movementsOf(
      build({
        kind: "expense",
        amountMinor: 300000,
        contactId: null,
        categoryAccountId: LAPTOP,
        paidFromAccountId: BANK,
      }),
    );
    expect(amountOn(m, LAPTOP)).toBe(300000);
    expect(amountOn(m, BANK)).toBe(-300000);
  });

  it("clears what we owe when we pay it, and takes the money out of the payer", () => {
    const m = movementsOf(
      build({
        kind: "payment",
        amountMinor: 5000,
        contactId: 42,
        paidFromAccountId: BANK,
        direction: "we-pay",
      }),
    );
    expect(amountOn(m, PAYABLE)).toBe(5000);
    expect(amountOn(m, BANK)).toBe(-5000);
  });

  it("clears what is owed to us when it arrives, into the receiving account", () => {
    const m = movementsOf(
      build({
        kind: "payment",
        amountMinor: 5000,
        contactId: 42,
        paidFromAccountId: BANK,
        direction: "we-receive",
      }),
    );
    expect(amountOn(m, BANK)).toBe(5000);
    expect(amountOn(m, RECEIVABLE)).toBe(-5000);
  });

  it("puts an issued invoice into money owed to us, out of its income account", () => {
    const m = movementsOf(
      build({
        kind: "invoice-issue",
        amountMinor: 250000,
        contactId: 42,
        incomeAccountId: SALES,
      }),
    );
    expect(amountOn(m, RECEIVABLE)).toBe(250000);
    expect(amountOn(m, SALES)).toBe(-250000);
  });

  it("puts an opening balance against the opening balances account", () => {
    const m = movementsOf(
      build({
        kind: "opening-balance",
        amountMinor: 750000,
        contactId: null,
        accountId: BANK,
      }),
    );
    expect(amountOn(m, BANK)).toBe(750000);
    expect(amountOn(m, OPENING)).toBe(-750000);
  });
});

describe("what the builder refuses", () => {
  it("refuses a record with only one side", () => {
    const result = build({
      kind: "journal",
      amountMinor: 0,
      contactId: null,
      movements: [{ accountId: BANK, amountMinor: 1000 }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/two sides|at least two/i);
  });

  it("refuses a set of sides that does not cancel out, naming the difference", () => {
    const result = build({
      kind: "journal",
      amountMinor: 0,
      contactId: null,
      movements: [
        { accountId: GROCERIES, amountMinor: 1000 },
        { accountId: BANK, amountMinor: -900 },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("1.00");
  });

  it("refuses a side worth nothing", () => {
    const result = build({
      kind: "journal",
      amountMinor: 0,
      contactId: null,
      movements: [
        { accountId: GROCERIES, amountMinor: 1000 },
        { accountId: BANK, amountMinor: -1000 },
        { accountId: WALLET, amountMinor: 0 },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/nothing|zero/i);
  });

  it("refuses an expense someone else paid that names nobody", () => {
    const result = build({
      kind: "expense",
      amountMinor: 5000,
      contactId: null,
      categoryAccountId: GROCERIES,
      paidFromAccountId: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/contact/i);
  });

  it("refuses a journal entry touching a shared owed account with no contact", () => {
    const result = build({
      kind: "journal",
      amountMinor: 0,
      contactId: null,
      movements: [
        { accountId: PAYABLE, amountMinor: 1000 },
        { accountId: BANK, amountMinor: -1000 },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/contact/i);
  });

  it("allows a journal entry touching a shared owed account when it names one", () => {
    const result = build({
      kind: "journal",
      amountMinor: 0,
      contactId: 42,
      movements: [
        { accountId: PAYABLE, amountMinor: 1000 },
        { accountId: BANK, amountMinor: -1000 },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it("refuses a transfer to the same account it came from", () => {
    const result = build({
      kind: "transfer",
      amountMinor: 40000,
      contactId: null,
      fromAccountId: BANK,
      toAccountId: BANK,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/same account/i);
  });

  it("refuses a record for no money at all", () => {
    const result = build({
      kind: "expense",
      amountMinor: 0,
      contactId: null,
      categoryAccountId: GROCERIES,
      paidFromAccountId: BANK,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/nothing|zero|more than/i);
  });

  it("refuses a side against an account it was not given", () => {
    const result = build({
      kind: "expense",
      amountMinor: 5000,
      contactId: null,
      categoryAccountId: 999,
      paidFromAccountId: BANK,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/account/i);
  });

  it("refuses a payment naming no contact and no settlements", () => {
    const result = build({
      kind: "payment",
      amountMinor: 5000,
      contactId: null,
      paidFromAccountId: BANK,
      direction: "we-pay",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/contact/i);
  });
});

describe("a batch payment — several contacts settled by one payment", () => {
  it("allows a payment naming no contact when it carries settlements", () => {
    const result = build({
      kind: "payment",
      amountMinor: 15000,
      contactId: null,
      paidFromAccountId: BANK,
      direction: "we-pay",
      settlements: [
        { owedMovementId: 101, amountMinor: 10000 },
        { owedMovementId: 102, amountMinor: 5000 },
      ],
    });
    expect(result.ok, result.ok ? "" : result.reason).toBe(true);
  });

  it("still clears what we owe and empties the payer, same as any payment", () => {
    const m = movementsOf(
      build({
        kind: "payment",
        amountMinor: 15000,
        contactId: null,
        paidFromAccountId: BANK,
        direction: "we-pay",
        settlements: [{ owedMovementId: 101, amountMinor: 15000 }],
      }),
    );
    expect(amountOn(m, PAYABLE)).toBe(15000);
    expect(amountOn(m, BANK)).toBe(-15000);
  });
});

describe("a journal entry's per-line label", () => {
  it("passes each line's label through unchanged", () => {
    const m = movementsOf(
      build({
        kind: "journal",
        amountMinor: 0,
        contactId: null,
        movements: [
          { accountId: GROCERIES, amountMinor: 1000, label: "Paper" },
          { accountId: BANK, amountMinor: -1000, label: "Scissors" },
        ],
      }),
    );
    expect(m.find((x) => x.accountId === GROCERIES)?.label).toBe("Paper");
    expect(m.find((x) => x.accountId === BANK)?.label).toBe("Scissors");
  });

  it("defaults to null when a line names no label", () => {
    const m = movementsOf(
      build({
        kind: "journal",
        amountMinor: 0,
        contactId: null,
        movements: [
          { accountId: GROCERIES, amountMinor: 1000 },
          { accountId: BANK, amountMinor: -1000 },
        ],
      }),
    );
    expect(m.every((x) => x.label === null)).toBe(true);
  });
});
