<script lang="ts">
  import { formatPct } from "$lib/format.js";

  /**
   * How a figure moved against its comparison period. Green means good news,
   * which for an expense is a fall: `higherIsBetter` says which way round.
   */
  let {
    current,
    previous,
    higherIsBetter = true,
    title,
  }: {
    current: number;
    previous: number;
    higherIsBetter?: boolean;
    title?: string;
  } = $props();

  const diff = $derived(current - previous);
  const pct = $derived(previous === 0 ? null : diff / Math.abs(previous));
  const tone = $derived(
    diff === 0 ? "flat" : diff > 0 === higherIsBetter ? "good" : "bad",
  );
</script>

{#if pct !== null}
  <span class="delta {tone}" {title}>{formatPct(pct)}</span>
{:else if current !== 0}
  <span class="delta flat" {title}>new</span>
{/if}

<style>
  .delta {
    font-size: 11.5px;
    font-weight: 600;
    padding: 1px 7px;
    border-radius: 999px;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .good {
    color: var(--green);
    background: var(--green-soft);
  }
  .bad {
    color: var(--red);
    background: var(--red-soft);
  }
  .flat {
    color: var(--muted-foreground);
    background: var(--accent);
  }
</style>
