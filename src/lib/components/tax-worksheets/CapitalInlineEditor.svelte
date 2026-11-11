<script lang="ts">
  import { untrack } from "svelte";
  import { beforeNavigate, goto } from "$app/navigation";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Textarea } from "$lib/components/ui/textarea/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import * as Select from "$lib/components/ui/select/index.js";
  import Disclosure from "$lib/components/ui/Disclosure.svelte";
  import ConfirmDialog from "$lib/components/ui/ConfirmDialog.svelte";
  import ReportNotes from "$lib/components/reports/ReportNotes.svelte";
  import CapitalClaimSummary from "./CapitalClaimSummary.svelte";
  import CapitalAssetFields from "./CapitalAssetFields.svelte";
  import {
    editorRows,
    editorSchemes,
    editorUses,
    editorPreview,
    editorSchemeChoices,
  } from "./capital-editor.js";
  import { schemeApplies } from "$lib/asset-tax-scheme.js";
  import { formatTaxMinor, safeTaxSum } from "$lib/tax-worksheet.js";
  import type { TaxWorksheetDetail as Detail } from "$lib/server/queries/tax-worksheets.js";
  let {
    detail,
    editable,
    dirty = $bindable(false),
    busy = $bindable(false),
    onsaved,
  }: {
    detail: Detail;
    editable: boolean;
    dirty?: boolean;
    busy?: boolean;
    onsaved: (d: Detail) => Promise<void>;
  } = $props();
  let initial = $state(untrack(() => structuredClone($state.snapshot(detail))));
  let rows = $state(
    untrack(() =>
      editorRows(initial.capital.schedule!, initial.worksheet, editable),
    ),
  );
  let uses = $state(
    untrack(() => editorUses(initial.capital.schedule!, initial.worksheet.ya)),
  );
  let remark = $state(untrack(() => initial.capital.schedule!.evidence));
  let expanded = $state<number | null>(null);
  let error = $state("");
  let saving = $state(false);
  let baseline = $state(untrack(fingerprint));
  function fingerprint() {
    return JSON.stringify([rows.map((r) => r.form), uses, remark]);
  }
  const changed = $derived(fingerprint() !== baseline);
  const jurisdiction = $derived(
    initial.capital.schedule!.jurisdiction ??
      (initial.capital.schedule!.calculationVersion === 1 ? "MY" : null),
  );
  const schemes = $derived(editorSchemes(initial.capital.schemes));
  const stale = $derived(
    detail.revision.version !== initial.revision.version ||
      detail.capital.assetsStale ||
      detail.capital.predecessorStale ||
      detail.capital.currencyMismatch ||
      !detail.capital.active,
  );
  const canEdit = $derived(editable && !stale && !saving);
  const money = (n: number | null | undefined) =>
    n == null
      ? "Needs review"
      : formatTaxMinor(n, initial.capital.schedule!.currency);
  function reset(d: Detail) {
    initial = structuredClone($state.snapshot(d));
    rows = editorRows(initial.capital.schedule!, initial.worksheet, editable);
    uses = editorUses(initial.capital.schedule!, initial.worksheet.ya);
    remark = initial.capital.schedule!.evidence;
    baseline = fingerprint();
    error = "";
  }
  $effect(() => {
    if (dirty !== changed) dirty = changed;
    if (busy !== saving) busy = saving;
  });
  // SSE may refresh the page while a form is dirty. Keep its snapshot and require a review.
  $effect(() => {
    if (
      !changed &&
      !saving &&
      JSON.stringify(detail) !== JSON.stringify(initial)
    )
      reset(detail);
  });
  const preview = $derived.by(() => {
    try {
      if (!editable)
        return {
          value: {
            input: initial.capital.schedule!,
            schedule: initial.capital.schedule!,
            totals: initial.capital.totals!,
            errors: [] as string[],
          },
          error: "",
        };
      return {
        value: editorPreview(
          initial.capital.schedule!,
          rows,
          schemes,
          uses,
          remark,
          initial.worksheet,
        ),
        error: "",
      };
    } catch (e) {
      return {
        value: null,
        error: e instanceof Error ? e.message : "Check the deduction inputs.",
      };
    }
  });
  const totals = $derived(preview.value?.totals ?? initial.capital.totals!);
  const baseResult = $derived(
    safeTaxSum([initial.totals.resultMinor, -initial.totals.capitalMinor]),
  );
  const result = $derived(
    safeTaxSum([baseResult, totals.balancingChargeMinor, -totals.usedMinor]),
  );
  function selectScheme(index: number, id: string) {
    const draft = rows[index];
    const wasPending =
      draft.form.treatment === "pending" ||
      (!draft.form.schemeId &&
        initial.capital.schedule!.rows.find((r) => r.assetId === draft.assetId)
          ?.treatment === "pending");
    draft.form.schemeId = id;
    draft.form.treatment = "claim";
    if (wasPending) {
      const asset = initial.capital.schedule!.assets.find(
        (a) => a.assetId === draft.assetId,
      );
      const scheme = schemes.find((s) => String(s.id) === id);
      draft.form.firstYear =
        draft.form.basisMode === "new" &&
        !!asset?.inServiceDate &&
        asset.inServiceDate >= initial.worksheet.dateFrom &&
        asset.inServiceDate <= initial.worksheet.dateTo &&
        !!scheme?.definition.firstYearRateBps;
    }
  }
  let retryKey = "",
    retryPayload = "";
  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (
      !canEdit ||
      !preview.value ||
      preview.error ||
      preview.value.errors.length
    )
      return;
    error = "";
    const payload = {
      action: "save",
      expectedVersion: initial.revision.version,
      liveAssetHash: initial.capital.liveAssetHash,
      reason: "Review and save inline asset deductions",
      input: preview.value.input,
    };
    const encoded = JSON.stringify(payload);
    if (encoded !== retryPayload) {
      retryPayload = encoded;
      retryKey = crypto.randomUUID();
    }
    saving = true;
    try {
      const response = await fetch(
        `/api/tax/${initial.worksheet.id}/capital-allowances`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...payload, requestKey: retryKey }),
        },
      );
      const data = await response.json();
      if (!response.ok) {
        error =
          data.issues?.[0]?.message ??
          data.error ??
          "Could not save deductions.";
        return;
      }
      reset(data);
      await onsaved(data);
    } catch {
      error =
        "The result could not be confirmed. Retry to check the same request.";
    } finally {
      saving = false;
    }
  }
  let confirmLeave = $state(false),
    pendingHref: string | null = null,
    leaving = false;
  beforeNavigate((nav) => {
    if (leaving || !changed || nav.willUnload || !nav.to) return;
    nav.cancel();
    pendingHref = nav.to.url.href;
    confirmLeave = true;
  });
  function discardAndLeave() {
    reset(detail);
    leaving = true;
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- SvelteKit supplied this destination.
    if (pendingHref) void goto(pendingHref);
  }
