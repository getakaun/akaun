<script lang="ts">
  import { invalidateAll } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { onMount, onDestroy } from "svelte";
  import { TriangleAlert } from "@lucide/svelte";
  import EmptyState from "$lib/components/ui/EmptyState.svelte";
  import { formatDate, formatMinor } from "$lib/format.js";
  import {
    balanceSheetHref,
    cashFlowHref,
    profitLossHref,
  } from "$lib/components/reports/report-links.js";
  import PeriodControl from "$lib/components/dashboard/PeriodControl.svelte";
  import KpiTile from "$lib/components/dashboard/KpiTile.svelte";
  import Sparkline from "$lib/components/dashboard/Sparkline.svelte";
  import MonthlyChart from "$lib/components/dashboard/MonthlyChart.svelte";
  import CashChart from "$lib/components/dashboard/CashChart.svelte";
  import CashBridge from "$lib/components/dashboard/CashBridge.svelte";
  import AgeingBar from "$lib/components/dashboard/AgeingBar.svelte";
  import TopLines from "$lib/components/dashboard/TopLines.svelte";
  import OwedSidePanel from "$lib/components/dashboard/OwedSidePanel.svelte";
  import PipelinePanel from "$lib/components/dashboard/PipelinePanel.svelte";
  import AttentionList from "$lib/components/dashboard/AttentionList.svelte";
  import RecentActivity from "$lib/components/dashboard/RecentActivity.svelte";
  import "$lib/components/dashboard/dashboard.css";
  import type { PageData } from "./$types.js";

  /**
   * How the business is doing (007). Every money figure is a report
   * function's own output for the dates shown, and links to that report
   * (005 FR-014, FR-015, carried forward by 007 FR-001/FR-002). A section the
   * user may not read arrives as null and is left out (FR-013).
   */
  let { data }: { data: PageData } = $props();

  const period = $derived(data.period);
  const current = $derived(data.period.current);

  function pctText(fraction: number | null): string {
    return fraction === null ? "" : `${(fraction * 100).toFixed(1).replace(/\.0$/, "")}%`;
  }

  const owedHref = $derived(
    data.owed?.canOpenContacts
      ? resolve("/(app)/contacts")
      : `${resolve("/(app)/records")}?status=owed`,
  );

  // SSE — push-to-refresh: the server signals when anything the figures read changes.
  let es: EventSource | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;

  onMount(() => {
    es = new EventSource("/api/dashboard/stream");
    es.onmessage = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => invalidateAll(), 500);
    };
  });
  onDestroy(() => {
    es?.close();
    if (debounce) clearTimeout(debounce);
  });
</script>

<svelte:head>
  <title>Dashboard - Akaun</title>
</svelte:head>

