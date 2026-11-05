<script lang="ts">
  import { Input } from "$lib/components/ui/input/index.js";
  import * as Select from "$lib/components/ui/select/index.js";
  import {
    TAX_TREATMENTS,
    TaxTreatmentLabels,
    type TaxTreatment,
  } from "$lib/expense-tax.js";
  let {
    id,
    percentage = $bindable(""),
    treatment = $bindable(""),
    disabled = false,
    named = false,
  }: {
    id: string;
    percentage?: string;
    treatment?: string;
    disabled?: boolean;
    named?: boolean;
  } = $props();
</script>

<div class="field">
  <label class="field-label" for={`${id}-percentage`}
    >Potential deduction (%)</label
  >
  <Input
    id={`${id}-percentage`}
    name={named ? "defaultTaxPercentage" : undefined}
    type="number"
    min="0"
    max="100"
    step="0.01"
    value={percentage}
    oninput={(event) => (percentage = event.currentTarget.value)}
    {disabled}
    placeholder="Unreviewed"
  />
</div>
<div class="field">
  <label class="field-label" for={`${id}-treatment`}>Tax treatment</label>
  <Select.Root
    type="single"
    value={treatment || "__auto__"}
    onValueChange={(v) => (treatment = v === "__auto__" ? "" : v)}
    {disabled}
  >
    <Select.Trigger id={`${id}-treatment`} class="w-full justify-between"
      >{treatment
        ? TaxTreatmentLabels[treatment as TaxTreatment]
        : "From percentage (or unreviewed)"}</Select.Trigger
    >
    <Select.Content>
      <Select.Item value="__auto__" label="From percentage (or unreviewed)" />
      {#each TAX_TREATMENTS as value (value)}<Select.Item
          {value}
          label={TaxTreatmentLabels[value]}
        />{/each}
    </Select.Content>
  </Select.Root>
  {#if named}<input
      type="hidden"
      name="defaultTaxTreatment"
      value={treatment}
    />{/if}
</div>
