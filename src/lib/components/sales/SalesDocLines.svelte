<script lang="ts">
	import { mainCurrency } from '$lib/currency-state.svelte.js';
	import { formatCurrencyAmount } from '$lib/currency.js';
	import { formatDate } from '$lib/format.js';
	import {
		SALES_DOC_KINDS,
		secondDateOf,
		type Invoice,
		type Quotation,
		type SalesDocKind
	} from './sales-doc-kinds.js';

	/**
	 * A quotation or an invoice, read: its line items and its details card.
	 * The two detail pages differ in their actions and their rails, not in
	 * this, which they each used to carry a copy of.
	 */
	let { kind, doc }: { kind: SalesDocKind; doc: Invoice | Quotation } = $props();

	const cfg = $derived(SALES_DOC_KINDS[kind]);
	const secondDate = $derived(secondDateOf(doc));
	// Only an invoice can be overdue; a quotation past its date is expired,
	// which its status chip already says.
	const overdue = $derived('isOverdue' in doc && doc.isOverdue);
</script>

<section class="detail-card">
	<div class="detail-card-head"><span class="detail-card-title">Line items</span></div>
	{#if doc.lines.length === 0}
		<p class="empty-note">This {cfg.noun.toLowerCase()} has no line items yet.</p>
	{:else}
		<!-- The line items, as the table they are. This is what the drawer could
		     not hold: four columns in 456px meant the description was the only one
		     that could be read. -->
		<div class="lines-table">
			<div class="lines-head">
				<span>Description</span>
				<span class="ta-right">Qty</span>
				<span class="ta-right">Unit price</span>
				<span class="ta-right">Total</span>
			</div>
			{#each doc.lines as line, i (i)}
				<div class="lines-row">
					<span class="line-desc">{line.description}</span>
					<span class="ta-right num">{line.quantity}</span>
					<span class="ta-right num">
						{formatCurrencyAmount(line.unitPrice, doc.currency)}
					</span>
					<span class="ta-right num strong">
						{formatCurrencyAmount(line.lineTotal, doc.currency)}
					</span>
				</div>
			{/each}
			<div class="lines-total">
				<span>Total</span>
				<span class="num strong">
					{doc.currency}
					{formatCurrencyAmount(doc.total, doc.currency)}
				</span>
			</div>
		</div>
	{/if}
</section>

<section class="detail-card">
	<div class="detail-card-head"><span class="detail-card-title">Details</span></div>
	<div class="detail-list">
		{#if doc.contactName}
			<div class="detail-row">
				<div class="detail-key">Customer</div>
				<div class="detail-val">{doc.contactName}</div>
			</div>
		{/if}
		<div class="detail-row">
			<div class="detail-key">Issue date</div>
			<div class="detail-val num">{formatDate(doc.issueDate)}</div>
		</div>
		{#if secondDate}
			<div class="detail-row">
				<div class="detail-key">{cfg.dateLabel}</div>
				<div class="detail-val num" class:overdue>
					{formatDate(secondDate)}
					{#if overdue}<span class="overdue-flag">OVERDUE</span>{/if}
				</div>
			</div>
		{/if}
		{#if doc.reference}
			<div class="detail-row">
				<div class="detail-key">Reference</div>
				<div class="detail-val num">{doc.reference}</div>
			</div>
		{/if}
		{#if doc.currency !== mainCurrency()}
			<div class="detail-row">
				<div class="detail-key">Currency</div>
				<div class="detail-val">{doc.currency} (rate: {doc.exchangeRate})</div>
			</div>
		{/if}
		{#if doc.notes}
			<div class="detail-row">
				<div class="detail-key">Notes</div>
				<div class="detail-val prewrap">{doc.notes}</div>
			</div>
		{/if}
		{#if doc.terms}
			<div class="detail-row">
				<div class="detail-key">Terms</div>
				<div class="detail-val prewrap">{doc.terms}</div>
			</div>
		{/if}
	</div>
</section>

<style>
	.empty-note {
		font-size: 12.5px;
		color: var(--muted-foreground);
		margin: 0;
	}
	.lines-table {
		display: flex;
		flex-direction: column;
	}
	.lines-head,
	.lines-row,
	.lines-total {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 70px 120px 130px;
		gap: 12px;
		align-items: baseline;
	}
	.lines-head {
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--muted-foreground);
		padding-bottom: 8px;
		border-bottom: 1px solid var(--border);
	}
	.lines-row {
		padding: 10px 0;
		border-bottom: 1px solid var(--border);
		font-size: 13.5px;
	}
	.line-desc {
		min-width: 0;
	}
	.lines-total {
		grid-template-columns: minmax(0, 1fr) auto;
		padding-top: 12px;
		font-size: 13.5px;
		font-weight: 600;
	}
	.ta-right {
		text-align: right;
	}
	.strong {
		font-weight: 600;
	}
	.prewrap {
		white-space: pre-wrap;
	}
	.overdue {
		color: var(--red);
		font-weight: 600;
	}
	.overdue-flag {
		font-size: 11px;
		margin-left: 4px;
	}

	@media (max-width: 767px) {
		.lines-head {
			display: none;
		}
		.lines-row {
			grid-template-columns: minmax(0, 1fr) auto;
			gap: 2px 12px;
		}
		.line-desc {
			grid-column: 1 / -1;
			font-weight: 500;
		}
	}
</style>
