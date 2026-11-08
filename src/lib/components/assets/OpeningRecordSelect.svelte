<script lang="ts">
  import { untrack } from "svelte";
  import { SvelteURLSearchParams } from "svelte/reactivity";
  import * as Combobox from "$lib/components/ui/combobox/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { formatDate, formatMinor } from "$lib/format.js";

  let {
    value = $bindable(""),
    accountId,
    dateTo,
    id,
    disabled = false,
  }: {
    value?: string;
    accountId: string;
    dateTo: string;
    id: string;
    disabled?: boolean;
  } = $props();
  type RecordOption = {
    id: number;
    recordNumber: string | null;
    description: string;
    date: string;
    amountMinor: number;
  };
  let open = $state(false);
  let query = $state("");
  let results = $state<RecordOption[]>([]);
  let loading = $state(false);
  let error = $state("");
  let selection = $state(
    untrack(() => ({ value, label: value ? `Record #${value}` : "" })),
  );
  const selectedLabel = $derived(
    selection.value === value
      ? selection.label
      : value
        ? `Record #${value}`
        : "",
  );
  const unavailable = $derived(disabled || !accountId || !dateTo);
  function label(record: RecordOption) {
    return `${record.recordNumber ?? `Record #${record.id}`} · ${record.description} · ${formatDate(record.date)} · ${formatMinor(record.amountMinor)}`;
  }
  $effect(() => {
    const term = query.trim();
    const account = accountId;
    const date = dateTo;
    if (!open || unavailable) return;
    const controller = new AbortController();
    loading = true;
    error = "";
    results = [];
    const timeout = setTimeout(async () => {
      try {
        const params = new SvelteURLSearchParams({
          accountId: account,
          dateTo: date,
          search: term,
          limit: "30",
          voided: "exclude",
        });
        const response = await fetch(`/api/records?${params}`, {
          signal: controller.signal,
        });
        if (!response.ok)
          throw Error("Could not load records. Try searching again.");
        const body = await response.json();
        if (!controller.signal.aborted) results = body.records;
      } catch (cause) {
        if (!controller.signal.aborted)
          error =
            cause instanceof Error ? cause.message : "Could not load records.";
      } finally {
        if (!controller.signal.aborted) loading = false;
      }
    }, 300);
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  });
</script>

<Combobox.Root
  type="single"
  {value}
  inputValue={open ? query : selectedLabel}
  bind:open
  disabled={unavailable}
  onValueChange={(next) => {
    value = next;
    const record = results.find((record) => String(record.id) === next);
    selection = {
      value: next,
      label: record ? label(record) : next ? `Record #${next}` : "",
    };
    query = "";
  }}
>
  <Combobox.Input
    {id}
    placeholder="Search existing records…"
    onfocus={() => {
      if (!unavailable) open = true;
    }}
    oninput={(event) => {
      query = event.currentTarget.value;
      open = true;
    }}
  />
  <Combobox.Content>
    {#if loading}<p class="hint px-3 py-2" role="status">Searching records…</p>
    {:else if error}<p class="hint px-3 py-2" role="alert">{error}</p>
    {:else}
      {#each results as record (record.id)}
        <Combobox.Item value={String(record.id)} label={label(record)} />
      {:else}<p class="hint px-3 py-2" role="status">
          No matching records. Try another search or use a document reference.
        </p>{/each}
    {/if}
  </Combobox.Content>
</Combobox.Root>
{#if value}<Button
    variant="ghost"
    size="sm"
    {disabled}
    onclick={() => {
      value = "";
      selection = { value: "", label: "" };
      query = "";
    }}>Clear selected record</Button
  >{/if}
