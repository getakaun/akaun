<script lang="ts">
	import { Calendar } from '@lucide/svelte';
	import FilterDropdown from '$lib/components/ui/FilterDropdown.svelte';
	import DatePicker from '$lib/components/ui/date-picker/DatePicker.svelte';

	/**
	 * The "Date range" filter of a list page, in the two places a list shows it:
	 * `dropdown` is the toolbar button on a desktop, `sheet` is the section inside
	 * the page's mobile filter sheet. The page owns the sheet itself (its frame,
	 * its other sections and its "Show results" button); this is one section of it.
	 *
	 * Both bind the same `from`/`to`, so the two can never disagree.
	 */
	let {
		from = $bindable(''),
		to = $bindable(''),
		variant
	}: {
		from: string;
		to: string;
		variant: 'dropdown' | 'sheet';
	} = $props();

	const active = $derived(!!(from || to));

	function clear() {
		from = '';
		to = '';
	}
</script>

{#snippet pickers()}
	<div style="display:flex; flex-direction:column; gap:8px;">
		<span style="font-size:11.5px; color:var(--muted-foreground);">From</span>
		<DatePicker bind:value={from} placeholder="From date" />
		<span style="font-size:11.5px; color:var(--muted-foreground);">To</span>
		<DatePicker bind:value={to} placeholder="To date" />
	</div>
{/snippet}

{#if variant === 'dropdown'}
	<FilterDropdown label="Date" {active}>
		{#snippet icon()}<Calendar size={14} />{/snippet}
		<div style="padding:12px 14px;">
			<div
				style="display:flex; align-items:center; justify-content:space-between; margin-bottom:10px;"
			>
				<div
					style="font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted-foreground);"
				>
					Date range
				</div>
				{#if active}
					<button
						onclick={clear}
						style="border:none; background:none; color:var(--primary); cursor:pointer; font-size:11px; font-weight:600; padding:0;"
						>Clear</button
					>
				{/if}
			</div>
			{@render pickers()}
		</div>
	</FilterDropdown>
{:else}
	<div style="margin-bottom:16px;">
		<div
			style="font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted-foreground); margin-bottom:10px; display:flex; align-items:center; justify-content:space-between;"
		>
			<span>Date range</span>
			{#if active}
				<button
					onclick={clear}
					style="border:none; background:none; color:var(--primary); cursor:pointer; font-size:11px; font-weight:600;"
					>Clear</button
				>
			{/if}
		</div>
		{@render pickers()}
	</div>
{/if}
