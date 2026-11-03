import { describe, expect, it } from "vitest";
import { AccountRole, AccountType, type AccountRoleCode } from "$lib/enums.js";
import { partnerStatement } from "./partner-statement.js";
import { accountTypeFor } from "../account-type.js";
import type { AccountTotal, Minor } from "../types.js";

function total(
  accountId: number,
  accountName: string,
  role: AccountRoleCode,
  contactId: number | null,
  amountMinor: Minor,
): AccountTotal {
  return {
    accountId,
    code: accountId,
    accountName,
    type: accountTypeFor(role),
    role,
    subType: null,
    contactId,
    amountMinor,
  };
}

const ALEX = 1;
const SAM = 2;
const ROBIN = 3;

const PARTNERS = [
  { contactId: ALEX, contactName: "Alex Tan" },
  { contactId: SAM, contactName: "Sam Lee" },
];

/** Alex put 5,000 in and took 1,200 back out; Sam put 3,000 in and took nothing. */
const TOTALS: AccountTotal[] = [
  total(
    100,
    "Alex Tan — money put in",
    AccountRole.PartnerCapital,
    ALEX,
    -500_000,
  ),
  total(
    101,
    "Alex Tan — money taken out",
    AccountRole.PartnerDrawings,
    ALEX,
    120_000,
  ),
  total(
    200,
    "Sam Lee — money put in",
    AccountRole.PartnerCapital,
    SAM,
    -300_000,
  ),
  total(201, "Sam Lee — money taken out", AccountRole.PartnerDrawings, SAM, 0),
];

describe("one block per contact holding the Partner role", () => {
  const report = partnerStatement({
    dateFrom: "2026-01-01",
    dateTo: "2026-12-31",
    partners: PARTNERS,
    totals: TOTALS,
    resultMinor: 90_001,
  });

  it("gives a block for each partner, in the order they were listed", () => {
    expect(report.partners.map((p) => p.contactId)).toEqual([ALEX, SAM]);
    expect(report.partners.map((p) => p.contactName)).toEqual([
      "Alex Tan",
      "Sam Lee",
    ]);
  });

  it("shows money put in as a positive figure", () => {
    // Capital sits at a negative balance under the one sign convention.
    expect(report.partners[0].contributionsMinor).toBe(500_000);
    expect(report.partners[1].contributionsMinor).toBe(300_000);
  });

  it("shows money taken out as a positive figure too", () => {
    expect(report.partners[0].drawingsMinor).toBe(120_000);
    expect(report.partners[1].drawingsMinor).toBe(0);
  });

  it("splits the result between them without losing or inventing a cent", () => {
    expect(report.partners[0].shareOfResultMinor).toBe(45_001);
    expect(report.partners[1].shareOfResultMinor).toBe(45_000);
    expect(
      report.partners.reduce((sum, p) => sum + p.shareOfResultMinor, 0),
    ).toBe(90_001);
  });

  it("leaves each partner what they put in, plus their share, less what they took out", () => {
    expect(report.partners[0].netMinor).toBe(500_000 + 45_001 - 120_000);
    expect(report.partners[1].netMinor).toBe(300_000 + 45_000 - 0);
  });

  it("echoes the period it covers", () => {
    expect(report.dateFrom).toBe("2026-01-01");
    expect(report.dateTo).toBe("2026-12-31");
  });

  it("says in plain words how the result was split", () => {
    expect(report.notes.some((n) => /equal/i.test(n))).toBe(true);
  });
});

describe("contact-scoped Equity movements", () => {
  it("treats credit-direction Equity as money put in and debit-direction Equity as money taken out", () => {
    const report = partnerStatement({
      dateFrom: "2026-01-01",
      dateTo: "2026-12-31",
      partners: [{ contactId: ALEX, contactName: "Alex Tan" }],
      totals: [
        {
          ...total(800, "Alex equity credit", AccountRole.Bank, ALEX, -5_000),
          type: AccountType.Equity,
        },
        {
          ...total(801, "Alex equity debit", AccountRole.Bank, ALEX, 1_200),
          type: AccountType.Equity,
        },
        {
          ...total(802, "Alex asset", AccountRole.PartnerCapital, ALEX, -9_000),
          type: AccountType.Asset,
        },
      ],
      resultMinor: 0,
    });
    expect(report.partners[0].contributionsMinor).toBe(5_000);
    expect(report.partners[0].drawingsMinor).toBe(1_200);
    expect(report.partners[0].netMinor).toBe(3_800);
  });
});

