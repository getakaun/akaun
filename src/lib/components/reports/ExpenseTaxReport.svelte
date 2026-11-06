<script lang="ts">
  import { resolve } from "$app/paths";
  import { goto } from "$app/navigation";
  import { formatMinor } from "$lib/format.js";
  import { TaxTreatmentLabels } from "$lib/expense-tax.js";
  import type { ExpenseTaxReport } from "$lib/server/queries/expense-tax-report.js";
  function filterHref(reviewOnly: boolean) {
    return `${resolve("/(app)/reports/[view]", { view: "expense-tax" })}?${new URLSearchParams({ from: report.dateFrom, to: report.dateTo, ...(reviewOnly ? { review: "unresolved" } : {}), ...(report.accountId === null ? {} : { account: String(report.accountId) }) })}`;
  }
  let {
    report,
    accounts,
  }: { report: ExpenseTaxReport; accounts: { id: number; name: string }[] } =
    $props();
  async function changeAccount(value: string) {
    const params = new URLSearchParams({
      from: report.dateFrom,
      to: report.dateTo,
      ...(report.reviewOnly ? { review: "unresolved" } : {}),
      ...(value ? { account: value } : {}),
    });
    /* eslint-disable svelte/no-navigation-without-resolve -- resolved report route plus filter values. */
    await goto(
      `${resolve("/(app)/reports/[view]", { view: "expense-tax" })}?${params}`,
      { noScroll: true, keepFocus: true },
    );
    /* eslint-enable svelte/no-navigation-without-resolve */
  }
</script>

<section class="detail-card">
  <div class="detail-card-head">
    <span class="detail-card-title">Expense tax estimates</span>
  </div>
  <p class="notice">{report.note}</p>
  {#if report.unresolvedLineCount > 0}
    <p class="review-warning" role="status">
      Needs tax review: {report.unresolvedLineCount} expense lines ({formatMinor(
        report.unresolvedMinor,
      )} net). Review every line, even when the net amount is zero. Each unresolved
      line must be classified before closing its period; already closed entries require
      reopening to edit.
    </p>
  {/if}
  <!-- eslint-disable svelte/no-navigation-without-resolve -- filterHref resolves the route and appends only date/review query values. -->
  <nav class="filters" aria-label="Expense tax review filter">
    <a
      href={filterHref(false)}
      aria-current={!report.reviewOnly ? "page" : undefined}
      >All expense lines</a
    >
    <a
      href={filterHref(true)}
      aria-current={report.reviewOnly ? "page" : undefined}
      >Needs tax review ({report.unresolvedLineCount})</a
    >
  </nav>
  <!-- eslint-enable svelte/no-navigation-without-resolve -->
  <div class="filters">
    <label for="tax-account">Expense account</label><select
      id="tax-account"
      class="rounded-md border bg-background px-2 py-1 text-sm"
      value={report.accountId ?? ""}
      onchange={(event) => void changeAccount(event.currentTarget.value)}
      ><option value="">All expense accounts</option
      >{#each accounts as account (account.id)}<option value={account.id}
          >{account.name} · #{account.id}</option
        >{/each}</select
    >
  </div>
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
                ? TaxTreatmentLabels[
                    row.classification?.treatment ?? "unclassified"
                  ]
                : formatMinor(row.deductibleMinor)}</td
            >
            <td
              >{row.addBackMinor === null
                ? TaxTreatmentLabels[
                    row.classification?.treatment ?? "unclassified"
                  ]
                : formatMinor(row.addBackMinor)}</td
            >
            <td
              >{row.classification?.percentageBps == null
                ? "—"
                : `${(row.classification.percentageBps / 100).toFixed(2)}%`} · {TaxTreatmentLabels[
                row.classification?.treatment ?? "unclassified"
              ]}<br /><small
                >{row.reviewRequired
                  ? "Needs tax review"
                  : row.voided
                    ? "Voided — no review needed"
                    : "Estimate"} · {row.classification?.source === "override"
                  ? "Override"
                  : row.classification?.source === "account_default"
                    ? "Saved account default"
                    : "Unclassified"}{row.classification?.reason
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
  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    padding: 1rem;
  }
  .filters a[aria-current="page"] {
    font-weight: 600;
  }
  .review-warning {
    margin: 1rem;
    padding: 0.75rem;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    background: var(--orange-soft, var(--muted));
  }

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
