<script lang="ts" generics="K extends SalesDocKind">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import DetailPage from '$lib/components/ui/DetailPage.svelte';
	import SalesDocForm from './SalesDocForm.svelte';
	import { SALES_DOC_KINDS, type SalesDoc, type SalesDocKind } from './sales-doc-kinds.js';

	/** Writing a quotation or an invoice, on its own page — see `SalesDocForm`. */
	let {
		kind,
		// From the settings: days from the issue date to the due or expiry date
		// a new document starts with (null: none).
		defaultDays
	}: { kind: K; defaultDays: number | null } = $props();

	const cfg = $derived(SALES_DOC_KINDS[kind]);
	const noun = $derived(cfg.noun.toLowerCase());

	let formRef = $state<{
		submit: () => Promise<SalesDoc<K> | null>;
		revert: () => void;
		blockedBy: () => string | null;
	} | null>(null);
	let dirty = $state(false);
	let saving = $state(false);
	let error = $state('');

	async function save() {
		const saved = await formRef?.submit();
		if (!saved) return;
		const id = String(saved.id);
		void goto(
			kind === 'invoice'
				? resolve('/(app)/invoices/[id]', { id })
				: resolve('/(app)/quotations/[id]', { id })
		);
	}
</script>

<svelte:head><title>New {noun} - Akaun</title></svelte:head>

<DetailPage
	backHref={cfg.listHref}
	backLabel={cfg.listLabel}
	{dirty}
	{saving}
	saveLabel="Create {noun}"
	onsave={save}
	onrevert={() => formRef?.revert()}
	dirtyNote={formRef?.blockedBy() ?? `New ${noun}`}
>
	{#snippet hero()}
		<div class="detail-hero-eyebrow"><span>New</span></div>
		<h1 class="detail-hero-title">New {noun}</h1>
		{#if error}<p class="hero-error">{error}</p>{/if}
	{/snippet}

	{#snippet main()}
		<SalesDocForm bind:this={formRef} bind:dirty bind:saving bind:error {kind} doc={null} {defaultDays} />
	{/snippet}
</DetailPage>

<style>
	.hero-error {
		background: var(--red-soft);
		color: var(--red);
		border-radius: 8px;
		padding: 8px 12px;
		font-size: 13px;
		margin: 8px 0 0;
	}
</style>
