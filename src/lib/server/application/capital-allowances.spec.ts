import { calculateUtilisation } from "$lib/capital-utilisation.js";
import { RevenueSubType, DefaultAccountPurpose } from "$lib/enums.js";
import { createRecord } from "./records.js";
import { saveTaxWorksheet } from "./tax-worksheet-save.js";
import { reviewedUtilisation } from "./__fixtures__/utilisation.js";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../db/schema.js";
import type { LedgerDb } from "../ledger/types.js";
import { AccountType, AccountSubType } from "$lib/enums.js";
import { createAccount } from "../services/accounts.js";
import { registerFixedAsset } from "./fixed-assets.js";
import { localsFor } from "../permissions/test-locals.js";
import { setSetting, SETTING_KEYS } from "../settings.js";
import {
  balanceSheetReport,
  profitLossReport,
  cashFlowReport,
} from "../queries/reports.js";
import {
  taxWorksheetCsv,
  taxWorksheetHtml,
} from "../queries/tax-worksheets.js";
import {
  createTaxWorksheet,
  changeTaxWorksheet,
  readTaxWorksheet,
  changeCapitalSchedule,
  taxWorksheetEvents,
} from "./tax-worksheets.js";
import {
  capitalTotals,
  capitalSum,
  type CapitalSchedule,
} from "$lib/capital-allowance.js";
import { toCsv } from "../ledger/reports/csv.js";
import { saveAssetTaxScheme } from "./asset-tax-schemes.js";
import { schemeSnapshot } from "../queries/asset-tax-schemes.js";
import type { AppliedAssetTaxScheme } from "$lib/asset-tax-scheme.js";

let sqlite: Database;
let db: LedgerDb;
let assetId: number;
let costAccount: number;
let scheme: AppliedAssetTaxScheme;
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
const read = (id: number, live = true) =>
  value(readTaxWorksheet(ctx(), id, undefined, live));
const create = (ya = 2025) =>
  value(
    createTaxWorksheet(ctx(), {
      ya,
      dateFrom: `${ya}-01-01`,
      dateTo: `${ya}-12-31`,
      requestKey: key(),
    }),
  );
type Detail = ReturnType<typeof create>;
function command(
  d: Detail,
  action: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    action,
    expectedVersion: d.revision.version,
    requestKey: key(),
    reason: "Accountant reviewed the annual tax workings",
    liveAssetHash: d.capital.liveAssetHash,
    ...(action === "prepare" ? { jurisdiction: "MY" } : {}),
    ...extra,
    ...(action === "save"
      ? { utilisationHash: d.capital.utilisationBasis?.hash }
      : {}),
    ...(action === "save" && extra.input
      ? {
          input: reviewedUtilisation(
            d,
            extra.input as import("$lib/capital-allowance.js").CapitalInput,
          ),
        }
      : {}),
  };
}
const apply = (d: Detail, payload: ReturnType<typeof command>) =>
  value(changeCapitalSchedule(ctx(), d.worksheet.id, payload));
