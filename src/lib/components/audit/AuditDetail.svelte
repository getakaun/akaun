<script lang="ts">
	import { ChevronRight, ExternalLink, Filter } from '@lucide/svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import DetailPage from '$lib/components/ui/DetailPage.svelte';
	import ListExpand, { visibleItems } from '$lib/components/ui/ListExpand.svelte';
	import {
		ACTION_LABELS,
		RECORD_TYPE_LABELS,
		VIA_LABELS,
		actorLine,
		changesSummary,
		describeChange,
		formatAuditTime,
		type AuditChange,
		type AuditVia
	} from './audit-format.js';

	type Entry = {
		id: number;
		recordType: string;
		recordId: string;
		recordLabel: string | null;
		action: string;
		changes: AuditChange[] | null;
		createdAt: string;
		userId: number | null;
		actorName: string | null;
		via: AuditVia;
		credentialId: string | null;
		clientId: string | null;
		credentialLabel: string | null;
		requestId: string | null;
		operation: string | null;
		href: string | null;
	};

	let {
		data
	}: { data: { entry: Entry; sameRequest: { entries: Entry[]; total: number } } } = $props();

	let sameExpanded = $state(false);
	const sameShown = $derived(visibleItems(data.sameRequest.entries, sameExpanded));

	const entry = $derived(data.entry);
	const typeLabel = $derived(RECORD_TYPE_LABELS[entry.recordType] ?? entry.recordType);
	const title = $derived(entry.recordLabel ?? `${typeLabel} #${entry.recordId}`);
	const changes = $derived((entry.changes ?? []).map((change) => describeChange(entry.recordType, change)));
	// A create shows what it was made with; a delete what was lost.
	const columns = $derived(
		entry.action === 'create'
			? (['after'] as const)
			: entry.action === 'delete'
				? (['before'] as const)
				: (['before', 'after'] as const)
	);

	function auditHref(query: Record<string, string>) {
		return `${resolve('/(app)/audit')}?${new URLSearchParams(query).toString()}`;
	}
	function credentialQuery(e: Entry): Record<string, string> | null {
		if (e.via === 'pat' && e.credentialId) return { credential: e.credentialId };
		if (e.via === 'oauth' && e.clientId) return { client: e.clientId };
		return null;
	}
	const credentialFilter = $derived(credentialQuery(entry));
</script>

<svelte:head><title>{title} · Audit log - Akaun</title></svelte:head>

