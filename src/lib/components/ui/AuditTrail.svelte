<script lang="ts">
	import { History } from '@lucide/svelte';
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
	let expandedEntries = $state<number[]>([]);
	const entryRows = $derived(
		new Map(
			entries.map((entry) => [
				entry.id,
				recordType === 'fixed_asset' ? auditChangeRows(recordType, entry.changes ?? []) : []
			])
		)
	);
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
			expandedEntries = [];
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

	function toggleEntry(id: number) {
		expandedEntries = expandedEntries.includes(id)
			? expandedEntries.filter((entryId) => entryId !== id)
			: [...expandedEntries, id];
	}

	function previewValue(value: string, open: boolean): string {
		return !open && value.length > 100 ? `${value.slice(0, 100)}…` : value;
	}

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
			{@const rows = entryRows.get(entry.id) ?? []}
			{@const detailsExpanded = expandedEntries.includes(entry.id)}
			<div class="audit-entry">
				<div class="audit-entry-icon"><History size={13} /></div>
				<div class="audit-entry-main">
					<div class="audit-entry-line">
						<span class="audit-entry-user">{who(entry)}</span>
						{#if channelLabel(entry)}<span class="audit-entry-via">{channelLabel(entry)}</span>{/if}
						{summary(entry)}
					</div>
					{#if rows.length}
						<div
							class="audit-change-chips"
							id={`audit-changes-${recordType}-${recordId}-${entry.id}`}
						>
							{#each detailsExpanded ? rows : rows.slice(0, 3) as row, index (index)}
								<span class="audit-change-chip">
									<span class="audit-change-key">{row.label}:</span>
									{#if entry.action !== 'create'}<span class="audit-change-value"
											>{previewValue(row.before, detailsExpanded)}</span
										>{/if}
									{#if entry.action === 'update'}<span aria-hidden="true">→</span><span
											class="sr-only">changed to</span
										>{/if}
									{#if entry.action !== 'delete'}<span class="audit-change-value"
											>{previewValue(row.after, detailsExpanded)}</span
										>{/if}
								</span>
							{/each}
						</div>
						{#if rows.length > 3 || rows.some((row) => row.before.length > 100 || row.after.length > 100)}
							<button
								type="button"
								class="audit-view-more"
								aria-expanded={detailsExpanded}
								aria-controls={`audit-changes-${recordType}-${recordId}-${entry.id}`}
								onclick={() => toggleEntry(entry.id)}
								>{detailsExpanded ? 'View less' : 'View more'}</button
							>
						{/if}
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

<style>
	.audit-entry-line {
		overflow-wrap: anywhere;
	}

	.audit-change-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin-top: 6px;
		min-width: 0;
	}
	.audit-change-chip {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 4px;
		padding: 3px 7px;
		max-width: 100%;
		min-width: 0;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--accent);
		font-size: 11.5px;
		line-height: 1.5;
	}
	.audit-change-key {
		font-weight: 500;
		overflow-wrap: anywhere;
		min-width: 0;
	}
	.audit-change-value {
		overflow-wrap: anywhere;
		white-space: pre-wrap;
		min-width: 0;
		max-width: 100%;
	}
	.audit-view-more {
		display: inline-block;
		margin-top: 6px;
		padding: 0;
		border: 0;
		background: none;
		color: var(--primary);
		font: inherit;
		font-size: 11.5px;
		text-decoration: underline;
		cursor: pointer;
	}
	.audit-view-more:focus-visible {
		outline: 2px solid var(--primary);
		outline-offset: 2px;
	}

	.audit-entry-via {
		color: var(--primary);
		font-weight: 500;
	}
</style>
