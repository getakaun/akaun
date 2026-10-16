<script lang="ts">
  import { formatCompactMinor, formatMinor } from "$lib/format.js";
  import { profitLossHref } from "$lib/components/reports/report-links.js";
  import { niceScale, toY } from "./chart-scale.js";
  import type { MonthPoint } from "./types.js";

  /**
   * Revenue and expenses for each of the last twelve months, with the net
   * result as a line. Each month is the Profit & Loss for that month (007
   * FR-001) and links to it (FR-002), so the chart is a grid of links rather
   * than a picture: `role="group"`, one labelled link per month.
   */
  let {
    months,
    periodFrom,
  }: {
    months: MonthPoint[];
    /** Months from here on are inside the selected period and drawn at full strength. */
    periodFrom: string;
  } = $props();

  const W = 600;
  const H = 200;
  const SLOT = $derived(W / Math.max(months.length, 1));
  const BAR = $derived(Math.min(16, SLOT * 0.3));

  const scale = $derived(
    niceScale(months.flatMap((m) => [m.incomeMinor, m.expensesMinor, m.resultMinor])),
  );
  const zeroY = $derived(toY(0, scale, H));

  function barRect(value: number) {
    const y = toY(Math.max(value, 0), scale, H);
    const bottom = toY(Math.min(value, 0), scale, H);
    return { y, height: Math.max(bottom - y, value === 0 ? 0 : 1) };
  }

  const resultPoints = $derived(
    months
      .map((m, i) => `${(i + 0.5) * SLOT},${toY(m.resultMinor, scale, H).toFixed(1)}`)
      .join(" "),
  );

  function describe(m: MonthPoint): string {
    return (
      `${m.label}: revenue ${formatMinor(m.incomeMinor)}, ` +
      `expenses ${formatMinor(m.expensesMinor)}, ` +
      `net ${m.resultMinor < 0 ? "loss" : "profit"} ${formatMinor(Math.abs(m.resultMinor))}. ` +
      `Open the profit and loss for ${m.label}.`
    );
  }

  const empty = $derived(
    months.every((m) => m.incomeMinor === 0 && m.expensesMinor === 0),
  );
</script>

{#if empty}
  <p class="chart-empty">No revenue or expenses in the last 12 months.</p>
{:else}
  <div class="chart">
    <div class="y-axis" aria-hidden="true">
      {#each scale.ticks as tick (tick)}
        <span style="top:{(toY(tick, scale, H) / H) * 100}%">{formatCompactMinor(tick)}</span>
      {/each}
    </div>
    <div class="plot">
      <svg
        viewBox="0 0 {W} {H}"
        preserveAspectRatio="none"
        role="group"
        aria-label="Revenue, expenses and net profit for each of the last 12 months"
      >
        {#each scale.ticks as tick (tick)}
          <line
            class="grid"
            class:zero={tick === 0}
            x1="0"
            x2={W}
            y1={toY(tick, scale, H)}
            y2={toY(tick, scale, H)}
            vector-effect="non-scaling-stroke"
          />
        {/each}
        {#each months as m, i (m.key)}
          {@const income = barRect(m.incomeMinor)}
          {@const expense = barRect(m.expensesMinor)}
          {@const cx = (i + 0.5) * SLOT}
          <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the href comes from resolve(); the rule cannot see through the helper call. -->
          <a href={profitLossHref(m.from, m.to)} aria-label={describe(m)} class:dim={m.to < periodFrom}>
            <title>{describe(m)}</title>
            <rect class="hit" x={i * SLOT} y="0" width={SLOT} height={H} />
            <rect class="bar income" x={cx - BAR - 1.5} y={income.y} width={BAR} height={income.height} />
            <rect class="bar expense" x={cx + 1.5} y={expense.y} width={BAR} height={expense.height} />
          </a>
        {/each}
        <polyline class="result" points={resultPoints} vector-effect="non-scaling-stroke" />
        <line class="axis" x1="0" x2={W} y1={zeroY} y2={zeroY} vector-effect="non-scaling-stroke" />
      </svg>
      <div class="x-axis" aria-hidden="true">
        {#each months as m (m.key)}
          <span class:dim={m.to < periodFrom}>{m.label}</span>
        {/each}
      </div>
    </div>
  </div>
  <div class="legend" aria-hidden="true">
    <span><i class="sw income"></i>Revenue</span>
    <span><i class="sw expense"></i>Expenses</span>
    <span><i class="sw result"></i>Net profit</span>
  </div>
{/if}

<style>
  .chart {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 8px;
  }
  .y-axis {
    position: relative;
    height: 200px;
    min-width: 52px;
    font-size: 10.5px;
    color: var(--muted-foreground);
    font-variant-numeric: tabular-nums;
  }
  .y-axis span {
    position: absolute;
    right: 0;
    transform: translateY(-50%);
    white-space: nowrap;
  }
  .plot {
    min-width: 0;
  }
  svg {
    display: block;
    width: 100%;
    height: 200px;
    overflow: visible;
  }
  .grid {
    stroke: var(--border);
    stroke-width: 1;
  }
  .axis {
    stroke: var(--border-strong);
    stroke-width: 1;
  }
  .hit {
    fill: transparent;
  }
  a:hover .hit,
  a:focus-visible .hit {
    fill: var(--accent);
  }
  a:focus-visible {
    outline: none;
  }
  .bar.income {
    fill: var(--chart-1);
  }
  .bar.expense {
    fill: var(--chart-4);
  }
  a.dim .bar {
    opacity: 0.45;
  }
  .result {
    fill: none;
    stroke: var(--foreground);
    stroke-width: 1.75;
    stroke-linejoin: round;
    pointer-events: none;
  }
  .x-axis {
    display: flex;
    margin-top: 6px;
  }
  .x-axis span {
    flex: 1;
    text-align: center;
    font-size: 11px;
    color: var(--foreground);
  }
  .x-axis span.dim {
    color: var(--muted-foreground);
  }
  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 14px;
    margin-top: 12px;
    font-size: 12px;
    color: var(--muted-foreground);
  }
  .legend span {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .sw {
    width: 10px;
    height: 10px;
    border-radius: 3px;
  }
  .sw.income {
    background: var(--chart-1);
  }
  .sw.expense {
    background: var(--chart-4);
  }
  .sw.result {
    height: 2px;
    border-radius: 0;
    background: var(--foreground);
  }
  .chart-empty {
    margin: 0;
    padding: 48px 0;
    text-align: center;
    font-size: 13px;
    color: var(--muted-foreground);
  }
  @media (max-width: 767px) {
    .x-axis span:nth-child(even) {
      visibility: hidden;
    }
  }
</style>
