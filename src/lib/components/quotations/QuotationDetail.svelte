<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import {
		Check,
		ChevronRight,
		FilePen,
		FileText,
		Printer,
		Receipt,
		RotateCcw,
		Send,
		Trash2,
		Undo2,
		X
	} from '@lucide/svelte';
	import DetailPage from '$lib/components/ui/DetailPage.svelte';
	import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte';
	import StatusBadge from '$lib/components/ui/StatusBadge.svelte';
	import AuditTrail from '$lib/components/ui/AuditTrail.svelte';
	import SalesDocForm from '$lib/components/sales/SalesDocForm.svelte';
	import SalesDocLines from '$lib/components/sales/SalesDocLines.svelte';
	import { mainCurrency, mainCurrencySymbol } from '$lib/currency-state.svelte.js';
	import { formatCurrencyAmount } from '$lib/currency.js';
	import { formatDate, formatMoney } from '$lib/format.js';
	import { QuotationStatus } from '$lib/enums.js';
	import { canConvert, canRevise, quotationStatusKey } from '$lib/sales/status.js';
	import type { loadQuotationDetail } from '$lib/server/loaders/quotations.js';

	/** One quotation, on its own page — its line items are a table. */
	let {
		data,
		form
	}: {
		data: Awaited<ReturnType<typeof loadQuotationDetail>>;
		form: { error?: string } | null;
	} = $props();

	type Quotation = typeof data.quotation;

	let quotation = $derived<Quotation>(data.quotation);

	let isEditing = $state(false);
	let formRef = $state<{
		submit: () => Promise<Quotation | null>;
		revert: () => void;
		blockedBy: () => string | null;
	} | null>(null);
	let formDirty = $state(false);
	let saving = $state(false);
	let saveError = $state('');
	let converting = $state(false);
	let convertError = $state('');
	let statusSaving = $state(false);
	let statusError = $state('');
	let revising = $state(false);
	let reviseError = $state('');
	let reviseConfirmOpen = $state(false);
	let deleteDialogOpen = $state(false);
	let auditTrailRef = $state<{ refresh: () => Promise<void> } | null>(null);

	// Only actually dirty while the form is mounted: leaving edit mode discards
	// whatever the form held, the same way closing the drawer this replaced did.
	const dirty = $derived(isEditing && formDirty);

	const isConverted = $derived(quotation.status === QuotationStatus.Converted);
	const isSuperseded = $derived(quotation.status === QuotationStatus.Superseded);
	/**
	 * Editing is allowed unless converted (the invoice is the record now) or
	 * superseded (it is what the customer was sent before its revision). Once
	 * sent, only its wording and expiry still change — the form seals the rest.
	 */
	const canEdit = $derived(data.perms.change && !isConverted && !isSuperseded);
	const deleteBlockedReason = $derived(
		isConverted
			? 'Converted quotations cannot be deleted'
			: isSuperseded
				? 'A quotation replaced by a revision is kept, so it cannot be deleted'
				: undefined
	);

	type StatusName = 'draft' | 'sent' | 'accepted' | 'declined';
	type StatusMove = { to: StatusName; label: string; icon: typeof Send };

	/**
	 * The status moves each status offers. The server allows any move but into or
	 * out of Converted (`canSetQuotationStatus`); these are the ones worth a
	 * button. Expired is worked out from the date, so it offers what Draft or Sent
	 * does.
	 */
	const statusMoves = $derived.by((): StatusMove[] => {
		switch (quotation.status) {
			case QuotationStatus.Draft:
				return [
					{ to: 'sent', label: 'Mark as sent', icon: Send },
					{ to: 'accepted', label: 'Mark accepted', icon: Check }
				];
			case QuotationStatus.Sent:
				return [
					{ to: 'accepted', label: 'Mark accepted', icon: Check },
					{ to: 'declined', label: 'Mark declined', icon: X }
				];
			case QuotationStatus.Accepted:
				return [{ to: 'sent', label: 'Undo acceptance', icon: Undo2 }];
			case QuotationStatus.Declined:
				return [{ to: 'sent', label: 'Reopen', icon: RotateCcw }];
			default:
				return [];
		}
	});

	function startEdit() {
		saveError = '';
		isEditing = true;
	}

	async function saveEdit() {
		const saved = await formRef?.submit();
		if (saved) {
			quotation = saved;
			isEditing = false;
			void auditTrailRef?.refresh();
		}
	}

	async function setStatus(to: StatusName) {
		statusSaving = true;
		statusError = '';
		convertError = '';
		try {
			const res = await fetch(`/api/quotations/${quotation.id}/status`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ status: to })
			});
			if (!res.ok) {
				statusError =
					(await res.json().catch(() => ({}))).error ?? 'Could not change the status.';
				return;
			}
			quotation = await res.json();
			void auditTrailRef?.refresh();
		} catch {
			statusError = 'Network error — try again';
		} finally {
			statusSaving = false;
		}
	}

	// Replace this quotation with a new draft version of it (`-R1`), and open
	// that. This one stays as it is, marked Superseded.
	async function revise() {
		// The dialog does not close itself on confirm; any refusal shows in the hero.
		reviseConfirmOpen = false;
		revising = true;
		reviseError = '';
		statusError = '';
		convertError = '';
		try {
			const res = await fetch(`/api/quotations/${quotation.id}/revise`, { method: 'POST' });
			if (!res.ok) {
				reviseError = (await res.json().catch(() => ({}))).error ?? 'Could not revise this.';
				return;
			}
			const json = await res.json();
			void goto(resolve('/(app)/quotations/[id]', { id: String(json.quotation.id) }));
		} catch {
			reviseError = 'Network error — try again';
		} finally {
			revising = false;
		}
	}

	async function convertToInvoice() {
		converting = true;
		convertError = '';
		statusError = '';
		const res = await fetch(`/api/quotations/${quotation.id}/convert`, { method: 'POST' });
		converting = false;
		if (!res.ok) {
			convertError = (await res.json().catch(() => ({}))).error ?? 'Could not convert this.';
			return;
		}
		const json = await res.json();
		void goto(resolve('/(app)/invoices/[id]', { id: String(json.invoice.id) }));
	}
