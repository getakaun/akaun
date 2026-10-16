<script lang="ts">
  import type { Snippet } from "svelte";
  import DeltaChip from "./DeltaChip.svelte";

  /**
   * One headline figure (007 FR-005): what it is, how it moved against the
   * comparison period, and a small picture of the last year. The whole tile
   * links to the statement the figure came from (FR-002).
   */
  let {
    label,
    value,
    href,
    current,
    previous,
    higherIsBetter = true,
    compareLabel,
    tone,
    sub,
    chart,
  }: {
    label: string;
    value: string;
    href: string;
    /** For the change chip; omit both to show none. */
    current?: number;
    previous?: number;
    higherIsBetter?: boolean;
    compareLabel?: string;
    tone?: "red" | "green";
    sub?: Snippet;
    chart?: Snippet;
  } = $props();
</script>

<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the href comes from resolve(); the rule cannot see through the helper call. -->
<a class="tile" {href}>
  <div class="top">
    <span class="label">{label}</span>
    {#if current !== undefined && previous !== undefined}
      <DeltaChip
        {current}
        {previous}
        {higherIsBetter}
        title={compareLabel ? `Against ${compareLabel}` : undefined}
      />
    {/if}
  </div>
  <div class="num value" class:red={tone === "red"} class:green={tone === "green"}>{value}</div>
  {#if sub}<div class="sub">{@render sub()}</div>{/if}
  {#if chart}<div class="chart">{@render chart()}</div>{/if}
</a>

<style>
  .tile {
    display: flex;
    flex-direction: column;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 16px;
    box-shadow: var(--shadow-sm);
    color: inherit;
    text-decoration: none;
    min-width: 0;
    transition: border-color 0.12s;
  }
  .tile:hover,
  .tile:focus-visible {
    border-color: var(--primary);
  }
  .top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .label {
    font-size: 13px;
    font-weight: 500;
    color: var(--muted-foreground);
  }
  .value {
    font-size: 24px;
    font-weight: 600;
    letter-spacing: -0.02em;
    margin-top: 10px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .value.red {
    color: var(--red);
  }
  .value.green {
    color: var(--green);
  }
  .sub {
    font-size: 12px;
    color: var(--muted-foreground);
    margin-top: 3px;
    min-height: 18px;
  }
  .chart {
    margin-top: auto;
    padding-top: 12px;
  }
  @media (max-width: 767px) {
    .tile {
      padding: 12px;
    }
    .value {
      font-size: 19px;
    }
  }
</style>
