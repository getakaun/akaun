import { describe, expect, it } from "vitest";
import {
  PROFILE_ENUM_VALUES_MAX,
  ROW_CONDITIONS_MAX,
  PROFILE_EXTRAS_MAX,
  PROFILE_FEE_TYPES_MAX,
  PROFILE_SAME_MONEY_MAX,
  PROFILE_SECTIONS_MAX,
  checkProfile,
  checkTablePreview,
  extraFieldsOf,
  feeTypeName,
  fileTypesOf,
  foldTableText,
  formatProfileErrors,
  legacyProfileMode,
  nameFromKey,
  profileFileTypes,
  profileSections,
  readsFromColumns,
  validateExtrasFragment,
  validateProfile,
  type ImportProfileDraft,
  type ProfileError,
} from "./import-profile-schema.js";
import {
  orderSections,
  walletLayout,
  withdrawalSection,
} from "./server/import/__fixtures__/wallet-table.js";
import {
  PROFILE_DRAFT_IDS,
  profileDraft,
} from "./server/import/__fixtures__/profile-drafts.js";

/**
 * The one check of an import profile, which the editor and the server both
 * run (006 FR-035). Each rule is shown refusing with the path of the value it
 * is about, so the editor can put the message beside the field.
 */

function profile(): ImportProfileDraft {
  return {
    name: "Ads invoice",
    description: "A monthly advertising invoice.",
    phrases: ["Ads e-Invoice"],
    instructions: "- Read each ad charge.",
    mode: "summary",
    statedTotalLabels: { summary: "Total charges" },
    sections: [
      {
        key: "fees",
        name: "Fees",
        description: "Each ad charge line.",
        kind: "expense",
        fixedCategoryAccountId: null,
        feeTypes: [
          { key: "ads", name: "Ads", description: "Ads", categoryAccountId: 7 },
          { key: "tax", name: "Tax", description: "", categoryAccountId: null },
        ],
        extras: null,
      },
    ],
  };
}

function withExtras(extras: unknown) {
  const value = profile() as unknown as {
    sections: Record<string, unknown>[];
  };
  value.sections[0].extras = extras;
  return value;
}

function paths(errors: ProfileError[]): string[] {
  return errors.map((error) => error.path);
}

/**
 * A draft with both its accounts chosen, as the user must before saving a
 * wallet report profile (FR-030). A draft with no transfer is unchanged.
 */
function withAccounts(draft: ImportProfileDraft): ImportProfileDraft {
  if (!draft.sections.some((section) => section.kind === "transfer")) {
    return draft;
  }
  return {
    ...draft,
    accountId: 5,
    sections: draft.sections.map((section) =>
      section.kind === "transfer"
        ? { ...section, counterAccountId: 6 }
        : section,
    ),
  };
}

describe("the spec drafts", () => {
  it.each(PROFILE_DRAFT_IDS.map((id) => [id]))(
    "%s passes the check unchanged, once its accounts are chosen",
    (id) => {
      const draft = withAccounts(profileDraft(id));
      const result = checkProfile(draft);
      expect(result).toEqual({ ok: true, profile: draft });
    },
  );

  it.each([["wallet_withdrawals"], ["wallet_every_transaction"]] as const)(
    "%s cannot be saved until both of its accounts are chosen (FR-030)",
    (id) => {
      const result = checkProfile(profileDraft(id));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      const transfer = profileDraft(id).sections.findIndex(
        (section) => section.kind === "transfer",
      );
      expect(paths(result.errors).sort()).toEqual(
        ["accountId", `sections[${transfer}].counterAccountId`].sort(),
      );
    },
  );
});

