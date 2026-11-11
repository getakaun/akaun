<script lang="ts">
  import Disclosure from "$lib/components/ui/Disclosure.svelte";
  import type { FirstYearContext } from "$lib/first-year-allowance.js";
  import { SvelteMap } from "svelte/reactivity";
  import * as Select from "$lib/components/ui/select/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Textarea } from "$lib/components/ui/textarea/index.js";
  import { Checkbox } from "$lib/components/ui/checkbox/index.js";
  import DatePicker from "$lib/components/ui/date-picker/DatePicker.svelte";
  import ReportNotes from "$lib/components/reports/ReportNotes.svelte";
  import { formatTaxMinor } from "$lib/tax-worksheet.js";
  import { resolve } from "$app/paths";
  import {
    schemeApplies,
    assetTaxSchemeRemark,
    type AppliedAssetTaxScheme,
  } from "$lib/asset-tax-scheme.js";
  import {
    capitalTotals,
    type CapitalRowInput,
    type CapitalSchedule,
    type CapitalAssetEvidence,
  } from "$lib/capital-allowance.js";
  import {
    assetTaxRowFromForm,
    assetTaxFirstYearStatus,
    amountInput,
    type AssetTaxForm,
  } from "./asset-tax-form.js";
  let {
    draft = $bindable(),
    selected,
    asset,
    schedule,
    schemes,
    jurisdiction,
    year,
    dateFrom,
    dateTo,
    currency,
    readonly = false,
    saving = false,
    firstYearContext,
  }: {
    draft: AssetTaxForm;
    selected: CapitalRowInput;
    asset: CapitalAssetEvidence | undefined;
    schedule: CapitalSchedule;
    schemes: AppliedAssetTaxScheme[];
    jurisdiction: string | null;
    year: number;
    dateFrom: string;
    dateTo: string;
    currency: string;
    readonly?: boolean;
    saving?: boolean;
    firstYearContext?: FirstYearContext;
  } = $props();
  const money = (n: number) => formatTaxMinor(n, currency);
  const choices = $derived.by(() => {
    const latest = new SvelteMap<string, AppliedAssetTaxScheme>();
    for (const scheme of schemes) {
      if (schemeApplies(scheme.definition, jurisdiction, year)) {
        const old = latest.get(scheme.familyKey);
        if (!old || old.version < scheme.version)
          latest.set(scheme.familyKey, scheme);
      }
    }
    const result = [...latest.values()];
    const applied =
      schemes.find((s) => String(s.id) === draft.schemeId) ??
      selected.appliedScheme;
    if (applied && !result.some((s) => s.id === applied.id))
      result.push(applied);
    return result;
  });
  const activeScheme = $derived(
    choices.find((s) => String(s.id) === draft.schemeId),
  );
  const previewState = $derived.by(() => {
    try {
      const row =
        readonly || (!draft.schemeId && selected.treatment === "claim")
          ? selected
          : assetTaxRowFromForm(
              selected,
              draft,
              year,
              choices,
              firstYearContext
                ? { context: firstYearContext, asset, dateFrom, dateTo }
                : undefined,
            );
      const rowPreview =
        capitalTotals(
          {
            ...schedule,
            jurisdiction,
            rows: schedule.rows.map((r) =>
              r.assetId === row.assetId ? row : r,
            ),
          },
          year,
          dateFrom,
          dateTo,
        ).rows.find((r) => r.assetId === row.assetId) ?? null;
      return { row: rowPreview, error: "" };
    } catch (error) {
      return {
        row: null,
        error: error instanceof Error ? error.message : "Check the tax basis.",
      };
    }
  });
  const rowPreview = $derived(previewState.row);
  const firstYearStatus = $derived(
    readonly
      ? {
          included: selected.schemeFirstYear ?? false,
          confirmation: selected.firstYearTreatment?.confirmation,
          reason:
            selected.firstYearTreatment?.confirmation === "worksheet_save"
              ? "Treatment confirmed when saving asset deductions."
              : (selected.firstYearTreatment?.reason ??
                "Using the saved first-year treatment."),
        }
      : assetTaxFirstYearStatus(selected, draft, year, choices, {
          context: firstYearContext,
          asset,
          dateFrom,
          dateTo,
        }),
  );
  const retainedManual = $derived(
    selected.treatment === "claim" &&
      (!selected.schemeId || selected.schemeOverride),
  );
  function changeBasis(mode: string) {
    if (mode !== "new" && mode !== "existing" && mode !== "detailed") return;
    draft.basisMode = mode;
    if (mode === "existing") {
      draft.amounts.openingResidualMinor = "";
      draft.amounts.additionsMinor = "0.00";
      draft.firstYear = false;
      draft.firstYearMode = "auto";
    }
  }
