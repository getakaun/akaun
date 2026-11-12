import { capitalTotals, type CapitalSchedule } from "./capital-allowance.js";
import { taxDecimal } from "./tax-worksheet.js";
import { taxJurisdictionLabel } from "./asset-tax-scheme.js";
/** Fully labelled retained workings shared by CSV and print; never reads live assets. */
export function capitalExportLines(
  schedule: CapitalSchedule,
  ya: number,
): [string, string][] {
  const totals = capitalTotals(schedule, ya);
  const amount = (n: number | null) =>
    n === null ? "Unreviewed" : taxDecimal(n);
  const lines: [string, string][] = [
    ["Calculation", `${schedule.currency}; scheme calculations`],
    ["Tax jurisdiction", taxJurisdictionLabel(schedule.jurisdiction)],
    ["Shared working-paper reference", schedule.evidence],
    ["Allowances available", amount(totals.allowanceMinor)],
    ["Allowances utilised", amount(totals.usedMinor)],
    ["Unabsorbed allowances carried forward", amount(totals.carryForwardMinor)],
    ["Predecessor evidence", JSON.stringify(schedule.predecessor)],
  ];
  if (schedule.utilisationPolicy) {
    lines.push(
      [
        "Utilisation policy (retained)",
        JSON.stringify(schedule.utilisationPolicy),
      ],
      [
        "Income and utilisation evidence (retained)",
        JSON.stringify(schedule.utilisationEvidence),
      ],
    );
    for (const g of schedule.utilisationEvidence?.groups ?? [])
      lines.push(
        [
          `${g.businessSource} · income available for allowances`,
          amount(g.capacityMinor),
        ],
        [`${g.businessSource} · income basis`, g.basis],
        [
          `${g.businessSource} · not claimed / restricted`,
          amount(g.restrictedMinor),
        ],
      );
  }
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
        schedule.jurisdiction === "MY"
          ? "Initial allowance"
          : "First-year deduction",
        amount(r.initialMinor),
      ],
      [
        schedule.jurisdiction === "MY"
          ? "Annual allowance"
          : "Regular deduction",
        amount(r.annualMinor),
      ],
      ["Residual expenditure adjustment", amount(r.residualAdjustmentMinor)],
      ["Closing tax residual", amount(r.closingResidualMinor)],
      ["Reason / notes", r.note],
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
        amount(u.balanceMinor - u.usedMinor - (u.restrictedMinor ?? 0)),
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
