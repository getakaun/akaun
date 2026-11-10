<script lang="ts">
  import StatusBadge from "$lib/components/ui/StatusBadge.svelte";
  import type { AssetDepreciationOverview } from "$lib/depreciation.js";
  let { overview }: { overview: AssetDepreciationOverview } = $props();
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
</style>