describe("checkProfile", () => {
  it("accepts a valid profile and trims its text", () => {
    const input = profile();
    input.name = "  Ads invoice  ";
    input.sections[0].feeTypes[0].description = " Ads ";
    const result = checkProfile(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.name).toBe("Ads invoice");
    expect(result.profile.sections[0].feeTypes[0].description).toBe("Ads");
  });

  it("drops keys a profile does not have", () => {
    const result = checkProfile({ ...profile(), id: 3, enabled: false });
    expect(result.ok && Object.keys(result.profile).sort()).toEqual([
      "description",
      "instructions",
      "kind",
      "mode",
      "name",
      "phrases",
      "sections",
      "statedTotalLabels",
    ]);
  });

  it("keeps the profile's one import mode (FR-032)", () => {
    const input = {
      ...profile(),
      mode: "every_transaction" as const,
      statedTotalLabels: { every_transaction: "  Total money in  " },
    };
    const result = checkProfile(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.mode).toBe("every_transaction");
    expect(result.profile.statedTotalLabels).toEqual({
      every_transaction: "Total money in",
    });
  });

  it("refuses a mode it does not know", () => {
    const errors = validateProfile({ ...profile(), mode: "everything" });
    expect(paths(errors)).toEqual(["mode"]);
    expect(errors[0].message).toBe(
      "Choose what the profile imports: Summary lines or Every transaction.",
    );
  });

  it("refuses a stated total under any key but the profile's mode", () => {
    const input = profile();
    input.statedTotalLabels = {
      summary: "Total charges",
      every_transaction: "Total money in",
    };
    const errors = validateProfile(input);
    expect(paths(errors)).toEqual(["statedTotalLabels.every_transaction"]);
    expect(errors[0].message).toBe(
      "This profile imports Summary, so its stated total is given for that only.",
    );
    const unknown = validateProfile({
      ...profile(),
      statedTotalLabels: { everything: "Total" },
    });
    expect(paths(unknown)).toEqual(["statedTotalLabels.everything"]);
  });

  it("never keeps a section's own mode: the profile's decides", () => {
    const input = profile() as unknown as {
      sections: Record<string, unknown>[];
    };
    input.sections[0].mode = "summary";
    const result = checkProfile(input);
    expect(result.ok).toBe(true);
    expect(result.ok && result.profile.sections[0]).not.toHaveProperty("mode");
    // A value that is no mode at all is dropped the same way.
    input.sections[0].mode = "everything";
    const odd = checkProfile(input);
    expect(odd.ok && odd.profile.sections[0]).not.toHaveProperty("mode");
  });

  describe("a profile sent with no mode, as an older editor sends it", () => {
    /** The profile with no profile mode, its sections in these modes. */
    function legacy(...modes: (string | undefined)[]) {
      const base = profile() as unknown as Record<string, unknown> & {
        sections: Record<string, unknown>[];
      };
      delete base.mode;
      base.statedTotalLabels = {};
      base.sections = modes.map((mode, index) => ({
        ...profile().sections[0],
        key: `part_${index + 1}`,
        ...(mode ? { mode } : {}),
      }));
      return base;
    }

    it("gets Every transaction when every section was in it", () => {
      const result = checkProfile(
        legacy("every_transaction", "every_transaction"),
      );
      expect(result.ok && result.profile.mode).toBe("every_transaction");
      expect(result.ok && result.profile.sections[0]).not.toHaveProperty(
        "mode",
      );
    });

    it("gets Summary when no section had a mode, or every one was Summary", () => {
      expect(checkProfile(legacy(undefined)).ok).toBe(true);
      const none = checkProfile(legacy(undefined, undefined));
      expect(none.ok && none.profile.mode).toBe("summary");
      const summary = checkProfile(legacy("summary", undefined));
      expect(summary.ok && summary.profile.mode).toBe("summary");
    });

    it("gets Summary with a problem on each Every transaction section when they were mixed", () => {
      const errors = validateProfile(
        legacy("summary", "every_transaction", undefined),
      );
      expect(paths(errors)).toEqual(["sections[1].mode"]);
      expect(errors[0].message).toBe(
        "This profile now reads one way: Summary. This section was read as Every transaction: move it to a new profile, or change the profile to Every transaction.",
      );
    });

    it("is refused the same way when the editor sends the profile's mode with an old section", () => {
      const input = legacy("summary", "every_transaction");
      expect(paths(validateProfile({ ...input, mode: "summary" }))).toEqual([
        "sections[1].mode",
      ]);
      expect(
        paths(validateProfile({ ...input, mode: "every_transaction" })),
      ).toEqual(["sections[0].mode"]);
    });
  });

  it("names each missing required field", () => {
    const input = profile();
    input.name = " ";
    input.description = "";
    input.sections[0].name = "";
    input.sections[0].description = "";
    // The recognition description is checked last: whether it is needed
    // depends on the kind, known once the sections are read.
    expect(paths(validateProfile(input))).toEqual([
      "name",
      "sections[0].name",
      "sections[0].description",
      "description",
    ]);
  });

  it("needs at least one section", () => {
    const input = profile();
    input.sections = [];
    expect(validateProfile(input)).toEqual([
      { path: "sections", message: "A profile needs at least one section." },
    ]);
  });

  it("refuses a bad section key, line type key and a key used twice", () => {
    const input = profile();
    input.sections[0].key = "Fees";
    input.sections[0].feeTypes[1].key = "ads";
    input.sections.push({ ...input.sections[0], key: "x".repeat(33) });
    input.sections.push({ ...structuredClone(input.sections[0]), key: "" });
    input.sections[2].feeTypes = [
      {
        key: "9lives",
        name: "9lives",
        description: "",
        categoryAccountId: null,
      },
    ];
    const errors = validateProfile(input);
    expect(paths(errors)).toEqual([
      "sections[0].key",
      "sections[0].feeTypes[1].key",
      "sections[1].key",
      "sections[1].feeTypes[1].key",
      "sections[2].key",
      "sections[2].feeTypes[0].key",
    ]);
    expect(errors[0].message).toMatch(/lower-case letter/);
    expect(errors[1].message).toMatch(/listed twice/);
  });

  it("names a line type saved before line types had names by its key", () => {
    const input = profile() as unknown as {
      sections: { feeTypes: Record<string, unknown>[] }[];
    };
    delete input.sections[0].feeTypes[0].name;
    input.sections[0].feeTypes[1].name = "  ";
    const result = checkProfile(input);
    if (!result.ok) throw new Error(formatProfileErrors(result.errors));
    expect(result.profile.sections[0].feeTypes.map((fee) => fee.name)).toEqual([
      "Ads",
      "Tax",
    ]);
    expect(nameFromKey("seller_coins_cashback")).toBe("Seller coins cashback");
  });

  it("refuses two line types with one name in a section, whatever the case", () => {
    const input = profile();
    input.sections[0].feeTypes[1].name = "ADS";
    const errors = validateProfile(input);
    expect(paths(errors)).toEqual(["sections[0].feeTypes[1].name"]);
    expect(errors[0].message).toMatch(/"ADS" is listed twice/);
  });

  it("shows a line type by its name, or its key as words when it is gone", () => {
    const fees = [{ key: "ads", name: "Advertising" }];
    expect(feeTypeName(fees, "ads")).toBe("Advertising");
    expect(feeTypeName(fees, "old_fee")).toBe("Old fee");
  });

  it("refuses two sections with one key", () => {
    const input = profile();
    input.sections.push(structuredClone(input.sections[0]));
    const errors = validateProfile(input);
    expect(paths(errors)).toEqual(["sections[1].key"]);
    expect(errors[0].message).toMatch(/Two sections use the key "fees"/);
  });

  it("refuses a key every plain object already has, which reading would trip on", () => {
    const input = profile();
    input.sections[0].key = "constructor";
    input.sections[0].feeTypes[1].key = "constructor";
    const errors = validateProfile(input);
    expect(paths(errors)).toEqual([
      "sections[0].key",
      "sections[0].feeTypes[1].key",
    ]);
    expect(errors[0].message).toBe(
      '"constructor" cannot be used as a section key. Choose another name.',
    );
  });

  it('refuses "none" as a line type key or a choice, since the reading uses it for none', () => {
    const input = withExtras({
      type: "object",
      properties: { status: { type: "string", enum: ["paid", "none"] } },
    }) as unknown as ImportProfileDraft;
    input.sections[0].feeTypes[1].key = "none";
    const errors = validateProfile(input);
    expect(paths(errors)).toEqual([
      "sections[0].feeTypes[1].key",
      "sections[0].extras.properties.status.enum[1]",
    ]);
    expect(errors[0].message).toMatch(/none of the line types/);
  });

  it("refuses an unknown kind", () => {
    const input = profile() as unknown as {
      sections: Record<string, unknown>[];
    };
    input.sections[0].kind = "document";
    expect(paths(validateProfile(input))).toEqual(["sections[0].kind"]);
  });

  it("refuses a category that is not an account id", () => {
    const input = profile() as unknown as {
      sections: {
        fixedCategoryAccountId: unknown;
        feeTypes: { categoryAccountId: unknown }[];
      }[];
    };
    input.sections[0].fixedCategoryAccountId = "Office";
    input.sections[0].feeTypes[0].categoryAccountId = 1.5;
    expect(paths(validateProfile(input))).toEqual([
      "sections[0].fixedCategoryAccountId",
      "sections[0].feeTypes[0].categoryAccountId",
    ]);
  });

  it("refuses repeated and empty phrases", () => {
    const input = profile();
    input.phrases = ["Ads e-Invoice", "ads E-INVOICE", " "];
    expect(paths(validateProfile(input))).toEqual(["phrases[1]", "phrases[2]"]);
  });

  it("refuses text over its limit, naming the length", () => {
    const input = profile();
    input.instructions = "x".repeat(4001);
    const errors = validateProfile(input);
    expect(errors).toEqual([
      {
        path: "instructions",
        message:
          "The instructions can be at most 4000 characters; this has 4001.",
      },
    ]);
  });

  it(`allows ${PROFILE_SECTIONS_MAX} sections and no more`, () => {
    const input = profile();
    const base = input.sections[0];
    input.sections = Array.from({ length: PROFILE_SECTIONS_MAX }, (_, i) => ({
      ...structuredClone(base),
      key: `s${i}`,
      feeTypes: [],
    }));
    expect(validateProfile(input)).toEqual([]);
    input.sections.push({
      ...structuredClone(base),
      key: "extra",
      feeTypes: [],
    });
    expect(paths(validateProfile(input))).toEqual(["sections"]);
  });

  it(`allows ${PROFILE_FEE_TYPES_MAX} line types in a section and no more`, () => {
    const input = profile();
    input.sections[0].feeTypes = Array.from(
      { length: PROFILE_FEE_TYPES_MAX + 1 },
      (_, i) => ({
        key: `fee_${i}`,
        name: `Fee ${i}`,
        description: "",
        categoryAccountId: null,
      }),
    );
    expect(paths(validateProfile(input))).toEqual(["sections[0].feeTypes"]);
  });

  it(`allows ${PROFILE_ENUM_VALUES_MAX} listed values in all, counting line types and extra choices`, () => {
    const input = profile();
    const fees = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, i) => ({
        key: `${prefix}_${i}`,
        name: `${prefix} ${i}`,
        description: "",
        categoryAccountId: null,
      }));
    const base = input.sections[0];
    // 4 sections of 50 line types: exactly the limit.
    input.sections = ["a", "b", "c", "d"].map((key) => ({
      ...structuredClone(base),
      key,
      feeTypes: fees(key, 50),
    }));
    expect(validateProfile(input)).toEqual([]);

    // One extra choice on the last section is one too many.
    input.sections[3].extras = {
      type: "object",
      properties: { channel: { type: "string", enum: ["web"] } },
    };
    const errors = validateProfile(input);
    expect(paths(errors)).toEqual(["sections[3]"]);
    expect(errors[0].message).toMatch(/at most 200 values in all/);
  });
});

