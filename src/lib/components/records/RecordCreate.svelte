<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { toast } from 'svelte-sonner';
	import DetailPage from '$lib/components/ui/DetailPage.svelte';
	import AttachmentStaging from '$lib/components/ui/AttachmentStaging.svelte';
	import RecordForm from '$lib/components/ledger/RecordForm.svelte';
	import type { loadRecordNew } from '$lib/server/loaders/records.js';
	import type { RecordView } from '$lib/server/ledger/types.js';

	/**
	 * Adding a record to the ledger, on its own page.
	 *
	 * The drawer this replaces held ten-odd fields, a dynamic list of extra
	 * sides, and attachments in a 500px column — the same crowding the record
	 * detail page was rebuilt to fix, on the way in this time rather than on the
	 * way out. `RecordForm` is unchanged and unaware which frame hosts it.
	 */
	let { data }: { data: Awaited<ReturnType<typeof loadRecordNew>> } = $props();

	let formRef = $state<{
		submit: () => Promise<RecordView | null>;
		revert: () => void;
		blockedBy: () => string | null;
	} | null>(null);
	let attachRef = $state<{
		clear: () => void;
		uploadAll: (recordId: number) => Promise<{ failedCount: number }>;
	} | null>(null);

	let formDirty = $state(false);
	let formSaving = $state(false);
	let error = $state('');
	let stagedCount = $state(0);
	let uploading = $state(false);

	const dirty = $derived(formDirty || stagedCount > 0);
	const saving = $derived(formSaving || uploading);

	async function save() {
		const saved = await formRef?.submit();
		if (!saved) return;
		if (stagedCount > 0) {
			uploading = true;
			const { failedCount } = (await attachRef?.uploadAll(saved.id)) ?? { failedCount: 0 };
			uploading = false;
			if (failedCount > 0) {
				toast.success(
					`Record saved. ${failedCount} attachment${failedCount === 1 ? '' : 's'} did not upload — add them again from the record.`
				);
			}
		}
		void goto(resolve('/(app)/records/[id]', { id: String(saved.id) }));
	}

	function revert() {
		formRef?.revert();
		attachRef?.clear();
	}
</script>

<svelte:head><title>New record - Akaun</title></svelte:head>

<DetailPage
	backHref="/records"
	backLabel="Records"
	{dirty}
	{saving}
	saveLabel="Save record"
	onsave={save}
	onrevert={revert}
	dirtyNote={formRef?.blockedBy() ?? 'Unsaved changes'}
>
	{#snippet hero()}
		<div class="detail-hero-eyebrow"><span>New</span></div>
		<h1 class="detail-hero-title">New record</h1>
		{#if error}<p class="hero-error">{error}</p>{/if}
	{/snippet}

	{#snippet main()}
		<RecordForm
			bind:this={formRef}
			bind:dirty={formDirty}
			bind:saving={formSaving}
			bind:error
			record={null}
			accounts={data.accounts}
			categories={data.categories}
			allAccounts={data.allAccounts}
			contacts={data.contacts}
			defaultAccountId={data.defaultAccountId}
			lastForeignCurrencyExpense={data.lastForeignCurrencyExpense}
			lastForeignCurrencyIncome={data.lastForeignCurrencyIncome}
			canChange={true}
			canAdjust={data.perms.adjustments}
		/>
	{/snippet}

	{#snippet rail()}
		<section class="detail-card">
			<AttachmentStaging bind:this={attachRef} bind:count={stagedCount} disabled={formSaving} />
		</section>
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
