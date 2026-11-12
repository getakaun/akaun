<script lang="ts">
  import { untrack } from "svelte";
  import * as Select from "$lib/components/ui/select/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import {
    TAX_JURISDICTIONS,
    taxJurisdictionLabel,
  } from "$lib/asset-tax-scheme.js";
  let {
    value = $bindable(null),
    disabled = false,
    id = "tax-jurisdiction",
  }: { value: string | null; disabled?: boolean; id?: string } = $props();
  let custom = $state(
    untrack(() => !!value && !TAX_JURISDICTIONS.some((j) => j.code === value)),
  );
  const selected = $derived(custom ? "custom" : (value ?? ""));
</script>

<div class="field">
  <label class="field-label" for={id}>Tax jurisdiction</label><Select.Root
    type="single"
    value={selected}
    {disabled}
    onValueChange={(code) => {
      custom = code === "custom";
      value = custom ? null : code || null;
    }}
    ><Select.Trigger {id} class="w-full justify-between"
      >{custom
        ? "Other jurisdiction"
        : value
          ? taxJurisdictionLabel(value)
          : "Select jurisdiction"}</Select.Trigger
    ><Select.Content
      >{#each TAX_JURISDICTIONS as j (j.code)}<Select.Item
          value={j.code}
          label={j.label}
        />{/each}<Select.Item
        value="custom"
        label="Other jurisdiction"
      /></Select.Content
    ></Select.Root
  >{#if custom}<label class="field-label" for={`${id}-code`}
      >Two-letter country / jurisdiction code</label
    ><Input
      id={`${id}-code`}
      value={value ?? ""}
      oninput={(e) => (value = e.currentTarget.value.toUpperCase())}
      maxlength={2}
      {disabled}
      placeholder="e.g. AU"
    />{/if}
  <p class="field-hint">
    Independent of book currency. No country’s tax rules are automatically
    certified.
  </p>
</div>
