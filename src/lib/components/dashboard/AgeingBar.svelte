<script lang="ts">
  import { formatMinor } from "$lib/format.js";
  import type { AgeingBandView } from "./types.js";

  /**
   * What is owed, as one bar split by how overdue it is — the same bands as
   * the ageing on Contacts. Freshest band first, so the red end of the bar is
   * the money most at risk.
   */
  let { bands }: { bands: AgeingBandView[] } = $props();

  const TONES = ["var(--chart-3)", "var(--chart-2)", "var(--amber)", "var(--red)", "var(--red)"];
  const total = $derived(bands.reduce((sum, b) => sum + b.totalMinor, 0));
  const summary = $derived(
    bands
      .filter((b) => b.totalMinor > 0)
      .map((b) => `${b.label}: ${formatMinor(b.totalMinor)}`)
      .join("; ") || "No outstanding balance",
  );
</script>

<div class="bar" role="img" aria-label={summary}>
  {#each bands as band, i (band.label)}
    {#if band.totalMinor > 0}
      <span
        class="part"
        class:over90={i === 4}
        style="flex-grow:{band.totalMinor / total}; background:{TONES[i]}"
        title="{band.label}: {formatMinor(band.totalMinor)}"
      ></span>
    {/if}
  {/each}
</div>
<div class="legend" aria-hidden="true">
  {#each bands as band, i (band.label)}
    {#if band.totalMinor > 0}
      <span><i style="background:{TONES[i]}"></i>{band.label}</span>
    {/if}
  {/each}
</div>

<style>
  .bar {
    display: flex;
    gap: 2px;
    height: 10px;
    border-radius: 999px;
    overflow: hidden;
    background: var(--muted);
  }
  .part {
    flex-basis: 0;
    min-width: 4px;
  }
  .part.over90 {
    background-image: repeating-linear-gradient(
      135deg,
      transparent 0 3px,
      oklch(1 0 0 / 0.35) 3px 5px
    ) !important;
  }
  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
    margin-top: 8px;
    font-size: 11.5px;
    color: var(--muted-foreground);
  }
  .legend span {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .legend i {
    width: 8px;
    height: 8px;
    border-radius: 2px;
  }
</style>