const prepare = (d: Detail) => apply(d, command(d, "prepare"));
function ready(d: Detail, overrides: Record<string, unknown> = {}) {
  const input = structuredClone(d.capital.schedule!);
  input.evidence = "Accountant working paper CA-2025";
  input.rows = input.rows.map((r) => ({
    ...r,
    treatment: "claim",
    schemeId: scheme.id,
    appliedScheme: scheme,
    schemeFirstYear: true,
    taxClass: scheme.definition.name,
    businessSource: "Trading",
    qualifyingMinor: 1200000,
    businessUseBps: 10000,
    openingResidualMinor: 0,
    additionsMinor: 1200000,
    initialMinor: 240000,
    annualMinor: 120000,
    ...overrides,
  }));
  input.utilisation = [
    {
      businessSource: "Trading",
      originYa: d.worksheet.ya,
      balanceMinor: 360000,
      usedMinor: 300000,
    },
  ];
  return input;
}
function save(d: Detail, input = ready(d)) {
  return apply(
    d,
    command(d, "save", {
      confirmFirstYearTreatments: true,
      input: {
        jurisdiction: input.jurisdiction,
        evidence: input.evidence,
        rows: input.rows,
        utilisation: input.utilisation,
      },
    }),
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
  JSON.stringify({
    accounts: db.select().from(schema.accounts).all(),
    records: db.select().from(schema.ledgerRecords).all(),
    movements: db.select().from(schema.ledgerMovements).all(),
    settlements: db.select().from(schema.settlements).all(),
    allocations: db.select().from(schema.reconciliationAllocations).all(),
    settings: db.select().from(schema.settings).all(),
    pl: profitLossReport(db, "2025-01-01", "2025-12-31"),
    bs: balanceSheetReport(db, "2025-12-31"),
    cf: cashFlowReport(db, "2025-01-01", "2025-12-31"),
  });
beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema }) as LedgerDb;
  migrate(db, { migrationsFolder: "drizzle" });
  sqlite.exec("PRAGMA foreign_keys=ON");
  db.insert(schema.users)
    .values({
      id: 1,
      email: "tax@test",
      username: "Accountant",
      passwordHash: "x",
    })
    .run();
  scheme = schemeSnapshot(
    value(
      saveAssetTaxScheme(ctx(), {
        familyKey: key(),
        expectedVersion: 0,
        requestKey: key(),
        definition: {
          name: "Reviewed plant",
          jurisdiction: "MY",
          yearFrom: 2023,
          yearTo: null,
          method: "original_cost",
          firstYearRateBps: 2000,
          regularRateBps: 1000,
        },
      }),
    ),
  );
  costAccount = value(
    createAccount(db, 1, {
      name: "Equipment",
      type: AccountType.Asset,
      subType: AccountSubType.FixedAsset,
    }),
  ).id;
  assetId = value(
    registerFixedAsset(ctx(), {
      name: "Laptop",
      assetType: "Computer equipment",
      sourceMovementId: null,
      acquisitionDate: "2025-01-10",
      inServiceDate: "2025-01-10",
      assetAccountId: costAccount,
      costMinor: 1200000,
      openingAsAt: "2025-01-10",
      broughtForwardDepMinor: 0,
      openingRecordId: null,
      documentReference: "Receipt PC-1",
    }),
  ).id;
});
afterEach(() => sqlite.close());
describe("scheme-based capital allowance schedules", () => {
  it("captures unresolved asset candidates without asserting eligibility or posting journals", () => {
    const before = financial();
    const d = prepare(create());
    expect(d.capital.schedule?.rows[0]).toMatchObject({
      assetId,
      treatment: "pending",
      businessUseBps: null,
      initialMinor: null,
    });
    expect(d.capital.totals?.problems.length).toBeGreaterThan(0);
    expect(
      changeTaxWorksheet(ctx(), d.worksheet.id, {
        action: "review",
        expectedVersion: d.revision.version,
      }).ok,
    ).toBe(false);
    expect(financial()).toBe(before);
  });
  it("separates asset tax residual, available allowances and reviewed utilisation without GL movement", () => {
    setSetting(db, SETTING_KEYS.accountingClosedThrough, "2025-12-31");
    const before = financial();
    const d = save(prepare(create()));
    expect(d.capital.totals).toMatchObject({
      allowanceMinor: 360000,
      usedMinor: 300000,
      carryForwardMinor: 60000,
      problems: [],
    });
    expect(d.capital.totals?.rows[0].closingResidualMinor).toBe(840000);
    expect(d.totals).toMatchObject({
      capitalMinor: -300000,
      resultMinor: -300000,
    });
    expect(financial()).toBe(before);
  });
  it("keeps stable retries idempotent and refuses changed payloads and stale writes", () => {
    let d = create();
    const p = command(d, "prepare");
    d = apply(d, p);
    const audits = db.select().from(schema.auditLog).all().length;
    expect(apply(d, p).revision.version).toBe(d.revision.version);
    expect(db.select().from(schema.auditLog).all()).toHaveLength(audits);
    expect(
      changeCapitalSchedule(ctx(), d.worksheet.id, {
        ...p,
        reason: "Different request with same key",
      }).ok,
    ).toBe(false);
    expect(
      changeCapitalSchedule(ctx(), d.worksheet.id, { ...p, requestKey: key() })
        .ok,
    ).toBe(false);
  });
  it("requires a selected scheme for every claimed asset without retaining arbitrary deduction amounts", () => {
    const d = prepare(create());
    const input = ready(d);
    input.rows[0].schemeId = null;
    input.rows[0].appliedScheme = undefined;
    const before = JSON.stringify([
      db.select().from(schema.taxCapitalSchedules).all(),
      db.select().from(schema.taxCapitalCommands).all(),
      db.select().from(schema.auditLog).all(),
    ]);
    expect(
      changeCapitalSchedule(
        ctx(),
        d.worksheet.id,
        command(d, "save", {
          confirmFirstYearTreatments: true,
          input: {
            jurisdiction: "MY",
            evidence: input.evidence,
            rows: input.rows,
            utilisation: input.utilisation,
          },
        }),
      ).ok,
    ).toBe(false);
    expect(
      JSON.stringify([
        db.select().from(schema.taxCapitalSchedules).all(),
        db.select().from(schema.taxCapitalCommands).all(),
        db.select().from(schema.auditLog).all(),
      ]),
    ).toBe(before);
  });
  it("rejects duplicate/missing/foreign asset IDs, unsafe amounts and out-of-range percentages", () => {
    const d = prepare(create());
    const input = ready(d);
    for (const rows of [
      [],
      [...input.rows, ...input.rows],
      [{ ...input.rows[0], assetId: 999 }],
      [{ ...input.rows[0], initialMinor: -1 }],
      [{ ...input.rows[0], businessUseBps: 10001 }],
      [{ ...input.rows[0], qualifyingMinor: Number.MAX_SAFE_INTEGER + 1 }],
    ]) {
      expect(
        changeCapitalSchedule(
          ctx(),
          d.worksheet.id,
          command(d, "save", {
            input: { evidence: input.evidence, rows, utilisation: [] },
          }),
        ).ok,
      ).toBe(false);
    }
    expect(db.select().from(schema.taxCapitalCommands).all()).toHaveLength(1);
  });
  it("rejects tampered scheme workings and duplicate or over-used balances", () => {
    const d = prepare(create());
    const input = ready(d);
    input.rows[0].initialMinor = 1300000;
    expect(
      changeCapitalSchedule(
        ctx(),
        d.worksheet.id,
        command(d, "save", {
          input: {
            jurisdiction: "MY",
            evidence: input.evidence,
            rows: input.rows,
            utilisation: input.utilisation,
          },
        }),
      ).ok,
    ).toBe(false);
    const good = ready(d);
    good.utilisation[0].usedMinor = 360001;
    expect(
      changeCapitalSchedule(
        ctx(),
        d.worksheet.id,
        command(d, "save", {
          input: {
            evidence: good.evidence,
            rows: good.rows,
            utilisation: good.utilisation,
          },
        }),
      ).ok,
    ).toBe(false);
    good.utilisation[0].usedMinor = 0;
    good.utilisation.push(good.utilisation[0]);
    expect(
      changeCapitalSchedule(
        ctx(),
        d.worksheet.id,
        command(d, "save", {
          input: {
            evidence: good.evidence,
            rows: good.rows,
            utilisation: good.utilisation,
          },
        }),
      ).ok,
    ).toBe(false);
  });
  it("detects asset changes before save/review/finalisation and explicitly resets affected rows", () => {
    let d = save(prepare(create()));
    d = value(
      changeTaxWorksheet(ctx(), d.worksheet.id, {
        action: "review",
        expectedVersion: d.revision.version,
      }),
    );
    db.update(schema.fixedAssets)
      .set({ revision: 2, costMinor: 1250000 })
      .where(eq(schema.fixedAssets.id, assetId))
      .run();
    expect(
      changeTaxWorksheet(ctx(), d.worksheet.id, {
        action: "finalise",
        expectedVersion: d.revision.version,
      }).ok,
    ).toBe(false);
    expect(
      changeCapitalSchedule(
        ctx(),
        d.worksheet.id,
        command(d, "save", {
          input: {
            evidence: d.capital.schedule!.evidence,
            rows: d.capital.schedule!.rows,
            utilisation: d.capital.schedule!.utilisation,
          },
        }),
      ).ok,
    ).toBe(false);
    d = read(d.worksheet.id);
    expect(d.capital.assetsStale).toBe(true);
    d = apply(d, command(d, "refresh-assets"));
    expect(d.revision.status).toBe("draft");
    expect(d.capital.schedule?.rows[0].treatment).toBe("pending");
    expect(d.capital.schedule?.utilisation).toEqual([]);
  });
  it("freezes finalised schedule exports across asset changes, amendment and source-free reads", () => {
    let d = finalise(save(prepare(create())));
    const csv = toCsv(taxWorksheetCsv(d)),
      html = taxWorksheetHtml(d);
    expect(csv).toContain("Opening tax residual");
    expect(html).toContain("Accountant working paper");
    expect(() =>
      db
        .update(schema.taxCapitalSchedules)
        .set({
          evidence: {
            ...d.capital.schedule!,
            evidence: "Tampered finalised evidence",
          },
        })
        .where(eq(schema.taxCapitalSchedules.revisionId, d.revision.id))
        .run(),
    ).toThrow();
    expect(() =>
      db
        .delete(schema.taxCapitalSchedules)
        .where(eq(schema.taxCapitalSchedules.revisionId, d.revision.id))
        .run(),
    ).toThrow();
    db.update(schema.fixedAssets)
      .set({ name: "Changed laptop", revision: 2 })
      .where(eq(schema.fixedAssets.id, assetId))
      .run();
    const retained = read(d.worksheet.id, false);
    expect(toCsv(taxWorksheetCsv(retained))).toBe(csv);
    expect(taxWorksheetHtml(retained)).toBe(html);
    d = value(
      changeTaxWorksheet(ctx(), d.worksheet.id, {
        action: "amend",
        expectedVersion: d.revision.version,
        requestKey: key(),
        reason: "Amend annual capital allowance review",
      }),
    );
    expect(d.revision.status).toBe("draft");
    expect(d.capital.active).toBe(true);
    expect(d.capital.totals?.usedMinor).toBe(0); // Source changes invalidate the reviewed income basis on amendment.
    expect(
      taxWorksheetHtml(
        value(readTaxWorksheet(ctx(), d.worksheet.id, 1, false)),
      ),
    ).toBe(html);
  });
  it("rolls forward residuals and unabsorbed allowances independently without assuming a new claim", () => {
    finalise(save(prepare(create())));
    let d = create(2026);
    expect(d.capital.rollover?.rows[0].openingResidualMinor).toBe(840000);
    expect(d.capital.rollover?.utilisation).toEqual([
      {
        businessSource: "Trading",
        originYa: 2025,
        balanceMinor: 60000,
        usedMinor: 0,
      },
    ]);
    d = apply(
      d,
      command(d, "rollover", {
        rolloverHash: d.capital.rolloverHash,
      }),
    );
    expect(d.capital.schedule?.rows[0].annualMinor).toBeNull();
    expect(d.capital.totals?.usedMinor).toBe(0);
    const input = structuredClone(d.capital.schedule!);
    input.evidence = "Reviewed 2026 capital allowances";
    input.rows[0].annualMinor = 120000;
    input.utilisation = input.utilisation.filter((u) => u.originYa !== 2026);
    input.utilisation.push({
      businessSource: "Trading",
      originYa: 2026,
      balanceMinor: 120000,
      usedMinor: 100000,
    });
    d = save(d, input);
    expect(d.capital.totals?.problems).toEqual([]);
    expect(d.capital.totals?.carryForwardMinor).toBe(80000);
  });
  it("refuses stale rollover previews and flags a prior-year amendment", () => {
    const prior = finalise(save(prepare(create())));
    const d = create(2026);
    value(
      changeTaxWorksheet(ctx(), prior.worksheet.id, {
        action: "amend",
        expectedVersion: prior.revision.version,
        requestKey: key(),
        reason: "New prior-year tax evidence received",
      }),
    );
    expect(
      changeCapitalSchedule(
        ctx(),
        d.worksheet.id,
        command(d, "rollover", {
          rolloverHash: d.capital.rolloverHash,
        }),
      ).ok,
    ).toBe(false);
  });
  it("flags predecessor drift after a rollover has already been saved", () => {
    const prior = finalise(save(prepare(create())));
    let d = create(2026);
    d = apply(
      d,
      command(d, "rollover", {
        rolloverHash: d.capital.rolloverHash,
      }),
    );
    value(
      changeTaxWorksheet(ctx(), prior.worksheet.id, {
        action: "amend",
        expectedVersion: prior.revision.version,
        requestKey: key(),
        reason: "New prior-year tax evidence received",
      }),
    );
    d = read(d.worksheet.id);
    expect(d.capital.predecessorStale).toBe(true);
    expect(
      changeTaxWorksheet(ctx(), d.worksheet.id, {
        action: "review",
        expectedVersion: d.revision.version,
      }).ok,
    ).toBe(false);
  });
  it("requires tax permissions, supports independent book currencies and isolates book contexts", () => {
    const d = create();
    const p = command(d, "prepare");
    expect(
      changeCapitalSchedule(
        ctx(["accounts", "records", "reports"]),
        d.worksheet.id,
        p,
      ).ok,
    ).toBe(false);
    expect(changeCapitalSchedule(ctx(["tax.read"]), d.worksheet.id, p).ok).toBe(
      false,
    );
    const other = new Database(":memory:");
    const otherDb = drizzle(other, { schema }) as LedgerDb;
    migrate(otherDb, { migrationsFolder: "drizzle" });
    try {
      expect(
        changeCapitalSchedule({ ...ctx(), db: otherDb }, d.worksheet.id, p).ok,
      ).toBe(false);
    } finally {
      other.close();
    }
    const snapshot = { ...d.revision.snapshot, currency: "USD" };
    db.update(schema.taxWorksheetRevisions)
      .set({ snapshot })
      .where(eq(schema.taxWorksheetRevisions.id, d.revision.id))
      .run();
    expect(
      value(changeCapitalSchedule(ctx(), d.worksheet.id, p)).capital.schedule
        ?.currency,
    ).toBe("USD");
  });
  it("rolls back schedule, receipt, version, audit and signals when the audit fails", () => {
    const d = create();
    sqlite.exec(
      "CREATE TRIGGER reject_capital_audit BEFORE INSERT ON audit_log WHEN NEW.record_type='tax_worksheet' BEGIN SELECT RAISE(ABORT,'simulated audit failure'); END",
    );
    let signals = 0;
    const listener = () => signals++;
    taxWorksheetEvents.on("changed", listener);
    try {
      expect(() =>
        changeCapitalSchedule(ctx(), d.worksheet.id, command(d, "prepare")),
      ).toThrow("simulated audit failure");
    } finally {
      taxWorksheetEvents.off("changed", listener);
    }
    expect(signals).toBe(0);
    expect(db.select().from(schema.taxCapitalSchedules).all()).toEqual([]);
    expect(db.select().from(schema.taxCapitalCommands).all()).toEqual([]);
    expect(read(d.worksheet.id).revision.version).toBe(d.revision.version);
    expect(read(d.worksheet.id).adjustments).toEqual([]);
  });
  it("uses exact basis-point arithmetic and rejects unsafe aggregate totals", () => {
    let d = prepare(create());
    const input = ready(d);
    const tiny = schemeSnapshot(
      value(
        saveAssetTaxScheme(ctx(), {
          familyKey: key(),
          expectedVersion: 0,
          requestKey: key(),
          definition: {
            ...scheme.definition,
            name: "Rounding fixture",
            firstYearRateBps: 100,
            regularRateBps: 100,
          },
        }),
      ),
    );
    input.rows[0] = {
      ...input.rows[0],
      schemeId: tiny.id,
      appliedScheme: tiny,
      qualifyingMinor: 101,
      businessUseBps: 5000,
      openingResidualMinor: 0,
      additionsMinor: 51,
      initialMinor: 1,
      annualMinor: 1,
    };
    input.utilisation = [
      {
        businessSource: "Trading",
        originYa: 2025,
        balanceMinor: 2,
        usedMinor: 2,
      },
    ];
    d = save(d, input);
    expect(d.capital.totals?.problems).toEqual([]);
    expect(d.capital.totals?.rows[0].closingResidualMinor).toBe(49);
    expect(() => capitalSum([Number.MAX_SAFE_INTEGER, 1])).toThrow("exceeds");
    const bad = structuredClone(input) as CapitalSchedule;
    bad.rows[0].initialMinor = Number.MAX_SAFE_INTEGER;
    bad.rows[0].annualMinor = Number.MAX_SAFE_INTEGER;
    expect(() => capitalTotals(bad, 2025)).toThrow();
  });
  it("escapes retained asset names and source notes in CSV/print", () => {
    db.update(schema.fixedAssets)
      .set({ name: "<script>alert(1)</script>", revision: 2 })
      .where(eq(schema.fixedAssets.id, assetId))
      .run();
    const d = save(prepare(create()));
    const html = taxWorksheetHtml(d);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(toCsv(taxWorksheetCsv(d))).toContain("Capital allowances");
  });
});

