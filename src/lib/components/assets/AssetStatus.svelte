<script lang="ts">
  import StatusBadge from "$lib/components/ui/StatusBadge.svelte";
  import type { AssetDepreciationOverview } from "$lib/depreciation.js";
  let {
    overview,
    showDetails = true,
  }: { overview: AssetDepreciationOverview; showDetails?: boolean } = $props();
</script>

<div class="asset-status">
  <div class="asset-status-badges">
    <StatusBadge status={overview.status} />
    {#if overview.reviewReason}<span title={overview.reviewReason}
        ><StatusBadge status="asset-review" /><span class="sr-only"
          >{overview.reviewReason}</span
        ></span
      >{/if}
  </div>
  {#if showDetails}
    {#if overview.dueCount}<span class="asset-status-note"
        >{overview.dueCount}
        {overview.dueCount === 1 ? "month" : "months"} pending · from {overview.firstDueMonth}</span
      >{/if}
    <span class="asset-status-note"
      >{overview.lastPostedMonth
        ? `Last posted ${overview.lastPostedMonth}`
        : "No depreciation posted"}</span
    >
    {#if overview.mode === "auto" && overview.status !== "depreciation-complete" && overview.status !== "depreciation-stopped"}<span
        class="asset-status-note">Auto-post enabled</span
      >{/if}
    {#if overview.nextMonth && !overview.dueCount}<span
        class="asset-status-note">Next scheduled {overview.nextMonth}</span
      >{/if}
  {/if}
</div>

<style>
  .asset-status {
    display: grid;
    gap: 4px;
  }
  .asset-status-badges {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
  }
  .asset-status-note {
    color: var(--muted-foreground);
    font-size: 11px;
    line-height: 1.4;
    white-space: normal;
  }
</style>
