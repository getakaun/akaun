<script lang="ts">
	import { History, X } from '@lucide/svelte';
	import { Dialog } from 'bits-ui';
	import { auditChangeRows } from '$lib/components/audit/audit-change-rows.js';
	import {
		changesSummary,
		channelLabel,
		formatAuditTime,
		type AuditChange,
		type AuditVia
	} from '$lib/components/audit/audit-format.js';
	import ListExpand, { visibleItems } from './ListExpand.svelte';

	type AuditEntry = {
		id: number;
		action: 'create' | 'update' | 'delete';
		changes: AuditChange[] | null;
		createdAt: string;
		userId: number | null;
		userName: string | null;
		via: AuditVia;
		credentialLabel: string | null;
	};

	let { recordType, recordId }: { recordType: string; recordId: number | string } = $props();

	let entries = $state<AuditEntry[]>([]);
	let loading = $state(true);
	let expanded = $state(false);
	let selected = $state<AuditEntry | null>(null);
	let detailsOpen = $state(false);
	const detailRows = $derived(auditChangeRows(recordType, selected?.changes ?? []));
	const shown = $derived(visibleItems(entries, expanded));

	// The record the entries on screen belong to. A refresh of the same record keeps them
	// (and the toggle) in place; pointing at another record drops them, so the old
	// record's history never stands under the new one while the fetch runs.
	let loadedFor = '';

	export async function refresh() {
		const url = `/api/audit/${recordType}/${encodeURIComponent(String(recordId))}`;
		if (url !== loadedFor) {
			entries = [];
			expanded = false;
			detailsOpen = false;
			selected = null;
			loadedFor = url;
		}
		loading = true;
		try {
			const res = await fetch(url);
			if (res.ok) entries = await res.json();
		} finally {
			loading = false;
		}
	}

	// refresh() reads recordType/recordId synchronously (building the fetch URL) before its
	// first await, so this effect re-runs whenever the sheet is pointed at a different record.
	$effect(() => {
		refresh();
	});

	function who(entry: AuditEntry): string {
		if (entry.via === 'system' && !entry.userName) return 'The system';
		return entry.userName ?? 'A deleted user';
	}

	function summary(entry: AuditEntry): string {
		if (recordType === 'fixed_asset')
			return `${entry.action === 'create' ? 'created' : entry.action === 'delete' ? 'deleted' : 'updated'} this asset`;
		if (entry.action === 'create') return 'created this record';
		if (entry.action === 'delete') return 'deleted this record';
		return changesSummary(recordType, entry.action, entry.changes, 4);
	}
</script>

<!-- Entries already shown stay put during a refresh(); only the first load says so. -->
{#if entries.length > 0}
	<div class="audit-list">
		{#each shown as entry (entry.id)}
			<div class="audit-entry">
				<div class="audit-entry-icon"><History size={13} /></div>
				<div class="audit-entry-main">
					<div class="audit-entry-line">
						<span class="audit-entry-user">{who(entry)}</span>
						{#if channelLabel(entry)}<span class="audit-entry-via">{channelLabel(entry)}</span>{/if}
						{summary(entry)}
					</div>
					{#if recordType === 'fixed_asset' && entry.changes?.length}
						<button
							type="button"
							class="audit-change-chip"
							onclick={() => {
								selected = entry;
								detailsOpen = true;
							}}>View changes <span aria-hidden="true">· {entry.changes.length}</span></button
						>
					{/if}
					<div class="audit-entry-time">{formatAuditTime(entry.createdAt)}</div>
				</div>
			</div>
		{/each}
	</div>
	<ListExpand total={entries.length} bind:expanded />
{:else if loading}
	<p class="card-empty">Loading…</p>
{:else}
	<p class="card-empty">No changes are recorded yet.</p>
{/if}

<Dialog.Root bind:open={detailsOpen}>
	<Dialog.Portal>
		<Dialog.Overlay class="fixed inset-0 z-50 bg-black/35" />
		<Dialog.Content
			class="bg-popover text-popover-foreground fixed top-1/2 left-1/2 z-50 max-h-[85dvh] w-[min(95vw,600px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border p-5 shadow-lg"
		>
			<div class="audit-details-head">
				<Dialog.Title class="text-base font-semibold">Activity details</Dialog.Title>
				<Dialog.Close class="audit-details-close" aria-label="Close activity details"
					><X size={16} /></Dialog.Close
				>
			</div>
			<Dialog.Description class="audit-details-description"
				>{selected
					? `${who(selected)} · ${formatAuditTime(selected.createdAt)}`
					: 'Recorded field changes'}</Dialog.Description
			>
			<div class="audit-values">
				{#each detailRows as row, index (index)}
					<div class="audit-value-row">
						<p class="audit-value-label">{row.label}</p>
						<div class="audit-value-pair">
							{#if selected?.action !== 'create'}<div>
									<span class="audit-value-heading"
										>{selected?.action === 'delete' ? 'Value' : 'Before'}</span
									>
									<p class="audit-value-text">{row.before}</p>
								</div>{/if}
							{#if selected?.action !== 'delete'}<div>
									<span class="audit-value-heading"
										>{selected?.action === 'create' ? 'Value' : 'After'}</span
									>
									<p class="audit-value-text">{row.after}</p>
								</div>{/if}
						</div>
					</div>
				{:else}<p class="card-empty">No field details were recorded for this change.</p>{/each}
			</div>
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>

<style>
	.audit-entry-line {
		overflow-wrap: anywhere;
	}
	.audit-change-chip {
		margin-top: 6px;
		padding: 3px 9px;
		max-width: 100%;
		border: 1px solid var(--border);
		border-radius: 999px;
		background: var(--accent);
		color: var(--foreground);
		font: inherit;
		font-size: 11px;
		cursor: pointer;
	}
	.audit-change-chip:hover {
		border-color: var(--primary);
	}
	.audit-change-chip:focus-visible,
	:global(.audit-details-close:focus-visible) {
		outline: 2px solid var(--primary);
		outline-offset: 2px;
	}
	.audit-details-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 12px;
	}
	:global(.audit-details-close) {
		display: grid;
		place-items: center;
		border: 0;
		background: none;
		color: var(--muted-foreground);
		padding: 5px;
		cursor: pointer;
	}
	:global(.audit-details-description) {
		margin: 4px 0 16px;
		color: var(--muted-foreground);
		font-size: 12px;
		overflow-wrap: anywhere;
	}
	.audit-values,
	.audit-value-row {
		min-width: 0;
	}
	.audit-value-row {
		padding: 10px 0;
		border-top: 1px solid var(--border);
	}
	.audit-value-label {
		font-size: 12px;
		font-weight: 500;
		margin: 0 0 6px;
		overflow-wrap: anywhere;
	}
	.audit-value-pair {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 12px;
	}
	.audit-value-heading {
		font-size: 11px;
		color: var(--muted-foreground);
	}
	.audit-value-text {
		font-size: 12px;
		line-height: 1.5;
		margin: 2px 0 0;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.audit-entry-via {
		color: var(--primary);
		font-weight: 500;
	}
</style>
