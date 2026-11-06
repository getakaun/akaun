<script lang="ts">
  import { resolve } from "$app/paths";
  import { goto, invalidateAll } from "$app/navigation";
  import { onMount, untrack } from "svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import BulkTaxDialog from "$lib/components/tax/BulkTaxDialog.svelte";
  import { BULK_TAX_LIMIT } from "$lib/bulk-expense-tax.js";
  import { getClosingBoundary } from "$lib/closing-context.js";
  import {
    taxLineSelectable,
    selectTaxPage,
    toggleTaxSelection,
  } from "$lib/components/tax/bulk-tax-selection.js";
  import { formatMinor } from "$lib/format.js";
  import { TaxTreatmentLabels } from "$lib/expense-tax.js";
  import type { ExpenseTaxReport } from "$lib/server/queries/expense-tax-report.js";
  function filterHref(reviewOnly: boolean) {
    return `${resolve("/(app)/reports/[view]", { view: "expense-tax" })}?${new URLSearchParams({ from: report.dateFrom, to: report.dateTo, ...(reviewOnly ? { review: "unresolved" } : {}), ...(report.accountId === null ? {} : { account: String(report.accountId) }) })}`;
  }
  let {
    report,
    accounts,
    canBulk = false,
    closedThrough = null,
  }: {
    report: ExpenseTaxReport;
    accounts: { id: number; name: string }[];
    canBulk?: boolean;
    closedThrough?: string | null;
  } = $props();
  const boundary = getClosingBoundary();
  const liveBoundary = $derived(
    boundary === undefined ? closedThrough : boundary.closedThrough,
  );
  let selected = $state<number[]>([]);
  let page = $state(0);
  let scope = $state("");
  let bulkOpen = $state(false);
  let selectionAtOpen = $state<number[]>([]);
  let success = $state("");
  const pageSize = 50;
  const pageCount = $derived(
    Math.max(1, Math.ceil(report.rows.length / pageSize)),
  );
  const pageRows = $derived(
    report.rows.slice(page * pageSize, (page + 1) * pageSize),
  );
  function selectable(row: ExpenseTaxReport["rows"][number]) {
    return canBulk && taxLineSelectable(row, liveBoundary);
  }
  function toggle(id: number, checked: boolean) {
    selected = toggleTaxSelection(selected, id, checked);
    success = "";
  }
  function selectPage() {
    selected = selectTaxPage(selected, pageRows, liveBoundary);
    success = "";
  }
  $effect(() => {
    const next = `${report.dateFrom}:${report.dateTo}:${report.accountId}:${report.reviewOnly}`;
    const eligible = new Set(
      report.rows.filter(selectable).map((row) => row.movementId),
    );
    if (scope !== next) {
      scope = next;
      selected = [];
      page = 0;
    } else {
      selected = untrack(() => selected).filter((id) => eligible.has(id));
      if (page >= pageCount) page = pageCount - 1;
    }
  });
  async function changeAccount(value: string) {
    const params = new URLSearchParams({
      from: report.dateFrom,
      to: report.dateTo,
      ...(report.reviewOnly ? { review: "unresolved" } : {}),
      ...(value ? { account: value } : {}),
    });
    /* eslint-disable svelte/no-navigation-without-resolve -- resolved route plus account/date filters only. */
    await goto(
      `${resolve("/(app)/reports/[view]", { view: "expense-tax" })}?${params}`,
      { noScroll: true, keepFocus: true },
    );
    /* eslint-enable svelte/no-navigation-without-resolve */
  }
  onMount(() => {
    if (!canBulk) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const source = new EventSource("/api/records/stream");
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        void invalidateAll();
      }, 80);
    };
    source.addEventListener("record-update", refresh);
    source.addEventListener("record-deleted", refresh);
    return () => {
      source.close();
      clearTimeout(timer);
    };
  });
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
    <label for="tax-account">Expense account</label>
    <select
      id="tax-account"
      value={report.accountId ?? ""}
      onchange={(event) => void changeAccount(event.currentTarget.value)}
      class="rounded-md border bg-background px-2 py-1 text-sm"
    >
      <option value="">All expense accounts</option>
      {#each accounts as account (account.id)}<option value={account.id}
          >{account.name} · #{account.id}</option
        >{/each}
    </select>
  </div>
  {#if canBulk}
    <div class="bulk-toolbar">
      <Button variant="outline" size="sm" onclick={selectPage}
        >Select eligible lines on this page</Button
      >
      <Button
        variant="ghost"
        size="sm"
        disabled={selected.length === 0}
        onclick={() => {
          selected = [];
        }}>Clear selection</Button
      >
      <span>{selected.length} / {BULK_TAX_LIMIT} selected across pages</span>
      <Button
        size="sm"
        disabled={selected.length === 0}
        onclick={() => {
          selectionAtOpen = [...selected];
          bulkOpen = true;
        }}>Classify selected</Button
      >
      <p class="selection-note">
        Page selection preserves manual overrides. Select a manually flagged
        review line individually to resolve it. Closed and resolved lines cannot
        be selected.
      </p>
    </div>
  {/if}
  {#if success}<p class="review-warning" role="status">{success}</p>{/if}
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
          >{#if canBulk}<th><span class="sr-only">Select expense line</span></th
            >{/if}<th>Date / record</th><th>Expense line</th><th>Expense</th><th
            >Potential deduction</th
          ><th>Potential add-back</th><th>Saved classification</th></tr
        ></thead
      >
      <tbody>
        {#each pageRows as row (row.movementId)}
          <tr>
            {#if canBulk}<td
                ><input
                  type="checkbox"
                  aria-label={`Select ${row.accountName}, ${row.label ?? row.description}, ${row.date}, line ${row.movementId}`}
                  checked={selected.includes(row.movementId)}
                  disabled={!selectable(row) ||
                    (selected.length >= BULK_TAX_LIMIT &&
                      !selected.includes(row.movementId))}
                  onchange={(event) =>
                    toggle(row.movementId, event.currentTarget.checked)}
                /></td
              >{/if}
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
                >{row.reviewRequired
                  ? row.classification?.source === "override"
                    ? "Manually marked for review"
                    : "Needs tax review"
                  : row.voided
                    ? "Voided — no review needed"
                    : "Estimate"} · {row.classification?.source === "override"
                  ? "Override"
                  : row.classification?.source === "account_default"
                    ? "Saved account default"
                    : "Unreviewed"}{row.classification?.reason
                  ? ` · ${row.classification.reason}`
                  : ""}</small
              >{#if liveBoundary && row.date <= liveBoundary}<br /><small
                  >Month closed — reopen to classify</small
                >{/if}</td
            >
          </tr>
        {:else}<tr
            ><td colspan={canBulk ? 7 : 6}
              >No expense movements in this period.</td
            ></tr
          >{/each}
      </tbody>
    </table>
  </div>
  <div class="bulk-toolbar" aria-label="Expense tax report pages">
    <Button
      variant="outline"
      size="sm"
      disabled={page === 0}
      onclick={() => {
        page--;
      }}>Previous</Button
    >
    <span>Page {page + 1} of {pageCount} · {report.rows.length} lines</span>
    <Button
      variant="outline"
      size="sm"
      disabled={page + 1 >= pageCount}
      onclick={() => {
        page++;
      }}>Next</Button
    >
  </div>
</section>

{#if bulkOpen}
  <BulkTaxDialog
    movementIds={selectionAtOpen}
    dateFrom={report.dateFrom}
    dateTo={report.dateTo}
    accountId={report.accountId}
    onclose={() => {
      bulkOpen = false;
    }}
    onapplied={(result) => {
      bulkOpen = false;
      selected = [];
      success = `Classified ${result.updatedLineCount} lines across ${result.updatedRecordCount} records. Refresh the month-closing checks when all remaining review lines are resolved.`;
      void invalidateAll();
    }}
  />
{/if}

<style>
  .bulk-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.65rem;
    padding: 1rem;
    font-size: 0.8rem;
  }
  .selection-note {
    flex-basis: 100%;
    margin: 0;
    color: var(--muted-foreground);
  }
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
