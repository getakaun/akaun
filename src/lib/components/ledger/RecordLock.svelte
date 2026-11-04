<script lang="ts">
	import { Lock } from '@lucide/svelte';
	import { MONTH_CLOSED_REASON } from '$lib/closing-context.js';

	let {
		periodClosedThrough,
		locked = false,
		lockedReason = null,
		size = 11
	}: {
		periodClosedThrough: string | null;
		locked?: boolean;
		lockedReason?: string | null;
		size?: number;
	} = $props();
	const reason = $derived(periodClosedThrough ? MONTH_CLOSED_REASON : lockedReason);
</script>

{#if periodClosedThrough || locked}
	<span
		class="record-lock"
		class:period-closed={!!periodClosedThrough}
		title={reason ?? undefined}
		aria-label={reason ?? 'Locked'}
	>
		<Lock {size} aria-hidden="true" />
	</span>
{/if}

<style>
	.record-lock {
		display: inline-flex;
		vertical-align: middle;
		margin-left: 5px;
		color: var(--muted-foreground);
	}
	.record-lock.period-closed {
		color: var(--primary);
	}
</style>