<div class="screen">
  <header class="topbar">
    <div class="topbar-left">
      <h1 class="page-title">Dashboard</h1>
      <p class="page-sub">Welcome back, {data.user?.username}</p>
    </div>
  </header>

  <div class="dash-scroll">
    <PeriodControl
      {period}
      periodOptions={data.periodOptions}
      compareOptions={data.compareOptions}
    />

    {#if data.isEmptyBook}
      <section class="dash-panel">
        <EmptyState
          title="No records yet"
          sub="When you add records, this page shows revenue, profit, cash flow, receivables and payables."
        >
          {#snippet action()}
            <div class="empty-actions">
              {#if data.canAddRecord}
                <a class="sheet-btn sheet-btn-primary" href={resolve("/(app)/records/new")}>Add a record</a>
              {/if}
              {#if data.canImport}
                <a class="sheet-btn" href={resolve("/(app)/import")}>Import a document</a>
              {/if}
            </div>
          {/snippet}
        </EmptyState>
      </section>
      {#if data.attention.length > 0}
        <AttentionList items={data.attention} />
      {/if}
    {:else}
      <!-- Headline figures (007 FR-005) -->
      {#if data.performance || data.cash || data.owed}
        <div class="dash-grid kpis">
          {#if data.performance}
            {@const perf = data.performance}
            <KpiTile
              label="Revenue"
              value={formatMinor(perf.totalIncomeMinor)}
              href={profitLossHref(current.from, current.to)}
              current={perf.totalIncomeMinor}
              previous={perf.totalIncomePrevMinor}
              compareLabel={period.comparisonLabel}
            >
              {#snippet sub()}{period.label}{/snippet}
              {#snippet chart()}
                <Sparkline
                  values={perf.months.map((m) => m.incomeMinor)}
                  label="Revenue for each of the last 12 months"
                />
              {/snippet}
            </KpiTile>
            <KpiTile
              label={perf.resultMinor < 0 ? "Net loss" : "Net profit"}
              value={formatMinor(perf.resultMinor)}
              href={profitLossHref(current.from, current.to)}
              current={perf.resultMinor}
              previous={perf.resultPrevMinor}
              compareLabel={period.comparisonLabel}
              tone={perf.resultMinor < 0 ? "red" : undefined}
            >
              {#snippet sub()}
                {#if perf.netMarginPct !== null}
                  Net margin {pctText(perf.netMarginPct)}{#if perf.netMarginPrevPct !== null}
                    <span class="was">(was {pctText(perf.netMarginPrevPct)})</span>{/if}
                {:else}
                  No revenue in this period
                {/if}
              {/snippet}
              {#snippet chart()}
                <Sparkline
                  values={perf.months.map((m) => m.resultMinor)}
                  label="Net profit for each of the last 12 months"
                  color="var(--foreground)"
                />
              {/snippet}
            </KpiTile>
          {/if}
          {#if data.cash}
            {@const cash = data.cash}
            <KpiTile
              label="Cash balance"
              value={formatMinor(cash.onHandMinor)}
              href={cashFlowHref(current.from, current.to)}
              current={cash.onHandMinor}
              previous={cash.onHandPrevMinor}
              compareLabel="cash at {formatDate(period.comparison.to)}"
              tone={cash.onHandMinor < 0 ? "red" : undefined}
            >
              {#snippet sub()}
                {#if cash.runwayMonths !== null && cash.monthlyBurnMinor !== null}
                  <span class:warn={cash.runwayMonths < 6}>
                    Runway {cash.runwayMonths < 10 ? cash.runwayMonths.toFixed(1) : Math.round(cash.runwayMonths)} months at
                    {formatMinor(cash.monthlyBurnMinor)} net outflow each month
                  </span>
                {:else}
                  Cash and cash equivalents today
                {/if}
              {/snippet}
              {#snippet chart()}
                <Sparkline
                  values={cash.monthEnds.map((m) => m.cashMinor)}
                  label="Cash at each month end for the last 12 months"
                  color="var(--chart-3)"
                />
              {/snippet}
            </KpiTile>
          {/if}
          {#if data.owed}
            {@const owed = data.owed.owedToUs}
            <KpiTile label="Receivables" value={formatMinor(owed.totalMinor)} href={owedHref}>
              {#snippet sub()}
                {#if owed.overdueMinor > 0}
                  <span class="bad">{formatMinor(owed.overdueMinor)} overdue</span>
                {:else if owed.totalMinor > 0}
                  No overdue amounts
                {:else}
                  No receivables
                {/if}
              {/snippet}
              {#snippet chart()}
                {#if owed.totalMinor > 0}<AgeingBar bands={owed.bands} />{/if}
              {/snippet}
            </KpiTile>
          {/if}
        </div>
      {/if}

      <!-- Trends (007 FR-006) -->
      {#if data.performance || data.cash || data.position}
        <div class="dash-grid main">
          {#if data.performance}
            <section class="dash-panel">
              <header class="dash-panel-head">
                <div>
                  <h2 class="dash-panel-title">Revenue and expenses</h2>
                  <p class="dash-panel-sub">Monthly profit and loss. Select a month to open its report.</p>
                </div>
              </header>
              <MonthlyChart months={data.performance.months} periodFrom={current.from} />
              {#if data.performance.notes.length > 0}
                {#each data.performance.notes as note (note)}
                  <p class="dash-note">{note}</p>
                {/each}
              {/if}
            </section>
          {/if}
          {#if data.cash || data.position}
            <section class="dash-panel">
              {#if data.cash}
                <div class="dash-panel-section">
                  <header class="dash-panel-head">
                    <div>
                      <h2 class="dash-panel-title">Cash balance</h2>
                      <p class="dash-panel-sub">Cash and cash equivalents at month end</p>
                    </div>
                    <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the href comes from resolve(); the rule cannot see through the helper call. -->
                    <a class="dash-panel-link" href={cashFlowHref(current.from, current.to)}>Cash flow</a>
                  </header>
                  <CashChart points={data.cash.monthEnds} />
                </div>
              {/if}
              {#if data.position}
                {@const pos = data.position}
                <div class="dash-panel-section">
                  <header class="dash-panel-head">
                    <div>
                      <h2 class="dash-panel-title">Balance sheet</h2>
                      <p class="dash-panel-sub">As at today</p>
                    </div>
                    <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the href comes from resolve(); the rule cannot see through the helper call. -->
                    <a class="dash-panel-link" href={balanceSheetHref(pos.asAt)}>Open report</a>
                  </header>
                  {#if pos.balances}
                    <dl class="position">
                      <div><dt>Assets</dt><dd class="num">{formatMinor(pos.assetsMinor)}</dd></div>
                      <div><dt>Liabilities</dt><dd class="num">{formatMinor(pos.liabilitiesMinor)}</dd></div>
                      <div><dt>Equity</dt><dd class="num">{formatMinor(pos.equityMinor)}</dd></div>
                    </dl>
                  {:else}
                    <p class="unbalanced">
                      <TriangleAlert size={14} />
                      The balance sheet does not balance. The difference is
                      {formatMinor(Math.abs(pos.differenceMinor))}. Do a check of the records before you use these figures.
                    </p>
                  {/if}
                </div>
              {/if}
            </section>
          {/if}
        </div>
      {/if}

      <!-- Profit to cash, and where money went (007 FR-007, FR-008) -->
      {#if data.performance && data.cash}
        <div class="dash-grid thirds">
          <section class="dash-panel">
            <header class="dash-panel-head">
              <div>
                <h2 class="dash-panel-title">Net profit to cash flow</h2>
                <p class="dash-panel-sub">{period.label}</p>
              </div>
              <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the href comes from resolve(); the rule cannot see through the helper call. -->
              <a class="dash-panel-link" href={cashFlowHref(current.from, current.to)}>Cash flow</a>
            </header>
            <CashBridge bridge={data.cash.bridge} />
            <p class="dash-note">
              An equipment purchase is capital expenditure. The cash goes out at once, but the cost is not an
              expense. Akaun does not calculate depreciation. To put the cost into profit, record depreciation
              with a journal entry.
            </p>
            {#if !data.cash.ties}
              <p class="dash-note bad">The cash flow statement does not reconcile. Open the report to find the cause.</p>
            {/if}
          </section>
          <section class="dash-panel">
            <header class="dash-panel-head">
              <div>
                <h2 class="dash-panel-title">Top expenses</h2>
                <p class="dash-panel-sub">By expense account · {period.label}</p>
              </div>
              <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the href comes from resolve(); the rule cannot see through the helper call. -->
              <a class="dash-panel-link" href={profitLossHref(current.from, current.to)}>Open report</a>
            </header>
            <TopLines
              lines={data.performance.topExpenses}
              totalMinor={data.performance.totalExpensesMinor}
              from={current.from}
              to={current.to}
              higherIsBetter={false}
              compareLabel={period.comparisonLabel}
              emptyText="No expenses in this period."
            />
          </section>
          <section class="dash-panel">
            <header class="dash-panel-head">
              <div>
                <h2 class="dash-panel-title">Top revenue</h2>
                <p class="dash-panel-sub">By revenue account · {period.label}</p>
              </div>
              <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the href comes from resolve(); the rule cannot see through the helper call. -->
              <a class="dash-panel-link" href={profitLossHref(current.from, current.to)}>Open report</a>
            </header>
            <TopLines
              lines={data.performance.topIncome}
              totalMinor={data.performance.totalIncomeMinor}
              from={current.from}
              to={current.to}
              higherIsBetter={true}
              compareLabel={period.comparisonLabel}
              emptyText="No revenue in this period."
            />
          </section>
        </div>
      {/if}

      <!-- Who owes whom, and sales in motion (007 FR-009, FR-010) -->
      {#if data.owed || data.pipeline}
        <div class="dash-grid thirds">
          {#if data.owed}
            <OwedSidePanel
              title="Receivables"
              side={data.owed.owedToUs}
              canOpenContacts={data.owed.canOpenContacts}
              emptyText="No receivables."
            />
            <OwedSidePanel
              title="Payables"
              side={data.owed.weOwe}
              canOpenContacts={data.owed.canOpenContacts}
              emptyText="No payables."
            />
          {/if}
          {#if data.pipeline}
            <PipelinePanel pipeline={data.pipeline} periodLabel={period.label} />
          {/if}
        </div>
      {/if}

      <!-- To-dos and the newest records (007 FR-011, FR-012) -->
      <div class="dash-grid halves">
        <AttentionList items={data.attention} />
        {#if data.recent}
          <RecentActivity items={data.recent} />
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .was {
    opacity: 0.8;
  }
  .bad {
    color: var(--red);
  }
  .warn {
    color: var(--amber);
  }
  .position {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .position div {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    font-size: 13px;
  }
  .position dt {
    color: var(--muted-foreground);
  }
  .position dd {
    margin: 0;
    font-weight: 500;
  }
  .unbalanced {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    margin: 0;
    font-size: 12.5px;
    color: var(--red);
  }
  .empty-actions {
    display: flex;
    gap: 8px;
    justify-content: center;
    margin-top: 12px;
  }
  .empty-actions a {
    text-decoration: none;
  }
</style>
