import { describe, expect, it } from "vitest";
import { applySorting, sortingOf } from "./import-profile-sample.js";
import {
  blankForm,
  errorsAt,
  errorsUnder,
  feeTypeKeys,
  formFingerprint,
  formFromDraft,
  layoutHeadings,
  newCondition,
  newFeeType,
  newRows,
  newSection,
  newSectionFor,
  payloadFromForm,
  problemPlace,
  readsSpreadsheets,
  sectionKeys,
  setKind,
  toggleFileType,
  transactionsSection,
  slugifyKey,
} from "./import-profile-form.js";
import {
  checkProfile,
  readsFromColumns,
  type ImportProfileDraft,
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
 * The import profile editor's form (006 US6, FR-030, FR-035). The editor
 * stages this shape and sends `payloadFromForm` once; the shared check reads
 * that payload on both sides, so each test here ends in that check.
 */

describe("keys made from names", () => {
  it("turns a name into a plain key", () => {
    expect(slugifyKey("Ads & promotions")).toBe("ads_promotions");
    expect(slugifyKey("  Café fees ")).toBe("cafe_fees");
    expect(slugifyKey("2024 Fees")).toBe("fees");
  });

  it("gives nothing for a name with no usable letter", () => {
    expect(slugifyKey("1234")).toBe("");
    expect(slugifyKey("手数料")).toBe("");
  });

  it("keeps a key within 32 characters", () => {
    const key = slugifyKey("a very long section name that goes on and on");
    expect(key.length).toBeLessThanOrEqual(32);
    expect(key.endsWith("_")).toBe(false);
  });
});

describe("line type keys", () => {
  it("makes a new line type's key from its name", () => {
    const fee = { ...newFeeType(), name: "Commission fee" };
    expect(feeTypeKeys([fee])).toEqual(["commission_fee"]);
  });

  it("keeps a saved line type's key when it is renamed", () => {
    const form = formFromDraft(profileDraft("fee_document"));
    const fees = form.sections[0].feeTypes;
    fees[1].name = "Sales commission";
    expect(feeTypeKeys(fees)[1]).toBe("commission_fee");
  });

  it("numbers a new line type whose name gives a key already used", () => {
    const saved = formFromDraft(profileDraft("fee_document")).sections[0]
      .feeTypes[1];
    const again = { ...newFeeType(), name: "Commission-fee" };
    expect(feeTypeKeys([saved, again])).toEqual([
      "commission_fee",
      "commission_fee_2",
    ]);
  });

  it("never makes the key that means none of the types", () => {
    const fee = { ...newFeeType(), name: "None" };
    expect(feeTypeKeys([fee])).toEqual(["none_2"]);
  });

  it("names a line type with no usable letter by its place", () => {
    const fees = [newFeeType(), { ...newFeeType(), name: "%" }];
    expect(feeTypeKeys(fees)).toEqual(["line_type_1", "line_type_2"]);
  });

  it("sends each line type's name and the key made from it", () => {
    const form = formFromDraft(profileDraft("fee_document"));
    form.sections[0].feeTypes = [{ ...newFeeType(), name: "Ads & promotions" }];
    const payload = payloadFromForm(form) as {
      sections: { feeTypes: { key: string; name: string }[] }[];
    };
    expect(payload.sections[0].feeTypes[0]).toMatchObject({
      key: "ads_promotions",
      name: "Ads & promotions",
    });
  });
});

describe("section keys", () => {
  it("makes a new section's key from its name", () => {
    const section = { ...newSection(), name: "Platform fees" };
    expect(sectionKeys([section])).toEqual(["platform_fees"]);
  });

  it("keeps a saved section's key when it is renamed", () => {
    const form = formFromDraft(profileDraft("fee_document"));
    form.sections[0].name = "Charges";
    expect(sectionKeys(form.sections)).toEqual(["fees"]);
  });

  it("numbers a new section whose name another section already uses", () => {
    const saved = formFromDraft(profileDraft("fee_document")).sections[0];
    const again = { ...newSection(), name: "Fees" };
    const third = { ...newSection(), name: "Fees" };
    expect(sectionKeys([saved, again, third])).toEqual([
      "fees",
      "fees_2",
      "fees_3",
    ]);
  });

  it("names a section with no usable letter by its place", () => {
    const sections = [newSection(), { ...newSection(), name: "123" }];
    expect(sectionKeys(sections)).toEqual(["section_1", "section_2"]);
  });
});

/** A draft with both its accounts chosen, as a wallet report one needs. */
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

describe("the form and the profile", () => {
  it.each(PROFILE_DRAFT_IDS.map((id) => [id]))(
    "%s comes back unchanged through the form",
    (id) => {
      const draft = withAccounts(profileDraft(id));
      const result = checkProfile(payloadFromForm(formFromDraft(draft)));
      expect(result).toEqual({ ok: true, profile: draft });
    },
  );

  it("carries the profile's sheet, for a profile the AI reads too (FR-069)", () => {
    const draft = {
      ...withAccounts(profileDraft("marketplace_summary")),
      sheet: "Summary",
    };
    const form = formFromDraft(draft);
    expect(form.sheet).toBe("Summary");
    expect(payloadFromForm(form)).toMatchObject({ sheet: "Summary" });
    form.sheet = "  ";
    expect(payloadFromForm(form)).toMatchObject({ sheet: null });
    expect(checkProfile(payloadFromForm(formFromDraft(draft)))).toEqual({
      ok: true,
      profile: draft,
    });
  });

  it("carries the files the profile reads, and its sheet only when it reads spreadsheets (FR-070)", () => {
    const draft = withAccounts(profileDraft("marketplace_summary"));
    const form = formFromDraft({ ...draft, sheet: "Summary" });
    expect(form.fileTypes).toEqual(["document", "spreadsheet"]);
    expect(readsSpreadsheets(form)).toBe(true);

    toggleFileType(form, "spreadsheet");
    expect(form.fileTypes).toEqual(["document"]);
    expect(readsSpreadsheets(form)).toBe(false);
    // Kept in the form for a tick back, but not sent.
    expect(form.sheet).toBe("Summary");
    expect(payloadFromForm(form)).toMatchObject({
      fileTypes: ["document"],
      sheet: null,
    });
    const checked = checkProfile(payloadFromForm(form));
    expect(checked.ok && checked.profile.fileTypes).toEqual(["document"]);

    // None ticked shows no sheet, and the check refuses it.
    toggleFileType(form, "document");
    expect(readsSpreadsheets(form)).toBe(false);
    expect(checkProfile(payloadFromForm(form)).ok).toBe(false);
  });

  it("is not dirty after a kind of file is unticked and ticked again", () => {
    const form = formFromDraft(
      withAccounts(profileDraft("marketplace_summary")),
    );
    const before = formFingerprint(form);
    toggleFileType(form, "document");
    expect(formFingerprint(form)).not.toBe(before);
    toggleFileType(form, "document");
    expect(form.fileTypes).toEqual(["document", "spreadsheet"]);
    expect(formFingerprint(form)).toBe(before);
  });

  it("sends no files for a kind that reads a table, which reads spreadsheets only", () => {
    const form = formFromDraft(
      withAccounts(profileDraft("wallet_withdrawals")),
    );
    form.fileTypes = ["document"];
    expect(payloadFromForm(form)).not.toHaveProperty("fileTypes");
    expect(readsSpreadsheets(form)).toBe(true);
  });

  it("is not dirty the moment a saved profile with a layout is opened", () => {
    const draft = withAccounts(profileDraft("wallet_every_transaction"));
    const checked = checkProfile(draft);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(formFingerprint(formFromDraft(checked.profile))).toBe(
      formFingerprint(formFromDraft(draft)),
    );
  });

  it("edits a table layout: headings, columns, direction and totals, one per line", () => {
    const form = formFromDraft(
      withAccounts(profileDraft("wallet_withdrawals")),
    );
    const layout = form.layout!;
    expect(layoutHeadings(layout)).toContain("Money Direction");
    layout.headersText = `${layout.headersText}\n  Fee  \n\n`;
    layout.directionInText = "Money In\nCredit";
    layout.totalsText = "Total Money In\n";
    layout.balanceColumn = "";
    layout.csvDelimiter = ";";
    layout.currency = "myr";
    const result = checkProfile(payloadFromForm(form));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.layout).toMatchObject({
      headers: [...walletLayout().headers, "Fee"],
      direction: {
        column: "Money Direction",
        in: ["Money In", "Credit"],
        out: ["Money Out"],
      },
      statedTotalLabels: { every_transaction: ["Total Money In"] },
      csvDelimiter: ";",
      currency: "MYR",
    });
    expect("balanceColumn" in result.profile.layout!).toBe(false);
    expect("remarkColumns" in result.profile.layout!).toBe(false);
  });

  it("reports a direction with values but no column, rather than dropping it", () => {
    const form = formFromDraft(
      withAccounts(profileDraft("wallet_withdrawals")),
    );
    form.layout!.directionColumn = "";
    const result = checkProfile(payloadFromForm(form));
    expect(
      result.ok === false && errorsAt(result.errors, "layout.direction.column"),
    ).toHaveLength(1);
  });

  it("adds a layout and row rules from nothing, and removes them", () => {
    const form = blankForm();
    form.name = "Bank export";
    form.description = "A bank's CSV export.";
    form.sections[0].name = "Charges";
    form.sections[0].description = "Each charge.";
    setKind(form, "table");
    if (!form.layout) throw new Error("no table");
    form.layout.headersText = "Date\nDetails\nAmount\nType";
    form.layout.date = "Date";
    form.layout.description = "Details";
    form.layout.amount = "Amount";
    form.sections[0].rows = newRows();
    const condition = newCondition("Type");
    condition.op = "is_one_of";
    condition.value = "left behind";
    condition.valuesText = "Fee\n Charge \n";
    form.sections[0].rows.where.push(condition);
    const result = checkProfile(payloadFromForm(form));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.sections[0].rows).toEqual({
      where: [{ column: "Type", op: "is_one_of", values: ["Fee", "Charge"] }],

      feeTypeColumn: null,
    });
    expect(result.profile.mode).toBe("every_transaction");
    expect(readsFromColumns(result.profile)).toBe(true);

    // Read by the AI instead, the section's rules are not sent.
    setKind(form, "summary");
    const read = checkProfile(payloadFromForm(form));
    expect(read.ok && read.profile.sections[0].rows).toBeUndefined();
  });

  it("keeps a section's row rules while the AI reads it, and sends them only from the table (FR-057)", () => {
    const form = formFromDraft(
      withAccounts(profileDraft("wallet_every_transaction")),
    );
    expect(form.kind).toBe("table");
    setKind(form, "mixed");
    const section = form.sections[0];
    const rules = section.rows;
    section.readBy = "ai";
    section.description = "";
    const refused = checkProfile(payloadFromForm(form));
    // The AI needs a description to find the section's lines.
    expect(
      refused.ok === false &&
        errorsAt(refused.errors, "sections[0].description"),
    ).toHaveLength(1);
    section.description = "Each withdrawal.";
    const read = checkProfile(payloadFromForm(form));
    expect(read.ok && read.profile.sections[0].rows).toBeUndefined();
    expect(section.rows).toBe(rules);

    setKind(form, "table");
    const back = checkProfile(payloadFromForm(form));
    expect(back.ok && back.profile.sections[0].rows).toBeTruthy();
  });

  it("asks no description of a section read from the table (FR-057)", () => {
    const form = formFromDraft(
      withAccounts(profileDraft("wallet_withdrawals")),
    );
    for (const section of form.sections) section.description = "";
    expect(checkProfile(payloadFromForm(form)).ok).toBe(true);
  });

  it("sends the profiles a section names as the same money, never for a transfer (FR-066)", () => {
    const form = formFromDraft(
      withAccounts(profileDraft("wallet_every_transaction")),
    );
    form.sections[0].sameMoneyAs = [4];
    form.sections[2].sameMoneyAs = [4];
    const result = checkProfile(payloadFromForm(form));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.profile.sections.map((section) => section.sameMoneyAs),
    ).toEqual([[4], undefined, undefined]);
    expect(formFromDraft(result.profile).sections[0].sameMoneyAs).toEqual([4]);
  });

  it("keeps a transfer section's accounts through the form (FR-058)", () => {
    const draft = profileDraft("fee_document");
    const transfer = {
      ...draft,
      accountId: 7,
      sections: [
        ...draft.sections,
        {
          key: "withdrawals",
          name: "Withdrawals",
          description: "Each withdrawal to the bank.",
          kind: "transfer" as const,
          fixedCategoryAccountId: null,
          feeTypes: [],
          extras: null,
          counterAccountId: 8,
        },
      ],
    };
    const form = formFromDraft(transfer);
    expect(form.accountId).toBe(7);
    expect(checkProfile(payloadFromForm(form))).toEqual({
      ok: true,
      profile: transfer,
    });

    // Another kind sends no other account, even when one was left behind.
    const last = form.sections[form.sections.length - 1];
    last.kind = "expense";
    const payload = payloadFromForm(form) as {
      sections: Record<string, unknown>[];
    };
    expect(payload.sections.at(-1)).not.toHaveProperty("counterAccountId");
  });

  it("keeps a table layout, row rules and line type values through the form", () => {
    const sections = [...orderSections(), withdrawalSection(8)];
    sections[0] = {
      ...sections[0],
      feeTypes: [
        {
          key: "orders",
          name: "Orders",
          description: "",
          categoryAccountId: null,
          values: ["Order Income"],
        },
      ],
      rows: {
        ...sections[0].rows!,
        where: [],
        feeTypeColumn: "Transaction Type",
      },
    };
    const draft = {
      name: "Wallet report",
      description: "A marketplace wallet report.",
      phrases: [],
      instructions: "",
      kind: "table" as const,
      mode: "every_transaction" as const,
      statedTotalLabels: {},
      accountId: 7,
      layout: walletLayout(),
      sections,
    };
    const form = formFromDraft(draft);
    form.name = "Wallet report, renamed";
    expect(checkProfile(payloadFromForm(form))).toEqual({
      ok: true,
      profile: { ...draft, name: "Wallet report, renamed" },
    });
  });

  it("starts a new profile in Summary, and sends the mode on the profile, never on a section", () => {
    const form = blankForm();
    expect(form.mode).toBe("summary");
    form.sections.push(newSection());
    form.mode = "every_transaction";
    const payload = payloadFromForm(form) as {
      mode: string;
      sections: Record<string, unknown>[];
    };
    expect(payload.mode).toBe("every_transaction");
    for (const section of payload.sections) {
      expect(section).not.toHaveProperty("mode");
    }
  });

  it("sends the one stated total under the profile's mode, and none when empty", () => {
    const form = blankForm();
    form.statedTotal = "   ";
    expect(payloadFromForm(form).statedTotalLabels).toEqual({});
    form.statedTotal = "Total charges";
    expect(payloadFromForm(form).statedTotalLabels).toEqual({
      summary: "Total charges",
    });
    // Changing what the profile imports moves the total with it.
    form.mode = "every_transaction";
    expect(payloadFromForm(form).statedTotalLabels).toEqual({
      every_transaction: "Total charges",
    });
  });

  it("keeps the profile's mode and its stated totals through the form", () => {
    const draft = withAccounts(profileDraft("wallet_every_transaction"));
    draft.statedTotalLabels = { every_transaction: " Total money in " };
    const form = formFromDraft(draft);
    expect(form.mode).toBe("every_transaction");
    expect(form.statedTotal).toBe(" Total money in ");
    expect(form.layout!.totalsText).toBe("Total Money In\nTotal Money Out");
    const result = checkProfile(payloadFromForm(form));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.mode).toBe("every_transaction");
    expect(result.profile.statedTotalLabels).toEqual({
      every_transaction: "Total money in",
    });
    expect(result.profile.layout!.statedTotalLabels).toEqual({
      every_transaction: ["Total Money In", "Total Money Out"],
    });
  });

  it("reads only the profile mode's stated total of a profile saved with one per mode", () => {
    const draft: ImportProfileDraft = {
      ...profileDraft("marketplace_summary"),
      statedTotalLabels: {
        summary: "Total payout released",
        every_transaction: "Total money in",
      },
    };
    const form = formFromDraft(draft);
    expect(form.statedTotal).toBe("Total payout released");
    const result = checkProfile(payloadFromForm(form));
    expect(result.ok && result.profile.statedTotalLabels).toEqual({
      summary: "Total payout released",
    });
  });

  it("keeps a section saved in the other mode as a problem until it is moved or kept (FR-032)", () => {
    // A profile from when each section had its own mode, with both: it
    // reads Summary, and its Every transaction section is flagged.
    const base = profileDraft("marketplace_summary");
    const draft: ImportProfileDraft = {
      ...base,
      mode: "summary",
      sections: [
        { ...base.sections[0], mode: "summary" },
        { ...base.sections[1], mode: "every_transaction" },
      ],
    };
    const form = formFromDraft(draft);
    expect(form.sections.map((section) => section.legacyMode)).toEqual([
      null,
      "every_transaction",
    ]);
    const payload = payloadFromForm(form) as {
      sections: Record<string, unknown>[];
    };
    expect(payload.sections[0]).not.toHaveProperty("mode");
    expect(payload.sections[1].mode).toBe("every_transaction");
    const refused = checkProfile(payload);
    expect(refused.ok === false && refused.errors.map((e) => e.path)).toEqual([
      "sections[1].mode",
    ]);

    // Changing the profile to that mode settles it: every section then reads
    // Every transaction, as the user chose.
    setKind(form, "transactions");
    const changed = checkProfile(payloadFromForm(form));
    expect(changed.ok).toBe(true);

    // So does keeping the section, which reads it in the profile's mode.
    setKind(form, "summary");
    form.sections[1].legacyMode = null;
    const kept = checkProfile(payloadFromForm(form));
    expect(kept.ok).toBe(true);
    if (!kept.ok) return;
    expect(kept.profile.mode).toBe("summary");
    expect(kept.profile.sections.every((section) => !("mode" in section))).toBe(
      true,
    );
  });

  it("sends the extra fields as typed, and the check reads them", () => {
    const form = formFromDraft(profileDraft("fee_document"));
    form.sections[0].extrasText =
      '{"type":"object","properties":{"order_no":{"type":["string","null"]}}}';
    const result = checkProfile(payloadFromForm(form));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.sections[0].extras).toEqual({
      type: "object",
      properties: { order_no: { type: ["string", "null"] } },
    });
  });

  it("shows saved extra fields as JSON text, and none as empty", () => {
    const draft = profileDraft("fee_document");
    draft.sections[0].extras = {
      type: "object",
      properties: { order_no: { type: "string" } },
    };
    const form = formFromDraft(draft);
    expect(JSON.parse(form.sections[0].extrasText)).toEqual(
      draft.sections[0].extras,
    );
    expect(formFromDraft(profileDraft("fee_document")).sections[0]).toEqual(
      expect.objectContaining({ extrasText: "" }),
    );
  });

  it("refuses a blank profile with the fields to fill in", () => {
    const result = checkProfile(payloadFromForm(blankForm()));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((error) => error.path)).toEqual(
      expect.arrayContaining([
        "name",
        "description",
        "sections[0].name",
        "sections[0].description",
      ]),
    );
  });
});

