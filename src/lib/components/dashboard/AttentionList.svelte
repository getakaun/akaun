<script lang="ts">
  import { resolve } from "$app/paths";
  import { ChevronRight, CircleCheck } from "@lucide/svelte";
  import type { AttentionItem, AttentionTarget } from "./types.js";

  /**
   * What needs doing (007 FR-011). The loader leaves out anything with nothing
   * to report, so an empty list is good news and says so.
   */
  let { items }: { items: AttentionItem[] } = $props();

  function hrefFor(target: AttentionTarget): string {
    switch (target.screen) {
      case "balance-sheet":
        return `${resolve("/(app)/reports/[view]", { view: "balance-sheet" })}?asAt=${target.asAt}`;
      case "import":
        return resolve("/(app)/import");
      case "invoices":
        return resolve("/(app)/invoices");
      case "unpaid-expenses":
        return `${resolve("/(app)/records")}?kind=1&status=owed`;
      case "reconcile":
        return resolve("/(app)/accounts/[id]/reconcile", { id: String(target.accountId) });
      case "accounts":
        return resolve("/(app)/accounts");
    }
  }
</script>

<section class="dash-panel">
  <header class="dash-panel-head">
    <div>
      <h2 class="dash-panel-title">Action items</h2>
      <p class="dash-panel-sub">Do these tasks to keep the books correct</p>
    </div>
  </header>
  {#if items.length === 0}
    <p class="all-clear"><CircleCheck size={15} /> No open items. The books are up to date.</p>
  {:else}
    <ul class="items">
      {#each items as item (item.key)}
        <li>
          <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the href comes from resolve(); the rule cannot see through the helper call. -->
          <a class="item related-link" href={hrefFor(item.target)}>
            <span class="dot {item.tone}" aria-hidden="true"></span>
            <span class="text">
              <span class="label">{item.label}</span>
              <span class="detail">{item.detail}</span>
            </span>
            <ChevronRight size={14} class="chev" />
          </a>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .items {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 11px;
    border: 1px solid var(--border);
    border-radius: 8px;
    color: inherit;
    text-decoration: none;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 999px;
    flex-shrink: 0;
    background: var(--muted-foreground);
  }
  .dot.red {
    background: var(--red);
  }
  .dot.amber {
    background: var(--amber);
  }
  .text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .label {
    font-size: 13px;
    font-weight: 500;
  }
  .detail {
    font-size: 11.5px;
    color: var(--muted-foreground);
  }
  .item :global(.chev) {
    color: var(--muted-foreground);
    flex-shrink: 0;
  }
  .all-clear {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
    padding: 14px 0;
    font-size: 13px;
    color: var(--green);
  }
</style>
