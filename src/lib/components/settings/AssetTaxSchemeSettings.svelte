<script lang="ts">
  import { SvelteMap } from "svelte/reactivity";
  import { invalidateAll } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { Plus } from "@lucide/svelte";
  import { toast } from "svelte-sonner";
  import { Button } from "$lib/components/ui/button/index.js";
  import DetailPage from "$lib/components/ui/DetailPage.svelte";
  import ReportNotes from "$lib/components/reports/ReportNotes.svelte";
  import AssetTaxSchemesSheet from "./AssetTaxSchemesSheet.svelte";
  import { taxJurisdictionLabel } from "$lib/asset-tax-scheme.js";
  import { createResourceStream } from "$lib/sse.js";
  import type { AssetTaxSchemeVersion } from "$lib/server/queries/asset-tax-schemes.js";
  import "$lib/components/tax-worksheets/tax-worksheets.css";
  import "$lib/components/reports/reports.css";
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
    toast.success(
      "Custom scheme version saved. Existing applications remain unchanged.",
    );
  }
</script>

<DetailPage
  backHref={canSeeSettings ? resolve("/(app)/settings") : resolve("/(app)/tax")}
  backLabel={canSeeSettings ? "Settings" : "Annual tax"}
>
  {#snippet hero()}<div class="detail-hero-eyebrow">Settings · Tax</div>
    <h1 class="detail-hero-title">Asset tax schemes</h1>
    <p class="detail-hero-note">
      Configure reusable schemes once, then select them in annual tax
      worksheets. Create a new version when rates or conditions change.
    </p>{/snippet}
  {#snippet actions()}{#if canManage}<Button size="sm" onclick={() => open()}
        ><Plus size={14} />New custom scheme</Button
      >{/if}{/snippet}
  {#snippet main()}
    <section class="detail-card">
      <div class="detail-card-head">
        <h2 class="detail-card-title">Reusable schemes</h2>
      </div>
      <div class="tax-stack">
        {#if !canManage}<p class="field-hint">
            Read-only. Changing schemes requires Tax → Update permission.
          </p>{/if}
        {#if latest.length === 0}<p class="card-empty">
            No schemes configured yet. Add a custom scheme here; you do not need
            to create an annual worksheet first.
          </p>{:else}
          {#each latest as scheme (scheme.id)}<article
              class="tax-item tax-stack"
            >
              <div class="tax-item-head">
                <div>
                  <strong>{scheme.definition.name}</strong>
                  <p class="field-hint">
                    {taxJurisdictionLabel(scheme.definition.jurisdiction)} · Version
                    {scheme.version} · Custom / unverified
                  </p>
                </div>
                {#if canManage}<button
                    type="button"
                    class="detail-card-action"
                    onclick={() => open(scheme.familyKey)}
                    >Edit as new version</button
                  >{/if}
              </div>
              <dl class="detail-list tax-summary">
                <div class="detail-row">
                  <dt class="detail-key">Effective tax years</dt>
                  <dd class="detail-val">
                    {scheme.definition.yearFrom}–{scheme.definition.yearTo ??
                      "onwards"}
                  </dd>
                </div>
                <div class="detail-row">
                  <dt class="detail-key">First-year rate</dt>
                  <dd class="detail-val">
                    {scheme.definition.firstYearRateBps / 100}%
                  </dd>
                </div>
                <div class="detail-row">
                  <dt class="detail-key">Regular rate</dt>
                  <dd class="detail-val">
                    {scheme.definition.regularRateBps / 100}%
                  </dd>
                </div>
                <div class="detail-row">
                  <dt class="detail-key">Regular basis</dt>
                  <dd class="detail-val">
                    {scheme.definition.method === "original_cost"
                      ? "Business-use qualifying cost"
                      : "Remaining tax residual"}
                  </dd>
                </div>
              </dl>
              <p class="field-hint">Reference: {scheme.definition.reference}</p>
              {#if scheme.definition.conditions}<p class="field-hint">
                  {scheme.definition.conditions}
                </p>{/if}
            </article>{/each}
        {/if}
      </div>
    </section>
    <ReportNotes
      notes={[
        "Schemes are custom calculation definitions, not verified country rules. Scheme edits create new versions; existing asset applications and finalised worksheets keep their saved versions.",
        "Annual scheme selection, asset-specific tax basis and deduction utilisation stay in Tax → annual worksheet. No financial journals are posted by this configuration.",
      ]}
    />
  {/snippet}
</DetailPage>
{#if editing}<AssetTaxSchemesSheet
    {schemes}
    initialFamilyKey={familyKey}
    onclose={() => (editing = false)}
    onsaved={saved}
  />{/if}
