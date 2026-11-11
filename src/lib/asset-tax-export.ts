import { capitalTotals, type CapitalSchedule } from "./capital-allowance.js";
import { taxDecimal } from "./tax-worksheet.js";
import { taxJurisdictionLabel } from "./asset-tax-scheme.js";
/** Fully labelled retained workings shared by CSV and print; never reads live assets. */
export function capitalExportLines(
  schedule: CapitalSchedule,
  active: boolean,
  ya: number,
  dateFrom: string,
  dateTo: string,
): [string, string][] {
  const totals = capitalTotals(schedule, ya, dateFrom, dateTo);
  const amount = (n: number | null) =>
    n === null ? "Unreviewed" : taxDecimal(n);
  const lines: [string, string][] = [
    [
      "Mode",
      active ? "Asset schedule" : "Retained schedule; manual totals active",
    ],
    [
      "Calculation",
      schedule.calculationVersion === 1
        ? "Version 1; manually reviewed MYR amounts; no statutory rate engine"
        : `Version 2; ${schedule.currency}; custom arithmetic; not jurisdiction-verified`,
    ],
    ["Shared working-paper reference", schedule.evidence],
    ["Allowances available", amount(totals.allowanceMinor)],
    ["Allowances utilised", amount(totals.usedMinor)],
    ["Balancing charges", amount(totals.balancingChargeMinor)],
    ["Unabsorbed allowances carried forward", amount(totals.carryForwardMinor)],
    ["Predecessor evidence", JSON.stringify(schedule.predecessor)],
  ];
  if (schedule.calculationVersion === 2)
    lines.push([
      "Tax jurisdiction",
      taxJurisdictionLabel(schedule.jurisdiction),
    ]);
  for (const r of totals.rows) {
    const prefix = `${r.asset.name} (FA-${r.assetId})`;
    const fields: [string, string][] = [
      ["Treatment", r.treatment],
      ["Tax class", r.taxClass],
      ["Business source", r.businessSource],
      [
        "Qualifying expenditure before business-use adjustment",
        amount(r.qualifyingMinor),
      ],
      [
        "Business use",
        r.businessUseBps === null ? "Unreviewed" : `${r.businessUseBps / 100}%`,
      ],
      ["Opening tax residual", amount(r.openingResidualMinor)],
      [
        "Qualifying additions (business-use adjusted)",
        amount(r.additionsMinor),
      ],
      [
        schedule.calculationVersion === 1 || schedule.jurisdiction === "MY"
          ? "Initial allowance"
          : "First-year deduction",
        amount(r.initialMinor),
      ],
      [
        schedule.calculationVersion === 1 || schedule.jurisdiction === "MY"
          ? "Annual allowance"
          : "Regular deduction",
        amount(r.annualMinor),
      ],
      ["Residual expenditure adjustment", amount(r.residualAdjustmentMinor)],
      ["Closing tax residual", amount(r.closingResidualMinor)],
      ["Tax residual removed on full disposal", amount(r.residualRemovedMinor)],
      ["Reason / notes", r.note],
      ["Rule / evidence reference", r.ruleReference],
      ["Effective YA", String(r.effectiveYa)],
      ["Asset and purchase evidence", JSON.stringify(r.asset)],
    ];
    if (r.appliedScheme)
      fields.push(
        [
          "Applied custom scheme",
          `${r.appliedScheme.definition.name} · v${r.appliedScheme.version}`,
        ],
        ["Scheme definition (retained)", JSON.stringify(r.appliedScheme)],
        ["Apply first-year deduction", r.schemeFirstYear ? "Yes" : "No"],
        ["Manual override", r.schemeOverride ? "Yes — see notes" : "No"],
      );
    if (r.disposal)
      fields.push(
        ["Disposal date", r.disposal.date],
        ["Disposal proceeds", amount(r.disposal.proceedsMinor)],
        ["Balancing allowance", amount(r.disposal.balancingAllowanceMinor)],
        ["Balancing charge", amount(r.disposal.balancingChargeMinor)],
        ["Disposal evidence", r.disposal.evidence],
        [
          "Book disposal",
          "Tax evidence only; book disposal and stopping depreciation require separate accounting attention.",
        ],
      );
    lines.push(
      ...fields.map(([label, value]): [string, string] => [
        `${prefix} · ${label}`,
        value,
      ]),
    );
  }
  for (const u of schedule.utilisation)
    lines.push(
      [
        `${u.businessSource} · origin YA ${u.originYa} · available balance`,
        amount(u.balanceMinor),
      ],
      [
        `${u.businessSource} · origin YA ${u.originYa} · utilisation`,
        amount(u.usedMinor),
      ],
      [
        `${u.businessSource} · origin YA ${u.originYa} · unabsorbed balance`,
        amount(u.balanceMinor - u.usedMinor),
      ],
    );
  lines.push(
    ...totals.problems.map((problem): [string, string] => [
      "Needs review",
      problem,
    ]),
  );
  return lines;
}