<DetailPage backHref="/audit" backLabel="Audit log">
	{#snippet hero()}
		<div class="detail-hero-eyebrow">
			<span>{typeLabel}</span><span>·</span><span>{ACTION_LABELS[entry.action] ?? entry.action}</span>
		</div>
		<h1 class="detail-hero-title">{title}</h1>
		<div class="detail-hero-figure">
			<span class="detail-hero-note">{actorLine(entry)} · {formatAuditTime(entry.createdAt)}</span>
		</div>
	{/snippet}

	{#snippet main()}
		<section class="detail-card">
			<div class="detail-card-head">
				<span class="detail-card-title">
					{entry.action === 'create' ? 'Created with' : entry.action === 'delete' ? 'What was deleted' : 'What changed'}
				</span>
			</div>
			{#if changes.length}
				<table class="change-table">
					<thead>
						<tr>
							<th>Field</th>
							{#each columns as column (column)}
								<th>{column === 'before' ? (entry.action === 'delete' ? 'Value' : 'Before') : entry.action === 'create' ? 'Value' : 'After'}</th>
							{/each}
						</tr>
					</thead>
					<tbody>
						{#each changes as change, index (index)}
							<tr>
								<td class="field">{change.label}</td>
								{#if change.added || change.removed}
									<td colspan={columns.length}>
										{#each change.added ?? [] as value (value)}<span class="set-chip added">+ {value}</span>{/each}
										{#each change.removed ?? [] as value (value)}<span class="set-chip removed">− {value}</span>{/each}
										{#if !change.added?.length && !change.removed?.length}<span class="muted">{change.after}</span>{/if}
									</td>
								{:else}
									{#each columns as column (column)}
										<td class:was={column === 'before' && entry.action === 'update'}>{change[column]}</td>
									{/each}
								{/if}
							</tr>
						{/each}
					</tbody>
				</table>
			{:else}
				<p class="card-empty">No field details were recorded for this change.</p>
			{/if}
		</section>
	{/snippet}

	{#snippet rail()}
		<section class="detail-card">
			<div class="detail-card-head"><span class="detail-card-title">How it arrived</span></div>
			<div class="detail-list">
				<div class="detail-row">
					<span class="detail-key">Who</span>
					<span class="detail-val">{entry.actorName ?? (entry.via === 'system' ? 'System' : 'A deleted user')}</span>
				</div>
				<div class="detail-row">
					<span class="detail-key">Channel</span>
					<span class="detail-val">{VIA_LABELS[entry.via]}</span>
				</div>
				{#if entry.via === 'pat' || entry.via === 'oauth'}
					<div class="detail-row">
						<span class="detail-key">{entry.via === 'pat' ? 'Token' : 'App'}</span>
						<span class="detail-val">{entry.credentialLabel ?? '—'}</span>
					</div>
				{/if}
				{#if entry.operation}
					<div class="detail-row">
						<span class="detail-key">Request</span>
						<span class="detail-val mono">{entry.operation}</span>
					</div>
				{/if}
				<div class="detail-row">
					<span class="detail-key">When</span>
					<span class="detail-val">{formatAuditTime(entry.createdAt)}</span>
				</div>
			</div>
			{#if credentialFilter}
				<button
					type="button"
					class="related-link ob-card"
					style="margin-top:12px;"
					onclick={() =>
						// eslint-disable-next-line svelte/no-navigation-without-resolve -- auditHref() starts from resolve(); the rule cannot see through the call.
						goto(auditHref(credentialFilter))}
				>
					<span class="ob-icon"><Filter size={15} /></span>
					<span class="ob-main">
						<span class="ob-title">Everything {entry.via === 'pat' ? 'this token' : 'this app'} changed</span>
						<span class="ob-sub">{entry.credentialLabel ?? VIA_LABELS[entry.via]}</span>
					</span>
					<ChevronRight size={14} color="var(--muted-foreground)" />
				</button>
			{/if}
		</section>

		<section class="detail-card">
			<div class="detail-card-head"><span class="detail-card-title">The {typeLabel.toLowerCase()}</span></div>
			{#if entry.href}
				<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the server builds this link from the record's own route. -->
				<a class="related-link ob-card" href={entry.href}>
					<span class="ob-icon"><ExternalLink size={15} /></span>
					<span class="ob-main">
						<span class="ob-title">{title}</span>
						<span class="ob-sub">Open it</span>
					</span>
					<ChevronRight size={14} color="var(--muted-foreground)" />
				</a>
			{:else}
				<p class="muted" style="margin:0 0 8px; font-size:13px;">
					{entry.action === 'delete' ? 'It was deleted.' : 'It has no page of its own, or no longer exists.'}
				</p>
			{/if}
			<button
				type="button"
				class="related-link ob-card"
				style="margin-top:8px;"
				onclick={() =>
					// eslint-disable-next-line svelte/no-navigation-without-resolve -- auditHref() starts from resolve(); the rule cannot see through the call.
					goto(auditHref({ type: entry.recordType, record: entry.recordId }))}
			>
				<span class="ob-icon"><Filter size={15} /></span>
				<span class="ob-main">
					<span class="ob-title">Its whole history</span>
					<span class="ob-sub">Every change to this {typeLabel.toLowerCase()}</span>
				</span>
				<ChevronRight size={14} color="var(--muted-foreground)" />
			</button>
		</section>

		{#if data.sameRequest.total > 0}
			<section class="detail-card">
				<div class="detail-card-head">
					<span class="detail-card-title">Changed in the same request</span>
				</div>
				<div class="same-list">
					{#each sameShown as other (other.id)}
						<button
							type="button"
							class="related-link same-row"
							onclick={() => goto(resolve('/(app)/audit/[id]', { id: String(other.id) }))}
						>
							<span class="same-main">
								<span class="same-title">
									{RECORD_TYPE_LABELS[other.recordType] ?? other.recordType}: {other.recordLabel ?? `#${other.recordId}`}
								</span>
								<span class="same-sub">{changesSummary(other.recordType, other.action, other.changes, 1)}</span>
							</span>
							<ChevronRight size={13} color="var(--muted-foreground)" />
						</button>
					{/each}
				</div>
				<ListExpand total={data.sameRequest.entries.length} bind:expanded={sameExpanded} />
				<!-- The page holds only the first entries; the rest are on the audit log, and
				     the link is offered once the reader has opened what is here. -->
				{#if sameShown.length === data.sameRequest.entries.length && data.sameRequest.total > data.sameRequest.entries.length && entry.requestId}
					<button
						type="button"
						class="list-expand-btn"
						onclick={() =>
							// eslint-disable-next-line svelte/no-navigation-without-resolve -- auditHref() starts from resolve(); the rule cannot see through the call.
							goto(auditHref({ request: entry.requestId! }))}
					>
						See all {data.sameRequest.total + 1} in the audit log
					</button>
				{/if}
			</section>
		{/if}
	{/snippet}
</DetailPage>

<style>
	.change-table {
		width: 100%;
		border-collapse: collapse;
		font-size: 13px;
	}
	.change-table th {
		text-align: left;
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--muted-foreground);
		padding: 0 10px 8px 0;
		border-bottom: 1px solid var(--border);
	}
	.change-table td {
		padding: 9px 10px 9px 0;
		border-bottom: 1px solid var(--border);
		vertical-align: top;
		word-break: break-word;
	}
	.change-table tr:last-child td {
		border-bottom: none;
	}
	.change-table .field {
		color: var(--muted-foreground);
		width: 34%;
	}
	.change-table .was {
		color: var(--muted-foreground);
		text-decoration: line-through;
		text-decoration-color: color-mix(in srgb, var(--muted-foreground) 50%, transparent);
	}
	.set-chip {
		display: inline-block;
		margin: 0 6px 4px 0;
		padding: 1px 8px;
		border-radius: 999px;
		font-size: 12px;
	}
	.set-chip.added {
		background: color-mix(in srgb, var(--primary) 12%, transparent);
		color: var(--primary);
	}
	.set-chip.removed {
		background: var(--secondary);
		color: var(--muted-foreground);
		text-decoration: line-through;
	}
	.mono {
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 12px;
		word-break: break-all;
	}
	.same-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.same-row {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		text-align: left;
		padding: 8px 10px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--card);
		font-family: inherit;
		color: var(--foreground);
	}
	.same-main {
		display: flex;
		flex-direction: column;
		gap: 2px;
		flex: 1;
		min-width: 0;
	}
	.same-title {
		font-size: 12.5px;
		font-weight: 500;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.same-sub {
		font-size: 11.5px;
		color: var(--muted-foreground);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
