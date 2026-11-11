<script lang="ts">
  import { SvelteMap } from "svelte/reactivity";
  import { invalidateAll } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { Plus } from "@lucide/svelte";
  import { toast } from "svelte-sonner";
  import { Button } from "$lib/components/ui/button/index.js";
  import BackLink from "$lib/components/ui/BackLink.svelte";
  import AssetTaxSchemesSheet from "./AssetTaxSchemesSheet.svelte";
  import {
    assetTaxSchemeRemark,
    taxJurisdictionLabel,
  } from "$lib/asset-tax-scheme.js";
  import { createResourceStream } from "$lib/sse.js";
  import type { AssetTaxSchemeVersion } from "$lib/server/queries/asset-tax-schemes.js";
  let {
    schemes,
    canManage,
    canSeeSettings,
  }: {
    schemes: AssetTaxSchemeVersion[];
    canManage: boolean;
    canSeeSettings: boolean;
  } = $props();
  const latest = $derived([
    ...new SvelteMap(schemes.map((s) => [s.familyKey, s])).values(),
  ]);
  let editing = $state(false);
  let familyKey = $state<string | null>(null);
  createResourceStream("/api/tax/stream", () => {
    void invalidateAll();
  });
  function open(family: string | null = null) {
    familyKey = family;
    editing = true;
  }
  async function saved() {
    await invalidateAll();
    toast.success("Asset tax scheme saved");
  }
</script>

<div class="screen">
  <header class="topbar">
    <div class="topbar-left">
      <BackLink
        href={canSeeSettings
          ? resolve("/(app)/settings")
          : resolve("/(app)/tax")}
        label={canSeeSettings ? "Settings" : "Annual tax"}
      />
      <h1 class="page-title">Tax settings</h1>
    </div>
  </header>
  <div class="set-content">
    <section class="set-section">
      <div class="set-section-head scheme-section-head">
        <div>
          <h2 class="set-section-title">Asset tax schemes</h2>
          <p class="set-section-sub">
            Reusable rates for your annual asset tax workings.
          </p>
        </div>
        {#if canManage}
          <Button size="sm" onclick={() => open()}
            ><Plus size={14} />New scheme</Button
          >
        {/if}
      </div>
      {#if !canManage}<p class="field-hint scheme-notice">
          Read-only. Tax update permission is required to make changes.
        </p>{/if}
      <div class="set-rows">
        {#if latest.length === 0}
          <div class="set-row">
            <p class="set-row-value">
              No schemes yet. Create a scheme to reuse its rates in annual tax
              worksheets.
            </p>
          </div>
        {:else}
          {#each latest as scheme (scheme.id)}
            {@const remark = assetTaxSchemeRemark(scheme.definition)}
            <div class="set-row">
              <div class="scheme-details">
                <div class="set-row-label">{scheme.definition.name}</div>
                <p class="set-desc">
                  {taxJurisdictionLabel(scheme.definition.jurisdiction)} · {scheme
                    .definition.yearTo === scheme.definition.yearFrom
                    ? scheme.definition.yearFrom
                    : `${scheme.definition.yearFrom}–${scheme.definition.yearTo ?? "onwards"}`}
                </p>
                <p class="set-desc">
                  First year {scheme.definition.firstYearRateBps / 100}% ·
                  Regular {scheme.definition.regularRateBps / 100}%
                </p>
                <p class="set-desc">
                  {scheme.definition.method === "original_cost"
                    ? "Business-use qualifying cost"
                    : "Remaining tax residual"}
                </p>
                {#if remark}<p class="set-desc scheme-remark">{remark}</p>{/if}
              </div>
              {#if canManage}<Button
                  variant="outline"
                  size="sm"
                  onclick={() => open(scheme.familyKey)}
                  aria-label={`Edit ${scheme.definition.name}`}>Edit</Button
                >{/if}
            </div>
          {/each}
        {/if}
      </div>
      <p class="field-hint scheme-notice">
        Custom schemes. Confirm the applicable tax rules before use.
      </p>
    </section>
  </div>
</div>
{#if editing}<AssetTaxSchemesSheet
    {schemes}
    initialFamilyKey={familyKey}
    onclose={() => (editing = false)}
    onsaved={saved}
  />{/if}

<style>
  .scheme-section-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 12px;
  }
  .scheme-details {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .scheme-remark {
    white-space: pre-wrap;
  }
  .scheme-notice {
    margin-top: 12px;
    margin-bottom: 12px;
  }
</style>
