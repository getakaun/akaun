<script lang="ts">
	import { ChevronRight, Undo2 } from '@lucide/svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { formatDate, formatMinor } from '$lib/format.js';
	import { LedgerRecordKind } from '$lib/enums.js';
	import ListExpand, { visibleItems } from '$lib/components/ui/ListExpand.svelte';

	/**
	 * What this payment covered, and what paid this record.
	 *
	 * The same list answers both questions because it is the same note read from
	 * either end: a payment's rows are the things it paid off, and a record's rows
	 * are the payments that paid it. One component, so the two can never look like
	 * two different features (CLAUDE.md § Cross-feature relation cards, FR-018).
	 */

	/** Mirrors `SettlementLink` in src/lib/server/queries/settlements.ts, which is
	 *  server-only and so cannot be imported into a component. Kept in step by
	 *  hand — the fields are the ones that endpoint returns. */
	export type SettlementLink = {
		settlementId: number;
		/** Presentation rows may explain a protected reimbursement relationship. */
		canUndo?: boolean;
		presentationKey?: string;
		amountMinor: number;
		createdAt: string;
		otherRecordId: number;
		otherRecordNumber: string | null;
		otherDate: string;
		otherDescription: string;
		otherKind: number;
		otherContactId: number | null;
		otherContactName: string | null;
		otherSupplierContactName?: string | null;
	};

	let {
		links,
		onundo,
		emptyLabel = ''
	}: {
		links: SettlementLink[];
		/** Supplied when the reader is allowed to take one of these back (FR-017). */
		onundo?: (link: SettlementLink) => void;
		/** Shown in place of the list when there is nothing in it. */
		emptyLabel?: string;
	} = $props();

	let expanded = $state(false);
	const shown = $derived(visibleItems(links, expanded));

	/**
	 * Every kind opens now.
	 *
	 * This used to answer true for expenses and income only, because those were
	 * the two kinds with a screen of their own: a payment row ended in nothing
	 * rather than in a chevron that went nowhere, which was the right call while
	 * it was true. One Records list gave every kind a deep link at
	 * `/records/[id]`, so the reason the chevron was withheld is gone (FR-027).
	 *
	 * Kept as a function rather than inlined as `true`: it is still the one place
	 * to change if a kind ever stops being openable.
	 */
	// eslint-disable-next-line @typescript-eslint/no-unused-vars -- the parameter is kept so this stays the one place to change if a kind stops being openable.
	function canOpen(_kind: number): boolean {
		return true;
	}

	function open(link: SettlementLink) {
		goto(resolve('/(app)/records/[id]', { id: String(link.otherRecordId) }));
	}

	/** What to call the other side when it was saved without a description. */
	const KIND_LABEL: Record<number, string> = {
		[LedgerRecordKind.Expense]: 'Expense',
		[LedgerRecordKind.Income]: 'Income',
		[LedgerRecordKind.Transfer]: 'Transfer',
		[LedgerRecordKind.Payment]: 'Payment',
		[LedgerRecordKind.OpeningBalance]: 'Opening balance',
		[LedgerRecordKind.InvoiceIssue]: 'Invoice',
		[LedgerRecordKind.Journal]: 'Journal entry'
	};

	function titleOf(link: SettlementLink): string {
		return link.otherDescription.trim() || KIND_LABEL[link.otherKind] || 'Record';
	}

	function subOf(link: SettlementLink): string {
		const date = formatDate(link.otherDate);
		const withNumber = link.otherRecordNumber ? `${date} · ${link.otherRecordNumber}` : date;
		// Named only when it differs from the row it is already attached to — a
		// batch payment's own rail is the one place several contacts show up
		// side by side, so that is the one place worth naming whose item this is.
		const contactName = link.otherSupplierContactName ?? link.otherContactName;
		return contactName ? `${contactName} · ${withNumber}` : withNumber;
	}
</script>

{#snippet body(link: SettlementLink)}
	<span class="settle-main">
		<span class="settle-name">{titleOf(link)}</span>
		<span class="settle-sub">{subOf(link)}</span>
	</span>
	<span class="settle-amt">{formatMinor(link.amountMinor)}</span>
	{#if canOpen(link.otherKind)}
		<ChevronRight size={14} color="var(--muted-foreground)" />
	{/if}
{/snippet}

{#if links.length > 0}
	<div class="settle-list">
		{#each shown as link (link.presentationKey ?? `${link.settlementId}-${link.otherRecordId}`)}
			{#if onundo && link.canUndo !== false}
				<!-- Two independent actions on one row — open it, or take it back — so
				     the row carries the shared hover and each action is its own target. -->
				<div class="settle-row" class:related-link={canOpen(link.otherKind)}>
					{#if canOpen(link.otherKind)}
						<button type="button" class="settle-open" onclick={() => open(link)}>
							{@render body(link)}
						</button>
					{:else}
						<div class="settle-open settle-static">{@render body(link)}</div>
					{/if}
					<button
						type="button"
						class="settle-undo"
						title="Correct allocation"
						aria-label="Correct allocation of {formatMinor(link.amountMinor)} to {titleOf(link)}"
						onclick={() => onundo?.(link)}
					>
						<Undo2 size={14} />
					</button>
				</div>
			{:else if canOpen(link.otherKind)}
				<button
					type="button"
					class="settle-row settle-open related-link"
					onclick={() => open(link)}
				>
					{@render body(link)}
				</button>
			{:else}
				<div class="settle-row settle-open settle-static">
					{@render body(link)}
				</div>
			{/if}
		{/each}
	</div>
	<ListExpand total={links.length} bind:expanded />
{:else if emptyLabel}
	<p class="card-empty">{emptyLabel}</p>
{/if}

<style>
	.settle-list {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.settle-row {
		display: flex;
		align-items: center;
		width: 100%;
		border: 1px solid var(--border);
		border-radius: 9px;
		background: var(--card);
		font-family: inherit;
		text-align: left;
		padding: 0;
	}
	/* The clickable area of a row that has a second action beside it. */
	.settle-open {
		display: flex;
		align-items: center;
		gap: 11px;
		flex: 1;
		min-width: 0;
		padding: 10px 12px;
		border: none;
		background: none;
		color: inherit;
		font-family: inherit;
		text-align: left;
		cursor: pointer;
	}
	/* A row that is itself the action carries the frame, which the rule above
	   would otherwise strip off it. */
	.settle-row.settle-open {
		border: 1px solid var(--border);
		background: var(--card);
	}
	.settle-static {
		cursor: default;
	}
	.settle-main {
		display: flex;
		flex-direction: column;
		gap: 2px;
		flex: 1;
		min-width: 0;
	}
	.settle-name {
		font-size: 13px;
		font-weight: 500;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.settle-sub {
		font-size: 11.5px;
		color: var(--muted-foreground);
	}
	.settle-amt {
		font-size: 13px;
		font-weight: 600;
		white-space: nowrap;
	}
	.settle-undo {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 26px;
		height: 26px;
		margin-right: 8px;
		border: none;
		background: none;
		border-radius: 6px;
		color: var(--muted-foreground);
		cursor: pointer;
		flex-shrink: 0;
	}
	.settle-undo:hover {
		background: var(--accent);
		color: var(--foreground);
	}
</style>
