import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { eq } from "drizzle-orm";
import { beforeEach, afterEach, describe, it, expect } from "vitest";
import * as schema from "../db/schema.js";
import type { LedgerDb } from "../ledger/types.js";
import { localsFor } from "../permissions/test-locals.js";
import { createAccount } from "../services/accounts.js";
import {
  AccountType,
  AccountSubType,
  DefaultAccountPurpose,
} from "$lib/enums.js";
import { registerFixedAsset } from "./fixed-assets.js";
import {
  createTaxWorksheet,
  changeTaxWorksheet,
  readTaxWorksheet,
} from "./tax-worksheets.js";
import { changeCapitalSchedule } from "./capital-allowances.js";
import {
  readAssetTaxSchemes,
  saveAssetTaxScheme,
} from "./asset-tax-schemes.js";
import { taxWorksheetEvents } from "./tax-worksheet-boundary.js";
import {
  taxWorksheetCsv,
  taxWorksheetHtml,
} from "../queries/tax-worksheets.js";
import { schemeSnapshot } from "../queries/asset-tax-schemes.js";
import {
  createAssetTaxForm,
  assetTaxRowFromForm,
  assetTaxFirstYearStatus,
} from "$lib/components/tax-worksheets/asset-tax-form.js";
import { setSetting, SETTING_KEYS } from "../settings.js";
import type { AssetTaxSchemeDefinition } from "$lib/asset-tax-scheme.js";
let raw: Database;
let db: LedgerDb;
let assetId: number;
const key = () => crypto.randomUUID();
const ctx = (
  permissions = ["tax", "tax.finalise", "tax.amend", "accounts", "records"],
) => ({ db, locals: localsFor(permissions) });
function value<T>(
  r: { ok: true; value: T } | { ok: false; reason: string },
): T {
  if (!r.ok) throw Error(r.reason);
  return r.value;
}
const definition: AssetTaxSchemeDefinition = {
  name: "Equipment — custom draft",
  jurisdiction: "MY",
  yearFrom: 2025,
  yearTo: null,
  method: "original_cost",
  firstYearRateBps: 2000,
  regularRateBps: 1000,
  reference: "Owner will verify later",
  conditions: "Test rates; no statutory verification",
};
const schemePayload = (overrides: Record<string, unknown> = {}) => ({
  familyKey: key(),
  expectedVersion: 0,
  requestKey: key(),
  reason: "Create an unverified custom scheme",
  definition,
  ...overrides,
});
function create(year = 2025, currency = "MYR") {
  setSetting(db, SETTING_KEYS.currencyCode, currency);
  return value(
    createTaxWorksheet(ctx(), {
      ya: year,
      dateFrom: `${year}-01-01`,
      dateTo: `${year}-12-31`,
      requestKey: key(),
    }),
  );
}
type Detail = ReturnType<typeof create>;
function command(
  d: Detail,
  action: string,
  extra: Record<string, unknown> = {},
) {
  return {
    action,
    expectedVersion: d.revision.version,
    requestKey: key(),
    reason: "Review custom scheme application and inputs",
    ...(action !== "manual" ? { liveAssetHash: d.capital.liveAssetHash } : {}),
    ...extra,
  };
}
const prepare = (d: Detail, jurisdiction: string | null = "MY") =>
  value(
    changeCapitalSchedule(
      ctx(),
      d.worksheet.id,
      command(d, "prepare", { jurisdiction, replaceManual: false }),
    ),
  );
