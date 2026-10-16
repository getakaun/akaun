<script lang="ts">
  import { formatCompactMinor, formatMinor, formatDate } from "$lib/format.js";
  import { niceScale, toY } from "./chart-scale.js";

  /**
   * Cash and cash equivalents at each month end — the Cash Flow Statement's
   * closing figure for a period ending that day (007 FR-006). The last point
   * is today.
   */
  let {
    points,
  }: {
    points: { key: string; label: string; asAt: string; cashMinor: number }[];
  } = $props();

  const W = 300;
  const H = 120;
  const scale = $derived(niceScale(points.map((p) => p.cashMinor), 3));
  const x = (i: number) =>
    points.length > 1 ? (i / (points.length - 1)) * W : W / 2;
  const line = $derived(
    points.map((p, i) => `${x(i)},${toY(p.cashMinor, scale, H).toFixed(1)}`).join(" "),
  );
  const area = $derived(
    `0,${toY(0, scale, H)} ${line} ${W},${toY(0, scale, H)}`,
  );
  const summary = $derived(
    points.length
      ? `Cash at each month end, from ${formatMinor(points[0].cashMinor)} at ${formatDate(points[0].asAt)} to ${formatMinor(points[points.length - 1].cashMinor)} today`
      : "No cash figures",
  );
</script>

<div class="chart">
  <div class="y-axis" aria-hidden="true">
    {#each scale.ticks as tick (tick)}
      <span style="top:{(toY(tick, scale, H) / H) * 100}%">{formatCompactMinor(tick)}</span>
    {/each}
  </div>
  <div class="plot">
    <svg viewBox="0 0 {W} {H}" preserveAspectRatio="none" role="img" aria-label={summary}>
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
      <polygon class="area" points={area} />
      <polyline class="line" points={line} vector-effect="non-scaling-stroke" />
      {#each points as p, i (p.key)}
        <rect class="hit" x={x(i) - W / points.length / 2} y="0" width={W / points.length} height={H}>
          <title>{p.label}: {formatMinor(p.cashMinor)}</title>
        </rect>
      {/each}
    </svg>
    <div class="x-axis" aria-hidden="true">
      <span>{points[0]?.label ?? ""}</span>
      <span>Today</span>
    </div>
  </div>
</div>

<style>
  .chart {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 8px;
  }
  .y-axis {
    position: relative;
    height: 120px;
    min-width: 46px;
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
    height: 120px;
    overflow: visible;
  }
  .grid {
    stroke: var(--border);
    stroke-width: 1;
  }
  .grid.zero {
    stroke: var(--border-strong);
  }
  .area {
    fill: var(--chart-3);
    opacity: 0.12;
  }
  .line {
    fill: none;
    stroke: var(--chart-3);
    stroke-width: 2;
    stroke-linejoin: round;
  }
  .hit {
    fill: transparent;
  }
  .x-axis {
    display: flex;
    justify-content: space-between;
    margin-top: 6px;
    font-size: 11px;
    color: var(--muted-foreground);
  }
</style>
