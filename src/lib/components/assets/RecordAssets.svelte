<script lang="ts">
  import { invalidateAll } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { createResourceStream } from "$lib/sse.js";
  import { assetNumber } from "$lib/fixed-assets.js";
  import { formatMinor } from "$lib/format.js";
  import AssetSheet from "./AssetSheet.svelte";
  import type { loadRecordDetail } from "$lib/server/loaders/records.js";
  let {
    data,
  }: { data: NonNullable<ReturnType<typeof loadRecordDetail>["assetData"]> } =
    $props();
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
    {#each data.assets as asset (asset.id)}<a
        class="related-link block p-3 text-sm"
        href={resolve(
          `/(app)/assets?asset=${asset.id}&asAt=${asset.acquisitionDate}`,
        )}
        >View asset {assetNumber(asset.id)} · {asset.name}{asset.reviewReason
          ? " · Needs review"
          : ""}</a
      >{/each}
    {#each data.unregistered as line (line.movementId)}<div
        class="flex items-center justify-between gap-3 p-3 text-sm"
      >
        <span
          >{line.label ?? line.description} · {formatMinor(
            line.amountMinor,
          )}</span
        >{#if data.canChange}<button
            class="sheet-btn"
            onclick={() => (movementId = line.movementId)}
            >Register asset</button
          >{/if}
      </div>{/each}
    <p class="text-muted-foreground p-3 text-xs">
      One individual asset per line. Registration creates no purchase or
      depreciation entry.
    </p>
  </section>
{/if}
{#if source}<AssetSheet
    {source}
    accounts={data.accounts}
    canChange={data.canChange}
    onclose={() => (movementId = null)}
    onsaved={invalidateAll}
  />{/if}