function row(
  d: Detail,
  s: typeof schema.assetTaxSchemes.$inferSelect,
  index = 0,
) {
  const original = d.capital.schedule!.rows[index];
  const form = createAssetTaxForm(original);
  Object.assign(form, {
    treatment: "claim",
    taxClass: s.definition.name,
    businessSource: "Trading",
    percentage: "100",
    schemeId: String(s.id),
    firstYear: true,
  });
  Object.assign(form.amounts, {
    qualifyingMinor: "10000.00",
    openingResidualMinor: "0.00",
    additionsMinor: "10000.00",
  });
  return assetTaxRowFromForm(original, form, d.worksheet.ya, [
    schemeSnapshot(s),
  ]);
}
function save(d: Detail, rows = d.capital.schedule!.rows, used = 0) {
  return value(
    changeCapitalSchedule(
      ctx(),
      d.worksheet.id,
      command(d, "save", {
        input: {
          jurisdiction: d.capital.schedule!.jurisdiction,
          evidence: "Working paper for custom deductions",
          rows,
          utilisation: [
            {
              businessSource: "Trading",
              originYa: d.worksheet.ya,
              balanceMinor: rows.reduce(
                (sum, r) => sum + (r.initialMinor ?? 0) + (r.annualMinor ?? 0),
                0,
              ),
              usedMinor: used,
            },
          ],
        },
      }),
    ),
  );
}
function finalise(d: Detail) {
  d = value(
    changeTaxWorksheet(ctx(), d.worksheet.id, {
      action: "review",
      expectedVersion: d.revision.version,
    }),
  );
  return value(
    changeTaxWorksheet(ctx(), d.worksheet.id, {
      action: "finalise",
      expectedVersion: d.revision.version,
    }),
  );
}
const financial = () =>
  JSON.stringify([
    db.select().from(schema.accounts).all(),
    db.select().from(schema.ledgerRecords).all(),
    db.select().from(schema.ledgerMovements).all(),
    db.select().from(schema.settlements).all(),
    db.select().from(schema.reconciliationAllocations).all(),
    db.select().from(schema.depreciationPostings).all(),
  ]);
