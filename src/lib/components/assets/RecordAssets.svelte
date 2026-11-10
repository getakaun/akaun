<script lang="ts">
  import { ChevronRight } from "@lucide/svelte";
  import { invalidateAll } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { createResourceStream } from "$lib/sse.js";
  import { assetNumber, assetReviewStatus } from "$lib/fixed-assets.js";
  import StatusBadge from "$lib/components/ui/StatusBadge.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { formatMinor } from "$lib/format.js";
  import AssetSheet from "./AssetSheet.svelte";
  import type { loadRecordDetail } from "$lib/server/loaders/records.js";
  let {
    data,
    disabled = false,
  }: {
    data: NonNullable<ReturnType<typeof loadRecordDetail>["assetData"]>;
    disabled?: boolean;
  } = $props();
  let movementId = $state<number | null>(null);
  const source = $derived(
    data.unregistered.find((line) => line.movementId === movementId) ?? null,
  );
  createResourceStream("/api/fixed-assets/stream", () => {
    void invalidateAll();
  });
</script>

{#if data.assets.length > 0 || data.unregistered.length > 0}
  <section class="detail-card">
    <div class="detail-card-head">
      <span class="detail-card-title">Fixed assets</span>
    </div>
    <div class="asset-links">
      {#each data.assets as asset (asset.id)}<a
          class="related-link ob-card"
          href={resolve("/(app)/assets/[id]", { id: String(asset.id) })}
          ><span class="ob-main"
            ><span class="ob-title">{asset.name}</span>
            <span class="ob-sub"
              >{assetNumber(asset.id)} · {formatMinor(asset.costMinor)}</span
            >
            <span><StatusBadge status={assetReviewStatus(asset)} /></span></span
          >
          <ChevronRight size={14} color="var(--muted-foreground)" /></a
        >{/each}
      {#each data.unregistered as line (line.movementId)}<div
          class="ob-card asset-candidate"
        >
          <span class="ob-main"
            ><span class="ob-title">{line.label ?? line.description}</span>
            <span class="ob-sub"
              >{formatMinor(line.amountMinor)} · Not registered</span
            ></span
          >
          {#if data.canChange}<Button
              size="sm"
              variant="outline"
              {disabled}
              onclick={() => (movementId = line.movementId)}
              >Register asset</Button
            >{/if}
        </div>{/each}
    </div>
    <p class="hint">
      {disabled
        ? "Save or discard record changes before registering an asset."
        : "Register each asset separately. Registration creates no accounting entry."}
    </p>
  </section>
{/if}
{#if source && !disabled}<AssetSheet
    {source}
    accounts={data.accounts}
    canChange={data.canChange}
    onclose={() => (movementId = null)}
    onsaved={invalidateAll}
  />{/if}

<style>
  .asset-links {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .asset-candidate {
    flex-direction: column;
    align-items: flex-start;
  }
  .ob-title,
  .ob-sub {
    overflow-wrap: anywhere;
  }
</style>
