<script lang="ts">
  import { resolve } from "$app/paths";
  import { ArrowDownLeft, ArrowUpRight, ArrowLeftRight } from "@lucide/svelte";
  import { formatDateShort, formatMinor } from "$lib/format.js";
  import EmptyState from "$lib/components/ui/EmptyState.svelte";
  import type { RecentItem } from "./types.js";

  /**
   * The newest records of every kind (007 FR-012), each opening at its own
   * page. Whether money came in or went out is the record's effect on cash,
   * worked out by the loader, so a transfer between two of the business's own
   * accounts reads as neither.
   */
  let { items }: { items: RecentItem[] } = $props();

  function recordHref(id: number): string {
    return resolve("/(app)/records/[id]", { id: String(id) });
  }
</script>

<section class="dash-panel">
  <header class="dash-panel-head">
    <div>
      <h2 class="dash-panel-title">Recent transactions</h2>
      <p class="dash-panel-sub">The latest records of all types</p>
    </div>
    <a class="dash-panel-link" href={resolve("/(app)/records")}>View all</a>
  </header>
  {#if items.length === 0}
    <EmptyState title="No transactions yet" sub="New records show here." style="padding:20px;" />
  {:else}
    <ul class="rows">
      {#each items as item (item.id)}
        <li>
          <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the href comes from resolve(); the rule cannot see through the helper call. -->
          <a class="row" href={recordHref(item.id)}>
            <span class="icon {item.direction}" aria-hidden="true">
              {#if item.direction === "in"}
                <ArrowDownLeft size={14} />
              {:else if item.direction === "out"}
                <ArrowUpRight size={14} />
              {:else}
                <ArrowLeftRight size={14} />
              {/if}
            </span>
            <span class="meta">
              <span class="name">{item.description || item.contactName || item.kindLabel}</span>
              <span class="sub">
                {item.kindLabel}{#if item.contactName && item.description} · {item.contactName}{/if}
                · {formatDateShort(item.date)}
              </span>
            </span>
            <span class="num amt {item.direction}">
              {item.direction === "in" ? "+" : item.direction === "out" ? "−" : ""}{formatMinor(item.amountMinor)}
            </span>
          </a>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .rows li + li {
    border-top: 1px solid var(--border);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 11px;
    padding: 9px 4px;
    color: inherit;
    text-decoration: none;
    border-radius: 6px;
  }
  .row:hover,
  .row:focus-visible {
    background: var(--accent);
  }
  .icon {
    width: 28px;
    height: 28px;
    border-radius: 8px;
    display: grid;
    place-items: center;
    flex-shrink: 0;
    background: var(--accent);
    color: var(--muted-foreground);
  }
  .icon.in {
    background: var(--green-soft);
    color: var(--green);
  }
  .meta {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .name {
    font-size: 13px;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sub {
    font-size: 11.5px;
    color: var(--muted-foreground);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .amt {
    font-size: 13px;
    font-weight: 600;
    white-space: nowrap;
  }
  .amt.in {
    color: var(--green);
  }
</style>