</script>

<svelte:window
  onbeforeunload={(event) => {
    if (changed) {
      event.preventDefault();
      event.returnValue = "";
    }
  }}
/>
<form onsubmit={save} class="tax-stack" aria-busy={saving}>
  {#if stale && changed}<ReportNotes
      notes={[
        "This worksheet changed while you were editing. Your inputs are kept. Discard them to load the latest worksheet before saving.",
      ]}
      firstIsWarning
    />{/if}
  {#if editable}<p class="field-hint">
      Review suggested costs, business use and first-year treatment before
      saving. Choose a scheme to include an asset.
    </p>{/if}
  {#if rows.length}<div class="tax-table-wrap inline-assets">
      <table class="rep-table">
        <thead
          ><tr
            ><th>Asset</th><th>Scheme</th><th>Business use</th><th
              class="rep-amount">Allowance</th
            ><th>Status</th></tr
          ></thead
        >
        <tbody
          >{#each rows as draft, index (draft.assetId)}
            {@const original = initial.capital.schedule!.rows.find(
              (r) => r.assetId === draft.assetId,
            )!}
            {@const asset = initial.capital.schedule!.assets.find(
              (a) => a.assetId === draft.assetId,
            )!}
            {@const row = totals.rows.find((r) => r.assetId === draft.assetId)}
            {@const choices = editorSchemeChoices(
              schemes,
              original,
              jurisdiction,
              initial.worksheet.ya,
            )}
            <tr>
              <td data-label="Asset"
                ><button
                  type="button"
                  class="detail-card-action"
                  aria-expanded={expanded === draft.assetId}
                  aria-controls={`asset-inline-${draft.assetId}`}
                  onclick={() =>
                    (expanded =
                      expanded === draft.assetId ? null : draft.assetId)}
                  >{asset.name}</button
                >
                <p class="field-hint">
                  {draft.form.businessSource || "Choose business source"}
                </p>
                <button
                  type="button"
                  class="detail-card-action"
                  onclick={() =>
                    (expanded =
                      expanded === draft.assetId ? null : draft.assetId)}
                  >{expanded === draft.assetId
                    ? "Hide details"
                    : "View calculation / change"}</button
                ></td
              >
              <td data-label="Scheme"
                ><Select.Root
                  type="single"
                  value={draft.form.schemeId}
                  disabled={!canEdit || !jurisdiction}
                  onValueChange={(id) => selectScheme(index, id)}
                  ><Select.Trigger
                    class="w-full justify-between"
                    aria-label={`Scheme for ${asset.name}`}
                    >{choices.find((s) => String(s.id) === draft.form.schemeId)
                      ?.definition.name ??
                      (original.treatment === "claim" && !original.schemeId
                        ? "Retained manual"
                        : "Select scheme")}</Select.Trigger
                  ><Select.Content
                    >{#each choices as scheme (scheme.id)}<Select.Item
                        value={String(scheme.id)}
                        label={`${scheme.definition.name} · v${scheme.version}`}
                        disabled={!schemeApplies(
                          scheme.definition,
                          jurisdiction,
                          initial.worksheet.ya,
                        )}
                      />{/each}</Select.Content
                  ></Select.Root
                ></td
              >
              <td data-label="Business use"
                ><Input
                  aria-label={`Business use (%) for ${asset.name}`}
                  value={draft.form.percentage}
                  oninput={(event) => {
                    draft.form.percentage = event.currentTarget.value;
                    if (draft.form.treatment === "pending")
                      draft.form.treatment = "claim";
                  }}
                  inputmode="decimal"
                  disabled={!canEdit || draft.form.treatment === "exclude"}
                  class="business-use-input"
                />{#if draft.form.firstYear && draft.form.treatment === "claim"}<p
                    class="field-hint"
                  >
                    Includes first-year allowance · change in details
                  </p>{/if}</td
              >
              <td data-label="Allowance" class="rep-amount"
                >{draft.form.treatment === "claim"
                  ? money(row?.allowanceMinor)
                  : "—"}</td
              >
              <td data-label="Status"
                >{draft.form.treatment === "exclude"
                  ? "Excluded"
                  : preview.error ||
                      preview.value?.errors.length ||
                      row?.issues.length ||
                      draft.form.treatment === "pending"
                    ? "Needs review"
                    : "Ready"}</td
              >
            </tr>
            {#if expanded === draft.assetId}<tr
                class="inline-detail-row"
                id={`asset-inline-${draft.assetId}`}
                ><td colspan="5"
                  ><div class="inline-detail tax-stack">
                    <CapitalAssetFields
                      bind:draft={rows[index].form}
                      selected={original}
                      {asset}
                      schedule={preview.value?.schedule ??
                        initial.capital.schedule!}
                      {schemes}
                      {jurisdiction}
                      year={initial.worksheet.ya}
                      dateFrom={initial.worksheet.dateFrom}
                      dateTo={initial.worksheet.dateTo}
                      currency={initial.capital.schedule!.currency}
                      readonly={!editable || stale}
                      {saving}
                    />
                  </div></td
                ></tr
              >{/if}
          {/each}</tbody
        >
      </table>
    </div>{:else}<p class="card-empty">
      No registered assets for this period. Earlier allowance balances can still
      be entered below.
    </p>{/if}
  <CapitalClaimSummary
    {totals}
    bind:uses
    year={initial.worksheet.ya}
    currency={initial.capital.schedule!.currency}
    {result}
    {canEdit}
    unavailable={!!preview.error}
  />
  <div class="field">
    <label class="field-label" for="capital-remark">Remark (optional)</label
    ><Textarea
      id="capital-remark"
      bind:value={remark}
      maxlength={2000}
      disabled={!canEdit}
      rows={2}
    />
  </div>
  {#if error || preview.error}<ReportNotes
      notes={[error || preview.error]}
      firstIsWarning
    />{/if}
  {#if preview.value?.errors.length}<ReportNotes
      notes={preview.value.errors}
      firstIsWarning
    />{/if}
  {#if totals.problems.length}<Disclosure
      label={`Needs review (${totals.problems.length})`}
      ><ReportNotes notes={totals.problems} firstIsWarning /></Disclosure
    >{/if}
  {#if editable}<div class="inline-save">
      <span class="field-hint"
        >{changed
          ? "Unsaved asset deductions"
          : "Review assets and claim amounts, then save together."}</span
      ><Button
        type="button"
        variant="outline"
        disabled={saving || !changed}
        onclick={() => reset(detail)}>Discard</Button
      ><Button
        type="submit"
        disabled={!canEdit ||
          !preview.value ||
          !!preview.error ||
          !!preview.value.errors.length}
        >{saving ? "Saving…" : "Save asset deductions"}</Button
      >
    </div>{/if}
</form>
<ConfirmDialog
  bind:open={confirmLeave}
  title="Discard unsaved asset deductions?"
  description="Your asset and claim changes have not been saved."
  confirmLabel="Discard and leave"
  danger
  onConfirm={discardAndLeave}
/>

<style>
  .inline-detail {
    padding: 16px;
    background: var(--muted);
    border-radius: var(--radius);
  }
  .inline-save {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    align-items: center;
    gap: 8px;
    border-top: 1px solid var(--border);
    padding-top: 16px;
  }
  .inline-save > span {
    margin-right: auto;
  }
  .inline-assets :global(.business-use-input) {
    width: 84px;
  }
  @media (max-width: 767px) {
    .inline-assets {
      overflow: visible;
    }
    .inline-assets thead {
      display: none;
    }
    .inline-assets table,
    .inline-assets tbody,
    .inline-assets tr,
    .inline-assets td {
      display: block;
      width: 100%;
    }
    .inline-assets tr {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      padding: 12px;
      gap: 12px;
      border-bottom: 1px solid var(--border);
    }
    .inline-assets td {
      border: 0;
      padding: 0;
      white-space: normal;
      text-align: left;
    }
    .inline-assets td::before {
      content: attr(data-label);
      display: block;
      font-size: 11px;
      color: var(--muted-foreground);
      margin-bottom: 4px;
    }
    .inline-assets td:first-child {
      grid-column: 1 / -1;
    }
    .inline-assets .inline-detail-row {
      display: block;
    }
  }
</style>
