<script lang="ts">
  import { untrack } from "svelte";
  import { resolve } from "$app/paths";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Checkbox } from "$lib/components/ui/checkbox/index.js";
  import Disclosure from "$lib/components/ui/Disclosure.svelte";
  import ReportNotes from "$lib/components/reports/ReportNotes.svelte";
  import TaxJurisdictionField from "./TaxJurisdictionField.svelte";
  import CapitalInlineEditor from "./CapitalInlineEditor.svelte";
  import CapitalAllowanceSheet, {
    type CapitalSheetMode,
  } from "./CapitalAllowanceSheet.svelte";
  import { taxJurisdictionLabel } from "$lib/asset-tax-scheme.js";
  import type { TaxWorksheetDetail as Detail } from "$lib/server/queries/tax-worksheets.js";
  let {
    detail,
    editable,
    canReadAssets,
    dirty = $bindable(false),
    busy = $bindable(false),
    onsaved,
  }: {
    detail: Detail;
    editable: boolean;
    canReadAssets: boolean;
    dirty?: boolean;
    busy?: boolean;
    onsaved: (d: Detail) => Promise<void>;
  } = $props();
  const c = $derived(detail.capital);
  let mode = $state<CapitalSheetMode | null>(null);
  let editorBusy = $state(false),
    setupBusy = $state(false),
    error = $state("");
  let jurisdiction = $state<string | null>(
    untrack(() => c.schedule?.jurisdiction ?? c.rollover?.jurisdiction ?? null),
  );
  let usePrevious = $state(untrack(() => !c.schedule && !!c.rollover));
  let replaceManual = $state(false);
  const overlaps = $derived(
    detail.adjustments.filter(
      (a) =>
        a.withdrawnAt === null &&
        ["capital_allowance", "allowance_brought_forward"].includes(a.kind),
    ),
  );
  const stale = $derived(
    c.assetsStale || c.predecessorStale || c.currencyMismatch,
  );
  $effect(() => {
    busy = editorBusy || setupBusy;
  });
  let retryPayload = "",
    retryKey = "";
  async function setup(event: SubmitEvent) {
    event.preventDefault();
    if (setupBusy || !editable) return;
    const payload = {
      action: usePrevious && c.rollover ? "rollover" : "prepare",
      expectedVersion: detail.revision.version,
      liveAssetHash: c.liveAssetHash,
      reason: "Set up inline asset deductions",
      replaceManual,
      ...(usePrevious && c.rollover
        ? { rolloverHash: c.rolloverHash }
        : { jurisdiction }),
    };
    const encoded = JSON.stringify(payload);
    if (encoded !== retryPayload) {
      retryPayload = encoded;
      retryKey = crypto.randomUUID();
    }
    setupBusy = true;
    error = "";
    try {
      const response = await fetch(
        `/api/tax/${detail.worksheet.id}/capital-allowances`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...payload, requestKey: retryKey }),
        },
      );
      const result = await response.json();
      if (!response.ok) {
        error = result.error ?? "Could not set up asset deductions.";
        return;
      }
      await onsaved(result);
    } catch {
      error =
        "The result could not be confirmed. Retry to check the same request.";
    } finally {
      setupBusy = false;
    }
  }
</script>

