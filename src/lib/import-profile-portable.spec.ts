import { describe, expect, it } from "vitest";
import {
  profileSnapshotOf,
  parseProfileSnapshot,
} from "./server/import/profile-snapshot.js";
import {
  draftFromFile,
  parseProfileFile,
  profileFile,
  profileFileName,
  type PortableChoices,
  type ProfileFile,
} from "./import-profile-portable.js";
import {
  checkProfile,
  type ImportProfileDraft,
} from "./import-profile-schema.js";
import { profileDraft } from "./server/import/__fixtures__/profile-drafts.js";
import {
  orderSections,
  walletLayout,
  withdrawalSection,
} from "./server/import/__fixtures__/wallet-table.js";

// The installation the profile was made in.
const here: PortableChoices = {
  moneyAccounts: [
    { id: 10, code: "1100", name: "Shopee wallet" },
    { id: 20, code: "1010", name: "Maybank" },
  ],
  expenseCategories: [{ id: 101, code: "6100", name: "Bank charges" }],
  incomeCategories: [{ id: 201, code: "4000", name: "Sales" }],
  otherProfiles: [{ id: 7, name: "Shopee income statement" }],
};

// Another installation: the same accounts under other ids.
const there: PortableChoices = {
  moneyAccounts: [
    { id: 51, code: "1100", name: "Wallet (renamed)" },
    { id: 52, code: "", name: "maybank " },
  ],
  expenseCategories: [{ id: 151, code: "6100", name: "Charges" }],
  incomeCategories: [{ id: 251, code: "4000", name: "Sales" }],
  otherProfiles: [{ id: 77, name: "shopee income statement" }],
};

/** A wallet report: an account, a transfer, categories and a same-money link. */
function walletDraft(): ImportProfileDraft {
  const [orders, adjustments] = orderSections({
    orders: 201,
    adjustments: 101,
  });
  const checked = checkProfile({
    name: "Shopee wallet report",
    description: "",
    phrases: [],
    instructions: "",
    kind: "table",
    mode: "every_transaction",
    statedTotalLabels: {},
    accountId: 10,
    layout: walletLayout(),
    sections: [
      { ...orders, sameMoneyAs: [7] },
      adjustments,
      withdrawalSection(20),
    ],
  });
  if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
  return checked.profile;
}

/** The file, as it is read back from disk. */
function roundTrip(file: ProfileFile): ProfileFile {
  const parsed = parseProfileFile(JSON.stringify(file));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.file;
}

describe("profileFile", () => {
  it("names accounts by code and name, and profiles by name, never by id", () => {
    const { file, lost } = profileFile(
      walletDraft(),
      here,
      new Date("2026-10-05T00:00:00Z"),
    );
    expect(lost).toEqual([]);
    expect(file.format).toBe("akaun.import-profile");
    expect(file.version).toBe(3);
    expect(file.exportedAt).toBe("2026-10-05T00:00:00.000Z");
    const profile = file.profile as {
      accountId: unknown;
      sections: Record<string, unknown>[];
    };
    expect(profile.accountId).toEqual({ code: "1100", name: "Shopee wallet" });
    expect(profile.sections[0].fixedCategoryAccountId).toEqual({
      code: "4000",
      name: "Sales",
    });
    expect(profile.sections[0].sameMoneyAs).toEqual([
      "Shopee income statement",
    ]);
    expect(profile.sections[1].fixedCategoryAccountId).toEqual({
      code: "6100",
      name: "Bank charges",
    });
    expect(profile.sections[2].counterAccountId).toEqual({
      code: "1010",
      name: "Maybank",
    });
    expect(JSON.stringify(file)).not.toMatch(
      /"(id|enabled|createdAt|updatedAt)"/,
    );
  });

  it("writes an id it cannot name as empty, and says so", () => {
    const draft = walletDraft();
    const { file, lost } = profileFile(draft, {
      ...here,
      expenseCategories: [],
      otherProfiles: [],
    });
    expect(lost).toEqual([
      "Section “Order income”: a profile with the same money",
      "Section “Adjustments”: category",
    ]);
    const sections = (file.profile as { sections: Record<string, unknown>[] })
      .sections;
    expect(sections[1].fixedCategoryAccountId).toBeNull();
    expect(sections[0].sameMoneyAs).toEqual([]);
  });

  it("names the file after the profile", () => {
    expect(profileFileName("Shopee wallet report")).toBe(
      "shopee_wallet_report.profile.json",
    );
    expect(profileFileName("2024")).toBe("import_profile.profile.json");
  });
});

