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
  addTaxAdjustment,
  taxWorksheetEvents,
} from "./tax-worksheets.js";
import {
  capitalTotals,
  capitalSum,
  type CapitalSchedule,
} from "$lib/capital-allowance.js";
import { toCsv } from "../ledger/reports/csv.js";

let sqlite: Database;
let db: LedgerDb;
let assetId: number;
let costAccount: number;
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
    ...(action !== "manual" ? { liveAssetHash: d.capital.liveAssetHash } : {}),
    ...(action === "prepare" ? { jurisdiction: "MY" } : {}),
    ...extra,
  };
}
const apply = (d: Detail, payload: ReturnType<typeof command>) =>
  value(changeCapitalSchedule(ctx(), d.worksheet.id, payload));
const prepare = (d: Detail) =>
  apply(d, command(d, "prepare", { replaceManual: false }));
function ready(d: Detail, overrides: Record<string, unknown> = {}) {
  const input = structuredClone(d.capital.schedule!);
  input.evidence = "Accountant working paper CA-2025";
  input.rows = input.rows.map((r) => ({
    ...r,
    treatment: "claim",
    taxClass: "Reviewed plant",
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
      input: {
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
function manual(d: Detail, kind = "capital_allowance") {
  return {
    kind,
    direction: "decrease",
    amountMinor: 10000,
    balanceMinor: kind === "allowance_brought_forward" ? 50000 : 0,
    originYa: kind === "allowance_brought_forward" ? 2024 : null,
    reason: "Reviewed existing allowance from accountant",
    evidence: "Old schedule",
    requestKey: key(),
    expectedVersion: d.revision.version,
  };
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
describe("manual Malaysian capital allowance schedules", () => {
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
  it("requires explicit manual-total replacement and prevents overlapping API and SQL claims", () => {
    let d = create();
    d = value(addTaxAdjustment(ctx(), d.worksheet.id, manual(d)));
    d = value(
      addTaxAdjustment(
        ctx(),
        d.worksheet.id,
        manual(d, "allowance_brought_forward"),
      ),
    );
    const p = command(d, "prepare", { replaceManual: false });
    expect(changeCapitalSchedule(ctx(), d.worksheet.id, p).ok).toBe(false);
    d = apply(d, { ...p, replaceManual: true });
    expect(d.adjustments.filter((a) => a.withdrawnAt !== null)).toHaveLength(2);
    expect(addTaxAdjustment(ctx(), d.worksheet.id, manual(d)).ok).toBe(false);
    expect(() =>
      db
        .insert(schema.taxWorksheetAdjustments)
        .values({
          revisionId: d.revision.id,
          kind: "capital_allowance",
          amountMinor: 1,
          direction: "decrease",
          reason: "Attempt bypass",
          evidence: "x",
          requestKey: key(),
          actorName: "x",
          createdAt: "2026-01-01",
        })
        .run(),
    ).toThrow();
    d = save(d);
    d = apply(d, command(d, "manual"));
    expect(d.totals.capitalMinor).toBe(0);
    expect(d.capital.schedule).not.toBeNull();
    expect(addTaxAdjustment(ctx(), d.worksheet.id, manual(d)).ok).toBe(true);
  });
  it("keeps stable retries idempotent and refuses changed payloads and stale writes", () => {
    let d = create();
    const p = command(d, "prepare", { replaceManual: false });
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
  it("blocks review of non-reconciling workings and duplicate or over-used balances", () => {
    let d = prepare(create());
    const input = ready(d);
    input.rows[0].initialMinor = 1300000;
    d = save(d, input);
    expect(d.capital.totals?.problems.join(" ")).toContain("reconcile");
    expect(
      changeTaxWorksheet(ctx(), d.worksheet.id, {
        action: "review",
        expectedVersion: d.revision.version,
      }).ok,
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
    expect(
      changeCapitalSchedule(ctx(), d.worksheet.id, command(d, "manual")).ok,
    ).toBe(false);
    expect(() =>
      db
        .update(schema.taxCapitalSchedules)
        .set({ active: false })
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
    expect(d.capital.totals?.usedMinor).toBe(300000);
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
        replaceManual: false,
      }),
    );
    expect(d.capital.schedule?.rows[0].annualMinor).toBeNull();
    expect(d.capital.totals?.usedMinor).toBe(0);
    const input = structuredClone(d.capital.schedule!);
    input.evidence = "Reviewed 2026 capital allowances";
    input.rows[0].annualMinor = 120000;
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
          replaceManual: false,
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
        replaceManual: false,
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
  it("records manual balancing charges and full tax disposal without altering book assets", () => {
    const before = financial();
    let d = prepare(create());
    const input = ready(d);
    input.rows[0].disposal = {
      date: "2025-11-01",
      proceedsMinor: 900000,
      balancingAllowanceMinor: 0,
      balancingChargeMinor: 60000,
      evidence: "Reviewed disposal schedule",
    };
    d = save(d, input);
    expect(d.capital.totals?.rows[0]).toMatchObject({
      closingResidualMinor: 0,
      residualRemovedMinor: 840000,
    });
    expect(d.totals.capitalMinor).toBe(-240000);
    expect(financial()).toBe(before);
    finalise(d);
    const next = create(2026);
    expect(next.capital.rollover?.rows[0].treatment).toBe("exclude");
    expect(next.capital.rollover?.rows[0].note).toContain("Tax disposal");
  });
  it("rejects invalid disposal periods, dual balancing events and missing exclusion reasons at review", () => {
    let d = prepare(create());
    const input = ready(d);
    input.rows[0].disposal = {
      date: "2024-01-01",
      proceedsMinor: 0,
      balancingAllowanceMinor: 100,
      balancingChargeMinor: 100,
      evidence: "Disposal memo",
    };
    d = save(d, input);
    expect(d.capital.totals?.problems.join(" ")).toContain("disposal date");
    expect(d.capital.totals?.problems.join(" ")).toContain("not both");
    input.rows[0].disposal = null;
    input.rows[0].treatment = "exclude";
    input.utilisation = [];
    d = save(d, input);
    expect(d.capital.totals?.problems.join(" ")).toContain("Explain why");
  });
  it("requires tax permissions, supports independent book currencies and isolates book contexts", () => {
    const d = create();
    const p = command(d, "prepare", { replaceManual: false });
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
  it("rolls back schedule, replacement, receipt, version, audit and signals when the audit fails", () => {
    let d = create();
    d = value(addTaxAdjustment(ctx(), d.worksheet.id, manual(d)));
    sqlite.exec(
      "CREATE TRIGGER reject_capital_audit BEFORE INSERT ON audit_log WHEN NEW.record_type='tax_worksheet' BEGIN SELECT RAISE(ABORT,'simulated audit failure'); END",
    );
    let signals = 0;
    const listener = () => signals++;
    taxWorksheetEvents.on("changed", listener);
    try {
      expect(() =>
        changeCapitalSchedule(
          ctx(),
          d.worksheet.id,
          command(d, "prepare", { replaceManual: true }),
        ),
      ).toThrow("simulated audit failure");
    } finally {
      taxWorksheetEvents.off("changed", listener);
    }
    expect(signals).toBe(0);
    expect(db.select().from(schema.taxCapitalSchedules).all()).toEqual([]);
    expect(db.select().from(schema.taxCapitalCommands).all()).toEqual([]);
    expect(read(d.worksheet.id).revision.version).toBe(d.revision.version);
    expect(read(d.worksheet.id).adjustments[0].withdrawnAt).toBeNull();
  });
  it("uses exact basis-point arithmetic and rejects unsafe aggregate totals", () => {
    let d = prepare(create());
    const input = ready(d);
    input.rows[0] = {
      ...input.rows[0],
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
    expect(() =>
      capitalTotals(bad, 2025, "2025-01-01", "2025-12-31"),
    ).toThrow();
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
        replaceManual: false,
      }),
    );
    const input = structuredClone(second.capital.schedule!);
    input.rows[0].annualMinor = 120000;
    input.evidence = "Reviewed annual tax schedule 2024";
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
        replaceManual: false,
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
