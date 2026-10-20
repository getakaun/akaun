<script lang="ts">
	import * as Popover from '$lib/components/ui/popover/index.js';
	import { cn, focusRingClass, focusRingOpenClass } from '$lib/utils.js';
	import Calendar from '$lib/components/ui/calendar/calendar.svelte';
	import CalendarIcon from '@lucide/svelte/icons/calendar';
	import XIcon from '@lucide/svelte/icons/x';
	import {
		DateFormatter,
		type DateValue,
		getLocalTimeZone,
		parseDate,
		today as getToday
	} from '@internationalized/date';

	let {
		name = undefined,
		value = $bindable<string | undefined>(undefined),
		defaultToday = false,
		onchange = undefined,
		placeholder = 'Pick a date',
		disabled = false,
		clearable = false,
		clearLabel = 'Clear date',
		labelledBy = undefined,
		min = undefined
	}: {
		name?: string;
		value?: string;
		defaultToday?: boolean;
		onchange?: (v: string) => void;
		placeholder?: string;
		disabled?: boolean;
		/** Shows a × beside a chosen date that empties the value. */
		clearable?: boolean;
		/** The ×'s accessible name, saying what clearing means. */
		clearLabel?: string;
		/** ID of a visible label that names the calendar trigger. */
		labelledBy?: string;
		/** The earliest day that can be picked (YYYY-MM-DD). */
		min?: string;
	} = $props();

	const df = new DateFormatter('en-GB', { dateStyle: 'medium' });

	// Initialise internal DateValue from prop (or today if defaultToday)
	function toDateValue(iso: string | undefined): DateValue | undefined {
		if (iso) return parseDate(iso);
		if (defaultToday) return getToday(getLocalTimeZone());
		return undefined;
	}

	let dateValue = $state<DateValue | undefined>(toDateValue(value));
	let open = $state(false);

	// Sync inward: when parent clears value (e.g. filter reset), clear internal state
	$effect(() => {
		const v = value;
		if (!v) {
			dateValue = undefined;
		} else if (!dateValue || dateValue.toString() !== v) {
			dateValue = parseDate(v);
		}
	});

	const displayLabel = $derived(
		dateValue ? df.format(dateValue.toDate(getLocalTimeZone())) : placeholder
	);

	// Room on the right for the ×, which sits over the trigger.
	const triggerStyle = $derived(
		`color:${dateValue ? 'var(--foreground)' : 'var(--muted-foreground)'}; text-align:left;` +
			(clearable && dateValue ? ' padding-right:34px;' : '')
	);
	const minValue = $derived(min ? parseDate(min) : undefined);

	function clear() {
		dateValue = undefined;
		value = '';
		onchange?.('');
	}

	function handleSelect(v: DateValue | undefined) {
		if (!v) return;
		dateValue = v;
		value = v.toString();
		onchange?.(value);
		open = false;
	}
</script>

<!-- The × is a sibling of the trigger, never inside it: a button cannot hold a button. -->
<div class="relative w-full">
	<Popover.Root bind:open>
		<Popover.Trigger
			{disabled}
			aria-labelledby={labelledBy}
			class={cn(
				"border-input flex h-9 w-full items-center gap-2 rounded-md border bg-card px-3 text-[13.5px] outline-none transition-[color,box-shadow] disabled:cursor-not-allowed disabled:opacity-50",
				focusRingClass,
				focusRingOpenClass
			)}
			style={triggerStyle}
		>
			<CalendarIcon size={14} style="flex-shrink:0; opacity:0.5;" />
			{displayLabel}
		</Popover.Trigger>
		<Popover.Content align="start" class="w-auto p-0">
			<Calendar
				type="single"
				value={dateValue}
				{minValue}
				onValueChange={handleSelect}
			/>
		</Popover.Content>
	</Popover.Root>
	{#if clearable && dateValue && !disabled}
		<button
			type="button"
			class={cn(
				'text-muted-foreground hover:text-foreground hover:bg-muted absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded-md outline-none',
				focusRingClass
			)}
			aria-label={clearLabel}
			title={clearLabel}
			onclick={clear}
		>
			<XIcon size={14} />
		</button>
	{/if}
</div>
{#if name}
	<input type="hidden" {name} value={value ?? ''} />
{/if}
