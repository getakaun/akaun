<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import {
		Ban,
		ChevronRight,
		FilePen,
		FileText,
		HandCoins,
		Printer,
		Receipt,
		Send,
		Trash2
	} from '@lucide/svelte';
	import DetailPage from '$lib/components/ui/DetailPage.svelte';
	import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte';
	import StatusBadge from '$lib/components/ui/StatusBadge.svelte';
	import AuditTrail from '$lib/components/ui/AuditTrail.svelte';
	import SalesDocForm from '$lib/components/sales/SalesDocForm.svelte';
	import SalesDocLines from '$lib/components/sales/SalesDocLines.svelte';
	import SettlementList from '$lib/components/ledger/SettlementList.svelte';
	import { mainCurrency, mainCurrencySymbol } from '$lib/currency-state.svelte.js';
	import { formatCurrencyAmount } from '$lib/currency.js';
	import { formatDate, formatMinor, formatMoney } from '$lib/format.js';
	import { InvoiceStatus } from '$lib/enums.js';
	import { canCancelInvoice, invoiceStatusKey } from '$lib/sales/status.js';
	import type { loadInvoiceDetail } from '$lib/server/loaders/invoices.js';

	/**
	 * One invoice, on its own page.
	 *
	 * Its line items are a table, and a table read column by column is the
	 * reason reports were already allowed to be full pages (CLAUDE.md). The
	 * invoice was the other thing in the app shaped like that, and it was in a
	 * 456px drawer.
	 */
	let {
		data,
		form
	}: {
		data: Awaited<ReturnType<typeof loadInvoiceDetail>>;
		form: { error?: string } | null;
	} = $props();

	type Invoice = typeof data.invoice;

	// Writable-derived: a fresh server load replaces it, and saving or sending
	// patches it in place from the response.
	let invoice = $derived<Invoice>(data.invoice);

	let isEditing = $state(false);
	let formRef = $state<{
		submit: () => Promise<Invoice | null>;
		revert: () => void;
		blockedBy: () => string | null;
	} | null>(null);
	let formDirty = $state(false);
	let saving = $state(false);
	let saveError = $state('');
	let issuing = $state(false);
	let issueError = $state('');
	let cancelling = $state(false);
	let cancelError = $state('');
	let deleteDialogOpen = $state(false);
	let issueConfirmOpen = $state(false);
	let cancelConfirmOpen = $state(false);
	let reissuing = $state(false);
	let reissueConfirmOpen = $state(false);
	let auditTrailRef = $state<{ refresh: () => Promise<void> } | null>(null);

	// Only actually dirty while the form is mounted: leaving edit mode discards
	// whatever the form held, the same way closing the drawer this replaced did.
	const dirty = $derived(isEditing && formDirty);

	const isDraft = $derived(invoice.status === InvoiceStatus.Draft);
	const canEdit = $derived(data.perms.change && invoice.status !== InvoiceStatus.Cancelled);
	/** Only a draft can be sent, and only once — sending it twice would owe it twice. */
	const canIssue = $derived(data.perms.issue && isDraft && invoice.ledgerRecordId === null);
	/**
	 * Only a draft can be deleted. A sent invoice is cancelled instead — its
	 * amount is already in the books — and a cancelled one keeps its number.
	 */
	const deleteBlockedReason = $derived(
		invoice.status === InvoiceStatus.Cancelled
			? 'A cancelled invoice keeps its number, so it cannot be deleted.'
			: invoice.ledgerRecordId !== null || !isDraft
				? 'This invoice has been sent, so it cannot be deleted. Cancel it instead.'
				: null
	);
	/** Sent and nothing paid yet — the same rule the server applies (`$lib/sales/status.ts`). */
	const canCancel = $derived(data.perms.void && canCancelInvoice(invoice));
	/**
	 * Cancelled before cancelling took the amount out of the books: the status
	 * already says Cancelled, so all that is left to do is the books.
	 */
	const cancelOnlyBooks = $derived(invoice.status === InvoiceStatus.Cancelled);
	/**
	 * Cancel & reissue: the way to change what a sent invoice says. Offered
	 * whenever a plain cancel is, except to finish one already cancelled.
	 */
	const canReissue = $derived(canCancel && !cancelOnlyBooks && data.perms.reissue);
	/** Sent, still owed, and the user may record a payment. */
	const canRecordPayment = $derived(
		data.perms.recordPayment &&
			invoice.ledgerRecordId !== null &&
			invoice.status !== InvoiceStatus.Cancelled &&
			!invoice.paid
	);

	function startEdit() {
		saveError = '';
		isEditing = true;
	}

	async function saveEdit() {
		const saved = await formRef?.submit();
		if (saved) {
			invoice = saved;
			isEditing = false;
			void auditTrailRef?.refresh();
		}
	}

	// Mark the invoice as sent: from here on the customer owes this amount, and
	// any payment they make settles it like any other debt (FR-018a).
	async function issue() {
		issuing = true;
		issueError = '';
		cancelError = '';
		try {
			const res = await fetch(`/api/invoices/${invoice.id}/issue`, { method: 'POST' });
			if (!res.ok) {
				issueError =
					(await res.json().catch(() => ({}))).error ?? 'Could not mark the invoice as sent.';
				return;
			}
			invoice = await fetch(`/api/invoices/${invoice.id}`).then((r) => r.json());
			issueConfirmOpen = false;
			void auditTrailRef?.refresh();
		} catch {
			issueError = 'Network error — try again';
		} finally {
			issuing = false;
		}
	}

	// Void it: the number stays, the status says Cancelled, and the amount
	// leaves the books. The server refuses once anything has been paid, and its
	// sentence is what shows.
	async function cancelInvoice() {
		// The dialog does not close itself on confirm; any refusal shows in the hero.
		cancelConfirmOpen = false;
		cancelling = true;
		cancelError = '';
		issueError = '';
		try {
			const res = await fetch(`/api/invoices/${invoice.id}/cancel`, { method: 'POST' });
			if (!res.ok) {
				cancelError =
					(await res.json().catch(() => ({}))).error ?? 'Could not cancel the invoice.';
				return;
			}
			invoice = await res.json();
			void auditTrailRef?.refresh();
		} catch {
			cancelError = 'Network error — try again';
		} finally {
			cancelling = false;
		}
	}

	// Void this one and open a draft copy of it, with the next number, to
	// correct and send. The server refuses on the same terms as a cancel.
	async function reissue() {
		// The dialog does not close itself on confirm; any refusal shows in the hero.
		reissueConfirmOpen = false;
		reissuing = true;
		cancelError = '';
		issueError = '';
		try {
			const res = await fetch(`/api/invoices/${invoice.id}/reissue`, { method: 'POST' });
			if (!res.ok) {
				cancelError =
					(await res.json().catch(() => ({}))).error ?? 'Could not reissue the invoice.';
				return;
			}
			const json = await res.json();
			void goto(resolve('/(app)/invoices/[id]', { id: String(json.invoice.id) }));
		} catch {
			cancelError = 'Network error — try again';
		} finally {
			reissuing = false;
		}
	}

	// The payment page opens as a receipt from this customer with this invoice
	// ticked, and comes back here once saved (`loadPaymentNew`).
	function recordPayment() {
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- the path is resolved; only the query is appended.
		void goto(`${resolve('/(app)/records/new/payment')}?invoice=${invoice.id}`);
	}