beforeEach(() => {
  raw = new Database(":memory:");
  db = drizzle(raw, { schema }) as LedgerDb;
  migrate(db, { migrationsFolder: "drizzle" });
  raw.exec("PRAGMA foreign_keys=ON");
  db.insert(schema.users)
    .values({
      id: 1,
      email: "scheme@test",
      username: "Owner",
      passwordHash: "x",
    })
    .run();
  const account = value(
    createAccount(db, 1, {
      name: "Equipment",
      type: AccountType.Asset,
      subType: AccountSubType.FixedAsset,
    }),
  );
  assetId = value(
    registerFixedAsset(ctx(), {
      name: "Laptop",
      assetType: "Computer equipment",
      sourceMovementId: null,
      acquisitionDate: "2025-01-10",
      inServiceDate: "2025-01-10",
      assetAccountId: account.id,
      costMinor: 1000000,
      openingAsAt: "2025-01-10",
      openingRecordId: null,
      documentReference: "Purchase receipt",
      broughtForwardDepMinor: 0,
    }),
  ).id;
});
afterEach(() => raw.close());
describe("versioned custom asset tax schemes", () => {
  it("previews unlinked assets immediately and confirms all first-year treatments with one save", async () => {
    const { editorRows, editorPreview, editorSchemes } =
      await import("$lib/components/tax-worksheets/capital-editor.js");
    const s = value(saveAssetTaxScheme(ctx(), schemePayload()));
    const originalAsset = db
      .select()
      .from(schema.fixedAssets)
      .where(eq(schema.fixedAssets.id, assetId))
      .get()!;
    const second = value(
      registerFixedAsset(ctx(), {
        name: "Printer two",
        assetType: "Machinery",
        sourceMovementId: null,
        acquisitionDate: "2025-06-10",
        inServiceDate: "2025-06-10",
        assetAccountId: originalAsset.assetAccountId,
        costMinor: 229900,
        openingAsAt: "2025-06-10",
        openingRecordId: null,
        documentReference: "Receipt",
        broughtForwardDepMinor: 0,
      }),
    );
    let d = prepare(create());
    const forms = editorRows(d.capital.schedule!, d.worksheet);
    for (const entry of forms)
      Object.assign(entry.form, { schemeId: String(s.id), treatment: "claim" });
    const staged = editorPreview(
      d.capital.schedule!,
      forms,
      editorSchemes(d.capital.schemes),
      [],
      "",
      d.worksheet,
      d.capital.firstYearContexts,
    );
    expect(staged.errors).toEqual([]);
    expect(
      staged.input.rows.every(
        (r) =>
          r.firstYearTreatment?.confirmation === "pending_save" &&
          r.note === "",
      ),
    ).toBe(true);
    expect(
      staged.input.rows.find((r) => r.assetId === second.id),
    ).toMatchObject({ initialMinor: 45980, annualMinor: 22990 });
    const financialBefore = financial();
    const noConfirmation = changeCapitalSchedule(
      ctx(),
      d.worksheet.id,
      command(d, "save", { input: staged.input }),
    );
    expect(noConfirmation.ok).toBe(false);
    const payload = command(d, "save", {
      input: staged.input,
      confirmFirstYearTreatments: true,
    });
    d = value(changeCapitalSchedule(ctx(), d.worksheet.id, payload));
    expect(
      d.capital.schedule!.rows.every(
        (r) =>
          r.firstYearTreatment?.confirmation === "worksheet_save" &&
          r.note === "",
      ),
    ).toBe(true);
    expect(d.capital.totals?.problems).toEqual([]);
    const confirmedRow = d.capital.schedule!.rows.find(
      (r) => r.assetId === second.id,
    )!;
    const savedAsset = d.capital.schedule!.assets.find(
      (a) => a.assetId === second.id,
    )!;
    expect(
      assetTaxFirstYearStatus(
        confirmedRow,
        createAssetTaxForm(
          confirmedRow,
          savedAsset,
          d.worksheet.dateFrom,
          d.worksheet.dateTo,
        ),
        d.worksheet.ya,
        editorSchemes(d.capital.schemes),
        {
          context: d.capital.firstYearContexts[second.id],
          asset: savedAsset,
          dateFrom: d.worksheet.dateFrom,
          dateTo: d.worksheet.dateTo,
        },
      ).confirmation,
    ).toBe("worksheet_save");
    expect(
      value(changeCapitalSchedule(ctx(), d.worksheet.id, payload)).revision
        .version,
    ).toBe(d.revision.version);
    // A previously confirmed, unchanged row remains compatible with older callers.
    d = value(
      changeCapitalSchedule(
        ctx(),
        d.worksheet.id,
        command(d, "save", {
          input: {
            jurisdiction: d.capital.schedule!.jurisdiction,
            rows: d.capital.schedule!.rows,
            evidence: "",
            utilisation: d.capital.schedule!.utilisation,
          },
        }),
      ),
    );
    expect(
      d.capital.schedule!.rows.every(
        (r) => r.firstYearTreatment?.confirmation === "worksheet_save",
      ),
    ).toBe(true);
    expect(JSON.stringify(db.select().from(schema.auditLog).all())).toContain(
      "firstYearWorksheetConfirmation",
    );
    expect(finalise(d).revision.status).toBe("finalised");
    expect(financial()).toBe(financialBefore);
  });

  it("automates a linked purchase, retains unused initial allowance history, and refuses a duplicate or stale decision", async () => {
    const { createRecord } = await import("./records.js");
    const { editorRows, editorPreview, editorSchemes } =
      await import("$lib/components/tax-worksheets/capital-editor.js");
    const equipment = db
      .select()
      .from(schema.fixedAssets)
      .where(eq(schema.fixedAssets.id, assetId))
      .get()!.assetAccountId;
    const bank = value(
      createAccount(db, 1, {
        name: "Bank",
        type: AccountType.Asset,
        subType: AccountSubType.Bank,
      }),
    );
    const receivable = value(
      createAccount(db, 1, {
        name: "Receivable",
        type: AccountType.Asset,
        subType: AccountSubType.Receivable,
      }),
    );
    const payable = value(
      createAccount(db, 1, {
        name: "Payable",
        type: AccountType.Liability,
        subType: AccountSubType.AccountsPayable,
      }),
    );
    const equity = value(
      createAccount(db, 1, {
        name: "Opening equity",
        type: AccountType.Equity,
      }),
    );
    for (const item of [
      { purpose: DefaultAccountPurpose.Receivable, accountId: receivable.id },
      { purpose: DefaultAccountPurpose.Payable, accountId: payable.id },
      { purpose: DefaultAccountPurpose.OpeningBalances, accountId: equity.id },
    ])
      db.insert(schema.accountDefaults)
        .values(item)
        .onConflictDoUpdate({
          target: schema.accountDefaults.purpose,
          set: { accountId: item.accountId },
        })
        .run();
    const purchase = value(
      createRecord(ctx(), {
        kind: "expense",
        description: "3D printer",
        date: "2025-06-10",
        amount: 2299,
        currency: "MYR",
        exchangeRate: 1,
        categoryAccountId: equipment,
        paidFromAccountId: bank.id,
      }),
    ).record;
    const linked = value(
      registerFixedAsset(ctx(), {
        name: "3D printer",
        assetType: "Machinery",
        sourceMovementId: purchase.movements.find(
          (m) => m.accountId === equipment,
        )!.id,
        inServiceDate: "2025-06-10",
      }),
    );
    const scheme = value(
      saveAssetTaxScheme(
        ctx(),
        schemePayload({ definition: { ...definition, regularRateBps: 1400 } }),
      ),
    );
    let d = prepare(create());
    const forms = editorRows(d.capital.schedule!, d.worksheet);
    const imported = forms.find((r) => r.assetId === assetId)!;
    Object.assign(imported.form, {
      treatment: "exclude",
      note: "Outside this test claim",
    });
    const printer = forms.find((r) => r.assetId === linked.id)!;
    Object.assign(printer.form, {
      treatment: "claim",
      schemeId: String(scheme.id),
    });
    const staged = editorPreview(
      d.capital.schedule!,
      forms,
      editorSchemes(d.capital.schemes),
      [],
      "",
      d.worksheet,
      d.capital.firstYearContexts,
    );
    expect(staged.errors).toEqual([]);
    expect(
      staged.input.rows.find((r) => r.assetId === linked.id),
    ).toMatchObject({
      initialMinor: 45980,
      annualMinor: 32186,
      schemeFirstYear: true,
      firstYearTreatment: { mode: "auto", included: true },
    });
    const linkedRow = staged.input.rows.find((r) => r.assetId === linked.id)!;
    const importedRow = row(
      d,
      scheme,
      d.capital.schedule!.rows.findIndex((r) => r.assetId === assetId),
    );
    const forgedImport = {
      ...importedRow,
      firstYearTreatment: {
        ...linkedRow.firstYearTreatment!,
        historyHash: d.capital.firstYearContexts[assetId].historyHash,
      },
    };
    const unknownRefused = changeCapitalSchedule(
      ctx(),
      d.worksheet.id,
      command(d, "save", {
        input: {
          ...staged.input,
          rows: staged.input.rows.map((r) =>
            r.assetId === assetId ? forgedImport : r,
          ),
        },
      }),
    );
    expect(unknownRefused.ok).toBe(false);
    if (!unknownRefused.ok)
      expect(unknownRefused.reason).toContain("confirm the worksheet");
    const overrideRefused = changeCapitalSchedule(
      ctx(),
      d.worksheet.id,
      command(d, "save", {
        input: {
          ...staged.input,
          rows: staged.input.rows.map((r) =>
            r.assetId === linked.id
              ? {
                  ...r,
                  schemeOverride: true,
                  note: "Try overriding an automatic allowance",
                }
              : r,
          ),
        },
      }),
    );
    expect(overrideRefused.ok).toBe(false);
    const financialBefore = financial();
    d = value(
      changeCapitalSchedule(
        ctx(),
        d.worksheet.id,
        command(d, "save", { input: staged.input }),
      ),
    );
    expect(d.capital.totals?.usedMinor).toBe(0);
    d = finalise(d);
    const retained = JSON.stringify(taxWorksheetCsv(d));
    let next = create(2026);
    next = value(
      changeCapitalSchedule(
        ctx(),
        next.worksheet.id,
        command(next, "rollover", {
          rolloverHash: next.capital.rolloverHash,
          replaceManual: false,
        }),
      ),
    );
    const nextForms = editorRows(next.capital.schedule!, next.worksheet);
    const nextPreview = editorPreview(
      next.capital.schedule!,
      nextForms,
      editorSchemes(next.capital.schemes),
      [],
      "",
      next.worksheet,
      next.capital.firstYearContexts,
    );
    expect(
      nextPreview.input.rows.find((r) => r.assetId === linked.id),
    ).toMatchObject({
      initialMinor: 0,
      annualMinor: 32186,
      firstYearTreatment: { included: false },
    });
    next = value(
      changeCapitalSchedule(
        ctx(),
        next.worksheet.id,
        command(next, "save", { input: nextPreview.input }),
      ),
    );
    expect(next.capital.firstYearContexts[linked.id].records[0]).toMatchObject({
      jurisdiction: "MY",
      currency: "MYR",
    });
    const savedRow = next.capital.schedule!.rows.find(
      (r) => r.assetId === linked.id,
    )!;
    const duplicate = {
      ...savedRow,
      openingResidualMinor: 0,
      additionsMinor: 229900,
      initialMinor: 45980,
      schemeFirstYear: true,
      note: "Attempt repeated initial allowance",
      firstYearTreatment: {
        ...savedRow.firstYearTreatment!,
        mode: "include",
        included: true,
      },
    };
    const rejected = changeCapitalSchedule(
      ctx(),
      next.worksheet.id,
      command(next, "save", {
        input: {
          ...nextPreview.input,
          rows: next.capital.schedule!.rows.map((r) =>
            r.assetId === linked.id ? duplicate : r,
          ),
        },
      }),
    );
    expect(rejected.ok).toBe(false);
    value(
      changeTaxWorksheet(ctx(), d.worksheet.id, {
        action: "amend",
        expectedVersion: d.revision.version,
        requestKey: key(),
        reason: "Review earlier asset eligibility",
      }),
    );
    const fresh = value(readTaxWorksheet(ctx(), next.worksheet.id));
    expect(
      fresh.capital.firstYearContexts[linked.id].records.some(
        (r) => r.status === "finalised" && r.initialMinor === 45980,
      ),
    ).toBe(true);
    expect(
      fresh.capital.totals?.problems.some((p) =>
        p.includes("First-year allowance history changed"),
      ),
    ).toBe(true);
    expect(
      changeCapitalSchedule(
        ctx(),
        next.worksheet.id,
        command(fresh, "save", { input: nextPreview.input }),
      ).ok,
    ).toBe(false);
    expect(
      JSON.stringify(
        taxWorksheetCsv(
          value(readTaxWorksheet(ctx(), d.worksheet.id, d.revision.revision)),
        ),
      ),
    ).toBe(retained);
    expect(financial()).toBe(financialBefore);
  });

  it("saves inline asset calculations and claims atomically without a mandatory reference", async () => {
    const { editorRows, editorUses, editorPreview, editorSchemes } =
      await import("$lib/components/tax-worksheets/capital-editor.js");
    const s = value(saveAssetTaxScheme(ctx(), schemePayload()));
    let d = prepare(create());
    const forms = editorRows(d.capital.schedule!, d.worksheet);
    Object.assign(forms[0].form, {
      schemeId: String(s.id),
      treatment: "claim",
      firstYear: true,
    });
    const uses = editorUses(d.capital.schedule!);
    uses.push({
      source: "Main business",
      origin: "2025",
      balance: "0.00",
      used: "3000.00",
    });
    const staged = editorPreview(
      d.capital.schedule!,
      forms,
      editorSchemes(value(readAssetTaxSchemes(ctx()))),
      uses,
      "",
      d.worksheet,
    );
    expect(staged.errors).toEqual([]);
    const before = financial();
    const payload = command(d, "save", { input: staged.input });
    d = value(changeCapitalSchedule(ctx(), d.worksheet.id, payload));
    expect(d.capital.totals).toMatchObject({
      allowanceMinor: 300000,
      usedMinor: 300000,
    });
    expect(d.capital.totals?.problems).toEqual([]);
    expect(
      value(changeCapitalSchedule(ctx(), d.worksheet.id, payload)).revision
        .version,
    ).toBe(d.revision.version);
    expect(financial()).toBe(before);
    const final = finalise(d);
    expect(final.revision.status).toBe("finalised");
  });

  it("creates and applies a scheme without supporting fields, retaining old definitions on remark edits", () => {
    const simple = { ...definition };
    delete simple.reference;
    delete simple.conditions;
    const payload = {
      familyKey: key(),
      expectedVersion: 0,
      requestKey: key(),
      definition: simple,
    };
    const first = value(saveAssetTaxScheme(ctx(), payload));
    expect(value(saveAssetTaxScheme(ctx(), payload)).id).toBe(first.id);
    expect(first.definition).toEqual(simple);
    let d = prepare(create());
    d = save(d, [row(d, first)], 300000);
    const retained = JSON.stringify(d.capital.schedule);
    const next = value(
      saveAssetTaxScheme(ctx(), {
        familyKey: first.familyKey,
        expectedVersion: 1,
        requestKey: key(),
        definition: {
          ...simple,
          remark: "Machinery rates reviewed for this assessment year",
        },
      }),
    );
    expect(next.version).toBe(2);
    expect(
      JSON.stringify(
        value(readTaxWorksheet(ctx(), d.worksheet.id)).capital.schedule,
      ),
    ).toBe(retained);
    expect(value(readAssetTaxSchemes(ctx()))[0].definition).toEqual(simple);
    expect(
      db
        .select()
        .from(schema.auditLog)
        .all()
        .some(
          (a) =>
            a.recordType === "tax_scheme" && a.recordId === String(next.id),
        ),
    ).toBe(true);
  });

  it("starts with an empty library and checks tax authority", () => {
    expect(value(readAssetTaxSchemes(ctx()))).toEqual([]);
    expect(saveAssetTaxScheme(ctx(["tax.read"]), schemePayload()).ok).toBe(
      false,
    );
    expect(readAssetTaxSchemes(ctx(["accounts"])).ok).toBe(false);
  });
  it("creates immutable versions with idempotent receipts and rejects stale edits", () => {
    const p = schemePayload();
    const first = value(saveAssetTaxScheme(ctx(), p));
    expect(value(saveAssetTaxScheme(ctx(), p)).id).toBe(first.id);
    expect(
      saveAssetTaxScheme(ctx(), {
        ...p,
        reason: "A different reason on same request",
      }).ok,
    ).toBe(false);
    const next = value(
      saveAssetTaxScheme(
        ctx(),
        schemePayload({
          familyKey: first.familyKey,
          expectedVersion: 1,
          definition: { ...definition, regularRateBps: 1500 },
        }),
      ),
    );
    expect(next.version).toBe(2);
    expect(
      saveAssetTaxScheme(
        ctx(),
        schemePayload({ familyKey: first.familyKey, expectedVersion: 1 }),
      ).ok,
    ).toBe(false);
    expect(() =>
      db
        .update(schema.assetTaxSchemes)
        .set({ version: 9 })
        .where(eq(schema.assetTaxSchemes.id, first.id))
        .run(),
    ).toThrow("new scheme version");
    expect(() =>
      db
        .delete(schema.assetTaxSchemes)
        .where(eq(schema.assetTaxSchemes.id, first.id))
        .run(),
    ).toThrow("retained");
  });
  it("changes asset numbers through a reusable scheme, and annual numbers only through explicit utilisation", () => {
    const s = value(saveAssetTaxScheme(ctx(), schemePayload()));
    let d = prepare(create());
    const before = financial();
    const calculated = row(d, s);
    expect(calculated).toMatchObject({
      initialMinor: 200000,
      annualMinor: 100000,
    });
    d = save(d, [calculated]);
    expect(d.capital.totals?.rows[0].closingResidualMinor).toBe(700000);
    expect(d.totals.capitalMinor).toBe(0);
    d = save(d, d.capital.schedule!.rows, 300000);
    expect(d.totals.capitalMinor).toBe(-300000);
    expect(d.capital.totals?.problems).toEqual([]);
    expect(financial()).toBe(before);
  });
  it("reuses the same definition on multiple assets and retains the exact version", () => {
    const s = value(saveAssetTaxScheme(ctx(), schemePayload()));
    const original = db
      .select()
      .from(schema.fixedAssets)
      .where(eq(schema.fixedAssets.id, assetId))
      .get()!;
    value(
      registerFixedAsset(ctx(), {
        name: "Second laptop",
        assetType: "Computer equipment",
        sourceMovementId: null,
        acquisitionDate: "2025-02-10",
        inServiceDate: "2025-02-10",
        assetAccountId: original.assetAccountId,
        costMinor: 1000000,
        openingAsAt: "2025-02-10",
        openingRecordId: null,
        documentReference: "Second receipt",
        broughtForwardDepMinor: 0,
      }),
    );
    let d = prepare(create());
    d = save(d, [row(d, s, 0), row(d, s, 1)]);
    expect(d.capital.totals?.allowanceMinor).toBe(600000);
    expect(d.capital.schedule!.rows.map((r) => r.appliedScheme?.id)).toEqual([
      s.id,
      s.id,
    ]);
    expect(d.capital.schedule!.rows[0].appliedScheme?.verification).toBe(
      "custom_unverified",
    );
  });
  it("recomputes previews on the server and refuses tampered amounts or foreign schemes", () => {
    const s = value(saveAssetTaxScheme(ctx(), schemePayload()));
    const d = prepare(create());
    const calculated = row(d, s);
    expect(
      changeCapitalSchedule(
        ctx(),
        d.worksheet.id,
        command(d, "save", {
          input: {
            jurisdiction: "MY",
            evidence: "Tax working paper",
            rows: [{ ...calculated, annualMinor: 999 }],
            utilisation: [],
          },
        }),
      ).ok,
    ).toBe(false);
    expect(
      changeCapitalSchedule(
        ctx(),
        d.worksheet.id,
        command(d, "save", {
          input: {
            jurisdiction: "MY",
            evidence: "Tax working paper",
            rows: [{ ...calculated, schemeId: 999 }],
            utilisation: [],
          },
        }),
      ).ok,
    ).toBe(false);
    const forged = {
      ...calculated,
      appliedScheme: {
        ...calculated.appliedScheme!,
        definition: { ...definition, regularRateBps: 9999 },
      },
    };
    expect(
      save(d, [forged]).capital.schedule!.rows[0].appliedScheme!.definition
        .regularRateBps,
    ).toBe(1000);
  });
  it("allows explained overrides but refuses unexplained changes", () => {
    const s = value(saveAssetTaxScheme(ctx(), schemePayload()));
    let d = prepare(create());
    const original = row(d, s);
    const modified = {
      ...original,
      schemeOverride: true,
      annualMinor: 50000,
      note: "",
    };
    expect(
      changeCapitalSchedule(
        ctx(),
        d.worksheet.id,
        command(d, "save", {
          input: {
            jurisdiction: "MY",
            evidence: "Tax working paper",
            rows: [modified],
            utilisation: [],
          },
        }),
      ).ok,
    ).toBe(false);
    d = save(d, [
      {
        ...modified,
        note: "Accountant adjusted the claim for reviewed circumstances",
      },
    ]);
    expect(d.capital.schedule!.rows[0].annualMinor).toBe(50000);
  });
  it("does not infer jurisdiction from currency and supports manual schemes across book currencies", () => {
    const gb = value(
      saveAssetTaxScheme(
        ctx(),
        schemePayload({ definition: { ...definition, jurisdiction: "GB" } }),
      ),
    );
    let d = prepare(create(2025, "USD"), "GB");
    d = save(d, [row(d, gb)]);
    expect(d.capital.schedule).toMatchObject({
      currency: "USD",
      jurisdiction: "GB",
      calculationVersion: 2,
    });
    expect(d.capital.totals?.problems).toEqual([]);
  });
  it("keeps unknown jurisdiction unreviewed and resets applications when jurisdiction changes", () => {
    let d = prepare(create(), null);
    expect(d.capital.totals?.problems.join(" ")).toContain(
      "Select the tax jurisdiction",
    );
    const s = value(saveAssetTaxScheme(ctx(), schemePayload()));
    d = value(
      changeCapitalSchedule(
        ctx(),
        d.worksheet.id,
        command(d, "save", {
          input: {
            jurisdiction: "MY",
            evidence: "Tax working paper",
            rows: d.capital.schedule!.rows,
            utilisation: [],
          },
        }),
      ),
    );
    d = save(d, [row(d, s)]);
    d = value(
      changeCapitalSchedule(
        ctx(),
        d.worksheet.id,
        command(d, "save", {
          input: {
            jurisdiction: "US",
            evidence: d.capital.schedule!.evidence,
            rows: d.capital.schedule!.rows,
            utilisation: d.capital.schedule!.utilisation,
          },
        }),
      ),
    );
    expect(d.capital.schedule!.rows[0]).toMatchObject({
      treatment: "pending",
      schemeId: null,
    });
    expect(d.capital.schedule!.rows[0].appliedScheme).toBeUndefined();
  });
  it("rejects schemes outside the selected year or jurisdiction", () => {
    const s = value(
      saveAssetTaxScheme(
        ctx(),
        schemePayload({ definition: { ...definition, yearFrom: 2026 } }),
      ),
    );
    const d = prepare(create());
    expect(
      changeCapitalSchedule(
        ctx(),
        d.worksheet.id,
        command(d, "save", {
          input: {
            jurisdiction: "MY",
            evidence: "Tax working paper",
            rows: [row(d, s)],
            utilisation: [],
          },
        }),
      ).ok,
    ).toBe(false);
    expect(
      saveAssetTaxScheme(
        ctx(),
        schemePayload({
          familyKey: s.familyKey,
          expectedVersion: 1,
          definition: { ...definition, jurisdiction: "GB" },
        }),
      ).ok,
    ).toBe(false);
  });
  it("preserves applied and finalised amounts/exports when a scheme gets a new version", () => {
    const s = value(saveAssetTaxScheme(ctx(), schemePayload()));
    let d = prepare(create());
    d = finalise(save(d, [row(d, s)]));
    const csv = JSON.stringify(taxWorksheetCsv(d)),
      html = taxWorksheetHtml(d);
    value(
      saveAssetTaxScheme(
        ctx(),
        schemePayload({
          familyKey: s.familyKey,
          expectedVersion: 1,
          definition: { ...definition, regularRateBps: 5000 },
        }),
      ),
    );
    const retained = value(
      readTaxWorksheet(ctx(), d.worksheet.id, undefined, false),
    );
    expect(retained.capital.schedule!.rows[0].appliedScheme?.version).toBe(1);
    expect(JSON.stringify(taxWorksheetCsv(retained))).toBe(csv);
    expect(taxWorksheetHtml(retained)).toBe(html);
  });
  it("does not roll balances across currencies", () => {
    const s = value(saveAssetTaxScheme(ctx(), schemePayload()));
    const d = prepare(create());
    finalise(save(d, [row(d, s)]));
    expect(create(2026, "USD").capital.rollover).toBeNull();
  });
  it("rolls scheme versions into the next year without claiming a new amount automatically", () => {
    const s = value(saveAssetTaxScheme(ctx(), schemePayload()));
    let d = prepare(create());
    finalise(save(d, [row(d, s)]));
    d = create(2026);
    d = value(
      changeCapitalSchedule(
        ctx(),
        d.worksheet.id,
        command(d, "rollover", {
          rolloverHash: d.capital.rolloverHash,
          replaceManual: false,
        }),
      ),
    );
    expect(d.capital.schedule!.rows[0]).toMatchObject({
      schemeId: s.id,
      schemeFirstYear: false,
      annualMinor: null,
      openingResidualMinor: 700000,
    });
    expect(d.capital.schedule!.rows[0].appliedScheme?.version).toBe(1);
    expect(d.capital.totals?.usedMinor).toBe(0);
  });
  it("rolls back definitions, audits and events when auditing fails", () => {
    raw.exec(
      "CREATE TRIGGER reject_scheme_audit BEFORE INSERT ON audit_log WHEN NEW.record_type='tax_scheme' BEGIN SELECT RAISE(ABORT,'scheme audit failed'); END",
    );
    let signals = 0;
    const listener = () => signals++;
    taxWorksheetEvents.on("changed", listener);
    try {
      expect(() => saveAssetTaxScheme(ctx(), schemePayload())).toThrow(
        "scheme audit failed",
      );
    } finally {
      taxWorksheetEvents.off("changed", listener);
    }
    expect(signals).toBe(0);
    expect(value(readAssetTaxSchemes(ctx()))).toEqual([]);
  });
});

