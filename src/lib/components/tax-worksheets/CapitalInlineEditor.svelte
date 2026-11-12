<script lang="ts">
  import { untrack } from "svelte";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Textarea } from "$lib/components/ui/textarea/index.js";
  import * as Select from "$lib/components/ui/select/index.js";
  import Disclosure from "$lib/components/ui/Disclosure.svelte";
  import ReportNotes from "$lib/components/reports/ReportNotes.svelte";
  import CapitalClaimSummary from "./CapitalClaimSummary.svelte";
  import CapitalAssetFields from "./CapitalAssetFields.svelte";
  import TaxJurisdictionField from "./TaxJurisdictionField.svelte";
  import {
    editorRows,
    editorSchemes,
    editorUses,
    editorPreview,
    editorSchemeChoices,
    mergeEditorRows,
  } from "./capital-editor.js";
  import { schemeApplies } from "$lib/asset-tax-scheme.js";
  import { formatTaxMinor } from "$lib/tax-worksheet.js";
  import type { TaxWorksheetDetail as Detail } from "$lib/server/queries/tax-worksheets.js";
  import type { CapitalDraft } from "./worksheet-draft.js";
  import type { TaxAdjustment } from "$lib/tax-worksheet.js";
  import type { UtilisationPolicy } from "$lib/capital-utilisation-policy.js";
  let {
    detail,
    editable,
    saving = false,
    adjustments,
    dirty = $bindable(false),
    draft = $bindable(null),
  }: {
    detail: Detail;
    editable: boolean;
    saving?: boolean;
    adjustments: TaxAdjustment[];
    dirty?: boolean;
    draft?: CapitalDraft | null;
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
  let jurisdiction = $state(
    untrack(() => initial.capital.schedule!.jurisdiction ?? null),
  );
  let policy = $state<UtilisationPolicy | null>(
    untrack(() => initial.capital.schedule!.utilisationPolicy ?? null),
  );
  const utilisationContext = $derived(
    detail.capital.utilisationBasis
      ? {
          hash: detail.capital.utilisationBasis.hash,
          businessIncomeAccounts:
            detail.capital.utilisationBasis.businessIncomeAccounts,
          snapshot: detail.revision.snapshot,
          adjustments,
        }
      : null,
  );
  let expanded = $state<number | null>(null);
  let removedEditedAsset = $state(false);
  let baseline = $state(untrack(fingerprint));
  function fingerprint() {
    return JSON.stringify([
      rows.map((r) => r.form),
      uses,
      remark,
      jurisdiction,
      policy,
    ]);
  }
  const changed = $derived(fingerprint() !== baseline);
  const schemes = $derived(editorSchemes(detail.capital.schemes));
  const stale = $derived(
    detail.revision.version !== initial.revision.version && changed,
  );
  const canEdit = $derived(
    editable && !stale && !removedEditedAsset && !saving,
  );
  const money = (n: number | null | undefined) =>
    n == null
      ? "Needs review"
      : formatTaxMinor(n, initial.capital.schedule!.currency);
  // Accounting events may change evidence without changing the saved worksheet version.
  // Merge untouched inputs while keeping edited forms, and never silently rebase another user's save.
  $effect(() => {
    if (JSON.stringify(detail) === JSON.stringify(initial) || saving || stale)
      return;
    const next = structuredClone($state.snapshot(detail));
    const nextRows = editorRows(
      next.capital.schedule!,
      next.worksheet,
      editable,
    );
    if (
      rows.some(
        (old) =>
          JSON.stringify(old.form) !== old.baseline &&
          !nextRows.some((fresh) => fresh.assetId === old.assetId),
      )
    ) {
      removedEditedAsset = true;
      return;
    }
    if (!changed) {
      rows = nextRows;
      uses = editorUses(next.capital.schedule!, next.worksheet.ya);
      remark = next.capital.schedule!.evidence;
      jurisdiction = next.capital.schedule!.jurisdiction ?? null;
      policy = next.capital.schedule!.utilisationPolicy ?? null;
      initial = next;
      baseline = fingerprint();
    } else {
      rows = mergeEditorRows(rows, nextRows);
      initial = next;
    }
  });
  const preview = $derived.by(() => {
    try {
      if (!editable)
        return {
          value: {
            input: null,
            schedule: initial.capital.schedule!,
            totals: initial.capital.totals!,
            errors: [] as string[],
          },
          error: "",
        };
      return {
        value: editorPreview(
          {
            ...initial.capital.schedule!,
            jurisdiction,
            utilisationPolicy: policy ?? undefined,
          },
          rows,
          schemes,
          uses,
          remark,
          initial.worksheet,
          initial.capital.firstYearContexts,
          utilisationContext,
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
  $effect(() => {
    if (dirty !== changed) dirty = changed;
    const nextDraft = {
      input: preview.value?.input ?? null,
      totals: preview.value?.totals ?? null,
      liveAssetHash: initial.capital.liveAssetHash,
      rolloverHash: initial.capital.rolloverHash,
      utilisationHash: utilisationContext?.hash,
      errors: [
        ...(removedEditedAsset
          ? [
              "An edited asset was removed from the register. Your inputs are kept; discard worksheet changes to load the latest assets.",
            ]
          : []),
        preview.error,
        ...(preview.value?.errors ?? []),
        ...(stale
          ? [
              "This worksheet was saved elsewhere. Discard your changes to load the latest version.",
            ]
          : []),
      ].filter(Boolean),
      problems: totals.problems,
    };
    if (JSON.stringify(draft) !== JSON.stringify(nextDraft)) draft = nextDraft;
  });
  function selectScheme(index: number, id: string) {
    rows[index].form.schemeId = id;
    rows[index].form.treatment = "claim";
    rows[index].form.firstYearMode = "auto";
  }
</script>

<div class="tax-stack" aria-busy={saving}>
  {#if editable && !jurisdiction}<TaxJurisdictionField
      bind:value={jurisdiction}
      disabled={!canEdit}
    />{/if}
  {#if stale}<ReportNotes
      notes={[
        "This worksheet was saved elsewhere. Your inputs are kept. Discard changes from the worksheet actions to load the latest version.",
      ]}
      firstIsWarning
    />{/if}
  {#if initial.capital.totals?.problems.some( (p) => p.includes("First-year allowance history changed"), )}<ReportNotes
      notes={[
        "Earlier tax history changed. Review the first-year treatment below and save the worksheet again before finalising.",
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
                      ?.definition.name ?? "Select scheme"}</Select.Trigger
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
                />{#if draft.form.treatment === "claim"}<p class="field-hint">
                    {row?.treatment === "claim" && row.firstYearTreatment
                      ? row.firstYearTreatment.included
                        ? row.firstYearTreatment.confirmation === "pending_save"
                          ? "Calculated · confirmed on save"
                          : "Initial allowance applied"
                        : "Initial allowance not applied"
                      : original.treatment === "claim" &&
                          draft.form.firstYearMode === "retained"
                        ? "Saved first-year treatment"
                        : "Choose a scheme to calculate"}
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
                      readonly={!canEdit}
                      {saving}
                      firstYearContext={initial.capital.firstYearContexts[
                        draft.assetId
                      ]}
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
    bind:policy
    evidence={preview.value?.schedule.utilisationEvidence}
    bind:uses
    year={initial.worksheet.ya}
    currency={initial.capital.schedule!.currency}
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
  {#if preview.error}<ReportNotes notes={[preview.error]} firstIsWarning />{/if}
  {#if preview.value?.errors.length}<ReportNotes
      notes={preview.value.errors}
      firstIsWarning
    />{/if}
  {#if totals.problems.length}<Disclosure
      label={`Needs review (${totals.problems.length})`}
      ><ReportNotes notes={totals.problems} firstIsWarning /></Disclosure
    >{/if}
  {#if editable}<p class="field-hint">
      Saving confirms the selected schemes, business use and first-year
      treatment for all included assets.
    </p>{/if}
  {#if editable}<p class="field-hint">
      Changes are saved with the worksheet’s Save draft or Finalise action.
    </p>{/if}
</div>

<style>
  .inline-detail {
    padding: 16px;
    background: var(--muted);
    border-radius: var(--radius);
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