describe("capital allowance dependency and multi-source review", () => {
  it("retains separate business-source utilisation and rejects future origin balances", () => {
    let d = prepare(create());
    const input = ready(d);
    input.utilisation.push({
      businessSource: "Second business",
      originYa: 2024,
      balanceMinor: 50000,
      usedMinor: 10000,
    });
    input.utilisation.push({
      businessSource: "Second business",
      originYa: 2025,
      balanceMinor: 0,
      usedMinor: 0,
    });
    d = save(d, input);
    expect(d.capital.totals?.groups).toHaveLength(2);
    expect(d.capital.totals?.usedMinor).toBe(310000);
    const future = structuredClone(input);
    future.utilisation.push({
      businessSource: "Trading",
      originYa: 2026,
      balanceMinor: 10000,
      usedMinor: 0,
    });
    expect(
      changeCapitalSchedule(
        ctx(),
        d.worksheet.id,
        command(d, "save", {
          input: {
            evidence: future.evidence,
            rows: future.rows,
            utilisation: future.utilisation,
          },
        }),
      ).ok,
    ).toBe(false);
  });
  it("blocks downstream review when an earlier dependency is amended", () => {
    db.update(schema.fixedAssets)
      .set({
        acquisitionDate: "2023-01-10",
        openingAsAt: "2023-01-10",
        inServiceDate: "2023-01-10",
      })
      .where(eq(schema.fixedAssets.id, assetId))
      .run();
    const first = finalise(save(prepare(create(2023))));
    let second = create(2024);
    second = apply(
      second,
      command(second, "rollover", {
        rolloverHash: second.capital.rolloverHash,
      }),
    );
    const input = structuredClone(second.capital.schedule!);
    input.rows[0].annualMinor = 120000;
    input.evidence = "Reviewed annual tax schedule 2024";
    input.utilisation = input.utilisation.filter((u) => u.originYa !== 2024);
    input.utilisation.push({
      businessSource: "Trading",
      originYa: 2024,
      balanceMinor: 120000,
      usedMinor: 0,
    });
    second = finalise(save(second, input));
    let third = create(2025);
    third = apply(
      third,
      command(third, "rollover", {
        rolloverHash: third.capital.rolloverHash,
      }),
    );
    value(
      changeTaxWorksheet(ctx(), first.worksheet.id, {
        action: "amend",
        expectedVersion: first.revision.version,
        requestKey: key(),
        reason: "Correct the first year tax schedule",
      }),
    );
    expect(read(second.worksheet.id).capital.predecessorStale).toBe(true);
    expect(read(third.worksheet.id).capital.predecessorStale).toBe(true);
    expect(read(third.worksheet.id).capital.rollover).toBeNull();
  });
});

