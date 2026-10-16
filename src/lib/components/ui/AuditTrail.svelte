<script lang="ts">
	import { History } from '@lucide/svelte';
	import {
		changesSummary,
		channelLabel,
		formatAuditTime,
		type AuditChange,
		type AuditVia
	} from '$lib/components/audit/audit-format.js';

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

	export async function refresh() {
		loading = true;
		try {
			const res = await fetch(`/api/audit/${recordType}/${encodeURIComponent(String(recordId))}`);
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
		if (entry.action === 'create') return 'created this record';
		if (entry.action === 'delete') return 'deleted this record';
		return changesSummary(recordType, entry.action, entry.changes, 4);
	}
</script>

{#if !loading && entries.length > 0}
	<div class="audit-list">
		{#each entries as entry (entry.id)}
			<div class="audit-entry">
				<div class="audit-entry-icon"><History size={13} /></div>
				<div class="audit-entry-main">
					<div class="audit-entry-line">
						<span class="audit-entry-user">{who(entry)}</span>
						{#if channelLabel(entry)}<span class="audit-entry-via">{channelLabel(entry)}</span>{/if}
						{summary(entry)}
					</div>
					<div class="audit-entry-time">{formatAuditTime(entry.createdAt)}</div>
				</div>
			</div>
		{/each}
	</div>
{/if}

<style>
	.audit-entry-via {
		color: var(--primary);
		font-weight: 500;
	}
</style>
