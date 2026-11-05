<script lang="ts">
  import { resolve } from "$app/paths";
  import { formatMinor } from "$lib/format.js";
  import { TaxTreatmentLabels } from "$lib/expense-tax.js";
  import type { ExpenseTaxReport } from "$lib/server/queries/expense-tax-report.js";
  let { report }: { report: ExpenseTaxReport } = $props();
</script>

<section class="detail-card">
  <div class="detail-card-head">
    <span class="detail-card-title">Expense tax estimates</span>
  </div>
  <p class="notice">{report.note}</p>
  <dl class="totals">
    <div>
      <dt>Expense</dt>
      <dd>{formatMinor(report.expenseMinor)}</dd>
    </div>
    <div>
      <dt>Potential deduction</dt>
      <dd>{formatMinor(report.deductibleMinor)}</dd>
    </div>
    <div>
      <dt>Potential add-back</dt>
      <dd>{formatMinor(report.addBackMinor)}</dd>
    </div>
    <div>
      <dt>Unresolved ({report.unresolvedLineCount} lines)</dt>
      <dd>{formatMinor(report.unresolvedMinor)}</dd>
    </div>
  </dl>
  <div class="table-scroll">
    <table>
      <thead
        ><tr
          ><th>Date / record</th><th>Expense line</th><th>Expense</th><th
            >Potential deduction</th
          ><th>Potential add-back</th><th>Saved classification</th></tr
        ></thead
      >
      <tbody>
        {#each report.rows as row (row.movementId)}
          <tr>
            <td
              ><a
                href={resolve("/(app)/records/[id]", {
                  id: String(row.recordId),
                })}>{row.date}<br />{row.recordNumber ?? `#${row.recordId}`}</a
              ></td
            >
            <td
              >{row.accountName}<br /><small
                >{row.label ?? row.description}</small
              ></td
            >
            <td>{formatMinor(row.expenseMinor)}</td>
            <td
              >{row.deductibleMinor === null
                ? "Unreviewed"
                : formatMinor(row.deductibleMinor)}</td
            >
            <td
              >{row.addBackMinor === null
                ? "Unreviewed"
                : formatMinor(row.addBackMinor)}</td
            >
            <td
              >{row.classification?.percentageBps == null
                ? "Unreviewed"
                : `${(row.classification.percentageBps / 100).toFixed(2)}%`} · {TaxTreatmentLabels[
                row.classification?.treatment ?? "requires_review"
              ]}<br /><small
                >{row.reviewStatus === "estimate" ? "Estimate" : "Unreviewed"} · {row
                  .classification?.source === "override"
                  ? "Override"
                  : row.classification?.source === "account_default"
                    ? "Saved account default"
                    : "Unreviewed"}{row.classification?.reason
                  ? ` · ${row.classification.reason}`
                  : ""}</small
              ></td
            >
          </tr>
        {:else}<tr><td colspan="6">No expense movements in this period.</td></tr
          >{/each}
      </tbody>
    </table>
  </div>
</section>

<style>
  .notice {
    margin: 1rem;
    color: var(--muted-foreground);
    font-size: 0.875rem;
  }
  .totals {
    display: flex;
    flex-wrap: wrap;
    gap: 1.5rem;
    padding: 1rem;
  }
  dt {
    font-size: 0.8rem;
    color: var(--muted-foreground);
  }
  dd {
    margin: 0.25rem 0;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }
  .table-scroll {
    overflow-x: auto;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.875rem;
  }
  th,
  td {
    text-align: left;
    vertical-align: top;
    padding: 0.8rem;
    border-top: 1px solid var(--border);
  }
  th {
    font-weight: 500;
  }
  small {
    color: var(--muted-foreground);
  }
  a {
    text-decoration: underline;
  }
</style>
