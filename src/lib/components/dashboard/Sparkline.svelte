<script lang="ts">
  import { toY, type Scale } from "./chart-scale.js";

  /**
   * A twelve-month trend line under a headline figure. Decorative beside the
   * number it sits under, so it carries a plain-words summary for assistive
   * tech rather than one label per point.
   */
  let {
    values,
    label,
    color = "var(--chart-1)",
  }: { values: number[]; label: string; color?: string } = $props();

  const W = 100;
  const H = 28;
  // Fitted to the data rather than to zero: the line is there to show the
  // shape of the year, and the figure above it already says how big it is.
  const scale: Scale = $derived.by(() => {
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    return lo === hi
      ? { min: lo - 1, max: hi + 1, ticks: [] }
      : { min: lo, max: hi, ticks: [] };
  });
  const points = $derived(
    values
      .map((v, i) => {
        const x = values.length > 1 ? (i / (values.length - 1)) * W : W / 2;
        return `${x.toFixed(2)},${toY(v, scale, H).toFixed(2)}`;
      })
      .join(" "),
  );
  const zeroY = $derived(toY(0, scale, H));
</script>

<svg
  class="spark"
  viewBox="0 0 {W} {H}"
  preserveAspectRatio="none"
  role="img"
  aria-label={label}
>
  {#if scale.min < 0 && scale.max > 0}
    <line x1="0" x2={W} y1={zeroY} y2={zeroY} class="zero" vector-effect="non-scaling-stroke" />
  {/if}
  <polyline {points} fill="none" stroke={color} vector-effect="non-scaling-stroke" />
</svg>

<style>
  .spark {
    display: block;
    width: 100%;
    height: 28px;
    overflow: visible;
  }
  polyline {
    stroke-width: 1.75;
    stroke-linejoin: round;
    stroke-linecap: round;
  }
  .zero {
    stroke: var(--border-strong);
    stroke-width: 1;
    stroke-dasharray: 2 2;
  }
</style>