</script>

<div>
  <strong>{asset?.name}</strong>
  <p class="field-hint">
    Purchased {asset?.acquisitionDate} · Book cost {money(
      asset?.costMinor ?? 0,
    )}
  </p>
</div>
{#if asset?.reviewReason}<ReportNotes
    notes={[asset.reviewReason]}
    firstIsWarning
  />{/if}
<div class="field">
  <label class="field-label" for="ca-treatment">Tax treatment</label>
  <Select.Root
    type="single"
    bind:value={draft.treatment}
    disabled={saving || readonly}
  >
    <Select.Trigger id="ca-treatment" class="w-full justify-between"
      >{draft.treatment === "claim"
        ? "Claim allowance"
        : draft.treatment === "exclude"
          ? "Exclude asset"
          : "Needs review"}</Select.Trigger
    >
    <Select.Content>
      <Select.Item value="pending" label="Needs review" />
      <Select.Item value="claim" label="Claim allowance" />
      <Select.Item value="exclude" label="Exclude asset" />
    </Select.Content>
  </Select.Root>
</div>
{#if draft.treatment === "claim"}
  <div class="field">
    <label class="field-label" for="asset-tax-scheme">Calculation scheme</label>
    <Select.Root
      type="single"
      value={draft.schemeId}
      disabled={saving || readonly || !jurisdiction}
      onValueChange={(id) => {
        draft.schemeId = id;
      }}
    >
      <Select.Trigger id="asset-tax-scheme" class="w-full justify-between"
        >{activeScheme
          ? activeScheme.definition.name
          : readonly
            ? "Retained manual calculation"
            : "Select a scheme"}</Select.Trigger
      >
      <Select.Content
        >{#each choices as scheme (scheme.id)}
          <Select.Item
            value={String(scheme.id)}
            label={`${scheme.definition.name} · v${scheme.version}`}
            disabled={!schemeApplies(scheme.definition, jurisdiction, year)}
          />
        {/each}</Select.Content
      >
    </Select.Root>
    {#if !readonly}<p class="field-hint">
        {#if !jurisdiction}Set the tax jurisdiction under Deductions used and
          evidence first.
        {:else}{#if !choices.some( (s) => schemeApplies(s.definition, jurisdiction, year), )}No
            matching scheme for this jurisdiction and tax year. Create one in{:else}Choose
            rates configured in{/if}
          <a class="detail-card-action" href={resolve("/(app)/settings/tax")}
            >Tax settings</a
          >.{/if}
      </p>{/if}
    {#if activeScheme && assetTaxSchemeRemark(activeScheme.definition)}<p
        class="field-hint"
      >
        {assetTaxSchemeRemark(activeScheme.definition)}
      </p>{/if}
  </div>
  {#if retainedManual && !readonly && !draft.schemeId}<p class="field-hint">
      Previously entered amounts are retained below. Choose a scheme to
      recalculate before saving a claim.
    </p>{/if}
  {#if selected.schemeOverride && !readonly && draft.schemeId}<p
      class="field-hint"
    >
      Saving replaces the previous manual override with the scheme calculation.
    </p>{/if}
  <div class="field">
    <label class="field-label" for="ca-source">Business source</label>
    <Input
      id="ca-source"
      bind:value={draft.businessSource}
      placeholder="e.g. Main trading business"
      maxlength={100}
      required
      disabled={saving || readonly}
    />
    <p class="field-hint">
      Keep the same name for assets belonging to the same business.
    </p>
  </div>
  <div class="field">
    <label class="field-label" for="ca-qualifyingMinor">Qualifying cost</label>
    <Input
      id="ca-qualifyingMinor"
      bind:value={draft.amounts.qualifyingMinor}
      inputmode="decimal"
      required
      disabled={saving || readonly}
    />
    {#if !readonly && asset}<button
        type="button"
        class="detail-card-action"
        disabled={saving}
        onclick={() =>
          (draft.amounts.qualifyingMinor = amountInput(asset.costMinor))}
        >Use book cost</button
      >{/if}
    <p class="field-hint">Eligible cost before business-use adjustment.</p>
  </div>
  <div class="field">
    <label class="field-label" for="ca-use">Business use (%)</label>
    <Input
      id="ca-use"
      bind:value={draft.percentage}
      inputmode="decimal"
      required
      disabled={saving || readonly}
    />
  </div>
  <div class="field">
    <label class="field-label" for="ca-basis">Tax basis</label>
    <Select.Root
      type="single"
      value={draft.basisMode}
      onValueChange={changeBasis}
      disabled={saving || readonly}
    >
      <Select.Trigger id="ca-basis" class="w-full justify-between"
        >{draft.basisMode === "new"
          ? "New qualifying expenditure this year"
          : draft.basisMode === "existing"
            ? "Brought-forward balance"
            : "Retained opening and additions"}</Select.Trigger
      >
      <Select.Content>
        <Select.Item value="new" label="New qualifying expenditure this year" />
        <Select.Item value="existing" label="Brought-forward balance" />
        {#if draft.basisMode === "detailed"}<Select.Item
            value="detailed"
            label="Retained opening and additions"
          />{/if}
      </Select.Content>
    </Select.Root>
  </div>
  {#if draft.basisMode !== "new"}<div class="field">
      <label class="field-label" for="ca-openingResidualMinor"
        >Opening tax balance</label
      >
      <Input
        id="ca-openingResidualMinor"
        bind:value={draft.amounts.openingResidualMinor}
        inputmode="decimal"
        required
        disabled={saving || readonly}
      />
      <p class="field-hint">
        Use the previous tax residual, already adjusted for business use.
      </p>
    </div>{/if}
  {#if activeScheme}
    <div role="status">
      <strong
        >Initial allowance: {firstYearStatus.included === null
          ? "Check inputs"
          : draft.firstYearMode === "retained"
            ? "Saved treatment"
            : firstYearStatus.included
              ? firstYearStatus.confirmation === "pending_save"
                ? "Calculated · confirmed on save"
                : firstYearStatus.confirmation === "worksheet_save"
                  ? "Confirmed on save"
                  : draft.firstYearMode === "auto"
                    ? "Automatically applied"
                    : "Included"
              : "Not applied"}</strong
      >
      <p class="field-hint">{firstYearStatus.reason}</p>
    </div>
    {#if !readonly && activeScheme.definition.firstYearRateBps > 0}
      <Disclosure label="Change first-year treatment">
        <div class="field">
          <label class="field-label" for="first-year-treatment"
            >First-year treatment</label
          >
          <Select.Root
            type="single"
            bind:value={draft.firstYearMode}
            disabled={saving}
          >
            <Select.Trigger
              id="first-year-treatment"
              class="w-full justify-between"
              >{draft.firstYearMode === "auto"
                ? "Automatic"
                : draft.firstYearMode === "include"
                  ? "Include first-year allowance"
                  : draft.firstYearMode === "exclude"
                    ? "Do not apply"
                    : "Previously saved treatment"}</Select.Trigger
            >
            <Select.Content>
              <Select.Item value="auto" label="Automatic" />
              <Select.Item
                value="include"
                label="Include first-year allowance"
              />
              <Select.Item value="exclude" label="Do not apply" />
              {#if draft.firstYearMode === "retained"}<Select.Item
                  value="retained"
                  label="Previously saved treatment"
                  disabled
                />{/if}
            </Select.Content>
          </Select.Root>
          <p class="field-hint">
            Change this only for an exception. Saving asset deductions confirms
            the treatment for all assets together.
          </p>
        </div>
      </Disclosure>
    {/if}
  {/if}
  {#if previewState.error && draft.schemeId}<ReportNotes
      notes={[previewState.error]}
      firstIsWarning
    />{/if}
  {#if rowPreview}<dl
      class="detail-list tax-summary"
      aria-label="Allowance calculation"
    >
      <div class="detail-row">
        <dt class="detail-key">
          {jurisdiction === "MY" ? "Initial allowance" : "First-year deduction"}
        </dt>
        <dd class="detail-val tax-amount">
          {rowPreview.initialMinor === null
            ? "Needs review"
            : money(rowPreview.initialMinor)}
        </dd>
      </div>
      <div class="detail-row">
        <dt class="detail-key">
          {jurisdiction === "MY" ? "Annual allowance" : "Regular deduction"}
        </dt>
        <dd class="detail-val tax-amount">
          {rowPreview.annualMinor === null
            ? "Needs review"
            : money(rowPreview.annualMinor)}
        </dd>
      </div>
      <div class="detail-row">
        <dt class="detail-key">Total allowance</dt>
        <dd class="detail-val tax-amount">
          {money(rowPreview.allowanceMinor)}
        </dd>
      </div>
      <div class="detail-row">
        <dt class="detail-key">Closing tax balance</dt>
        <dd class="detail-val tax-amount">
          {rowPreview.closingResidualMinor === null
            ? "Needs review"
            : money(rowPreview.closingResidualMinor)}
        </dd>
      </div>
    </dl>
    {#if rowPreview.issues.length && (draft.schemeId || readonly)}<ReportNotes
        notes={rowPreview.issues}
        firstIsWarning
      />{/if}{/if}
  <details
    class="tax-disclosure"
    open={!!selected.residualAdjustmentMinor ||
      !!selected.disposal ||
      draft.basisMode === "detailed"}
  >
    <summary>Adjustments and disposal</summary>
    <div class="tax-disclosure-body">
      {#if draft.basisMode !== "new"}<div class="field">
          <label class="field-label" for="ca-additionsMinor"
            >Additional qualifying expenditure this year</label
          >
          <Input
            id="ca-additionsMinor"
            bind:value={draft.amounts.additionsMinor}
            inputmode="decimal"
            disabled={saving || readonly}
          />
          <p class="field-hint">
            Already adjusted for business use. Leave zero when there are no
            additions.
          </p>
        </div>{/if}
      <div class="field">
        <label class="field-label" for="ca-residual-adjust"
          >Tax balance adjustment (+ / −)</label
        >
        <Input
          id="ca-residual-adjust"
          bind:value={draft.residualAdjustment}
          inputmode="decimal"
          disabled={saving || readonly}
        />
      </div>
      {#if selected.ruleReference}<p class="field-hint">
          Saved reference: {selected.ruleReference}
        </p>{/if}
      <div class="tax-filter">
        <Checkbox
          id="ca-disposal"
          bind:checked={draft.disposed}
          disabled={saving || readonly}
        /><label for="ca-disposal">Full tax disposal in this period</label>
      </div>
      {#if draft.disposed}<ReportNotes
          notes={[
            "Tax disposal does not record the asset sale or stop book depreciation. Complete the separate accounting correction with your accountant. Partial disposals and hire purchase are not supported here.",
          ]}
          firstIsWarning
        />
        <div class="field">
          <span class="field-label" id="ca-disposal-date">Disposal date</span
          ><DatePicker
            labelledBy="ca-disposal-date"
            bind:value={draft.disposalDate}
            disabled={saving || readonly}
          />
        </div>
        <div class="field">
          <label class="field-label" for="ca-proceeds">Disposal proceeds</label
          ><Input
            id="ca-proceeds"
            bind:value={draft.proceeds}
            inputmode="decimal"
            disabled={saving || readonly}
          />
        </div>
        <div class="field">
          <label class="field-label" for="ca-ba"
            >Reviewed balancing allowance</label
          ><Input
            id="ca-ba"
            bind:value={draft.balancingAllowance}
            inputmode="decimal"
            disabled={saving || readonly}
          />
        </div>
        <div class="field">
          <label class="field-label" for="ca-bc"
            >Reviewed balancing charge</label
          ><Input
            id="ca-bc"
            bind:value={draft.balancingCharge}
            inputmode="decimal"
            disabled={saving || readonly}
          />
        </div>
        <p class="field-hint">
          Use the Remark below to explain the disposal and its reviewed amounts.
        </p>
        {#if draft.disposalEvidence}<p class="field-hint">
            Saved disposal reference: {draft.disposalEvidence}
          </p>{/if}
      {/if}
    </div>
  </details>
{/if}
<div class="field">
  <label class="field-label" for="ca-note"
    >{draft.treatment === "exclude"
      ? "Remark (reason for exclusion)"
      : draft.treatment === "claim" && Number(draft.residualAdjustment) !== 0
        ? "Remark (explain the adjustment)"
        : draft.treatment === "claim" &&
            draft.disposed &&
            !draft.disposalEvidence
          ? "Remark (disposal reference)"
          : "Remark (optional)"}</label
  >
  <Textarea
    id="ca-note"
    bind:value={draft.note}
    maxlength={2000}
    required={draft.treatment === "exclude" ||
      (draft.treatment === "claim" &&
        ((draft.disposed && !draft.disposalEvidence) ||
          Number(draft.residualAdjustment) !== 0))}
    disabled={saving || readonly}
  />
</div>