describe("retained schedule currency", () => {
  it("refuses implicit relabelling after a draft worksheet currency changes", () => {
    const scheme = value(saveAssetTaxScheme(ctx(), schemePayload()));
    let d = prepare(create());
    d = save(d, [row(d, scheme)], 300000);
    db.update(schema.taxWorksheetRevisions)
      .set({ snapshot: { ...d.revision.snapshot, currency: "USD" } })
      .where(eq(schema.taxWorksheetRevisions.id, d.revision.id))
      .run();
    d = value(readTaxWorksheet(ctx(), d.worksheet.id));
    expect(d.capital.currencyMismatch).toBe(true);
    expect(d.totals.capitalMinor).toBe(0);
    expect(
      changeCapitalSchedule(
        ctx(),
        d.worksheet.id,
        command(d, "save", {
          input: {
            jurisdiction: "MY",
            evidence: d.capital.schedule!.evidence,
            rows: d.capital.schedule!.rows,
            utilisation: d.capital.schedule!.utilisation,
          },
        }),
      ).ok,
    ).toBe(false);
    const manual = value(
      changeCapitalSchedule(ctx(), d.worksheet.id, command(d, "manual")),
    );
    expect(manual.capital.active).toBe(false);
    expect(manual.capital.schedule!.currency).toBe("MYR");
  });
});
