<script lang="ts">
  import { SvelteMap } from "svelte/reactivity";
  import * as Select from "$lib/components/ui/select/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Textarea } from "$lib/components/ui/textarea/index.js";
  import { Checkbox } from "$lib/components/ui/checkbox/index.js";
  import DatePicker from "$lib/components/ui/date-picker/DatePicker.svelte";
  import ReportNotes from "$lib/components/reports/ReportNotes.svelte";
  import { formatTaxMinor } from "$lib/tax-worksheet.js";
  import { percentageToBps } from "$lib/expense-tax.js";
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
  const fieldDefinitions = $derived([
    [
      "qualifyingMinor",
      "Qualifying expenditure before business-use adjustment",
    ],
    ["openingResidualMinor", "Opening tax residual expenditure"],
    ["additionsMinor", "This-year qualifying additions"],
    [
      "initialMinor",
      jurisdiction === "MY" ? "Initial allowance (IA)" : "First-year deduction",
    ],
    [
      "annualMinor",
      jurisdiction === "MY" ? "Annual allowance (AA)" : "Regular deduction",
    ],
  ] as const);
  const previewState = $derived.by(() => {
    try {
      const row = assetTaxRowFromForm(selected, draft, year, choices);
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
  let basisError = $state("");
  function reusePurchase() {
    const bps = percentageToBps(draft.percentage);
    if (bps === null) {
      basisError = "Enter business use before reusing the purchase cost.";
      return;
    }
    basisError = "";
    draft.amounts.qualifyingMinor = amountInput(asset!.costMinor);
    draft.amounts.openingResidualMinor = "0.00";
    draft.amounts.additionsMinor = amountInput(
      Number((BigInt(asset!.costMinor) * BigInt(bps) + 5000n) / 10000n),
    );
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
  <label class="field-label" for="ca-treatment">Tax treatment</label
  ><Select.Root
    type="single"
    bind:value={draft.treatment}
    disabled={saving || readonly}
    ><Select.Trigger id="ca-treatment" class="w-full justify-between"
      >{draft.treatment === "claim"
        ? "Prepare allowance workings"
        : draft.treatment === "exclude"
          ? "Exclude with reason"
          : "Needs review"}</Select.Trigger
    ><Select.Content
      ><Select.Item value="pending" label="Needs review" /><Select.Item
        value="claim"
        label="Prepare allowance workings"
      /><Select.Item
        value="exclude"
        label="Exclude with reason"
      /></Select.Content
    ></Select.Root
  >
</div>
{#if draft.treatment === "claim"}
  {#if !jurisdiction}<p class="field-hint">
      Select the tax jurisdiction under Deductions used and evidence before
      choosing a reusable scheme.
    </p>{/if}
  <div class="field">
    <label class="field-label" for="asset-tax-scheme">Calculation scheme</label
    ><Select.Root
      type="single"
      value={draft.schemeId || "manual"}
      disabled={saving || readonly}
      onValueChange={(id) => {
        draft.schemeId = id === "manual" ? "" : id;
        draft.override = false;
        const choice = choices.find((s) => String(s.id) === id);
        if (choice) {
          draft.taxClass = choice.definition.name;
          draft.ruleReference = choice.definition.reference ?? "";
        }
      }}
      ><Select.Trigger id="asset-tax-scheme" class="w-full justify-between"
        >{activeScheme
          ? `${activeScheme.definition.name} · v${activeScheme.version}`
          : "Enter amounts manually"}</Select.Trigger
      ><Select.Content
        ><Select.Item
          value="manual"
          label="Enter amounts manually"
        />{#each choices as scheme (scheme.id)}<Select.Item
            value={String(scheme.id)}
            label={`${scheme.definition.name} · v${scheme.version}`}
          />{/each}</Select.Content
      ></Select.Root
    >
  </div>
  {#if activeScheme}<ReportNotes
      notes={[
        "Custom scheme — not jurisdiction-verified. Confirm its applicability, tax year and conditions before using these amounts.",
        assetTaxSchemeRemark(activeScheme.definition),
      ].filter(Boolean)}
    />
    <div class="tax-filter">
      <Checkbox
        id="scheme-first-year"
        bind:checked={draft.firstYear}
        disabled={saving || readonly}
      /><label for="scheme-first-year"
        >Apply the scheme’s first-year deduction to this-year additions</label
      >
    </div>
    <div class="tax-filter">
      <Checkbox
        id="scheme-override"
        checked={draft.override}
        disabled={saving || readonly}
        onCheckedChange={(checked) => {
          if (checked && rowPreview) {
            draft.amounts.initialMinor = amountInput(rowPreview.initialMinor);
            draft.amounts.annualMinor = amountInput(rowPreview.annualMinor);
          }
          draft.override = checked === true;
        }}
      /><label for="scheme-override"
        >Override calculated amounts with a reason</label
      >
    </div>
    <p class="field-hint">
      {activeScheme.definition.method === "original_cost"
        ? "Regular deduction uses business-use qualifying expenditure."
        : "Regular deduction uses the remaining tax residual after the first-year deduction."}
      Full-period calculation; no proration or statutory elections are inferred.
    </p>{/if}

  <p class="field-hint">
    Enter accountant-reviewed amounts. Qualifying expenditure is before business
    use; all residual, addition and allowance amounts below are already
    business-use adjusted. A selected scheme calculates suggestions; eligibility
    remains your decision.
  </p>
  <div class="field">
    <label class="field-label" for="ca-class">Tax class</label><Input
      id="ca-class"
      bind:value={draft.taxClass}
      placeholder="As confirmed by your accountant"
      maxlength={100}
      disabled={saving || readonly}
    />
  </div>
  <div class="field">
    <label class="field-label" for="ca-source">Business source</label><Input
      id="ca-source"
      bind:value={draft.businessSource}
      placeholder="e.g. Main trading business"
      maxlength={100}
      disabled={saving || readonly}
    />
  </div>
  {#if !readonly && asset && asset.acquisitionDate >= dateFrom}<button
      type="button"
      class="detail-card-action"
      disabled={saving}
      onclick={reusePurchase}>Use purchase cost for this new asset</button
    >{#if basisError}<p class="field-hint" role="alert">
        {basisError}
      </p>{/if}{/if}
  {#each fieldDefinitions as [key, label] (key)}
    <div class="field">
      <label class="field-label" for={`ca-${key}`}>{label}</label><Input
        id={`ca-${key}`}
        value={activeScheme &&
        !draft.override &&
        (key === "initialMinor" || key === "annualMinor")
          ? amountInput(
              key === "initialMinor"
                ? rowPreview?.initialMinor
                : rowPreview?.annualMinor,
            )
          : draft.amounts[key]}
        oninput={(event) =>
          (draft.amounts[key] = String(event.currentTarget.value))}
        readonly={!!activeScheme &&
          !draft.override &&
          (key === "initialMinor" || key === "annualMinor")}
        inputmode="decimal"
        disabled={saving || readonly}
      />
    </div>
    {#if key === "qualifyingMinor"}<div class="field">
        <label class="field-label" for="ca-use">Business use (%)</label><Input
          id="ca-use"
          bind:value={draft.percentage}
          inputmode="decimal"
          disabled={saving || readonly}
        />
      </div>{/if}
  {/each}
  {#if previewState.error}<ReportNotes
      notes={[previewState.error]}
      firstIsWarning
    />{/if}
  {#if rowPreview}<dl class="detail-list tax-summary">
      <div class="detail-row">
        <dt class="detail-key">
          {jurisdiction === "MY"
            ? "Entered IA + AA"
            : "First-year + regular deductions"}
        </dt>
        <dd class="detail-val tax-amount">
          {money(rowPreview.allowanceMinor)}
        </dd>
      </div>
      <div class="detail-row">
        <dt class="detail-key">Closing tax residual</dt>
        <dd class="detail-val tax-amount">
          {rowPreview.closingResidualMinor === null
            ? "Needs review"
            : money(rowPreview.closingResidualMinor)}
        </dd>
      </div>
    </dl>
    {#if rowPreview.issues.length}<ReportNotes
        notes={rowPreview.issues}
        firstIsWarning
      />{/if}{/if}
  <details
    class="tax-disclosure"
    open={!!selected?.residualAdjustmentMinor ||
      !!selected?.ruleReference ||
      draft.disposed}
  >
    <summary>Adjustments, source notes and disposal</summary>
    <div class="tax-disclosure-body">
      <div class="field">
        <label class="field-label" for="ca-residual-adjust"
          >Tax residual adjustment (+ / −)</label
        ><Input
          id="ca-residual-adjust"
          bind:value={draft.residualAdjustment}
          inputmode="decimal"
          disabled={saving || readonly}
        />
      </div>
      <div class="field">
        <label class="field-label" for="ca-rule"
          >Rule or individual working-paper reference</label
        ><Textarea
          id="ca-rule"
          bind:value={draft.ruleReference}
          maxlength={2000}
          disabled={saving || readonly}
        />
        <p class="field-hint">
          Effective YA {year}. A shared working-paper reference can be entered
          under Deductions used and evidence.
        </p>
      </div>
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
        <div class="field">
          <label class="field-label" for="ca-disposal-evidence"
            >Disposal evidence reference</label
          ><Input
            id="ca-disposal-evidence"
            bind:value={draft.disposalEvidence}
            maxlength={2000}
            disabled={saving || readonly}
          />
        </div>
      {/if}
    </div>
  </details>
{/if}
<div class="field">
  <label class="field-label" for="ca-note"
    >{draft.treatment === "exclude"
      ? "Exclusion reason"
      : "Notes / adjustment explanation"}</label
  ><Textarea
    id="ca-note"
    bind:value={draft.note}
    maxlength={2000}
    disabled={saving || readonly}
  />
</div>