describe("draftFromFile", () => {
  it("gives back the same profile in the same installation", () => {
    const draft = walletDraft();
    const read = draftFromFile(
      roundTrip(profileFile(draft, here).file),
      here,
      null,
    );
    expect(read.ok && read.unmatched).toEqual([]);
    expect(read.ok && read.draft).toEqual(draft);
  });

  it("finds each reference here by code first, then by name", () => {
    const read = draftFromFile(
      roundTrip(profileFile(walletDraft(), here).file),
      there,
      null,
    );
    if (!read.ok) throw new Error(read.error);
    expect(read.unmatched).toEqual([]);
    // By code, though the name differs.
    expect(read.draft.accountId).toBe(51);
    expect(read.draft.sections[1].fixedCategoryAccountId).toBe(151);
    expect(read.draft.sections[0].fixedCategoryAccountId).toBe(251);
    // By name, ignoring case and spaces, where there is no code.
    expect(read.draft.sections[2].counterAccountId).toBe(52);
    expect(read.draft.sections[0].sameMoneyAs).toEqual([77]);
  });

  it("looks up an income section's category among income categories only", () => {
    const base = profileDraft("marketplace_summary");
    base.sections[0].fixedCategoryAccountId = 201;
    base.sections[1].feeTypes[0].categoryAccountId = 101;
    const { file } = profileFile(base, here);
    // An expense category with the income one's code is not taken for it.
    const read = draftFromFile(
      roundTrip(file),
      {
        ...there,
        expenseCategories: [
          { id: 151, code: "6100", name: "Charges" },
          { id: 152, code: "4000", name: "Sales" },
        ],
        incomeCategories: [],
      },
      null,
    );
    if (!read.ok) throw new Error(read.error);
    expect(read.draft.sections[0].fixedCategoryAccountId).toBeNull();
    expect(read.unmatched).toEqual(["Section “Sales”: category: 4000 Sales"]);
    // A by-sign section takes either.
    expect(read.draft.sections[1].feeTypes[0].categoryAccountId).toBe(151);
  });

  it("leaves what is not here empty, and lists it", () => {
    const empty: PortableChoices = {
      moneyAccounts: [],
      expenseCategories: [],
      incomeCategories: [],
      otherProfiles: [],
    };
    const read = draftFromFile(
      roundTrip(profileFile(walletDraft(), here).file),
      empty,
      null,
    );
    if (!read.ok) throw new Error(read.error);
    expect(read.draft.accountId).toBeNull();
    expect(read.draft.sections[2].counterAccountId).toBeNull();
    expect(read.draft.sections[0].fixedCategoryAccountId).toBeNull();
    expect(read.draft.sections[0].sameMoneyAs).toBeUndefined();
    expect(read.unmatched).toEqual([
      "Account: 1100 Shopee wallet",
      "Section “Order income”: category: 4000 Sales",
      "Section “Order income”: same money as “Shopee income statement”",
      "Section “Adjustments”: category: 6100 Bank charges",
      "Section “Withdrawals”: other account: 1010 Maybank",
    ]);
  });

  it("never takes a bare number as an id from this installation", () => {
    const { file } = profileFile(walletDraft(), here);
    (file.profile as Record<string, unknown>).accountId = 51;
    const read = draftFromFile(roundTrip(file), there, null);
    expect(read.ok && read.draft.accountId).toBeNull();
    expect(read.ok && read.unmatched).toEqual(["Account"]);
  });

  it("does not let a profile name itself as the same money", () => {
    const read = draftFromFile(
      roundTrip(profileFile(walletDraft(), here).file),
      there,
      77,
    );
    expect(read.ok && read.draft.sections[0].sameMoneyAs).toBeUndefined();
    expect(read.ok && read.unmatched).toEqual([
      "Section “Order income”: same money as “Shopee income statement”",
    ]);
  });

  it("keeps each line type's name, and reads a file without one by its key", () => {
    const draft = profileDraft("fee_document");
    draft.sections[0].feeTypes[0].name = "Ads";
    const file = roundTrip(profileFile(draft, here).file);
    const read = draftFromFile(file, here, null);
    if (!read.ok) throw new Error(read.error);
    expect(read.draft.sections[0].feeTypes[0]).toMatchObject({
      key: "advertising_fee",
      name: "Ads",
    });

    // A file exported before line types had names.
    const sections = file.profile.sections as {
      feeTypes: Record<string, unknown>[];
    }[];
    for (const fee of sections[0].feeTypes) delete fee.name;
    const old = draftFromFile(file, here, null);
    if (!old.ok) throw new Error(old.error);
    expect(old.draft.sections[0].feeTypes[0].name).toBe("Advertising fee");
  });

  it("refuses a profile that is not one the editor can show", () => {
    const { file } = profileFile(walletDraft(), here);
    (file.profile as Record<string, unknown>).name = "";
    const read = draftFromFile(roundTrip(file), here, null);
    expect(read.ok).toBe(false);
    expect(!read.ok && read.error).toMatch(
      /^The profile in this file has problems: /,
    );
  });
});