describe("automatic capital utilisation at the application boundary", () => {
  beforeEach(() => {
    for (const [purpose, name, type, subType] of [
      [
        DefaultAccountPurpose.Receivable,
        "Receivable",
        AccountType.Asset,
        AccountSubType.Receivable,
      ],
      [
        DefaultAccountPurpose.Payable,
        "Payable",
        AccountType.Liability,
        AccountSubType.AccountsPayable,
      ],
      [
        DefaultAccountPurpose.OpeningBalances,
        "Opening equity",
        AccountType.Equity,
        undefined,
      ],
    ] as const) {
      const accountId = value(createAccount(db, 1, { name, type, subType })).id;
      db.insert(schema.accountDefaults).values({ purpose, accountId }).run();
    }
  });
  function autoSave(d: Detail, input = ready(d)) {
    return value(
      changeCapitalSchedule(ctx(), d.worksheet.id, {
        action: "save",
        expectedVersion: d.revision.version,
        requestKey: key(),
        reason: "Review automatic allowance utilisation",
        liveAssetHash: d.capital.liveAssetHash,
        utilisationHash: d.capital.utilisationBasis!.hash,
        confirmFirstYearTreatments: true,
        input: {
          jurisdiction: input.jurisdiction,
          evidence: input.evidence,
          rows: input.rows,
          utilisation: input.utilisation,
          utilisationPolicy: input.utilisationPolicy,
        },
      }),
    );
  }
  function income(amount: number) {
    const sales = value(
      createAccount(db, 1, {
        name: `Trading sales ${key()}`,
        type: AccountType.Revenue,
        subType: RevenueSubType.OperatingRevenue,
      }),
    ).id;
    value(
      createRecord(ctx(), {
        kind: "income",
        date: "2025-05-01",
        amount,
        currency: "MYR",
        exchangeRate: 1,
        description: "Trading receipts",
        categoryAccountId: sales,
        receivedIntoAccountId: value(
          createAccount(db, 1, {
            name: `Receipts bank ${key()}`,
            type: AccountType.Asset,
            subType: AccountSubType.Bank,
          }),
        ).id,
      }),
    );
    return sales;
  }
  it("uses the maximum automatically, disregards client usage, caps income and changes no ledger balances", () => {
    income(1000);
    let d = prepare(create());
    const before = financial();
    const input = ready(d);
    input.utilisation[0].usedMinor = 0;
    d = autoSave(d, input);
    expect(d.capital.schedule!.utilisationPolicy).toMatchObject({
      version: 1,
      overrides: [],
    });
    expect(d.capital.totals).toMatchObject({
      usedMinor: 100000,
      carryForwardMinor: 260000,
    });
    expect(d.capital.schedule!.utilisationEvidence!.groups[0]).toMatchObject({
      capacityMinor: 100000,
      basis: "bookkeeping",
    });
    expect(financial()).toBe(before);
  });
  it("recalculates on a worksheet save without a capital payload and freezes finalised evidence", () => {
    income(1000);
    let d = autoSave(prepare(create()));
    income(500);
    d = read(d.worksheet.id);
    expect(d.capital.totals!.usedMinor).toBe(150000);
    d = value(
      saveTaxWorksheet(ctx(), d.worksheet.id, {
        action: "save-worksheet",
        target: "finalised",
        expectedVersion: d.revision.version,
        requestKey: key(),
        liveHash: d.liveHash,
        sourceHashes: d.sourceHashes,
        adjustments: [],
        withdrawals: [],
      }),
    );
    const stored = db
      .select()
      .from(schema.taxCapitalSchedules)
      .where(eq(schema.taxCapitalSchedules.revisionId, d.revision.id))
      .get()!.evidence;
    expect(stored.utilisationEvidence!.groups[0].usedMinor).toBe(150000);
    const csv = toCsv(taxWorksheetCsv(read(d.worksheet.id, false)));
    income(300);
    expect(toCsv(taxWorksheetCsv(read(d.worksheet.id, false)))).toBe(csv);
    expect(read(d.worksheet.id).capital.totals!.usedMinor).toBe(150000);
  });
  it("automatically uses revenue with no subtype, consistently with the P&L", () => {
    const sales = income(1000);
    db.update(schema.accounts)
      .set({ subType: null })
      .where(eq(schema.accounts.id, sales))
      .run();
    const d = autoSave(prepare(create()));
    expect(d.capital.totals).toMatchObject({
      usedMinor: 100000,
      carryForwardMinor: 260000,
      problems: [],
    });
    expect(d.capital.schedule!.utilisationEvidence!.groups[0].basis).toBe(
      "bookkeeping",
    );
    expect(finalise(d).revision.status).toBe("finalised");
  });
  it("automatically applies staged annual adjustments before allowances and brought-forward losses", () => {
    income(1000);
    let d = autoSave(prepare(create()));
    d = value(
      saveTaxWorksheet(ctx(), d.worksheet.id, {
        action: "save-worksheet",
        target: "finalised",
        expectedVersion: d.revision.version,
        requestKey: key(),
        liveHash: d.liveHash,
        sourceHashes: d.sourceHashes,
        withdrawals: [],
        adjustments: [
          {
            kind: "other",
            direction: "decrease",
            amountMinor: 20000,
            balanceMinor: 0,
            originYa: null,
            reason: "Annual single-business adjustment",
            evidence: "Annual workings",
            requestKey: key(),
            expectedVersion: d.revision.version,
          },
          {
            kind: "loss_brought_forward",
            direction: "decrease",
            amountMinor: 10000,
            balanceMinor: 10000,
            originYa: 2024,
            reason: "Brought-forward business loss",
            evidence: "Prior workings",
            requestKey: key(),
            expectedVersion: d.revision.version,
          },
        ],
      }),
    );
    expect(d.capital.totals).toMatchObject({
      usedMinor: 80000,
      carryForwardMinor: 280000,
      problems: [],
    });
    expect(d.revision.status).toBe("finalised");
  });
  it("detects changed income classifications even when GL amounts did not change", () => {
    const sales = income(1000);
    const d = prepare(create()),
      input = ready(d);
    db.update(schema.accounts)
      .set({ subType: RevenueSubType.OtherRevenue })
      .where(eq(schema.accounts.id, sales))
      .run();
    const result = changeCapitalSchedule(ctx(), d.worksheet.id, {
      action: "save",
      expectedVersion: d.revision.version,
      requestKey: key(),
      reason: "Review allowance income capacity",
      liveAssetHash: d.capital.liveAssetHash,
      utilisationHash: d.capital.utilisationBasis!.hash,
      confirmFirstYearTreatments: true,
      input: {
        jurisdiction: input.jurisdiction,
        evidence: input.evidence,
        rows: input.rows,
        utilisation: input.utilisation,
        utilisationPolicy: input.utilisationPolicy,
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("Income evidence changed");
    const fresh = read(d.worksheet.id);
    const preview = calculateUtilisation(
      {
        ...input,
        assets: input.assets,
        calculationVersion: 2,
        predecessor: null,
      },
      2025,
      {
        ...fresh.capital.utilisationBasis!,
        snapshot: fresh.revision.snapshot,
        adjustments: fresh.adjustments,
      },
    );
    expect(preview.utilisationEvidence!.groups[0].capacityMinor).toBeNull();
  });
  it("preserves saved legacy manual evidence and starts the following YA in automatic mode", () => {
    income(1000);
    let d = autoSave(prepare(create()));
    const legacy = structuredClone(d.capital.schedule!);
    delete legacy.utilisationPolicy;
    delete legacy.utilisationEvidence;
    legacy.utilisation[0].usedMinor = 50000;
    db.update(schema.taxCapitalSchedules)
      .set({ evidence: legacy })
      .where(eq(schema.taxCapitalSchedules.revisionId, d.revision.id))
      .run();
    d = read(d.worksheet.id);
    expect(d.capital.totals!.usedMinor).toBe(50000);
    expect(d.capital.schedule!.utilisationPolicy).toBeUndefined();
    d = finalise(d);
    const before = JSON.stringify(
      db
        .select()
        .from(schema.taxCapitalSchedules)
        .where(eq(schema.taxCapitalSchedules.revisionId, d.revision.id))
        .get(),
    );
    const next = create(2026);
    expect(next.capital.schedule!.utilisationPolicy).toMatchObject({
      version: 1,
      overrides: [],
      income: [],
    });
    expect(
      next.capital.schedule!.utilisation.find((u) => u.originYa === 2025)!
        .balanceMinor,
    ).toBe(310000);
    expect(
      JSON.stringify(
        db
          .select()
          .from(schema.taxCapitalSchedules)
          .where(eq(schema.taxCapitalSchedules.revisionId, d.revision.id))
          .get(),
      ),
    ).toBe(before);
  });
  it("carries only unabsorbed balances and clears yearly restrictions on rollover", () => {
    income(1000);
    let d = prepare(create());
    const input = ready(d);
    input.utilisationPolicy!.overrides = [
      {
        businessSource: "Trading",
        usedMinor: 50000,
        reason: "Accountant approved a restricted claim",
      },
    ];
    d = finalise(autoSave(d, input));
    expect(d.capital.totals).toMatchObject({
      usedMinor: 50000,
      carryForwardMinor: 260000,
    });
    expect(
      d.capital.schedule!.utilisationEvidence!.groups[0].restrictedMinor,
    ).toBe(50000);
    const next = create(2026);
    expect(
      next.capital
        .schedule!.utilisation.filter((u) => u.originYa === 2025)
        .map((u) => u.balanceMinor),
    ).toEqual([260000]);
    expect(next.capital.schedule!.utilisationPolicy).toMatchObject({
      overrides: [],
      income: [],
    });
  });
});