</script>

<svelte:head><title>{quotation.quotationNumber} - Akaun</title></svelte:head>

<DetailPage
	backHref="/quotations"
	backLabel="Quotations"
	{dirty}
	editing={isEditing}
	{saving}
	saveLabel="Save"
	dirtyNote={formRef?.blockedBy() ?? 'Editing this quotation'}
	onsave={saveEdit}
	onrevert={() => (isEditing = false)}
>
	{#snippet actions()}
		{#if data.perms.delete}
			<button
				class="sheet-btn sheet-btn-delete"
				disabled={!!deleteBlockedReason}
				title={deleteBlockedReason}
				onclick={() => (deleteDialogOpen = true)}
			>
				<Trash2 size={14} /> Delete
			</button>
		{/if}
		<a
			href={resolve('/api/quotations/[id]/pdf', { id: String(quotation.id) })}
			target="_blank"
			class="sheet-btn print-btn"
		>
			<Printer size={14} /> Print
		</a>
		{#if data.perms.change && !isEditing}
			{#each statusMoves as move (move.to)}
				<button
					class="sheet-btn"
					onclick={() => setStatus(move.to)}
					disabled={statusSaving || converting}
				>
					<move.icon size={14} /> {move.label}
				</button>
			{/each}
		{/if}
		{#if data.perms.revise && canRevise(quotation) && !isEditing}
			<button
				class="sheet-btn"
				onclick={() => (reviseConfirmOpen = true)}
				disabled={revising || statusSaving || converting}
			>
				<FilePen size={14} /> {revising ? 'Revising…' : 'Revise'}
			</button>
		{/if}
		{#if data.perms.convert && canConvert(quotation) && !isEditing}
			<button
				class="sheet-btn"
				onclick={convertToInvoice}
				disabled={converting || statusSaving}
			>
				<FileText size={14} /> {converting ? 'Converting…' : 'Convert'}
			</button>
		{/if}
		{#if canEdit && !isEditing}
			<button class="sheet-btn sheet-btn-primary" onclick={startEdit}>Edit</button>
		{/if}
	{/snippet}

	{#snippet hero()}
		<div class="detail-hero-eyebrow">
			<span>{quotation.quotationNumber}</span>
			<span>·</span>
			<span>{formatDate(quotation.issueDate)}</span>
		</div>
		<h1 class="detail-hero-title">{quotation.contactName || 'Quotation'}</h1>
		<div class="detail-hero-figure">
			<span class="detail-hero-amount">
				{mainCurrencySymbol()}{formatMoney(quotation.mainAmount)}
			</span>
			<StatusBadge status={quotationStatusKey(quotation)} />
			{#if quotation.currency !== mainCurrency()}
				<span class="detail-hero-note">
					{quotation.currency}
					{formatCurrencyAmount(quotation.total, quotation.currency)} · rate {quotation.exchangeRate}
				</span>
			{/if}
		</div>
		{#if saveError || statusError || convertError || reviseError || form?.error}
			<p class="hero-error">
				{saveError || statusError || convertError || reviseError || form?.error}
			</p>
		{/if}
	{/snippet}

	{#snippet main()}
		{#if isEditing}
			<SalesDocForm
				bind:this={formRef}
				bind:dirty={formDirty}
				bind:saving
				bind:error={saveError}
				kind="quotation"
				doc={quotation}
			/>
		{:else}
			<SalesDocLines kind="quotation" doc={quotation} />
		{/if}
	{/snippet}

	{#snippet rail()}
		{#if quotation.supersededBy}
			<section class="detail-card">
				<div class="detail-card-head"><span class="detail-card-title">Replaced by</span></div>
				<a
					class="related-link ob-card"
					href={resolve('/(app)/quotations/[id]', { id: String(quotation.supersededBy.id) })}
				>
					<span class="ob-icon"><FileText size={15} /></span>
					<span class="ob-main">
						<span class="ob-title">{quotation.supersededBy.quotationNumber}</span>
						<span class="ob-sub">The revision that replaced this quotation</span>
					</span>
					<ChevronRight size={14} color="var(--muted-foreground)" />
				</a>
			</section>
		{/if}

		{#if quotation.revisedFrom}
			<section class="detail-card">
				<div class="detail-card-head"><span class="detail-card-title">Revision of</span></div>
				<a
					class="related-link ob-card"
					href={resolve('/(app)/quotations/[id]', { id: String(quotation.revisedFrom.id) })}
				>
					<span class="ob-icon"><FileText size={15} /></span>
					<span class="ob-main">
						<span class="ob-title">{quotation.revisedFrom.quotationNumber}</span>
						<span class="ob-sub">The version the customer was sent before this one</span>
					</span>
					<ChevronRight size={14} color="var(--muted-foreground)" />
				</a>
			</section>
		{/if}

		{#if quotation.convertedInvoiceId}
			<section class="detail-card">
				<div class="detail-card-head"><span class="detail-card-title">Became</span></div>
				<a
					class="related-link ob-card"
					href={resolve('/(app)/invoices/[id]', { id: String(quotation.convertedInvoiceId) })}
				>
					<span class="ob-icon"><Receipt size={15} /></span>
					<span class="ob-main">
						<span class="ob-title">Invoice</span>
						<span class="ob-sub">Converted from this quotation</span>
					</span>
					<ChevronRight size={14} color="var(--muted-foreground)" />
				</a>
			</section>
		{/if}

		<section class="detail-card">
			<div class="detail-card-head"><span class="detail-card-title">History</span></div>
			<AuditTrail bind:this={auditTrailRef} recordType="quotation" recordId={quotation.id} />
		</section>
	{/snippet}
</DetailPage>

<form method="POST" action="?/delete" use:enhance id="quotation-delete-form" hidden>
	<input type="hidden" name="id" value={quotation.id} />
</form>

<ConfirmDialog
	bind:open={deleteDialogOpen}
	title="Delete quotation {quotation.quotationNumber}?"
	description={quotation.revisedFrom
		? `This permanently deletes this revision. ${quotation.revisedFrom.quotationNumber}, the version it replaced, goes back to Sent. It cannot be undone.`
		: 'This permanently deletes the quotation. It cannot be undone.'}
	confirmLabel="Delete"
	danger
	onConfirm={() =>
		(document.getElementById('quotation-delete-form') as HTMLFormElement)?.requestSubmit()}
/>

<ConfirmDialog
	bind:open={reviseConfirmOpen}
	title="Revise quotation {quotation.quotationNumber}?"
	description="A new draft version opens, dated today, with the same customer and line items for you to change and send. This quotation is kept as it is and marked Superseded."
	confirmLabel="Revise"
	onConfirm={revise}
/>

<style>
	.hero-error {
		background: var(--red-soft);
		color: var(--red);
		border-radius: 8px;
		padding: 8px 12px;
		font-size: 13px;
		margin: 8px 0 0;
	}
	.print-btn {
		text-decoration: none;
	}
</style>
