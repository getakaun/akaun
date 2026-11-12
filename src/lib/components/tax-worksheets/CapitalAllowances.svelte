<script lang="ts">
  import { blankCapitalRow } from "$lib/capital-allowance.js";
  import { invalidateAll } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { Button } from "$lib/components/ui/button/index.js";
  import CapitalAllowanceSheet, {
    type CapitalSheetMode,
  } from "./CapitalAllowanceSheet.svelte";
  import { Checkbox } from "$lib/components/ui/checkbox/index.js";
  import Disclosure from "$lib/components/ui/Disclosure.svelte";
  import ReportNotes from "$lib/components/reports/ReportNotes.svelte";
  import CapitalInlineEditor from "./CapitalInlineEditor.svelte";
  import { taxJurisdictionLabel } from "$lib/asset-tax-scheme.js";
  import type { TaxWorksheetDetail as Detail } from "$lib/server/queries/tax-worksheets.js";
  import type { CapitalDraft } from "./worksheet-draft.js";
  let {
    detail,
    editable,
    canReadAssets,
    saving = false,
    worksheetDirty = false,
    resultBase,
    dirty = $bindable(false),
    draft = $bindable(null),
    replaceManual = $bindable(false),
  }: {
    detail: Detail;
    editable: boolean;
    canReadAssets: boolean;
    saving?: boolean;
    worksheetDirty?: boolean;
    resultBase?: number;
    dirty?: boolean;
    draft?: CapitalDraft | null;
    replaceManual?: boolean;
  } = $props();
  let mode = $state<CapitalSheetMode | null>(null);
  let activate = $state(false),
    assetDirty = $state(false);
  const c = $derived(detail.capital);
  const active = $derived((c.active && !c.currencyMismatch) || activate);
  const editingDetail = $derived.by(() => {
    if (!activate || (c.active && !c.currencyMismatch)) return detail;
    const schedule =
      c.rollover ??
      (c.schedule && !c.currencyMismatch
        ? c.schedule
        : {
            calculationVersion: 2 as const,
            currency: detail.revision.snapshot.currency,
            jurisdiction: c.defaultJurisdiction,
            evidence: "",
            assets: c.candidates,
            rows: c.candidates.map((a) =>
              blankCapitalRow(a.assetId, detail.worksheet.ya),
            ),
            utilisation: [],
            predecessor: null,
          });
    return {
      ...detail,
      capital: { ...c, active: true, schedule, currencyMismatch: false },
    };
  });
  $effect(() => {
    dirty = assetDirty || activate;
    if (!active) draft = null;
  });
  const overlaps = $derived(
    detail.adjustments.filter(
      (a) =>
        a.withdrawnAt === null &&
        ["capital_allowance", "allowance_brought_forward"].includes(a.kind),
    ),
  );
</script>

<section class="detail-card" aria-labelledby="capital-allowances-title">
  <div class="detail-card-head">
    <h2 id="capital-allowances-title" class="detail-card-title">
      Asset tax deductions
    </h2>
  </div>
  <div class="tax-stack">
    {#if editable && !c.currencyMismatch && !c.active}<div class="tax-filter">
        <Checkbox
          id="capital-activate"
          bind:checked={activate}
          disabled={saving}
        />
        <label for="capital-activate"
          >{c.currencyMismatch
            ? "Replace the retained asset schedule with current-currency asset workings when saving"
            : "Use asset workings instead of manual allowance totals"}</label
        >
      </div>{/if}
    {#if editingDetail.capital.schedule && active}
      <p class="field-hint">
        {taxJurisdictionLabel(
          editingDetail.capital.schedule.jurisdiction ??
            (editingDetail.capital.schedule.calculationVersion === 1
              ? "MY"
              : null),
        )} · {editingDetail.capital.schedule.currency}
      </p>
      {#if editable}<p class="hint">
          Assets for this period are shown automatically. Choose a scheme for
          new assets; existing tax balances are brought forward where available.
        </p>{/if}
      {#if editable && !c.schemes.length}<p class="field-hint">
          No schemes configured. <a
            class="detail-card-action"
            href={resolve("/(app)/settings/tax")}>Create a scheme</a
          > to calculate allowances.
        </p>{/if}
      {#if c.currencyMismatch}<ReportNotes
          notes={[
            "The retained asset schedule uses another currency. Its amounts cannot be converted automatically.",
          ]}
          firstIsWarning
        />{/if}
      {#if editable && overlaps.length}<div class="tax-filter">
          <Checkbox
            id="capital-replace-manual"
            bind:checked={replaceManual}
            disabled={saving}
          />
          <label for="capital-replace-manual"
            >Replace {overlaps.length} manual allowance entries with this asset schedule
            when saving (history retained)</label
          >
        </div>{/if}
      <CapitalInlineEditor
        detail={editingDetail}
        {editable}
        {saving}
        {resultBase}
        bind:dirty={assetDirty}
        bind:draft
      />
    {:else}<p class="card-empty">
        {c.active || c.schedule
          ? "Asset workings are retained but are not included in the current tax result."
          : "No asset deductions in this revision."}
      </p>{/if}
    <Disclosure label="More options"
      ><div class="tax-actions">
        <a class="detail-card-action" href={resolve("/(app)/settings/tax")}
          >Manage schemes</a
        >
        {#if editable && c.currencyMismatch}<ReportNotes
            notes={[
              "The retained schedule has another currency. Use a matching-currency prior-year schedule or explicitly switch to manual totals.",
            ]}
            firstIsWarning
          />
          {#if c.rollover}<Button
              variant="outline"
              disabled={worksheetDirty || dirty || saving}
              onclick={() => (mode = "rollover")}
              >Use matching prior-year balances</Button
            >{/if}
        {/if}
        {#if editable && c.active}<Button
            variant="outline"
            disabled={worksheetDirty || dirty || saving}
            onclick={() => (mode = "manual")}>Switch to manual totals</Button
          >
        {/if}
        {#if canReadAssets}<a
            class="detail-card-action"
            href={resolve("/(app)/assets")}>Asset register</a
          >{/if}
      </div></Disclosure
    >
  </div>
</section>
{#if mode}<CapitalAllowanceSheet
    {mode}
    {detail}
    onclose={() => (mode = null)}
    onsaved={async () => {
      mode = null;
      await invalidateAll();
    }}
  />{/if}