</script>

<svelte:head><title>{invoice.invoiceNumber} - Akaun</title></svelte:head>

<DetailPage
	backHref="/invoices"
	backLabel="Invoices"
	{dirty}
	editing={isEditing}
	{saving}
	saveLabel="Save"
	dirtyNote={formRef?.blockedBy() ?? 'Editing this invoice'}
	onsave={saveEdit}
	onrevert={() => (isEditing = false)}
>
	{#snippet actions()}
		{#if data.perms.delete}
			<button
				class="sheet-btn sheet-btn-delete"
				disabled={!!deleteBlockedReason}
				title={deleteBlockedReason ?? undefined}
				onclick={() => (deleteDialogOpen = true)}
			>
				<Trash2 size={14} /> Delete
			</button>
		{/if}
		<a
			href={resolve('/api/invoices/[id]/pdf', { id: String(invoice.id) })}
			target="_blank"
			class="sheet-btn print-btn"
		>
			<Printer size={14} /> Print
		</a>
		{#if canReissue && !isEditing}
			<button
				class="sheet-btn"
				onclick={() => (reissueConfirmOpen = true)}
				disabled={reissuing || cancelling}
			>
				<FilePen size={14} />
				{reissuing ? 'Reissuing…' : 'Cancel & reissue'}
			</button>
		{/if}
		{#if canCancel && !isEditing}
			<button
				class="sheet-btn"
				onclick={() => (cancelConfirmOpen = true)}
				disabled={cancelling || reissuing}
			>
				<Ban size={14} />
				{cancelling ? 'Cancelling…' : cancelOnlyBooks ? 'Remove from the books' : 'Cancel invoice'}
			</button>
		{/if}
		{#if canIssue && !isEditing}
			<button class="sheet-btn" onclick={() => (issueConfirmOpen = true)} disabled={issuing}>
				<Send size={14} /> {issuing ? 'Marking…' : 'Mark as sent'}
			</button>
		{/if}
		{#if canRecordPayment && !isEditing}
			<button class="sheet-btn" onclick={recordPayment}>
				<HandCoins size={14} /> Record payment
			</button>
		{/if}
		{#if canEdit && !isEditing}
			<button class="sheet-btn sheet-btn-primary" onclick={startEdit}>Edit</button>
		{/if}
	{/snippet}

	{#snippet hero()}
		<div class="detail-hero-eyebrow">
			<span>{invoice.invoiceNumber}</span>
			<span>·</span>
			<span>{formatDate(invoice.issueDate)}</span>
		</div>
		<h1 class="detail-hero-title">{invoice.contactName || 'Invoice'}</h1>
		<div class="detail-hero-figure">
			<span class="detail-hero-amount">
				{mainCurrencySymbol()}{formatMoney(invoice.mainAmount)}
			</span>
			<StatusBadge status={invoiceStatusKey(invoice)} />
			{#if invoice.currency !== mainCurrency()}
				<span class="detail-hero-note">
					{invoice.currency}
					{formatCurrencyAmount(invoice.total, invoice.currency)} · rate {invoice.exchangeRate}
				</span>
			{/if}
		</div>
		{#if issueError || cancelError || saveError || form?.error}
			<p class="hero-error">{issueError || cancelError || saveError || form?.error}</p>
		{/if}
	{/snippet}

	{#snippet main()}
		{#if isEditing}
			<SalesDocForm
				bind:this={formRef}
				bind:dirty={formDirty}
				bind:saving
				bind:error={saveError}
				kind="invoice"
				doc={invoice}
			/>
		{:else}
			<SalesDocLines kind="invoice" doc={invoice} />
		{/if}
	{/snippet}

	{#snippet rail()}
		<!-- How much has come in, once the invoice has been sent (D-10) -->
		{#if invoice.ledgerRecordId !== null}
			<section class="detail-card">
				<div class="detail-card-head"><span class="detail-card-title">Settled</span></div>
				<div class="detail-list">
					<div class="detail-row">
						<div class="detail-key">Paid so far</div>
						<div class="detail-val num">{formatMinor(invoice.paidMinor)}</div>
					</div>
					<div class="detail-row">
						<div class="detail-key">Outstanding</div>
						<div class="detail-val num" class:strong={invoice.outstandingMinor > 0}>
							{formatMinor(invoice.outstandingMinor)}
						</div>
					</div>
				</div>
			</section>
		{/if}

		<!-- The payments that settled it (FR-018a) -->
		{#if invoice.settlements.length > 0}
			<section class="detail-card">
				<div class="detail-card-head"><span class="detail-card-title">Payments</span></div>
				<SettlementList links={invoice.settlements} />
			</section>
		{/if}

		{#if invoice.replacedBy}
			<section class="detail-card">
				<div class="detail-card-head"><span class="detail-card-title">Replaced by</span></div>
				<a
					class="related-link ob-card"
					href={resolve('/(app)/invoices/[id]', { id: String(invoice.replacedBy.id) })}
				>
					<span class="ob-icon"><Receipt size={15} /></span>
					<span class="ob-main">
						<span class="ob-title">{invoice.replacedBy.invoiceNumber}</span>
						<span class="ob-sub">Reissued in place of this invoice</span>
					</span>
					<ChevronRight size={14} color="var(--muted-foreground)" />
				</a>
			</section>
		{/if}

		{#if invoice.replaces}
			<section class="detail-card">
				<div class="detail-card-head"><span class="detail-card-title">Replaces</span></div>
				<a
					class="related-link ob-card"
					href={resolve('/(app)/invoices/[id]', { id: String(invoice.replaces.id) })}
				>
					<span class="ob-icon"><Receipt size={15} /></span>
					<span class="ob-main">
						<span class="ob-title">{invoice.replaces.invoiceNumber}</span>
						<span class="ob-sub">The cancelled invoice this one was reissued from</span>
					</span>
					<ChevronRight size={14} color="var(--muted-foreground)" />
				</a>
			</section>
		{/if}

		{#if invoice.sourceQuotationId}
			<section class="detail-card">
				<div class="detail-card-head"><span class="detail-card-title">Came from</span></div>
				<a
					class="related-link ob-card"
					href={resolve('/(app)/quotations/[id]', { id: String(invoice.sourceQuotationId) })}
				>
					<span class="ob-icon"><FileText size={15} /></span>
					<span class="ob-main">
						<span class="ob-title">Source quotation</span>
						<span class="ob-sub">The quotation this invoice was made from</span>
					</span>
					<ChevronRight size={14} color="var(--muted-foreground)" />
				</a>
			</section>
		{/if}

		<section class="detail-card">
			<div class="detail-card-head"><span class="detail-card-title">History</span></div>
			<AuditTrail bind:this={auditTrailRef} recordType="invoice" recordId={invoice.id} />
		</section>
	{/snippet}
</DetailPage>

<form method="POST" action="?/delete" use:enhance id="invoice-delete-form" hidden>
	<input type="hidden" name="id" value={invoice.id} />
</form>

<ConfirmDialog
	bind:open={deleteDialogOpen}
	title="Delete invoice {invoice.invoiceNumber}?"
	description={invoice.sourceQuotationId
		? 'This removes the invoice. It is only possible while it has not been sent. The quotation it was converted from goes back to Accepted, so it can be converted again.'
		: 'This removes the invoice. It is only possible while it has not been sent.'}
	confirmLabel="Delete"
	danger
	onConfirm={() =>
		(document.getElementById('invoice-delete-form') as HTMLFormElement)?.requestSubmit()}
/>

<ConfirmDialog
	bind:open={issueConfirmOpen}
	title="Mark invoice {invoice.invoiceNumber} as sent?"
	description="This records the amount in the books as owed to you by the customer, from the issue date. After this its customer, date, currency and line items are fixed, and it can be cancelled but not deleted."
	confirmLabel="Mark as sent"
	onConfirm={issue}
/>

<ConfirmDialog
	bind:open={cancelConfirmOpen}
	title={cancelOnlyBooks
		? `Remove invoice ${invoice.invoiceNumber} from the books?`
		: `Cancel invoice ${invoice.invoiceNumber}?`}
	description={cancelOnlyBooks
		? 'This invoice is already marked Cancelled, but its amount is still in the books. This takes it out of them — out of money owed to you and out of income, including the reports for the period it was issued in. The invoice keeps its number.'
		: `The invoice keeps its number and is marked Cancelled. Its amount is taken out of the books — out of money owed to you and out of income, including the reports for the period it was issued in.${invoice.sourceQuotationId ? ' The quotation it was converted from goes back to Accepted, so it can be converted again.' : ''} This cannot be undone.`}
	confirmLabel={cancelOnlyBooks ? 'Remove from the books' : 'Cancel invoice'}
	cancelLabel="Keep it"
	danger
	onConfirm={cancelInvoice}
/>

<ConfirmDialog
	bind:open={reissueConfirmOpen}
	title="Cancel and reissue invoice {invoice.invoiceNumber}?"
	description="This invoice keeps its number and is marked Cancelled, and its amount is taken out of the books, including the reports for the period it was issued in. A draft copy opens with the next invoice number, dated today, for you to correct and send. This cannot be undone."
	confirmLabel="Cancel & reissue"
	cancelLabel="Keep it"
	danger
	onConfirm={reissue}
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
	.strong {
		font-weight: 600;
	}
</style>