describe("unsaved changes", () => {
  it("is the same for the same form, whatever the row ids", () => {
    const draft = profileDraft("marketplace_summary");
    expect(formFingerprint(formFromDraft(draft))).toBe(
      formFingerprint(formFromDraft(draft)),
    );
  });

  it("changes when a line type is added or a category pinned", () => {
    const form = formFromDraft(profileDraft("fee_document"));
    const before = formFingerprint(form);
    form.sections[0].feeTypes.push(newFeeType());
    const added = formFingerprint(form);
    expect(added).not.toBe(before);
    form.sections[0].feeTypes[0].categoryAccountId = 12;
    expect(formFingerprint(form)).not.toBe(added);
  });
});

describe("where a problem is shown", () => {
  const errors = [
    { path: "name", message: "Fill in the name." },
    {
      path: "sections[0].extras.properties.order_no.type",
      message: "Bad type.",
    },
    { path: "sections[0].extras", message: "Not JSON." },
    { path: "sections[10].name", message: "Other section." },
  ];

  it("finds the problems of one field", () => {
    expect(errorsAt(errors, "name")).toEqual(["Fill in the name."]);
    expect(errorsAt(errors, "description")).toEqual([]);
  });

  it("finds every problem under the extra fields, with the rest of the path", () => {
    expect(errorsUnder(errors, "sections[0].extras")).toEqual([
      "properties.order_no.type: Bad type.",
      "Not JSON.",
    ]);
    expect(errorsUnder(errors, "sections[1]")).toEqual([]);
  });
});

