<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { ChevronRight, FileText, Scale, Trash2, Users } from '@lucide/svelte';
	import { toast } from 'svelte-sonner';
	import DetailPage from '$lib/components/ui/DetailPage.svelte';
	import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte';
	import StatusBadge from '$lib/components/ui/StatusBadge.svelte';
	import AttachmentManager, { type Attachment } from '$lib/components/ui/AttachmentManager.svelte';
	import AuditTrail from '$lib/components/ui/AuditTrail.svelte';
	import RecordForm from '$lib/components/ledger/RecordForm.svelte';
	import ListExpand, { visibleItems } from '$lib/components/ui/ListExpand.svelte';
	import ReimbursementReversalDialog from './ReimbursementReversalDialog.svelte';
	import RecipientCorrectionDialog from './RecipientCorrectionDialog.svelte';
	import AllocationCorrectionDialog from './AllocationCorrectionDialog.svelte';
	import DateCorrectionDialog from './DateCorrectionDialog.svelte';
	import SettlementList, {
		type SettlementLink
	} from '$lib/components/ledger/SettlementList.svelte';
	import { statusLabelFor } from '$lib/components/ledger/record-status.js';
	import { createResourceStream } from '$lib/sse.js';
	import { formatDate, formatMinor } from '$lib/format.js';
	import { LedgerRecordKind, AccountSubType } from '$lib/enums.js';
	import type { loadRecordDetail } from '$lib/server/loaders/records.js';
	import type { RecordView } from '$lib/server/ledger/types.js';

	/**
	 * One record, on its own page.
	 *
	 * The drawer this replaces was fifteen sections in a 456px column: the amount
	 * and the status — the two things somebody opens a record to see — scrolled
	 * out of view before the first field. Here the record is on the left and
	 * everything it touches is on the right, and neither is below the other.
	 */
	let { data }: { data: Awaited<ReturnType<typeof loadRecordDetail>> } = $props();

	// Writable-derived: a fresh server load replaces it, and a stream event can
	// still patch it in place.
	let record = $derived<RecordView>(data.record);
	let attachments = $state<Attachment[]>([]);
	let settlementLinks = $state<SettlementLink[]>([]);

	// Server-rendered, so nothing above the fold waits on a round trip.
	$effect(() => {
		attachments = data.attachments as Attachment[];
		settlementLinks = data.settlements as SettlementLink[];
	});

	// Structural types, the house convention for `bind:this` on a component.
	let formRef = $state<{
		submit: () => Promise<RecordView | null>;
		revert: () => void;
		blockedBy: () => string | null;
	} | null>(null);
	let dirty = $state(false);
	let saving = $state(false);
	let error = $state('');
	let deleteDialogOpen = $state(false);
	let dateCorrectionOpen = $state(false);
	let recipientCorrectionOpen = $state(false);
	let reversalGroupId = $state<number | null>(null);
	let reimbursementExpanded = $state(false);
	let correctionSettlementId = $state<number | null>(null);
	let auditTrailRef = $state<{ refresh: () => Promise<void> } | null>(null);

	const KIND_TITLES: Record<number, string> = {
		[LedgerRecordKind.Expense]: 'Expense',
		[LedgerRecordKind.Income]: 'Income',
		[LedgerRecordKind.Transfer]: 'Transfer',
		[LedgerRecordKind.Payment]: 'Payment',
		[LedgerRecordKind.OpeningBalance]: 'Opening balance',
		[LedgerRecordKind.InvoiceIssue]: 'Invoice',
		[LedgerRecordKind.Journal]: 'Journal entry'
	};

	const kindLabel = $derived(KIND_TITLES[record.kind] ?? 'Record');
	/**
	 * An invoice's issue posting belongs to the invoice: it is changed there and
	 * removed by cancelling it. The server refuses both here too.
	 */
	const fromInvoice = $derived(record.kind === LedgerRecordKind.InvoiceIssue);
	const canCorrectDate = $derived(
		data.perms.change &&
			!data.reimbursement.generated &&
			data.perms.correctDate &&
			record.locked &&
			!record.reconciled &&
			(record.kind === LedgerRecordKind.Expense || record.kind === LedgerRecordKind.Income)
	);
	const deleteBlockedReason = $derived(
		fromInvoice ? 'Cancel the invoice instead' : record.locked ? (record.lockedReason ?? '') : null
	);
	const isPayment = $derived(record.kind === LedgerRecordKind.Payment);
	const paymentControl = $derived(
		isPayment
			? record.movements.find(
					(m) =>
						m.accountSubType === AccountSubType.AccountsPayable ||
						m.accountSubType === AccountSubType.Receivable
				)
			: null
	);
	const creditAvailable = $derived(
		!!paymentControl &&
			record.contactId !== null &&
			record.outstandingMinor > 0 &&
			(paymentControl.accountSubType === AccountSubType.AccountsPayable
				? paymentControl.amountMinor > 0
				: paymentControl.amountMinor < 0)
	);
	const refundHref = $derived(
		`${resolve('/(app)/records/new/payment')}?contactId=${record.contactId}&direction=${paymentControl?.accountSubType === AccountSubType.AccountsPayable ? 'refund-received' : 'refund-paid'}`
	);
	const settlementsLabel = $derived(isPayment ? 'Allocated to' : 'Payments applied');
	const contact = $derived(data.contacts.find((c) => c.id === record.contactId) ?? null);
	// A batch payment names no single contact of its own — each settlement it
	// creates carries its own instead (CLAUDE.md's ledger notes, FR-008). Only
	// meaningful for a payment; every other kind with no contact just has none.
	const batchContactCount = $derived(
		record.kind === LedgerRecordKind.Payment && record.contactId === null
			? new Set(
					settlementLinks.map((l) => l.otherContactId).filter((id): id is number => id !== null)
				).size
			: 0
	);

	async function save() {
		const saved = await formRef?.submit();
		if (saved) {
			record = saved;
			auditTrailRef?.refresh();
		}
	}

	async function remove() {
		error = '';
		const res = await fetch(`/api/records/${record.id}`, { method: 'DELETE' });
		if (!res.ok) {
			const body = await res.json().catch(() => null);
			error = body?.reason ?? body?.error ?? 'That could not be deleted.';
			return;
		}
		void goto(resolve('/(app)/records'), { replaceState: true });
	}

	/**
	 * Takes one payment back off this record (FR-017). The record's own paid
	 * figure comes back over the stream, so only the list is corrected here —
	 * read again rather than filtered, because taking back one part of a batch
	 * payment (no contact) takes back all of it.
	 */
	function undoPayment(link: SettlementLink) {
		correctionSettlementId = link.settlementId;
	}

	async function refreshSettlements() {
		const res = await fetch(`/api/records/${record.id}/settlements`);
		if (res.ok) settlementLinks = (await res.json()).links ?? [];
	}

	// The shared registry, so list → record → back reuses one connection instead
	// of reconnecting (CLAUDE.md § SSE-only). It subscribes in `onMount` itself,
	// so this is called at init and never from an `$effect`.
	createResourceStream<{
		type: string;
		record?: RecordView;
		id?: number;
		recordIds?: number[];
	}>('/api/records/stream', (m) => {
		if (m.type === 'record-update' && m.record?.id === record.id) {
			record = m.record;
		} else if (m.type === 'record-deleted' && m.id === record.id) {
			// Staying on the page of a record that is gone is worse than a drawer
			// closing. `replaceState` so the back button cannot land here either.
			toast('That record was deleted.');
			void goto(resolve('/(app)/records'), { replaceState: true });
		} else if (m.type === 'settlement-changed' && m.recordIds?.includes(record.id)) {
			void refreshSettlements();
		}
	});
