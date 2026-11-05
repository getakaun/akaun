<script lang="ts">
  import { Input } from "$lib/components/ui/input/index.js";
  import * as Select from "$lib/components/ui/select/index.js";
  import {
    TAX_TREATMENTS,
    TaxTreatmentLabels,
    taxFormValues,
    switchTaxTreatment,
    type TaxTreatment,
  } from "$lib/expense-tax.js";
  let {
    id,
    percentage = $bindable(""),
    treatment = $bindable("requires_review"),
    disabled = false,
    named = false,
    allowNoDefault = false,
  }: {
    id: string;
    percentage?: string;
    treatment?: string;
    disabled?: boolean;
    named?: boolean;
    allowNoDefault?: boolean;
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
  }
</script>

<div class="field">
  <label class="field-label" for={`${id}-treatment`}>Tax treatment</label>
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
  <div class="field">
    <label class="field-label" for={`${id}-percentage`}
      >Potential deduction (%) *</label
    >
    <Input
      id={`${id}-percentage`}
      type="number"
      min="0.01"
      max="99.99"
      step="0.01"
      required
      value={percentage}
      oninput={(event) => (percentage = event.currentTarget.value)}
      {disabled}
      aria-invalid={values.error ? true : undefined}
      aria-describedby={`${id}-percentage-hint`}
    />
    <p
      id={`${id}-percentage-hint`}
      class="field-hint"
      role={values.error ? "alert" : undefined}
    >
      {values.error ?? "Greater than 0% and below 100%."}
    </p>
  </div>
{:else if selected === "requires_review" || !selected}
  <p class="field-hint" role="status">
    Needs tax review. Excluded from potential deduction and add-back estimates
    until classified.
  </p>
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