describe("what a profile imports (FR-055, FR-057)", () => {
  it("is the kind saved, or worked out from an older profile's shape", () => {
    expect(blankForm().kind).toBe("summary");
    expect(
      formFromDraft(withAccounts(profileDraft("wallet_withdrawals"))).kind,
    ).toBe("table");
    const { kind: _kind, ...older } = withAccounts(
      profileDraft("wallet_withdrawals"),
    );
    void _kind;
    expect(formFromDraft(older).kind).toBe("table");
  });

  it("sets the mode, the table and the sections when it changes", () => {
    const form = formFromDraft(
      withAccounts(profileDraft("wallet_every_transaction")),
    );
    const rules = form.sections.map((section) => section.rows);

    setKind(form, "summary");
    expect(form.mode).toBe("summary");
    expect(form.layout).toBeNull();
    expect(form.sections.every((section) => section.readBy === "ai")).toBe(
      true,
    );
    // The rules stay in the form, unsent, for a switch back.
    expect(form.sections.map((section) => section.rows)).toEqual(rules);

    setKind(form, "transactions");
    expect(form.mode).toBe("every_transaction");

    setKind(form, "table");
    expect(form.mode).toBe("every_transaction");
    expect(form.layout).not.toBeNull();
    expect(form.sections.every((section) => section.readBy === "table")).toBe(
      true,
    );
    expect(newSectionFor(form).readBy).toBe("table");
  });

  it("starts a table with one section that takes every row, in place of a blank one", () => {
    const form = blankForm();
    setKind(form, "table");
    expect(form.sections).toHaveLength(1);
    expect(form.sections[0]).toMatchObject({
      name: "Transactions",
      kind: "by_sign",
      readBy: "table",
    });
    expect(form.sections[0].rows?.where).toEqual([]);

    // A mixed profile keeps its AI sections beside the table's.
    const mixed = blankForm();
    mixed.sections[0].name = "Fees";
    setKind(mixed, "mixed");
    expect(mixed.sections.map((s) => [s.name, s.readBy])).toEqual([
      ["Transactions", "table"],
      ["Fees", "ai"],
    ]);
    expect(mixed.mode).toBe("summary");
    expect(transactionsSection().kind).toBe("by_sign");
  });
});

