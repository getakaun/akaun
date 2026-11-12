import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AccountSubType,
  AccountType,
  DefaultAccountPurpose,
} from "$lib/enums.js";
import * as schema from "../db/schema.js";
import type { LedgerDb } from "../ledger/types.js";
import { localsFor } from "../permissions/test-locals.js";
import { createAccount } from "../services/accounts.js";
import { toCsv } from "../ledger/reports/csv.js";
import { taxWorksheetCsv } from "../queries/tax-worksheets.js";
import { registerFixedAsset } from "./fixed-assets.js";
import { saveAssetTaxScheme } from "./asset-tax-schemes.js";
import { schemeSnapshot } from "../queries/asset-tax-schemes.js";
import { createRecord, updateRecord } from "./records.js";
import { setSetting, SETTING_KEYS } from "../settings.js";
import {
  editorRows,
  editorUses,
  editorSchemes,
  editorPreview,
} from "$lib/components/tax-worksheets/capital-editor.js";
import {
  createTaxWorksheet,
  changeTaxWorksheet,
  changeCapitalSchedule,
  readTaxWorksheet,
  saveTaxWorksheet,
  taxWorksheetEvents,
} from "./tax-worksheets.js";

let sqlite: Database;
let db: LedgerDb;
let bank: number;
let expenseAccount: number;
const key = () => crypto.randomUUID();
const ctx = (
  permissions = ["tax", "tax.finalise", "tax.amend", "accounts", "records"],
) => ({
  db,
  locals: localsFor(permissions),
});
function value<T>(
  result: { ok: true; value: T } | { ok: false; reason: string },
): T {
  if (!result.ok) throw Error(result.reason);
  return result.value;
}
const create = (year = 2025) =>
  value(
    createTaxWorksheet(ctx(), {
      ya: year,
      dateFrom: `${year}-01-01`,
      dateTo: `${year}-12-31`,
      requestKey: key(),
    }),
  );
type Detail = ReturnType<typeof create>;
const read = (id: number, live = true) =>
  value(readTaxWorksheet(ctx(), id, undefined, live));
function payload(detail: Detail, extra: Record<string, unknown> = {}) {
  return {
    action: "save-worksheet",
    target: "draft",
    expectedVersion: detail.revision.version,
    requestKey: key(),
    liveHash: detail.liveHash,
    sourceHashes: detail.sourceHashes,
    adjustments: [],
    withdrawals: [],
    ...extra,
  };
}
function adjustment(detail: Detail, extra: Record<string, unknown> = {}) {
  return {
    kind: "other",
    direction: "decrease",
    amountMinor: 1000,
    balanceMinor: 0,
    originYa: null,
    reason: "Annual worksheet tax adjustment",
    evidence: "Annual working paper",
    requestKey: key(),
    expectedVersion: detail.revision.version,
    ...extra,
  };
}
function expense(amount = 100) {
  return value(
    createRecord(ctx(), {
      kind: "expense",
      date: "2025-05-01",
      description: "Business expense",
      amount,
      currency: "MYR",
      exchangeRate: 1,
      categoryAccountId: expenseAccount,
      paidFromAccountId: bank,
    }),
  );
}
function printer() {
  const cost = value(
    createAccount(db, 1, {
      name: "Equipment",
      type: AccountType.Asset,
      subType: AccountSubType.FixedAsset,
    }),
  ).id;
  return value(
    registerFixedAsset(ctx(), {
      name: "Printer",
      assetType: "Machinery",
      sourceMovementId: null,
      acquisitionDate: "2025-06-01",
      inServiceDate: "2025-06-01",
      assetAccountId: cost,
      costMinor: 229900,
      openingAsAt: "2025-06-01",
      broughtForwardDepMinor: 0,
      openingRecordId: null,
      documentReference: "Printer receipt",
    }),
  );
}
function state() {
  return JSON.stringify({
    revisions: db.select().from(schema.taxWorksheetRevisions).all(),
    adjustments: db.select().from(schema.taxWorksheetAdjustments).all(),
    schedules: db.select().from(schema.taxCapitalSchedules).all(),
    commands: db.select().from(schema.taxCapitalCommands).all(),
    audit: db.select().from(schema.auditLog).all(),
  });
}
beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema }) as LedgerDb;
  migrate(db, { migrationsFolder: "drizzle" });
  sqlite.exec("PRAGMA foreign_keys = ON");
  db.insert(schema.users)
    .values({ id: 1, email: "save@test", username: "Owner", passwordHash: "x" })
    .run();
  function account(
    name: string,
    type: 1 | 2 | 3 | 4 | 5,
    subType?: number,
    percentage?: number,
  ) {
    return value(
      createAccount(db, 1, {
        name,
        type,
        subType: subType as never,
        defaultTaxPercentageBps: percentage,
      }),
    ).id;
  }
  bank = account("Bank", AccountType.Asset, AccountSubType.Bank);
  expenseAccount = account("Expenses", AccountType.Expense, undefined, 10000);
  const receivable = account(
    "Receivable",
    AccountType.Asset,
    AccountSubType.Receivable,
  );
  const payable = account(
    "Payable",
    AccountType.Liability,
    AccountSubType.AccountsPayable,
  );
  const opening = account("Opening", AccountType.Equity);
  db.insert(schema.accountDefaults)
    .values([
      { purpose: DefaultAccountPurpose.Receivable, accountId: receivable },
      { purpose: DefaultAccountPurpose.Payable, accountId: payable },
      { purpose: DefaultAccountPurpose.OpeningBalances, accountId: opening },
    ])
    .run();
});
afterEach(() => sqlite.close());