<section class="detail-card" aria-labelledby="capital-allowances-title">
  <div class="detail-card-head">
    <h2 id="capital-allowances-title" class="detail-card-title">
      Asset tax deductions
    </h2>
  </div>
  <div class="tax-stack">
    {#if !c.active && editable}<form onsubmit={setup} class="tax-stack">
        <p class="field-hint">
          Set up asset deductions to review assets and claim amounts together.
        </p>
        {#if c.rollover}<div class="tax-filter">
            <Checkbox
              id="capital-bring-forward"
              bind:checked={usePrevious}
              disabled={setupBusy}
            /><label for="capital-bring-forward"
              >Bring forward finalised YA {c.rollover.predecessor?.ya} balances</label
            >
          </div>{/if}
        {#if usePrevious && c.rollover}<p class="field-hint">
            {c.rollover.rows.length} assets · {taxJurisdictionLabel(
              c.rollover.jurisdiction,
            )} · {c.rollover.currency}. Opening tax balances and unused
            allowances will be brought forward for review.
          </p>{:else}<TaxJurisdictionField
            bind:value={jurisdiction}
            disabled={setupBusy}
          />{/if}
        {#if overlaps.length}<div class="tax-filter">
            <Checkbox
              id="capital-replace-manual"
              bind:checked={replaceManual}
              disabled={setupBusy}
            /><label for="capital-replace-manual"
              >Replace {overlaps.length} existing manual allowance entries (history
              retained)</label
            >
          </div>{/if}
        <div>
          <Button
            type="submit"
            disabled={setupBusy ||
              (overlaps.length > 0 && !replaceManual) ||
              (!(usePrevious && c.rollover) && !jurisdiction)}
            >{setupBusy ? "Setting up…" : "Set up asset deductions"}</Button
          >
        </div>
      </form>{/if}
    {#if c.active}<p class="field-hint">
        {taxJurisdictionLabel(
          c.schedule?.jurisdiction ??
            (c.schedule?.calculationVersion === 1 ? "MY" : null),
        )} · {c.schedule?.currency} · Schemes are custom calculation rules.
      </p>{/if}
    {#if c.active && editable && !c.schemes.length}<p class="field-hint">
        No schemes configured. <a
          class="detail-card-action"
          href={resolve("/(app)/settings/tax")}>Create a scheme</a
        > to calculate allowances.
      </p>{/if}
    {#if c.active && editable && c.schedule?.calculationVersion === 2 && !c.schedule.jurisdiction}<Button
        type="button"
        size="sm"
        variant="outline"
        disabled={dirty || busy}
        onclick={() => (mode = "jurisdiction")}>Select tax jurisdiction</Button
      >{/if}
    {#if c.active && stale}<ReportNotes
        notes={[
          c.currencyMismatch
            ? "The schedule currency differs from the worksheet. Review a matching-currency rollover or switch to manual totals; amounts are not converted."
            : c.assetsStale
              ? "Asset records changed. Use Review updated assets below, then check the affected calculations."
              : "The preceding tax year changed. Bring forward its updated balances and review the calculations.",
        ]}
        firstIsWarning
      />{/if}
    {#if error}<ReportNotes notes={[error]} firstIsWarning />{/if}
    {#if c.schedule}<CapitalInlineEditor
        {detail}
        editable={editable && c.active && !stale}
        bind:dirty
        bind:busy={editorBusy}
        {onsaved}
      />{/if}
    <Disclosure label="More options">
      <div class="tax-actions">
        <a class="detail-card-action" href={resolve("/(app)/settings/tax")}
          >Manage schemes</a
        >
        {#if canReadAssets}<a
            class="detail-card-action"
            href={resolve("/(app)/assets")}>Asset register</a
          >{/if}
        {#if editable}
          {#if c.schedule && c.assetsStale}<Button
              type="button"
              variant="outline"
              size="sm"
              disabled={dirty || busy}
              onclick={() => (mode = "refresh-assets")}
              >Review updated assets</Button
            >{/if}
          {#if c.active && c.rollover}<Button
              type="button"
              variant="outline"
              size="sm"
              disabled={dirty || busy}
              onclick={() => (mode = "rollover")}
              >Review prior-year balances</Button
            >{/if}
          {#if c.active}<Button
              type="button"
              variant="outline"
              size="sm"
              disabled={dirty || busy}
              onclick={() => (mode = "jurisdiction")}
              >Change jurisdiction</Button
            ><Button
              type="button"
              variant="outline"
              size="sm"
              disabled={dirty || busy}
              onclick={() => (mode = "manual")}>Use manual totals</Button
            >{/if}
        {/if}
      </div>
    </Disclosure>
  </div>
</section>
{#if mode}<CapitalAllowanceSheet
    {mode}
    {detail}
    onclose={() => (mode = null)}
    {onsaved}
  />{/if}
