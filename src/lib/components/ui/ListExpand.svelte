<script module lang="ts">
	/**
	 * How many rows a list card shows before it folds the rest away.
	 *
	 * One number for every card, so a History card and a Payments card that hold
	 * the same count read the same (CLAUDE.md § List cards). A list of one row
	 * more than this shows in full: a button that hides a single row is noise.
	 */
	export const LIST_CAP = 5;

	export function visibleItems<T>(items: T[], expanded: boolean): T[] {
		return expanded || items.length <= LIST_CAP + 1 ? items : items.slice(0, LIST_CAP);
	}
</script>

<script lang="ts">
	import { ChevronDown, ChevronUp } from '@lucide/svelte';

	let { total, expanded = $bindable(false) }: { total: number; expanded?: boolean } = $props();
</script>

{#if total > LIST_CAP + 1}
	<button
		type="button"
		class="list-expand-btn"
		aria-expanded={expanded}
		onclick={() => (expanded = !expanded)}
	>
		{#if expanded}
			<ChevronUp size={13} /> Show fewer
		{:else}
			<ChevronDown size={13} /> Show all {total}
		{/if}
	</button>
{/if}
