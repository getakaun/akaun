<script lang="ts">
  import { resolve } from "$app/paths";
  import { ChevronRight } from "@lucide/svelte";
  import { formatMinor } from "$lib/format.js";
  import DeltaChip from "./DeltaChip.svelte";
  import type { TopLine } from "./types.js";

  /**
   * The largest lines of the period's Profit & Loss, with the rest as "Other"
   * so the list adds up to the report's total (007 FR-008). Each named line
   * opens the records behind it for the same dates.
   */
  let {
    lines,
    totalMinor,
    from,
    to,
    higherIsBetter,
    compareLabel,
    emptyText,
  }: {
    lines: TopLine[];
    totalMinor: number;
    from: string;
    to: string;
    higherIsBetter: boolean;
    compareLabel: string;
    emptyText: string;
  } = $props();

  const widest = $derived(Math.max(1, ...lines.map((l) => Math.max(l.amountMinor, 0))));

  function recordsHref(accountId: number): string {
    return `${resolve("/(app)/records")}?category=${accountId}&dateFrom=${from}&dateTo=${to}`;
  }
</script>

{#if lines.length === 0}
  <p class="empty-text">{emptyText}</p>
{:else}
  <ul class="lines">
    {#each lines as line (line.accountId ?? "other")}
      {@const share = totalMinor > 0 ? Math.max(line.amountMinor, 0) / totalMinor : 0}
      {#snippet body()}
        <div class="row-top">
          <span class="name">{line.name}</span>
          <DeltaChip
            current={line.amountMinor}
            previous={line.prevMinor}
            {higherIsBetter}
            title="Against {compareLabel}: {formatMinor(line.prevMinor)}"
          />
          <span class="num amount">{formatMinor(line.amountMinor)}</span>
        </div>
        <div class="meter" aria-hidden="true">
          <span style="width:{(Math.max(line.amountMinor, 0) / widest) * 100}%"></span>
        </div>
        <span class="share">{Math.round(share * 100)}%</span>
      {/snippet}
      <li>
        {#if line.accountId !== null}
          <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the href comes from resolve(); the rule cannot see through the helper call. -->
          <a class="line related-link" href={recordsHref(line.accountId)}>
            {@render body()}
            <ChevronRight size={13} class="chev" />
          </a>
        {:else}
          <div class="line">{@render body()}</div>
        {/if}
      </li>
    {/each}
  </ul>
{/if}

<style>
  .lines {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .line {
    display: grid;
    grid-template-columns: 1fr auto 14px;
    grid-template-areas:
      "top top chev"
      "meter share chev";
    align-items: center;
    gap: 4px 10px;
    padding: 7px 8px;
    border: 1px solid transparent;
    border-radius: 8px;
    color: inherit;
    text-decoration: none;
  }
  div.line {
    grid-template-columns: 1fr auto 14px;
  }
  .row-top {
    grid-area: top;
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .name {
    flex: 1;
    min-width: 0;
    font-size: 13px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .amount {
    font-size: 13px;
    font-weight: 500;
  }
  .meter {
    grid-area: meter;
    height: 5px;
    border-radius: 999px;
    background: var(--muted);
    overflow: hidden;
  }
  .meter span {
    display: block;
    height: 100%;
    border-radius: 999px;
    background: var(--chart-1);
  }
  .share {
    grid-area: share;
    font-size: 11px;
    color: var(--muted-foreground);
    font-variant-numeric: tabular-nums;
    min-width: 30px;
    text-align: right;
  }
  .line :global(.chev) {
    grid-area: chev;
    color: var(--muted-foreground);
  }
  .empty-text {
    margin: 0;
    padding: 24px 0;
    text-align: center;
    font-size: 13px;
    color: var(--muted-foreground);
  }
</style>
