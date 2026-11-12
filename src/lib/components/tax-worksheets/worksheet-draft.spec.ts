import { describe, it, expect } from "vitest";
import {
  changedStagedSources,
  draftTotals,
  stagedAdjustments,
  type StagedAdjustment,
  type CapitalDraft,
} from "./worksheet-draft.js";
import type { TaxWorksheetDetail as Detail } from "$lib/server/queries/tax-worksheets.js";

const manual: StagedAdjustment = {
  kind: "capital_allowance",
  direction: "decrease",
  amountMinor: 1000,
  balanceMinor: 0,
  originYa: null,
  reason: "Reviewed manual tax allowance",
  evidence: "Working paper",
  requestKey: "f5b05d41-70a9-4cf5-a5b3-64580f2ca678",
  expectedVersion: 1,
};
const source: StagedAdjustment = {
  kind: "source",
  sourceMovementId: 4,
  treatment: "non_deductible",
  percentageBps: 0,
  reason: "Annual expense classification",
  evidence: "Working paper",
  requestKey: "365c9ef8-d9ee-4543-9993-fe6cfec117d3",
  expectedVersion: 1,
};
const detail = {
  revision: {
    id: 1,
    snapshot: {
      calculationVersion: 1,
      profitMinor: 10000,
      expenses: [],
      notes: [],
    },
  },
  adjustments: [{ ...manual, id: 3, revisionId: 1, withdrawnAt: null }],
  capital: { active: false, totals: null },
} as unknown as Detail;

describe("worksheet draft projection", () => {
  it("replaces manual totals in the preview without subtracting both allowance claims", () => {
    const capital = { totals: { effectMinor: -3000 } } as CapitalDraft;
    expect(draftTotals(detail, [], [], null).resultMinor).toBe(9000);
    expect(draftTotals(detail, [], [], capital, true).resultMinor).toBe(7000);
    expect(stagedAdjustments(detail, [], [], true)[0].withdrawnAt).toBe(
      "pending",
    );
    expect(detail.adjustments[0].withdrawnAt).toBeNull();
  });
  it("flags only edited expense decisions whose captured accounting facts changed or disappeared", () => {
    const staged = [source, manual];
    expect(
      changedStagedSources(
        staged,
        { "4": "old" },
        { "4": "old", "5": "new unrelated expense" },
      ),
    ).toEqual([]);
    expect(
      changedStagedSources(
        staged,
        { "4": "old" },
        { "4": "new receipt details" },
      ),
    ).toEqual([source]);
    expect(changedStagedSources(staged, { "4": "old" }, {})).toEqual([source]);
    expect(staged).toEqual([source, manual]);
  });
});