describe("validateExtrasFragment", () => {
  it("accepts flat plain fields, and reads which may be missing", () => {
    const result = validateExtrasFragment(
      JSON.stringify({
        type: "object",
        properties: {
          order_no: { type: "string", description: "The order number" },
          quantity: { type: ["integer", "null"] },
          paid_by_card: { type: "boolean" },
          channel: { type: "string", enum: ["web", "app"] },
        },
        required: ["order_no", "paid_by_card"],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.enumCount).toBe(2);
    expect(extraFieldsOf(result.fragment)).toEqual([
      {
        key: "order_no",
        type: "string",
        nullable: false,
        description: "The order number",
        enum: null,
      },
      {
        key: "quantity",
        type: "integer",
        nullable: true,
        description: null,
        enum: null,
      },
      {
        key: "paid_by_card",
        type: "boolean",
        nullable: false,
        description: null,
        enum: null,
      },
      {
        key: "channel",
        type: "string",
        nullable: true,
        description: null,
        enum: ["web", "app"],
      },
    ]);
  });

  it("reads empty text, null and no properties as no extra fields", () => {
    for (const input of ["", "  ", null, undefined]) {
      expect(validateExtrasFragment(input)).toEqual({
        ok: true,
        fragment: null,
        enumCount: 0,
      });
    }
    expect(
      validateExtrasFragment({ type: "object", properties: {} }),
    ).toMatchObject({ ok: true, fragment: null });
  });

  it("refuses text that is not JSON", () => {
    const result = validateExtrasFragment(
      "{ type: object",
      "sections[2].extras",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].path).toBe("sections[2].extras");
    expect(result.errors[0].message).toMatch(/not valid JSON/);
  });

  it("refuses a name the books already use", () => {
    const errors = validateProfile(
      withExtras({
        type: "object",
        properties: {
          amount: { type: "number" },
          supplier: { type: "string" },
        },
      }),
    );
    expect(errors).toEqual([
      {
        path: "sections[0].extras.properties.amount",
        message:
          '"amount" is a name the books already use for every item. Choose another name.',
      },
      {
        path: "sections[0].extras.properties.supplier",
        message:
          '"supplier" is a name the books already use for every item. Choose another name.',
      },
    ]);
  });

  it("refuses a field name that is not a slug", () => {
    const errors = validateProfile(
      withExtras({
        type: "object",
        properties: { "Order No": { type: "string" } },
      }),
    );
    expect(paths(errors)).toEqual(["sections[0].extras.properties.Order No"]);
  });

  it("refuses nested values", () => {
    const errors = validateProfile(
      withExtras({
        type: "object",
        properties: {
          address: {
            type: "object",
            properties: { street: { type: "string" } },
          },
          tags: { type: "array", items: { type: "string" } },
        },
      }),
    );
    expect(paths(errors)).toEqual([
      "sections[0].extras.properties.address.properties",
      "sections[0].extras.properties.address.type",
      "sections[0].extras.properties.tags.items",
      "sections[0].extras.properties.tags.type",
    ]);
    for (const error of errors) expect(error.message).toMatch(/plain values/);
  });

  it("refuses a keyword outside the whitelist, on the list and on a field", () => {
    const errors = validateProfile(
      withExtras({
        type: "object",
        additionalProperties: false,
        properties: {
          quantity: { type: "integer", minimum: 0 },
          code: { type: "string", $ref: "#/x" },
        },
      }),
    );
    expect(paths(errors)).toEqual([
      "sections[0].extras.additionalProperties",
      "sections[0].extras.properties.quantity.minimum",
      "sections[0].extras.properties.code.$ref",
    ]);
    expect(errors[1].message).toMatch(/"minimum" is not supported/);
  });

  it("refuses a bad type, and an enum that is not text", () => {
    const errors = validateProfile(
      withExtras({
        type: "object",
        properties: {
          a: { type: "date" },
          b: { type: ["string", "number"] },
          c: { type: "number", enum: ["1"] },
          d: { type: "string", enum: [1, "x", "x"] },
          e: { type: "string", enum: [] },
        },
      }),
    );
    expect(paths(errors)).toEqual([
      "sections[0].extras.properties.a.type",
      "sections[0].extras.properties.b.type",
      "sections[0].extras.properties.c.enum",
      "sections[0].extras.properties.d.enum[0]",
      "sections[0].extras.properties.d.enum[2]",
      "sections[0].extras.properties.e.enum",
    ]);
  });

  it("refuses a list that is not an object, and a required name it lacks", () => {
    expect(paths(validateProfile(withExtras([])))).toEqual([
      "sections[0].extras",
    ]);
    expect(
      paths(
        validateProfile(
          withExtras({
            type: "array",
            properties: { a: { type: "string" } },
            required: ["b"],
          }),
        ),
      ),
    ).toEqual(["sections[0].extras.type", "sections[0].extras.required[0]"]);
  });

  it("refuses a built-in object name as a field, or listed as required", () => {
    expect(
      validateProfile(
        withExtras({
          type: "object",
          properties: { constructor: { type: "string" } },
        }),
      ),
    ).toEqual([
      {
        path: "sections[0].extras.properties.constructor",
        message:
          '"constructor" cannot be used as a field name. Choose another name.',
      },
    ]);
    expect(
      paths(
        validateProfile(
          withExtras({
            type: "object",
            properties: { a: { type: "string" } },
            required: ["toString", "constructor"],
          }),
        ),
      ),
    ).toEqual([
      "sections[0].extras.required[0]",
      "sections[0].extras.required[1]",
    ]);
  });

  it(`allows ${PROFILE_EXTRAS_MAX} extra fields in a section and no more`, () => {
    const properties = Object.fromEntries(
      Array.from({ length: PROFILE_EXTRAS_MAX + 1 }, (_, i) => [
        `field_${i}`,
        { type: "string" },
      ]),
    );
    expect(
      paths(validateProfile(withExtras({ type: "object", properties }))),
    ).toEqual(["sections[0].extras.properties"]);
  });
});

describe("formatProfileErrors", () => {
  it("joins the first few problems with their paths", () => {
    const errors = Array.from({ length: 7 }, (_, i) => ({
      path: `p${i}`,
      message: `m${i}.`,
    }));
    expect(formatProfileErrors(errors)).toBe(
      "p0: m0. p1: m1. p2: m2. p3: m3. p4: m4. and 2 more.",
    );
  });
});

describe("table layout and row rules (FR-053, FR-054)", () => {
  function wallet(): Record<string, unknown> {
    return {
      name: "Wallet report",
      description: "A marketplace wallet report.",
      phrases: [],
      instructions: "",
      mode: "every_transaction",
      statedTotalLabels: {},
      accountId: 40,
      layout: walletLayout(),
      sections: [...orderSections(), withdrawalSection(41)],
    };
  }
  type Loose = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  function errorsOf(edit: (value: Loose) => void): ProfileError[] {
    const value = structuredClone(wallet()) as Loose;
    edit(value);
    return validateProfile(value);
  }

  it("keeps a layout and each section's row rules as they are", () => {
    const result = checkProfile(wallet());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.layout).toEqual(walletLayout());
    expect(result.profile.sections.map((section) => section.rows)).toEqual(
      [...orderSections(), withdrawalSection(41)].map(
        (section) => section.rows,
      ),
    );
  });

  it("fills in the date format and decimal separator when they are left out", () => {
    const value = wallet();
    const layout = { ...walletLayout() } as Loose;
    delete layout.dateFormat;
    delete layout.decimalSeparator;
    delete layout.csvDelimiter;
    value.layout = layout;
    const result = checkProfile(value);
    expect(result.ok && result.profile.layout).toMatchObject({
      dateFormat: "YYYY-MM-DD",
      decimalSeparator: ".",
      csvDelimiter: null,
    });
  });

  it("keeps no layout key on a profile without one, as before", () => {
    const value = wallet();
    delete value.layout;
    value.sections = [{ ...orderSections()[0], rows: undefined }];
    const result = checkProfile(value);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect("layout" in result.profile).toBe(false);
    expect("rows" in result.profile.sections[0]).toBe(false);
  });

  it("drops the remark columns a layout was saved with: no column fills the remark", () => {
    const value = wallet() as unknown as {
      layout: Record<string, unknown>;
    };
    value.layout.remarkColumns = ["Transaction Type", "Not a heading"];
    const result = checkProfile(value);
    if (!result.ok) throw new Error(formatProfileErrors(result.errors));
    expect("remarkColumns" in result.profile.layout!).toBe(false);
  });

  it("refuses a column that is not one of the headings, wherever it is named", () => {
    const errors = errorsOf((value) => {
      value.layout.columns.amount = "Total";
      value.sections[0].rows.where[0].column = "Kind";
    });
    expect(paths(errors)).toEqual([
      "layout.columns.amount",
      "sections[0].rows.where[0].column",
    ]);
    expect(errors[0].message).toBe(
      '"Total" is not one of the table\'s headings. Add it to the headings, or choose one of them.',
    );
    // Headings compare as the reading compares them.
    expect(
      errorsOf((value) => {
        value.layout.columns.amount = "  AMOUNT ";
      }),
    ).toEqual([]);
  });

  it("refuses row rules on a profile with no table layout", () => {
    const errors = errorsOf((value) => {
      delete value.layout;
    });
    expect(paths(errors)).toEqual([
      "sections[0].rows",
      "sections[1].rows",
      "sections[2].rows",
    ]);
    expect(errors[0].message).toMatch(/has no table layout/);
  });

  it("refuses a layout with no headings or a missing column", () => {
    expect(
      paths(
        errorsOf((value) => {
          value.layout = { headers: [], columns: {} };
        }),
      ),
    ).toEqual(
      expect.arrayContaining([
        "layout.headers",
        "layout.columns.date",
        "layout.columns.description",
        "layout.columns.amount",
      ]),
    );
    expect(
      paths(
        errorsOf((value) => {
          value.layout.headers = ["Date", "date"];
        }),
      ),
    ).toContain("layout.headers[1]");
  });

  it("refuses a condition with no value, an unknown comparison or an empty list", () => {
    const errors = errorsOf((value) => {
      value.sections[0].rows.where = [
        { column: "Status", op: "is" },
        { column: "Status", op: "starts_with", value: "x" },
        { column: "Status", op: "is_one_of", values: [] },
        { column: "Status", op: "empty" },
      ];
    });
    expect(paths(errors)).toEqual([
      "sections[0].rows.where[0].value",
      "sections[0].rows.where[1].op",
      "sections[0].rows.where[2].values",
    ]);
  });

  it("validates table filter columns, comparisons, values and limits like assignment rules", () => {
    const value = wallet() as Loose;
    value.sections[0].rows.filter = [
      { column: "Missing", op: "empty" },
      { column: "Status", op: "unknown" },
      { column: "Status", op: "is" },
      { column: "Status", op: "is_one_of", values: [] },
    ];
    const result = checkProfile(value);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(paths(result.errors)).toEqual(
      expect.arrayContaining([
        "sections[0].rows.filter[0].column",
        "sections[0].rows.filter[1].op",
        "sections[0].rows.filter[2].value",
        "sections[0].rows.filter[3].values",
      ]),
    );
  });

  it("rejects too many filter conditions", () => {
    const value = wallet() as Loose;
    value.sections[0].rows.filter = Array.from(
      { length: ROW_CONDITIONS_MAX + 1 },
      () => ({ column: "Status", op: "empty" }),
    );
    const result = checkProfile(value);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(paths(result.errors)).toContain("sections[0].rows.filter");
  });

  it("ignores and drops legacy row review rules", () => {
    const value = wallet() as Loose;
    value.sections[0].rows.flagWhen = [{ column: "Missing", op: "is" }];
    value.sections[0].rows.flagNote = "Legacy note";
    const result = checkProfile(value);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.sections[0].rows).not.toHaveProperty("flagWhen");
    expect(result.profile.sections[0].rows).not.toHaveProperty("flagNote");
  });

  it("ties line types to their column and values, and no value to two types", () => {
    const withFees = (edit: (section: Loose) => void) =>
      paths(
        errorsOf((value) => {
          value.sections[0].feeTypes = [
            {
              key: "orders",
              name: "Orders",
              description: "",
              categoryAccountId: null,
              values: ["Order Income"],
            },
            {
              key: "refunds",
              name: "Refunds",
              description: "",
              categoryAccountId: null,
              values: ["Refund"],
            },
          ];
          value.sections[0].rows.feeTypeColumn = "Transaction Type";
          edit(value.sections[0]);
        }),
      );
    expect(withFees(() => {})).toEqual([]);
    expect(
      withFees((section) => {
        section.rows.feeTypeColumn = null;
      }),
    ).toEqual([
      "sections[0].rows.feeTypeColumn",
      "sections[0].feeTypes[0].values",
      "sections[0].feeTypes[1].values",
    ]);
    expect(
      withFees((section) => {
        section.feeTypes[1].values = [];
      }),
    ).toEqual(["sections[0].feeTypes[1].values"]);
    expect(
      withFees((section) => {
        section.feeTypes[1].values = ["order  income"];
      }),
    ).toEqual(["sections[0].feeTypes[1].values[0]"]);
    expect(
      withFees((section) => {
        section.feeTypes = [];
      }),
    ).toEqual(["sections[0].rows.feeTypeColumn"]);
  });

  it("refuses values on a line type the AI reads, which has no column to read them from", () => {
    const value = wallet();
    delete value.layout;
    value.sections = [
      {
        ...orderSections()[0],
        rows: undefined,
        feeTypes: [
          {
            key: "orders",
            name: "Orders",
            description: "",
            categoryAccountId: null,
            values: ["Order"],
          },
        ],
      },
    ];
    expect(paths(validateProfile(value))).toEqual([
      "sections[0].feeTypes[0].values",
    ]);
  });

  it("refuses a direction value meaning both ways, a bad currency and an unknown mode", () => {
    const errors = errorsOf((value) => {
      value.layout.direction.out = ["Money Out", "money in"];
      value.layout.currency = "RM";
      value.layout.decimalSeparator = " ";
      value.layout.dateFormat = "D MMM YYYY";
      value.layout.statedTotalLabels = { daily: ["Total"] };
    });
    expect(paths(errors)).toEqual([
      "layout.dateFormat",
      "layout.direction.out[1]",
      "layout.decimalSeparator",
      "layout.currency",
      "layout.statedTotalLabels.daily",
    ]);
  });

  it("works out the kind of a profile saved without one: a layout, and rules on every section it reads", () => {
    const result = checkProfile(wallet());
    if (!result.ok) throw new Error("not ok");
    expect(result.profile.kind).toBe("table");
    // Saved before the kind was stored: its shape says.
    const { kind: _kind, ...profile } = result.profile;
    void _kind;
    expect(readsFromColumns(profile)).toBe(true);
    const noRules = { ...profile.sections[0], key: "other", rows: undefined };
    expect(
      readsFromColumns({
        ...profile,
        sections: [...profile.sections, noRules],
      }),
    ).toBe(false);
    expect(readsFromColumns({ ...profile, layout: null })).toBe(false);
    // A section saved in the other mode, on a profile from when each section
    // had its own, is not read, so its missing rules do not count.
    expect(
      readsFromColumns({
        ...profile,
        sections: [...profile.sections, { ...noRules, mode: "summary" }],
      }),
    ).toBe(true);
    // A profile whose only sections are in the other mode reads nothing.
    expect(
      readsFromColumns({
        ...profile,
        mode: "summary",
        sections: profile.sections.map((section) => ({
          ...section,
          mode: "every_transaction" as const,
        })),
      }),
    ).toBe(false);
  });

  it("refuses layout stated total labels under any key but the profile's mode", () => {
    const errors = errorsOf((value) => {
      value.layout.statedTotalLabels = { summary: ["Total Money In"] };
    });
    expect(errors).toEqual([
      {
        path: "layout.statedTotalLabels.summary",
        message:
          "This profile imports Every transaction, so its stated total is given for that only.",
      },
    ]);
    const kept = checkProfile(wallet());
    expect(kept.ok && kept.profile.layout?.statedTotalLabels).toEqual({
      every_transaction: ["Total Money In", "Total Money Out"],
    });
  });

  it("folds case and spacing the one way the reader does", () => {
    expect(foldTableText("  Money\u00a0 In ")).toBe("money in");
  });

  it("keeps a running balance column only when one is named", () => {
    const named = checkProfile({
      ...wallet(),
      layout: walletLayout({ balanceColumn: "Balance After Transactions" }),
    });
    expect(named.ok && named.profile.layout?.balanceColumn).toBe(
      "Balance After Transactions",
    );
    const none = checkProfile({
      ...wallet(),
      layout: { ...walletLayout(), balanceColumn: null },
    });
    expect(none.ok && "balanceColumn" in none.profile.layout!).toBe(false);
  });

  it("refuses a balance column that is not a heading, or is the amount", () => {
    expect(
      paths(
        errorsOf((value) => {
          value.layout.balanceColumn = "Running total";
        }),
      ),
    ).toEqual(["layout.balanceColumn"]);
    expect(
      errorsOf((value) => {
        value.layout.balanceColumn = "amount";
      }),
    ).toEqual([
      {
        path: "layout.balanceColumn",
        message:
          "The balance column is the balance after each row, not its amount. Choose another column, or none.",
      },
    ]);
  });

  it("keeps the profiles a section names as the same money (FR-066)", () => {
    const value = wallet() as Loose;
    value.sections[0].sameMoneyAs = [3, 9];
    const result = checkProfile(value);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.sections[0].sameMoneyAs).toEqual([3, 9]);
    // A section that names none carries no key, as one saved before it.
    expect("sameMoneyAs" in result.profile.sections[1]).toBe(false);
  });

  it("refuses a same-money list on a transfer, twice the same profile, or a bad id", () => {
    const errors = errorsOf((value) => {
      value.sections[0].sameMoneyAs = [3, 3, "x"];
      value.sections[2].sameMoneyAs = [3];
    });
    expect(paths(errors)).toEqual([
      "sections[0].sameMoneyAs[1]",
      "sections[0].sameMoneyAs[2]",
      "sections[2].sameMoneyAs",
    ]);
    expect(
      paths(
        errorsOf((value) => {
          value.sections[0].sameMoneyAs = Array.from(
            { length: PROFILE_SAME_MONEY_MAX + 1 },
            (_, i) => i + 1,
          );
        }),
      ),
    ).toEqual(["sections[0].sameMoneyAs"]);
  });
});