describe("the profile's sheet (FR-069)", () => {
  it("goes with the profile, and comes back on import", () => {
    const draft = { ...walletDraft(), sheet: "Transaction Report" };
    const { file } = profileFile(draft, here);
    expect(file.version).toBe(3);
    expect(file.profile.sheet).toBe("Transaction Report");
    const back = draftFromFile(roundTrip(file), there, null);
    expect(back.ok && back.draft.sheet).toBe("Transaction Report");
  });
});

describe("the files a profile reads (FR-070)", () => {
  it("go with the profile when it reads one kind, and are left out for both", () => {
    const draft: ImportProfileDraft = {
      ...profileDraft("fee_document"),
      fileTypes: ["document"],
    };
    const { file } = profileFile(draft, here);
    expect(file.profile.fileTypes).toEqual(["document"]);
    const back = draftFromFile(roundTrip(file), there, null);
    expect(back.ok && back.draft.fileTypes).toEqual(["document"]);

    const both = profileFile({ ...draft, fileTypes: undefined }, here);
    expect(both.file.profile).not.toHaveProperty("fileTypes");
  });
});

describe("parseProfileFile", () => {
  it("says plainly what is wrong with a file that is not a profile file", () => {
    const error = (text: string) => {
      const parsed = parseProfileFile(text);
      return parsed.ok ? null : parsed.error;
    };
    expect(error("{not json")).toMatch(/not JSON/);
    expect(error('{"name":"A profile"}')).toMatch(
      /not an Akaun import profile/,
    );
    expect(error('{"format":"akaun.import-profile","profile":{}}')).toMatch(
      /no version/,
    );
    expect(
      error('{"format":"akaun.import-profile","version":4,"profile":{}}'),
    ).toMatch(/newer version/);
    expect(error('{"format":"akaun.import-profile","version":1}')).toMatch(
      /no profile/,
    );
    expect(
      error('{"format":"akaun.import-profile","version":1,"profile":{}}'),
    ).toBeNull();
  });
});

it("preserves table filters through portable export and import", () => {
  const draft = walletDraft();
  draft.sections[0].rows!.filter = [
    { column: "Status", op: "is", value: "Completed" },
  ];
  const result = draftFromFile(
    roundTrip(profileFile(draft, here).file),
    there,
    null,
  );
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.draft.sections[0].rows!.filter).toEqual(
    draft.sections[0].rows!.filter,
  );
  const snapshot = parseProfileSnapshot(
    JSON.stringify(profileSnapshotOf({ id: 7, ...draft })),
  );
  expect(snapshot?.profile.sections[0].rows!.filter).toEqual(
    draft.sections[0].rows!.filter,
  );
});

it("accepts version 2 profiles without filters", () => {
  const draft = walletDraft();
  const file = profileFile(draft, here).file;
  file.version = 2;
  const result = draftFromFile(roundTrip(file), here, null);
  expect(result.ok && result.draft).toEqual(draft);
});