</script>

{#if correctionSettlementId !== null}
	<AllocationCorrectionDialog
		settlementId={correctionSettlementId}
		onclose={() => {
			correctionSettlementId = null;
		}}
		oncorrected={() => {
			void refreshSettlements();
			void auditTrailRef?.refresh();
		}}
	/>
{/if}

{#if reversalGroupId !== null}<ReimbursementReversalDialog
		groupId={reversalGroupId}
		onclose={() => (reversalGroupId = null)}
		onreversed={() => window.location.reload()}
	/>{/if}
{#if recipientCorrectionOpen}
	<RecipientCorrectionDialog
		recordId={record.id}
		contacts={data.contacts}
		onclose={() => (recipientCorrectionOpen = false)}
		oncorrected={() => {
			window.location.reload();
		}}
	/>
{/if}

<svelte:head><title>{record.description || kindLabel} - Akaun</title></svelte:head>

<DetailPage
	backHref="/records"
	backLabel="Records"
	{dirty}
	{saving}
	onsave={save}
	onrevert={() => formRef?.revert()}
	dirtyNote={formRef?.blockedBy() ?? 'Unsaved changes'}
>
	{#snippet actions()}
		{#if record.kind === LedgerRecordKind.Payment && paymentControl?.amountMinor && paymentControl.amountMinor > 0 && paymentControl.accountSubType === AccountSubType.AccountsPayable && data.perms.change && data.perms.delete && data.perms.add}
			<button
				class="sheet-btn"
				disabled={dirty || saving}
				onclick={() => (recipientCorrectionOpen = true)}>Correct recipient</button
			>
		{/if}
		{#if canCorrectDate}
			<button
				class="sheet-btn"
				disabled={dirty || saving}
				title={dirty ? 'Save or discard your changes before correcting the date.' : undefined}
				onclick={() => (dateCorrectionOpen = true)}>Correct date</button
			>
		{/if}
		{#if data.perms.delete && !data.reimbursement.generated}
			<button
				class="sheet-btn sheet-btn-delete"
				disabled={deleteBlockedReason !== null}
				title={deleteBlockedReason ?? undefined}
				onclick={() => (deleteDialogOpen = true)}
			>
				<Trash2 size={14} /> Delete
			</button>
		{/if}
	{/snippet}

	{#snippet hero()}
		<div class="detail-hero-eyebrow">
			<span>{kindLabel}</span>
			<span>·</span>
			<span>{formatDate(record.date)}</span>
			{#if record.recordNumber}
				<span>·</span><span>{record.recordNumber}</span>
			{/if}
		</div>
		<h1 class="detail-hero-title">{record.description || kindLabel}</h1>
		<div class="detail-hero-figure">
			<span class="detail-hero-amount">{formatMinor(record.amountMinor)}</span>
			<!-- Moving money between two accounts you hold owes nobody anything, so
			     "paid" is not a state it can be in (FR-007). -->
			{#if record.kind !== LedgerRecordKind.Transfer}
				<StatusBadge status={statusLabelFor(record)} />
				{#if record.outstandingMinor > 0}
					<span class="detail-hero-note">
						{formatMinor(record.outstandingMinor)} outstanding
					</span>
				{/if}
			{/if}
		</div>
		{#if error}<p class="hero-error">{error}</p>{/if}
	{/snippet}

	{#snippet main()}
		{#if canCorrectDate}
			<p class="text-muted-foreground mb-3 text-sm">
				To correct only this settled date, use Correct date. A reason and review are required.
			</p>
		{/if}
		{#if data.reimbursement.groups.length}
			<section class="detail-card">
				<div class="detail-card-head"><span class="detail-card-title">Reimbursement</span></div>
				{#if data.reimbursement.generated}<p class="card-empty">
						This transfer entry is read-only.
					</p>{/if}
				{#each data.reimbursement.groups as group (group.id)}
					<p class="card-empty">Group #{group.id}{group.reversedAt ? ' · Reversed' : ''}</p>
					{#if !group.reversedAt && data.perms.add && data.perms.delete}<button
							class="sheet-btn"
							disabled={dirty || saving}
							onclick={() => (reversalGroupId = group.id)}>Reverse reimbursement</button
						>{/if}
					{#if group.paymentRecordId}<button
							class="sheet-btn"
							onclick={() =>
								goto(resolve('/(app)/records/[id]', { id: String(group.paymentRecordId) }))}
							>Payment #{group.paymentRecordId}</button
						>{/if}
					{#each group.entries as entry (entry.recordId)}
						<button
							class="sheet-btn"
							onclick={() => goto(resolve('/(app)/records/[id]', { id: String(entry.recordId) }))}
							>{entry.role === 'recipient'
								? 'Recipient payable'
								: entry.role === 'supplier'
									? 'Supplier transfer'
									: 'Reversal'} · {entry.contactName} · #{entry.recordId}</button
						>
					{/each}
					{#each visibleItems(group.items, reimbursementExpanded) as item (item.id)}
						<button
							class="sheet-btn"
							onclick={() => goto(resolve('/(app)/records/[id]', { id: String(item.recordId) }))}
							>Expense #{item.recordId} · {formatMinor(item.amountMinor)}</button
						>
					{/each}
					<ListExpand total={group.items.length} bind:expanded={reimbursementExpanded} />
				{/each}
			</section>
		{/if}

		<RecordForm
			bind:this={formRef}
			bind:dirty
			bind:saving
			{record}
			accounts={data.accounts}
			categories={data.categories}
			allAccounts={data.allAccounts}
			contacts={data.contacts}
			defaultAccountId={data.defaultAccountId}
			lastForeignCurrencyExpense={data.lastForeignCurrencyExpense}
			lastForeignCurrencyIncome={data.lastForeignCurrencyIncome}
			canChange={data.perms.change && !fromInvoice && !data.reimbursement.generated}
			canAdjust={data.perms.adjustments}
		/>
	{/snippet}

	{#snippet rail()}
		{#if contact}
			<section class="detail-card">
				<div class="detail-card-head"><span class="detail-card-title">Contact</span></div>
				<button
					class="related-link ob-card"
					onclick={() => goto(resolve('/(app)/contacts/[id]', { id: String(contact.id) }))}
				>
					<span class="ob-icon"><Users size={15} /></span>
					<span class="ob-main">
						<span class="ob-title">{contact.legalName}</span>
						<span class="ob-sub">Contact ledger: receivables and payables</span>
					</span>
					<ChevronRight size={14} color="var(--muted-foreground)" />
				</button>
			</section>
		{:else if batchContactCount > 0}
			<section class="detail-card">
				<div class="detail-card-head"><span class="detail-card-title">Contact</span></div>
				<div class="ob-card ob-card-static">
					<span class="ob-icon"><Users size={15} /></span>
					<span class="ob-main">
						<span class="ob-title">{batchContactCount} contacts</span>
						<span class="ob-sub">Batch payment allocated to several contacts. See below.</span>
					</span>
				</div>
			</section>
		{/if}

		<!--
			Shown wherever settling applies, empty or not: a payment can always be
			allocated, and a record that is still owed can always be paid. A record paid
			straight from an account reads paid with nothing to settle, so it has no card.
		-->
		{#if settlementLinks.length > 0 || isPayment || !record.paid}
			<section class="detail-card">
				<div class="detail-card-head">
					<span class="detail-card-title">{settlementsLabel}</span>
				</div>
				{#if creditAvailable}
					<p class="text-muted-foreground mb-3 text-sm">
						{formatMinor(record.outstandingMinor)} unallocated. Available for a future claim or refund.
					</p>
					{#if data.perms.add}
						<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- built above with resolve and fixed query parameters. -->
						<a class="sheet-btn mb-3" href={refundHref}>Record refund</a>
					{/if}
				{/if}
				<SettlementList
					links={settlementLinks}
					onundo={data.perms.delete ? undoPayment : undefined}
					emptyLabel={isPayment
						? 'This payment is not allocated to a record yet.'
						: 'No payments are applied yet.'}
				/>
			</section>
		{/if}

		<section class="detail-card">
			<AttachmentManager
				apiBase="/api/records/{record.id}"
				bind:attachments
				canDelete={data.perms.delete && !data.reimbursement.generated}
			/>
		</section>

		<!--
			Whether a bank line has been matched to this record. Stated, not linked:
			reconciling is reached from the account it belongs to, and a record
			touches two of them — there is no single account this could send the
			reader to (FR-048, D-06).
		-->
		<section class="detail-card">
			<div class="detail-card-head"><span class="detail-card-title">Bank</span></div>
			<div class="ob-card ob-card-static">
				<span class="ob-icon" class:cleared={record.reconciled}><Scale size={15} /></span>
				<span class="ob-main">
					<span class="ob-title">
						{record.reconciled ? 'Reconciled' : 'Unreconciled'}
					</span>
					<span class="ob-sub">
						{record.reconciled
							? 'Matched to a bank statement line.'
							: 'Not matched to a bank statement line.'}
					</span>
				</span>
			</div>
		</section>

		{#if fromInvoice && data.invoiceId !== null}
			{@const invoiceId = data.invoiceId}
			<section class="detail-card">
				<div class="detail-card-head"><span class="detail-card-title">Invoice</span></div>
				<button
					type="button"
					class="related-link ob-card"
					onclick={() => goto(resolve('/(app)/invoices/[id]', { id: String(invoiceId) }))}
				>
					<span class="ob-icon"><FileText size={15} /></span>
					<span class="ob-main">
						<span class="ob-title">The invoice this came from</span>
						<span class="ob-sub">Issued invoices are changed on the invoice itself.</span>
					</span>
					<ChevronRight size={14} color="var(--muted-foreground)" />
				</button>
			</section>
		{/if}

		<section class="detail-card">
			<div class="detail-card-head"><span class="detail-card-title">History</span></div>
			<AuditTrail bind:this={auditTrailRef} recordType="record" recordId={record.id} />
		</section>
	{/snippet}
</DetailPage>

{#if dateCorrectionOpen}
	<DateCorrectionDialog
		recordId={record.id}
		onclose={() => (dateCorrectionOpen = false)}
		oncorrected={() => {
			auditTrailRef?.refresh();
			toast('The record date was corrected.');
		}}
	/>
{/if}

<ConfirmDialog
	bind:open={deleteDialogOpen}
	title="Delete this record?"
	description="This removes the record and its journal lines. It cannot be undone."
	confirmLabel="Delete"
	danger
	onConfirm={remove}
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
	.ob-card-static {
		cursor: default;
	}
	.ob-icon.cleared {
		background: var(--green-soft);
		color: var(--green);
	}
</style>