describe("a partner who has not moved any money yet", () => {
  it("still gets a block, at zero", () => {
    const report = partnerStatement({
      dateFrom: "2026-01-01",
      dateTo: "2026-12-31",
      partners: [...PARTNERS, { contactId: ROBIN, contactName: "Robin Ng" }],
      totals: TOTALS,
      resultMinor: 0,
    });
    const robin = report.partners.find((p) => p.contactId === ROBIN);
    expect(robin).toEqual({
      contactId: ROBIN,
      contactName: "Robin Ng",
      contributionsMinor: 0,
      shareOfResultMinor: 0,
      drawingsMinor: 0,
      netMinor: 0,
    });
  });

  it("is counted when the result is shared out", () => {
    const report = partnerStatement({
      dateFrom: "2026-01-01",
      dateTo: "2026-12-31",
      partners: [...PARTNERS, { contactId: ROBIN, contactName: "Robin Ng" }],
      totals: TOTALS,
      resultMinor: 90_000,
    });
    expect(report.partners.map((p) => p.shareOfResultMinor)).toEqual([
      30_000, 30_000, 30_000,
    ]);
  });
});

describe("a period the business lost money in", () => {
  it("shares the loss out too, and takes it off what each partner is left with", () => {
    const report = partnerStatement({
      dateFrom: "2026-01-01",
      dateTo: "2026-12-31",
      partners: PARTNERS,
      totals: TOTALS,
      resultMinor: -90_001,
    });
    expect(report.partners[0].shareOfResultMinor).toBe(-45_001);
    expect(report.partners[1].shareOfResultMinor).toBe(-45_000);
    expect(report.partners[1].netMinor).toBe(300_000 - 45_000);
  });
});

describe("accounts that are not a partner's", () => {
  it("leaves out anything that belongs to nobody or to somebody else", () => {
    const report = partnerStatement({
      dateFrom: "2026-01-01",
      dateTo: "2026-12-31",
      partners: [{ contactId: ALEX, contactName: "Alex Tan" }],
      totals: [
        ...TOTALS,
        total(300, "Bank", AccountRole.Bank, null, 900_000),
        total(
          301,
          "Opening balances",
          AccountRole.OpeningBalances,
          null,
          -900_000,
        ),
      ],
      resultMinor: 0,
    });
    expect(report.partners).toHaveLength(1);
    expect(report.partners[0].contributionsMinor).toBe(500_000);
    expect(report.partners[0].drawingsMinor).toBe(120_000);
  });
});

describe("no partners at all", () => {
  it("produces an empty statement rather than failing", () => {
    const report = partnerStatement({
      dateFrom: "2026-01-01",
      dateTo: "2026-12-31",
      partners: [],
      totals: [],
      resultMinor: 50_000,
    });
    expect(report.partners).toEqual([]);
  });
});

describe("stable rounding when partner labels or display order change", () => {
  it.each([101, -101])(
    "keeps each contact's share of %s cents after a rename changes alphabetical order",
    (resultMinor) => {
      const base = {
        dateFrom: "2026-10-01",
        dateTo: "2026-10-31",
        totals: [],
        resultMinor,
      };
      const original = partnerStatement({
        ...base,
        partners: PARTNERS,
      }).partners;
      const renamed = partnerStatement({
        ...base,
        partners: [PARTNERS[1], { contactId: ALEX, contactName: "Zach Tan" }],
      }).partners;
      expect(renamed.map((p) => p.contactName)).toEqual([
        "Sam Lee",
        "Zach Tan",
      ]);
      for (const partner of original) {
        expect(
          renamed.find((p) => p.contactId === partner.contactId)
            ?.shareOfResultMinor,
        ).toBe(partner.shareOfResultMinor);
      }
      expect(renamed.reduce((sum, p) => sum + p.shareOfResultMinor, 0)).toBe(
        resultMinor,
      );
    },
  );

  it("assigns the rounding remainder by numeric contact id and preserves caller display order", () => {
    const partners = [
      { contactId: 10, contactName: "Amy" },
      { contactId: 2, contactName: "Ben" },
    ];
    const base = {
      dateFrom: "2026-10-01",
      dateTo: "2026-10-31",
      totals: [],
      resultMinor: 101,
    };
    const report = partnerStatement({ ...base, partners });
    const reordered = partnerStatement({
      ...base,
      partners: [...partners].reverse(),
    });
    expect(
      report.partners.map((p) => [p.contactId, p.shareOfResultMinor]),
    ).toEqual([
      [10, 50],
      [2, 51],
    ]);
    expect(
      reordered.partners.map((p) => [p.contactId, p.shareOfResultMinor]),
    ).toEqual([
      [2, 51],
      [10, 50],
    ]);
    expect(partners.map((p) => p.contactId)).toEqual([10, 2]);
  });
});