describe("worksheet-level draft and completion", () => {
  it("rejects removed manual allowance operations without changing a worksheet", () => {
    printer();
    const d = create();
    const before = state();
    expect(
      changeCapitalSchedule(ctx(), d.worksheet.id, {
        action: "manual",
        expectedVersion: d.revision.version,
        requestKey: key(),
        reason: "Removed allowance mode",
      }).ok,
    ).toBe(false);
    for (const kind of ["capital_allowance", "allowance_brought_forward"]) {
      expect(
        saveTaxWorksheet(
          ctx(),
          d.worksheet.id,
          payload(d, {
            adjustments: [
              adjustment(d, {
                kind,
                ...(kind === "allowance_brought_forward"
                  ? { balanceMinor: 5000, originYa: 2024 }
                  : {}),
              }),
            ],
          }),
        ).ok,
      ).toBe(false);
      expect(state()).toBe(before);
    }
  });
  it("saves scheme choices and utilisation together, then automatically updates brought-forward balances after an amendment", () => {
    printer();
    setSetting(db, SETTING_KEYS.taxJurisdiction, "MY");
    const scheme = value(
      saveAssetTaxScheme(ctx(), {
        familyKey: key(),
        expectedVersion: 0,
        requestKey: key(),
        definition: {
          name: "Machinery",
          jurisdiction: "MY",
          yearFrom: 2025,
          yearTo: null,
          method: "original_cost",
          firstYearRateBps: 2000,
          regularRateBps: 1400,
        },
      }),
    );
    function capital(d: Detail, used?: number) {
      const schedule = d.capital.schedule!;
      const rows = editorRows(schedule, d.worksheet);
      if (rows[0].form.treatment === "pending")
        Object.assign(rows[0].form, {
          treatment: "claim",
          schemeId: String(scheme.id),
          firstYearMode: "auto",
        });
      const uses =
        used === undefined
          ? editorUses(schedule, d.worksheet.ya)
          : [
              {
                source: "Main business",
                origin: String(d.worksheet.ya),
                balance: "0.00",
                used: (used / 100).toFixed(2),
              },
            ];
      const preview = editorPreview(
        schedule,
        rows,
        editorSchemes(d.capital.schemes),
        uses,
        "",
        d.worksheet,
        d.capital.firstYearContexts,
      );
      expect(preview.errors).toEqual([]);
      return {
        input: preview.input,
        liveAssetHash: d.capital.liveAssetHash,
        rolloverHash: d.capital.rolloverHash,
        confirmFirstYearTreatments: true,
      };
    }
    let prior = create();
    const financial = () =>
      JSON.stringify([
        db.select().from(schema.ledgerRecords).all(),
        db.select().from(schema.ledgerMovements).all(),
      ]);
    const before = financial();
    prior = value(
      saveTaxWorksheet(
        ctx(),
        prior.worksheet.id,
        payload(prior, { target: "finalised", capital: capital(prior, 50000) }),
      ),
    );
    expect(prior.capital.totals!.allowanceMinor).toBe(78166);
    expect(prior.capital.totals!.usedMinor).toBe(50000);
    expect(financial()).toBe(before);
    const frozenCsv = toCsv(taxWorksheetCsv(read(prior.worksheet.id, false)));
    setSetting(db, SETTING_KEYS.taxJurisdiction, "GB");
    const foreign = create(2099);
    expect(foreign.capital.rollover).toBeNull();
    expect(foreign.capital.schedule!.jurisdiction).toBe("GB");
    expect(foreign.capital.schedule!.rows[0].openingResidualMinor).toBeNull();
    setSetting(db, SETTING_KEYS.taxJurisdiction, "MY");
    let next = create(2026);
    expect(next.capital.autoPrepared).toBe(true);
    expect(next.capital.schedule!.rows[0].openingResidualMinor).toBe(151734);
    expect(next.capital.schedule!.utilisation[0].balanceMinor).toBe(28166);
    next = value(
      saveTaxWorksheet(
        ctx(),
        next.worksheet.id,
        payload(next, { capital: capital(next) }),
      ),
    );
    const oldRolloverHash = next.capital.rolloverHash;
    prior = value(
      changeTaxWorksheet(ctx(), prior.worksheet.id, {
        action: "amend",
        expectedVersion: prior.revision.version,
        requestKey: key(),
        reason: "Amend prior-year claim utilisation",
      }),
    );
    prior = value(
      saveTaxWorksheet(
        ctx(),
        prior.worksheet.id,
        payload(prior, { target: "finalised", capital: capital(prior, 0) }),
      ),
    );
    next = read(next.worksheet.id);
    expect(next.capital.autoRollover).toBe(true);
    expect(next.capital.schedule!.utilisation[0].balanceMinor).toBe(78166);
    const fresh = capital(next);
    const snapshot = state();
    expect(
      saveTaxWorksheet(
        ctx(),
        next.worksheet.id,
        payload(next, { capital: { ...fresh, rolloverHash: oldRolloverHash } }),
      ).ok,
    ).toBe(false);
    expect(state()).toBe(snapshot);
    next = value(
      saveTaxWorksheet(
        ctx(),
        next.worksheet.id,
        payload(next, { capital: fresh }),
      ),
    );
    expect(next.capital.predecessorStale).toBe(false);
    expect(next.capital.schedule!.utilisation[0].balanceMinor).toBe(78166);
    const old = value(readTaxWorksheet(ctx(), prior.worksheet.id, 1, false));
    expect(toCsv(taxWorksheetCsv(old))).toBe(frozenCsv);
    expect(financial()).toBe(before);
  });
  it("projects current bookkeeping without writing on read and retains saved export figures", () => {
    const original = create();
    const savedCsv = toCsv(taxWorksheetCsv(read(original.worksheet.id, false)));
    expense();
    const before = state();
    const latest = read(original.worksheet.id);
    expect(latest.totals.resultMinor).toBe(-10000);
    expect(latest.revision.snapshot.profitMinor).toBe(-10000);
    expect(latest.savedRevision.snapshot.profitMinor).toBe(0);
    expect(state()).toBe(before);
    expect(toCsv(taxWorksheetCsv(read(original.worksheet.id, false)))).toBe(
      savedCsv,
    );
  });

  it("saves the latest sources and staged adjustments together", () => {
    const original = create();
    expense();
    const latest = read(original.worksheet.id);
    const saved = value(
      saveTaxWorksheet(
        ctx(),
        latest.worksheet.id,
        payload(latest, {
          adjustments: [adjustment(latest)],
        }),
      ),
    );
    expect(saved.revision.status).toBe("draft");
    expect(saved.totals.resultMinor).toBe(-11000);
    const retained = read(original.worksheet.id, false);
    expect(retained.revision.snapshot.profitMinor).toBe(-10000);
    expect(retained.totals.resultMinor).toBe(-11000);
    expect(
      retained.adjustments.filter((a) => a.withdrawnAt === null),
    ).toHaveLength(1);
  });

  it("retains a changed-source correction as an unresolved draft until it is withdrawn or replaced", () => {
    const record = expense().record;
    let detail = create();
    detail = value(
      saveTaxWorksheet(
        ctx(),
        detail.worksheet.id,
        payload(detail, {
          adjustments: [
            {
              kind: "source",
              sourceMovementId: detail.totals.lines[0].movementId,
              percentageBps: 0,
              treatment: "non_deductible",
              reason: "Owner elected annual expense treatment",
              evidence: "Annual review",
              requestKey: key(),
              expectedVersion: detail.revision.version,
            },
          ],
        }),
      ),
    );
    const correctionId = detail.adjustments[0].id;
    value(
      updateRecord(ctx(), record.id, { description: "Changed source details" }),
    );
    detail = read(detail.worksheet.id);
    expect(detail.sourceConflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ adjustmentId: correctionId }),
      ]),
    );
    detail = value(
      saveTaxWorksheet(ctx(), detail.worksheet.id, payload(detail)),
    );
    expect(detail.revision.status).toBe("draft");
    expect(detail.sourceConflicts).toHaveLength(1);
    detail = value(
      saveTaxWorksheet(ctx(), detail.worksheet.id, payload(detail)),
    );
    expect(detail.sourceConflicts).toHaveLength(1);
    detail = value(
      changeTaxWorksheet(ctx(), detail.worksheet.id, {
        action: "refresh",
        expectedVersion: detail.revision.version,
        liveHash: detail.liveHash,
        reason: "Legacy refresh must retain unresolved annual correction",
      }),
    );
    expect(detail.sourceConflicts).toHaveLength(1);
    expect(
      changeTaxWorksheet(ctx(), detail.worksheet.id, {
        action: "review",
        expectedVersion: detail.revision.version,
      }).ok,
    ).toBe(false);
    const before = state();
    expect(
      saveTaxWorksheet(
        ctx(),
        detail.worksheet.id,
        payload(detail, { target: "finalised" }),
      ).ok,
    ).toBe(false);
    expect(state()).toBe(before);
    const finalised = value(
      saveTaxWorksheet(
        ctx(),
        detail.worksheet.id,
        payload(detail, {
          target: "finalised",
          withdrawals: [
            {
              adjustmentId: correctionId,
              reason: "Use current accounting treatment instead",
            },
          ],
        }),
      ),
    );
    expect(finalised.revision.status).toBe("finalised");
    expect(finalised.sourceConflicts).toHaveLength(0);
    expect(
      finalised.adjustments.find((a) => a.id === correctionId)?.withdrawnAt,
    ).not.toBeNull();
  });

  it("replaces a changed annual correction and finalises the replacement in the same save", () => {
    const record = expense().record;
    let detail = create();
    const source = {
      kind: "source",
      sourceMovementId: detail.totals.lines[0].movementId,
      percentageBps: 0,
      treatment: "non_deductible",
      reason: "Original annual expense decision",
      evidence: "Original review",
      requestKey: key(),
      expectedVersion: detail.revision.version,
    };
    detail = value(
      saveTaxWorksheet(
        ctx(),
        detail.worksheet.id,
        payload(detail, { adjustments: [source] }),
      ),
    );
    const oldId = detail.adjustments[0].id;
    value(
      updateRecord(ctx(), record.id, {
        description: "Updated source description",
      }),
    );
    detail = read(detail.worksheet.id);
    detail = value(
      saveTaxWorksheet(
        ctx(),
        detail.worksheet.id,
        payload(detail, {
          target: "finalised",
          adjustments: [
            {
              ...source,
              percentageBps: 10000,
              treatment: "ordinary_deductible",
              reason: "Replacement after source record changed",
              requestKey: key(),
              expectedVersion: detail.revision.version,
            },
          ],
        }),
      ),
    );
    expect(detail.revision.status).toBe("finalised");
    expect(detail.sourceConflicts).toHaveLength(0);
    expect(
      detail.adjustments.filter((a) => a.withdrawnAt === null),
    ).toHaveLength(1);
    expect(
      detail.adjustments.find((a) => a.id === oldId)?.withdrawnAt,
    ).not.toBeNull();
    expect(detail.totals.resultMinor).toBe(-10000);
  });

  it("rejects a staged correction against changed source facts even when the global live hash is current", () => {
    const record = expense().record;
    const original = create();
    const stagedCorrection = {
      kind: "source",
      sourceMovementId: original.totals.lines[0].movementId,
      percentageBps: 0,
      treatment: "non_deductible",
      reason: "Annual decision entered against old receipt",
      evidence: "Original receipt review",
      requestKey: key(),
      expectedVersion: original.revision.version,
    };
    value(
      updateRecord(ctx(), record.id, {
        description: "Receipt changed while editing annual correction",
      }),
    );
    const latest = read(original.worksheet.id);
    expect(latest.liveHash).not.toBe(original.liveHash);
    expect(
      latest.sourceHashes[String(stagedCorrection.sourceMovementId)],
    ).not.toBe(
      original.sourceHashes[String(stagedCorrection.sourceMovementId)],
    );
    const before = state();
    for (const target of ["draft", "finalised"]) {
      const result = saveTaxWorksheet(
        ctx(),
        latest.worksheet.id,
        payload(latest, {
          target,
          sourceHashes: original.sourceHashes,
          adjustments: [stagedCorrection],
        }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("CONFLICT");
      expect(state()).toBe(before);
    }
    const saved = value(
      saveTaxWorksheet(
        ctx(),
        latest.worksheet.id,
        payload(latest, {
          adjustments: [stagedCorrection],
        }),
      ),
    );
    expect(
      saved.adjustments.filter((a) => a.withdrawnAt === null),
    ).toHaveLength(1);
  });

  it("rolls back prepared assets, staged adjustments and child signals when scheme amounts are tampered", () => {
    const asset = printer();
    const scheme = value(
      saveAssetTaxScheme(ctx(), {
        familyKey: key(),
        expectedVersion: 0,
        requestKey: key(),
        reason: "Create custom test machinery scheme",
        definition: {
          name: "Machinery",
          jurisdiction: "MY",
          yearFrom: 2025,
          yearTo: null,
          method: "original_cost",
          firstYearRateBps: 2000,
          regularRateBps: 1400,
          remark: "Custom unverified scheme",
        },
      }),
    );
    const detail = create();
    const row = {
      ...detail.capital.schedule!.rows.find((r) => r.assetId === asset.id)!,
      treatment: "claim",
      schemeId: scheme.id,
      appliedScheme: schemeSnapshot(scheme),
      schemeFirstYear: true,
      taxClass: "Machinery",
      businessSource: "Trading",
      businessUseBps: 10000,
      qualifyingMinor: 229900,
      openingResidualMinor: 0,
      additionsMinor: 229900,
      initialMinor: 45980,
      annualMinor: 32187,
    };
    const before = state();
    let emitted = 0;
    const listener = () => emitted++;
    taxWorksheetEvents.on("changed", listener);
    try {
      const result = saveTaxWorksheet(
        ctx(),
        detail.worksheet.id,
        payload(detail, {
          adjustments: [adjustment(detail)],
          capital: {
            input: {
              jurisdiction: "MY",
              rows: [row],
              utilisation: [],
              evidence: "Custom machinery workings",
            },
            liveAssetHash: detail.capital.liveAssetHash,
            confirmFirstYearTreatments: true,
          },
        }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("scheme calculation");
      expect(state()).toBe(before);
      expect(emitted).toBe(0);
    } finally {
      taxWorksheetEvents.off("changed", listener);
    }
  });

  it("refuses malformed worksheet IDs without database changes", () => {
    const detail = create();
    const before = state();
    for (const id of [NaN, Infinity, -1, 0, 1.5]) {
      expect(saveTaxWorksheet(ctx(), id, payload(detail)).ok).toBe(false);
      expect(state()).toBe(before);
    }
  });

  it("allows an incomplete asset schedule to be saved as draft without a separate prepare command", () => {
    const cost = value(
      createAccount(db, 1, {
        name: "Equipment",
        type: AccountType.Asset,
        subType: AccountSubType.FixedAsset,
      }),
    ).id;
    const asset = value(
      registerFixedAsset(ctx(), {
        name: "Printer",
        assetType: "Machinery",
        sourceMovementId: null,
        acquisitionDate: "2025-06-01",
        inServiceDate: "2025-06-01",
        assetAccountId: cost,
        costMinor: 229900,
        openingAsAt: "2025-06-01",
        broughtForwardDepMinor: 0,
        openingRecordId: null,
        documentReference: "Printer receipt",
      }),
    );
    const detail = create();
    expect(detail.capital.active).toBe(true);
    expect(detail.capital.autoPrepared).toBe(true);
    expect(db.select().from(schema.taxCapitalSchedules).all()).toHaveLength(0);
    const schedule = detail.capital.schedule!;
    expect(schedule.rows.find((r) => r.assetId === asset.id)?.treatment).toBe(
      "pending",
    );
    const saved = value(
      saveTaxWorksheet(
        ctx(),
        detail.worksheet.id,
        payload(detail, {
          capital: {
            input: {
              jurisdiction: "MY",
              rows: schedule.rows,
              utilisation: schedule.utilisation,
              evidence: schedule.evidence,
            },
            liveAssetHash: detail.capital.liveAssetHash,
            confirmFirstYearTreatments: true,
          },
        }),
      ),
    );
    expect(saved.revision.status).toBe("draft");
    expect(saved.capital.totals?.problems.length).toBeGreaterThan(0);
    expect(db.select().from(schema.taxCapitalSchedules).all()).toHaveLength(1);
    const before = state();
    expect(
      saveTaxWorksheet(
        ctx(),
        saved.worksheet.id,
        payload(saved, { target: "finalised" }),
      ).ok,
    ).toBe(false);
    expect(state()).toBe(before);
  });

  it("saves, reviews and finalises in one action and preserves the completed snapshot after records change", () => {
    expense();
    const detail = create();
    const saved = value(
      saveTaxWorksheet(
        ctx(),
        detail.worksheet.id,
        payload(detail, {
          target: "finalised",
          adjustments: [adjustment(detail)],
        }),
      ),
    );
    expect(saved.revision.status).toBe("finalised");
    expect(saved.revision.reviewedBy).toBe(1);
    expect(saved.revision.finalisedBy).toBe(1);
    expect(saved.totals.resultMinor).toBe(-11000);
    const csv = toCsv(taxWorksheetCsv(saved));
    expense(200);
    const retained = read(detail.worksheet.id);
    expect(retained.totals.resultMinor).toBe(-11000);
    expect(toCsv(taxWorksheetCsv(retained))).toBe(csv);
  });

  it("keeps a retry idempotent and refuses the request key with a different payload", () => {
    const detail = create();
    const command = payload(detail, { adjustments: [adjustment(detail)] });
    const saved = value(saveTaxWorksheet(ctx(), detail.worksheet.id, command));
    const before = state();
    const replay = value(saveTaxWorksheet(ctx(), detail.worksheet.id, command));
    expect(replay.revision.version).toBe(saved.revision.version);
    expect(state()).toBe(before);
    expect(
      saveTaxWorksheet(ctx(), detail.worksheet.id, {
        ...command,
        target: "reviewed",
      }).ok,
    ).toBe(false);
    expect(state()).toBe(before);
  });

  it("shows reviewed work as a draft when bookkeeping changes and persists that transition on save", () => {
    const original = create();
    const reviewed = value(
      saveTaxWorksheet(
        ctx(),
        original.worksheet.id,
        payload(original, { target: "reviewed" }),
      ),
    );
    expect(reviewed.revision.status).toBe("reviewed");
    expense();
    const before = state();
    const working = read(original.worksheet.id);
    expect(working.revision.status).toBe("draft");
    expect(working.savedRevision.status).toBe("reviewed");
    expect(state()).toBe(before);
    const saved = value(
      saveTaxWorksheet(ctx(), original.worksheet.id, payload(working)),
    );
    expect(saved.revision.status).toBe("draft");
    expect(read(original.worksheet.id, false).revision.status).toBe("draft");
    expect(read(original.worksheet.id, false).revision.reviewedAt).toBeNull();
  });

  it("rolls back the entire staged save and emits nothing when completion fails", () => {
    const detail = create(2099);
    const before = state();
    let emitted = 0;
    const listener = () => emitted++;
    taxWorksheetEvents.on("changed", listener);
    try {
      const result = saveTaxWorksheet(
        ctx(),
        detail.worksheet.id,
        payload(detail, {
          target: "finalised",
          adjustments: [adjustment(detail)],
        }),
      );
      expect(result.ok).toBe(false);
      expect(state()).toBe(before);
      expect(emitted).toBe(0);
    } finally {
      taxWorksheetEvents.off("changed", listener);
    }
  });

  it("requires update, review and finalise authority for combined completion, including a signed-in session", () => {
    const detail = create();
    const command = payload(detail, {
      target: "finalised",
      adjustments: [adjustment(detail)],
    });
    const before = state();
    for (const permissions of [
      ["tax.read", "tax.finalise"],
      ["tax.read", "tax.update", "tax.finalise"],
      ["tax.read", "tax.review", "tax.finalise"],
      ["tax.read", "tax.update", "tax.review"],
    ]) {
      expect(
        saveTaxWorksheet(ctx(permissions), detail.worksheet.id, command).ok,
      ).toBe(false);
      expect(state()).toBe(before);
    }
    const credential = ctx();
    credential.locals.credential = { kind: "pat", tokenId: 1 };
    expect(saveTaxWorksheet(credential, detail.worksheet.id, command).ok).toBe(
      false,
    );
    expect(state()).toBe(before);
    const reviewed = value(
      saveTaxWorksheet(
        ctx(["tax.read", "tax.update", "tax.review"]),
        detail.worksheet.id,
        {
          ...command,
          target: "reviewed",
        },
      ),
    );
    expect(reviewed.revision.status).toBe("reviewed");
  });

  it("refuses stale source hashes and worksheet versions without partial writes", () => {
    const detail = create();
    expense();
    const before = state();
    expect(
      saveTaxWorksheet(
        ctx(),
        detail.worksheet.id,
        payload(detail, { adjustments: [adjustment(detail)] }),
      ).ok,
    ).toBe(false);
    expect(state()).toBe(before);
    const latest = read(detail.worksheet.id);
    value(saveTaxWorksheet(ctx(), latest.worksheet.id, payload(latest)));
    const after = state();
    expect(
      saveTaxWorksheet(ctx(), latest.worksheet.id, payload(latest)).ok,
    ).toBe(false);
    expect(state()).toBe(after);
  });
});
