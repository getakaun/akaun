<script lang="ts">
  import { invalidateAll } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { ChevronRight } from "@lucide/svelte";
  import DetailPage from "$lib/components/ui/DetailPage.svelte";
  import AuditTrail from "$lib/components/ui/AuditTrail.svelte";
  import StatusBadge from "$lib/components/ui/StatusBadge.svelte";
  import { assetNumber, assetReviewStatus } from "$lib/fixed-assets.js";
  import { formatDate, formatMinor } from "$lib/format.js";
  import { createResourceStream } from "$lib/sse.js";
  import AssetForm from "./AssetForm.svelte";
  import AssetDepreciation from "./AssetDepreciation.svelte";
  import AssetReview from "./AssetReview.svelte";
  import type { loadFixedAssetDetail } from "$lib/server/loaders/fixed-assets.js";

  let {
    data,
  }: {
    data: Omit<ReturnType<typeof loadFixedAssetDetail>, "depreciation"> & {
      depreciation?: ReturnType<typeof loadFixedAssetDetail>["depreciation"];
    };
  } = $props();
  const asset = $derived(data.asset);
  let dirty = $state(false);
  let saving = $state(false);
  let formRef = $state<{
    submit: () => Promise<void>;
    revert: () => void;
  } | null>(null);
  let auditRef = $state<{ refresh: () => Promise<void> } | null>(null);
  createResourceStream("/api/fixed-assets/stream", () => {
    void invalidateAll();
  });
  async function saved() {
    await invalidateAll();
    await auditRef?.refresh();
  }
</script>

<DetailPage
  backHref={resolve("/(app)/assets")}
  backLabel="Assets"
  {dirty}
  {saving}
  onsave={() => {
    void formRef?.submit();
  }}
  onrevert={() => formRef?.revert()}
>
  {#snippet hero()}
    <div class="detail-hero-eyebrow">
      {assetNumber(asset.id)} · {asset.assetType}
    </div>
    <h1 class="detail-hero-title">{asset.name}</h1>
    <div class="detail-hero-figure">
      <span class="detail-hero-amount">{formatMinor(asset.costMinor)}</span
      ><StatusBadge status={assetReviewStatus(asset)} />
    </div>
    <p class="detail-hero-note">
      Original cost · Purchased {formatDate(
        asset.acquisitionDate,
      )}{asset.inServiceDate
        ? ` · In service ${formatDate(asset.inServiceDate)}`
        : ""}
    </p>
  {/snippet}
  {#snippet main()}
    {#if data.depreciation}<AssetDepreciation
        data={data.depreciation}
        accounts={data.accounts}
        disabled={dirty || saving}
        onsaved={saved}
      />{/if}
    {#if asset.reviewReason}<AssetReview
        {asset}
        accounts={data.accounts}
        canChange={data.canChange}
        disabled={dirty || saving}
        onsaved={saved}
      />{/if}
    <section class="detail-card">
      <div class="detail-card-head">
        <span class="detail-card-title">Asset details</span>
      </div>
      <AssetForm
        bind:this={formRef}
        {asset}
        accounts={data.accounts}
        canChange={data.canChange}
        bind:dirty
        bind:saving
        onsaved={saved}
      />
    </section>
  {/snippet}
  {#snippet rail()}
    <section class="detail-card">
      <div class="detail-card-head">
        <span class="detail-card-title">Related records</span>
      </div>
      {#if asset.sourceRecordId}<a
          class="related-link asset-relation"
          href={resolve("/(app)/records/[id]", {
            id: String(asset.sourceRecordId),
          })}
          ><span
            >Purchase and documents<span class="asset-relation-note"
              >{asset.source?.recordNumber ??
                `Record #${asset.sourceRecordId}`}</span
            ></span
          ><ChevronRight size={14} /></a
        >{/if}
      {#if asset.openingRecordId}<a
          class="related-link asset-relation"
          href={resolve("/(app)/records/[id]", {
            id: String(asset.openingRecordId),
          })}
          ><span
            >Opening record and documents<span class="asset-relation-note"
              >Record #{asset.openingRecordId}</span
            ></span
          ><ChevronRight size={14} /></a
        >{/if}
      <a
        class="related-link asset-relation"
        href={resolve("/(app)/accounts/[id]", {
          id: String(asset.assetAccountId),
        })}
        ><span
          >Asset cost account<span class="asset-relation-note"
            >{asset.accountName}</span
          ></span
        ><ChevronRight size={14} /></a
      >
      <a
        class="related-link asset-relation"
        href={resolve(
          `/(app)/assets?account=${asset.assetAccountId}&view=reconciliation`,
        )}
        ><span
          >Reconciliation<span class="asset-relation-note"
            >Register and ledger balances</span
          ></span
        ><ChevronRight size={14} /></a
      >
    </section>
    {#if asset.openingAsAt}<section class="detail-card">
        <div class="detail-card-head">
          <span class="detail-card-title">Opening values</span>
        </div>
        <p class="detail-hero-note">As at {formatDate(asset.openingAsAt)}</p>
        <div class="detail-list">
          <div class="detail-row">
            <span class="detail-key">Original cost</span><span
              class="detail-val">{formatMinor(asset.costMinor)}</span
            >
          </div>
          <div class="detail-row">
            <span class="detail-key"
              >Accumulated depreciation brought forward</span
            ><span class="detail-val"
              >{formatMinor(asset.broughtForwardDepMinor)}</span
            >
          </div>
          <div class="detail-row">
            <span class="detail-key">Net book value</span><span
              class="detail-val"
              >{formatMinor(
                asset.costMinor - asset.broughtForwardDepMinor,
              )}</span
            >
          </div>
        </div>
        <p class="field-hint">Opening values are not a current valuation.</p>
      </section>{/if}
    <section class="detail-card">
      <div class="detail-card-head">
        <span class="detail-card-title">Activity</span>
      </div>
      <AuditTrail
        bind:this={auditRef}
        recordType="fixed_asset"
        recordId={asset.id}
      />
    </section>
  {/snippet}
</DetailPage>

<style>
  .asset-relation {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    font-size: 13px;
    margin-top: 8px;
  }
  .asset-relation-note {
    display: block;
    color: var(--muted-foreground);
    font-size: 11.5px;
    margin-top: 3px;
  }
</style>