describe("the one sheet a profile reads (FR-069)", () => {
  it("keeps the sheet on the profile, for every kind, and none when it names none", () => {
    const result = checkProfile({ ...profile(), sheet: "  Summary " });
    expect(result.ok && result.profile.sheet).toBe("Summary");
    const none = checkProfile({ ...profile(), sheet: "" });
    expect(none.ok && "sheet" in none.profile).toBe(false);
  });

  it("reads the sheet of a profile saved when it was on the table layout", () => {
    const result = checkProfile({
      ...withAccounts(profileDraft("wallet_withdrawals")),
      layout: {
        ...profileDraft("wallet_withdrawals").layout,
        sheet: "Transaction Report",
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.sheet).toBe("Transaction Report");
    expect(result.profile.layout).not.toHaveProperty("sheet");
  });

  it("refuses a sheet name longer than Excel allows, at the Sheet field even from an old layout", () => {
    expect(
      paths(validateProfile({ ...profile(), sheet: "x".repeat(32) })),
    ).toEqual(["sheet"]);
    const draft = withAccounts(profileDraft("wallet_withdrawals"));
    expect(
      paths(
        validateProfile({
          ...draft,
          layout: { ...draft.layout, sheet: "x".repeat(32) },
        }),
      ),
    ).toEqual(["sheet"]);
  });
});

describe("the files a profile reads (FR-070)", () => {
  it("reads what its kind allows when nothing is stored: both for the AI, spreadsheets for a table", () => {
    expect(fileTypesOf("summary")).toEqual(["document", "spreadsheet"]);
    expect(fileTypesOf("transactions", [])).toEqual([
      "document",
      "spreadsheet",
    ]);
    expect(fileTypesOf("table")).toEqual(["spreadsheet"]);
    expect(fileTypesOf("mixed", ["document"])).toEqual(["spreadsheet"]);
    expect(profileFileTypes(profile())).toEqual(["document", "spreadsheet"]);
  });

  it("keeps one kind of file on a profile the AI reads", () => {
    const result = checkProfile({
      ...profile(),
      kind: "summary",
      fileTypes: ["document"],
    });
    expect(result.ok && result.profile.fileTypes).toEqual(["document"]);
    expect(result.ok && profileFileTypes(result.profile)).toEqual(["document"]);
  });

  it("stores nothing for both, however they are sent", () => {
    for (const fileTypes of [
      ["spreadsheet", "document"],
      ["document", "document", "spreadsheet"],
      null,
    ]) {
      const result = checkProfile({ ...profile(), kind: "summary", fileTypes });
      expect(result.ok && "fileTypes" in result.profile).toBe(false);
    }
  });

  it("refuses none ticked, and a kind of file it does not know, at the Reads field", () => {
    expect(
      paths(validateProfile({ ...profile(), kind: "summary", fileTypes: [] })),
    ).toEqual(["fileTypes"]);
    expect(
      paths(
        validateProfile({ ...profile(), kind: "summary", fileTypes: ["pdf"] }),
      ),
    ).toEqual(["fileTypes"]);
  });

  it("drops a choice sent with a kind that reads a table", () => {
    const result = checkProfile({
      ...withAccounts(profileDraft("wallet_withdrawals")),
      fileTypes: ["document"],
    });
    expect(result.ok).toBe(true);
    expect(result.ok && "fileTypes" in result.profile).toBe(false);
  });

  it("keeps no sheet on a profile that reads no spreadsheet, and does not check one", () => {
    const result = checkProfile({
      ...profile(),
      kind: "summary",
      fileTypes: ["document"],
      sheet: "x".repeat(32),
    });
    expect(result.ok).toBe(true);
    expect(result.ok && "sheet" in result.profile).toBe(false);
    const both = checkProfile({
      ...profile(),
      kind: "summary",
      sheet: "Income",
    });
    expect(both.ok && both.profile.sheet).toBe("Income");
  });
});

describe("checkTablePreview", () => {
  function draft(): Record<string, unknown> {
    return {
      name: "",
      description: "",
      phrases: [],
      instructions: "",
      mode: "every_transaction",
      statedTotalLabels: {},
      layout: walletLayout(),
      sections: [withdrawalSection(41)],
    };
  }

  it("previews a profile still being filled in: no name, no accounts", () => {
    const value = draft();
    (value.sections as Record<string, unknown>[])[0].counterAccountId = null;
    const result = checkTablePreview(value);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.layout).toEqual(walletLayout());
    expect(paths(result.unsaved).sort()).toEqual(
      // No description: a profile that reads a table is found by its
      // headings, so it needs none.
      ["accountId", "name", "sections[0].counterAccountId"].sort(),
    );
  });

  it("stops at a problem with the layout or a section's row rules", () => {
    const value = draft();
    (value.layout as Record<string, unknown>).headers = [];
    const result = checkTablePreview(value);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(paths(result.errors)).toContain("layout.headers");
    // Every column named is then not a heading either, in the layout and in
    // the row rules; nothing about a name or an account.
    expect(
      result.errors.every((error) =>
        /^(layout\.|sections\[0\]\.rows\.)/.test(error.path),
      ),
    ).toBe(true);
    const rules = draft();
    (
      rules.sections as Record<string, Record<string, unknown>>[]
    )[0].rows.where = [{ column: "Nope", op: "is", value: "x" }];
    const refused = checkTablePreview(rules);
    expect(refused.ok === false && paths(refused.errors)).toEqual([
      "sections[0].rows.where[0].column",
    ]);
  });

  it("needs a layout, and a section with row rules", () => {
    const none = draft();
    delete none.layout;
    (none.sections as Record<string, unknown>[])[0].rows = undefined;
    expect(checkTablePreview(none)).toMatchObject({
      ok: false,
      errors: [{ path: "layout" }],
    });
    const noRules = draft();
    (noRules.sections as Record<string, unknown>[])[0].rows = undefined;
    expect(checkTablePreview(noRules)).toMatchObject({
      ok: false,
      errors: [{ path: "sections" }],
    });
  });
});

describe("the profile's import mode (FR-032)", () => {
  const section = (mode?: "summary" | "every_transaction") => ({
    key: "k",
    ...(mode ? { mode } : {}),
  });

  it("works out an older profile's mode from its sections", () => {
    expect(
      legacyProfileMode([
        section("every_transaction"),
        section("every_transaction"),
      ]),
    ).toBe("every_transaction");
    expect(legacyProfileMode([section("summary"), section("summary")])).toBe(
      "summary",
    );
    // A section with no mode was a Summary one.
    expect(legacyProfileMode([section(), section()])).toBe("summary");
    expect(legacyProfileMode([])).toBe("summary");
    // Mixed: Summary, and the editor shows a problem on the others.
    expect(
      legacyProfileMode([section("summary"), section("every_transaction")]),
    ).toBe("summary");
    expect(legacyProfileMode([section(), section("every_transaction")])).toBe(
      "summary",
    );
  });

  it("reads every section with no mode, and those saved in the profile's mode", () => {
    const sections = [
      { ...section(), key: "a" },
      { ...section("summary"), key: "b" },
      { ...section("every_transaction"), key: "c" },
    ];
    expect(
      profileSections({ mode: "summary", sections }).map((s) => s.key),
    ).toEqual(["a", "b"]);
    expect(
      profileSections({ mode: "every_transaction", sections }).map(
        (s) => s.key,
      ),
    ).toEqual(["a", "c"]);
  });
});