describe("problemPlace", () => {
  function twoSections() {
    const form = blankForm();
    const fees = { ...newSection(), name: "Fees" };
    fees.feeTypes = [newFeeType(), newFeeType()];
    form.sections = [fees, { ...newSection(), name: "  " }];
    return { form, fees, other: form.sections[1] };
  }

  it("names a profile field and goes to it", () => {
    const { form } = twoSections();
    expect(problemPlace("name", form)).toEqual({
      label: "Name",
      targets: ["pf-name"],
    });
    expect(problemPlace("mode", form).label).toBe("What to import");
    expect(problemPlace("fileTypes", form)).toEqual({
      label: "Reads",
      targets: ["pf-file-types"],
    });
    expect(problemPlace("phrases[2]", form)).toEqual({
      label: "Fixed phrases",
      targets: ["pf-phrases"],
    });
    expect(problemPlace("sections", form).targets).toEqual(["pf-sections"]);
  });

  it("names a section by its name, or by its place when it has none", () => {
    const { form, fees, other } = twoSections();
    expect(problemPlace("sections[0].name", form)).toEqual({
      label: "Section “Fees” › Name",
      targets: [`pf-s-${fees.uid}-name`, `pf-s-${fees.uid}`],
      sectionUid: fees.uid,
    });
    expect(problemPlace("sections[1]", form)).toEqual({
      label: "Section 2",
      targets: [`pf-s-${other.uid}`],
      sectionUid: other.uid,
    });
    // A section's key is made from its name.
    expect(problemPlace("sections[0].key", form).label).toBe(
      "Section “Fees” › Name",
    );
  });

  it("numbers line types and goes to the row, then the list, then the section", () => {
    const { form, fees } = twoSections();
    const second = fees.feeTypes[1];
    expect(
      problemPlace("sections[0].feeTypes[1].categoryAccountId", form),
    ).toEqual({
      label: "Section “Fees” › Line type 2 › Category",
      targets: [
        `pf-s-${fees.uid}-fee-${second.uid}`,
        `pf-s-${fees.uid}-fees`,
        `pf-s-${fees.uid}`,
      ],
      sectionUid: fees.uid,
    });
    // The key is never shown, so a problem with it is shown on the name.
    expect(problemPlace("sections[0].feeTypes[0].key", form).label).toBe(
      "Section “Fees” › Line type 1 › Name",
    );
    fees.feeTypes[0].name = "Ads";
    expect(problemPlace("sections[0].feeTypes[0].name", form).label).toBe(
      "Section “Fees” › Line type “Ads” › Name",
    );
    expect(problemPlace("sections[0].feeTypes", form).label).toBe(
      "Section “Fees” › Line types",
    );
  });

  it("says when the field is folded inside a section's More", () => {
    const { form, fees } = twoSections();
    const more = (path: string) => problemPlace(path, form);
    expect(more("sections[0].sameMoneyAs").inMore).toBe("section");
    expect(more("sections[0].extras.properties.order").label).toBe(
      "Section “Fees” › More › Extra fields",
    );
    expect(more("sections[0].rows.where[1].column").targets).toEqual([
      `pf-s-${fees.uid}-where`,
      "pf-sorting",
      `pf-s-${fees.uid}`,
    ]);
    expect(more("sections[0].rows.feeTypeColumn")).not.toHaveProperty("inMore");
    expect(more("sections[0].fixedCategoryAccountId")).not.toHaveProperty(
      "inMore",
    );
  });

  it("places the table's fields above the sample or under More options", () => {
    const { form } = twoSections();
    expect(problemPlace("layout", form)).toEqual({
      label: "Table",
      targets: ["pf-table"],
    });
    expect(problemPlace("layout.columns.date", form)).toEqual({
      label: "Table › Columns",
      targets: ["pf-table"],
    });
    expect(problemPlace("layout.dateFormat", form)).toEqual({
      label: "Table › More options › Date format",
      targets: ["pf-l-dateFormat", "pf-table"],
      inMore: "table",
    });
    expect(problemPlace("layout.direction.column", form).label).toBe(
      "Table › Columns",
    );
    expect(problemPlace("layout.direction.in[0]", form).inMore).toBe("table");
  });

  it("falls back to the profile for a path it does not know", () => {
    const { form } = twoSections();
    expect(problemPlace("", form)).toEqual({ label: "Profile", targets: [] });
    expect(problemPlace("sections[9].name", form)).toEqual({
      label: "Section 10",
      targets: ["pf-sections"],
    });
  });
});

it("preserves filters through section assignment, reading-method changes and form round trips", () => {
  const form = formFromDraft(
    withAccounts(profileDraft("wallet_every_transaction")),
  );
  const section = form.sections[0];
  section.rows!.filter = [{ ...newCondition("Status"), value: "Completed" }];
  const sorting = sortingOf(form)!;
  expect(sorting).not.toBeNull();
  applySorting(form, sorting);
  applySorting(form, { column: "Status", assignments: new Map() });
  expect(section.rows!.filter[0].value).toBe("Completed");
  applySorting(form, sorting);
  const filter = section.rows!.filter;
  setKind(form, "mixed");
  section.readBy = "ai";
  expect(section.rows!.filter).toEqual(filter);
  setKind(form, "table");
  const checked = checkProfile(payloadFromForm(form));
  expect(checked.ok).toBe(true);
  if (!checked.ok) return;
  const reopened = formFromDraft(checked.profile);
  expect(reopened.sections[0].rows!.filter[0]).toMatchObject({
    column: "Status",
    op: "is",
    value: "Completed",
  });
  expect(
    problemPlace("sections[0].rows.filter[0].value", form).targets,
  ).toContain(`pf-s-${section.uid}-filter`);
});
