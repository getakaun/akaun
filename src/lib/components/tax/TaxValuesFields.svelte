<script lang="ts">
  import { Input } from "$lib/components/ui/input/index.js";
  import * as Select from "$lib/components/ui/select/index.js";
  import {
    TAX_TREATMENTS,
    TaxTreatmentLabels,
    taxFormValues,
    switchTaxTreatment,
    type TaxTreatment,
    type TaxFormDraft,
  } from "$lib/expense-tax.js";
  let {
    id,
    percentage = $bindable(""),
    treatment = $bindable("requires_review"),
    disabled = false,
    named = false,
    allowNoDefault = false,
    compact = false,
    onchange,
  }: {
    id: string;
    percentage?: string;
    treatment?: string;
    disabled?: boolean;
    named?: boolean;
    allowNoDefault?: boolean;
    compact?: boolean;
    onchange?: (value: TaxFormDraft) => void;
  } = $props();
  let previousPartial = $state("");
  const selected = $derived(
    treatment || (allowNoDefault ? "" : "requires_review"),
  );
  const values = $derived(taxFormValues(selected, percentage, allowNoDefault));
  function choose(value: string) {
    const next = value === "__none__" ? "" : value;
    if (next === selected) return;
    const draft = switchTaxTreatment(
      { treatment: selected, percentage },
      next,
      previousPartial,
    );
    previousPartial = draft.previousPartial;
    treatment = draft.treatment;
    percentage = draft.percentage;
    onchange?.({ treatment, percentage });
  }
</script>

<div class="tax-values" class:compact>
  <div class="field treatment-field">
    <label class="field-label" class:sr-only={compact} for={`${id}-treatment`}
      >Tax treatment</label
    >
    <Select.Root
      type="single"
      value={selected || "__none__"}
      onValueChange={choose}
      {disabled}
    >
      <Select.Trigger id={`${id}-treatment`} class="w-full justify-between">
        {selected
          ? TaxTreatmentLabels[selected as TaxTreatment]
          : "No default — requires review"}
      </Select.Trigger>
      <Select.Content>
        {#if allowNoDefault}<Select.Item
            value="__none__"
            label="No default — requires review"
          />{/if}
        {#each TAX_TREATMENTS as value (value)}<Select.Item
            {value}
            label={TaxTreatmentLabels[value]}
          />{/each}
      </Select.Content>
    </Select.Root>
  </div>
  {#if selected === "partial"}
    <div class="field percentage-field">
      <label
        class="field-label"
        class:sr-only={compact}
        for={`${id}-percentage`}>Potential deduction (%) *</label
      >
      <div class="percentage-input">
        <Input
          id={`${id}-percentage`}
          type="number"
          min="0.01"
          max="99.99"
          step="0.01"
          required
          value={percentage}
          oninput={(event) => {
            percentage = event.currentTarget.value;
            onchange?.({ treatment, percentage });
          }}
          {disabled}
          aria-invalid={values.error ? true : undefined}
          aria-describedby={values.error || !compact
            ? `${id}-percentage-hint`
            : undefined}
        />
        {#if compact}<span aria-hidden="true">%</span>{/if}
      </div>
      {#if values.error || !compact}<p
          id={`${id}-percentage-hint`}
          class="field-hint"
          role={values.error ? "alert" : undefined}
        >
          {values.error
            ? compact
              ? "Use 0.01–99.99%, max 2 decimals."
              : values.error
            : "Greater than 0% and below 100%."}
        </p>{/if}
    </div>
  {:else if selected === "requires_review" || !selected}
    {#if !compact}<p class="field-hint" role="status">
        Needs tax review. Excluded from potential deduction and add-back
        estimates until classified.
      </p>{/if}
  {:else if compact}
    <output class="fixed-percentage" aria-label="Potential deduction percentage"
      >{values.percentageBps === 10000 ? "100%" : "0%"}</output
    >
  {:else}
    <div class="field">
      <label class="field-label" for={`${id}-percentage`}
        >Potential deduction (%) — fixed by treatment</label
      >
      <Input
        id={`${id}-percentage`}
        type="text"
        value={values.percentageBps === 10000 ? "100.00%" : "0.00%"}
        readonly
        {disabled}
      />
      {#if selected === "capital_expenditure"}<p class="field-hint">
          Capital allowances are handled separately.
        </p>{/if}
    </div>
  {/if}
</div>
{#if named}
  <input type="hidden" name="defaultTaxTreatment" value={selected} />
  <input
    type="hidden"
    name="defaultTaxPercentage"
    value={selected === "partial"
      ? percentage
      : values.percentageBps === null
        ? ""
        : (values.percentageBps / 100).toFixed(2)}
  />
{/if}

<style>
  .compact {
    display: flex;
    gap: 0.75rem;
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .compact .field {
    margin: 0;
  }
  .compact .treatment-field {
    flex: 1;
    min-width: min(15rem, 100%);
  }
  .compact .percentage-field {
    width: 9rem;
    max-width: 100%;
  }
  .percentage-input {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .fixed-percentage {
    padding: 0.5rem 0;
    font-variant-numeric: tabular-nums;
    min-width: 3rem;
  }
</style>
