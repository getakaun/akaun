<script lang="ts">
  import { CalendarDays, ChevronLeft, ChevronRight } from "@lucide/svelte";
  import * as Popover from "$lib/components/ui/popover/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { cn, focusRingClass, focusRingOpenClass } from "$lib/utils.js";

  let {
    value = $bindable(""),
    min,
    max,
    disabled = false,
    labelledBy,
    onchange,
  }: {
    value?: string;
    min?: string;
    max?: string;
    disabled?: boolean;
    labelledBy?: string;
    onchange?: (value: string) => void;
  } = $props();

  const id = $props.id();
  const labelId = `${id}-value`;
  const longMonth = new Intl.DateTimeFormat("en-GB", {
    month: "long",
    timeZone: "UTC",
  });
  const shortMonth = new Intl.DateTimeFormat("en-GB", {
    month: "short",
    timeZone: "UTC",
  });
  const monthAndYear = new Intl.DateTimeFormat("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  const months = Array.from({ length: 12 }, (_, index) => {
    const date = new Date(Date.UTC(2000, index, 1));
    return {
      number: String(index + 1).padStart(2, "0"),
      short: shortMonth.format(date),
      long: longMonth.format(date),
    };
  });
  let open = $state(false);
  let year = $state(new Date().getFullYear());
  const minYear = $derived(min ? Number(min.slice(0, 4)) : 1);
  const maxYear = $derived(max ? Number(max.slice(0, 4)) : 9999);
  const display = $derived(
    value
      ? monthAndYear.format(new Date(`${value}-01T00:00:00Z`))
      : "Select month",
  );

  function monthValue(number: string) {
    return `${String(year).padStart(4, "0")}-${number}`;
  }
  function unavailable(month: string) {
    return Boolean((min && month < min) || (max && month > max));
  }
  function setOpen(next: boolean) {
    open = next;
    if (next)
      year =
        Number(value?.slice(0, 4)) ||
        Math.min(Math.max(new Date().getFullYear(), minYear), maxYear);
  }
  function choose(month: string) {
    if (disabled || unavailable(month)) return;
    value = month;
    open = false;
    onchange?.(month);
  }
</script>

<Popover.Root {open} onOpenChange={setOpen}>
  <Popover.Trigger
    {disabled}
    aria-labelledby={labelledBy ? `${labelledBy} ${labelId}` : labelId}
    class={cn(
      "border-input flex h-9 w-full items-center gap-2 rounded-md border bg-card px-3 text-left text-[13.5px] outline-none transition-[color,box-shadow] disabled:cursor-not-allowed disabled:opacity-50",
      focusRingClass,
      focusRingOpenClass,
    )}
  >
    <CalendarDays size={14} class="shrink-0 text-muted-foreground" />
    <span id={labelId}>{display}</span>
  </Popover.Trigger>
  <Popover.Content align="start" class="w-64 gap-3 p-3">
    <div class="flex items-center justify-between gap-2">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Previous year"
        disabled={year <= minYear}
        onclick={() => year--}><ChevronLeft size={15} /></Button
      >
      <span class="num text-[13px] font-semibold" aria-live="polite"
        >{year}</span
      >
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Next year"
        disabled={year >= maxYear}
        onclick={() => year++}><ChevronRight size={15} /></Button
      >
    </div>
    <div
      class="grid grid-cols-3 gap-1"
      role="group"
      aria-label={`Months in ${year}`}
    >
      {#each months as month (month.number)}
        {@const next = monthValue(month.number)}
        <Button
          size="sm"
          variant={value === next ? "default" : "ghost"}
          class="h-9 w-full"
          disabled={unavailable(next)}
          aria-label={`${month.long} ${year}`}
          aria-pressed={value === next}
          onclick={() => choose(next)}>{month.short}</Button
        >
      {/each}
    </div>
  </Popover.Content>
</Popover.Root>
