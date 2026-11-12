<script lang="ts">
  import { invalidateAll } from "$app/navigation";
  import { Button } from "$lib/components/ui/button/index.js";
  import ReportNotes from "$lib/components/reports/ReportNotes.svelte";
  import CapitalInlineEditor from "./CapitalInlineEditor.svelte";
  import CapitalRolloverSheet from "./CapitalRolloverSheet.svelte";
  import { taxJurisdictionLabel } from "$lib/asset-tax-scheme.js";
  import type { TaxWorksheetDetail as Detail } from "$lib/server/queries/tax-worksheets.js";
  import type { CapitalDraft } from "./worksheet-draft.js";
  let {
    detail,
    editable,
    saving = false,
    worksheetDirty = false,
    resultBase,
    dirty = $bindable(false),
    draft = $bindable(null),
  }: {
    detail: Detail;
    editable: boolean;
    saving?: boolean;
    worksheetDirty?: boolean;
    resultBase?: number;
    dirty?: boolean;
    draft?: CapitalDraft | null;
  } = $props();
  let rolloverOpen = $state(false);
  const c = $derived(detail.capital);
  $effect(() => {
    if (!c.schedule) {
      dirty = false;
      draft = null;
    }
  });
</script>

<section class="detail-card" aria-labelledby="capital-allowances-title">
  <div class="detail-card-head">
    <h2 id="capital-allowances-title" class="detail-card-title">
      Asset tax deductions
    </h2>
  </div>
  <div class="tax-stack">
    {#if c.schedule}
      <p class="field-hint">
        {taxJurisdictionLabel(c.schedule.jurisdiction)} · {c.schedule.currency}
      </p>
      {#if editable}<p class="hint">
          Assets for this period are shown automatically. Choose a scheme for
          new assets; existing tax balances are brought forward where available.
        </p>{/if}
      {#if editable && !c.schemes.length}<p class="field-hint">
          Configure asset tax schemes in Settings → Tax to calculate allowances.
        </p>{/if}
      {#if c.currencyMismatch}<ReportNotes
          notes={[
            "The retained asset schedule uses another currency. Only matching-currency asset workings can be used; amounts cannot be converted automatically.",
          ]}
          firstIsWarning
        />{/if}
      <CapitalInlineEditor
        {detail}
        editable={editable && !c.currencyMismatch}
        {saving}
        {resultBase}
        bind:dirty
        bind:draft
      />
      {#if editable && c.currencyMismatch && c.rollover}<Button
          variant="outline"
          disabled={worksheetDirty || dirty || saving}
          onclick={() => (rolloverOpen = true)}
          >Use matching prior-year balances</Button
        >{/if}
    {:else}<p class="card-empty">
        No assets recorded for this accounting period.
      </p>{/if}
  </div>
</section>
{#if rolloverOpen}<CapitalRolloverSheet
    {detail}
    onclose={() => (rolloverOpen = false)}
    onsaved={async () => {
      rolloverOpen = false;
      await invalidateAll();
    }}
  />{/if}
