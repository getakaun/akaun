<script lang="ts">
	import { History, User, KeyRound, Shapes, Activity, X } from '@lucide/svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { SvelteURLSearchParams } from 'svelte/reactivity';
	import FilterDropdown from '$lib/components/ui/FilterDropdown.svelte';
	import DateRangeFilter from '$lib/components/ui/DateRangeFilter.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import { createResourceStream } from '$lib/sse.js';
	import {
		ACTION_LABELS,
		RECORD_TYPE_LABELS,
		VIA_LABELS,
		actorLine,
		changesSummary,
		formatAuditTime,
		isAgent,
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
		actorName: string | null;
		via: AuditVia;
		credentialLabel: string | null;
	};
	type Filters = {
		userId?: number;
		via?: string;
		credentialId?: string;
		clientId?: string;
		recordTypes?: string[];
		action?: string;
		from?: string;
		to?: string;
		requestId?: string;
		recordId?: string;
	};
	type Data = {
		entries: Entry[];
		nextCursor: number | null;
		filters: Filters;
		options: {
			actors: { userId: number; name: string }[];
			tokens: { credentialId: string; label: string }[];
			apps: { clientId: string; label: string }[];
		};
	};

	let { data }: { data: Data } = $props();

	// The server filters, so a filter change is a navigation that replaces the
	// first page; live entries and "Load more" are added to this copy.
	// svelte-ignore state_referenced_locally
	let entries = $state<Entry[]>(data.entries);
	// svelte-ignore state_referenced_locally
	let nextCursor = $state<number | null>(data.nextCursor);
	$effect(() => {
		entries = data.entries;
		nextCursor = data.nextCursor;
	});

	const filters = $derived(data.filters);
	const activeCount = $derived(
		[
			filters.userId,
			filters.via,
			filters.credentialId,
			filters.clientId,
			filters.recordTypes?.length,
			filters.action,
			filters.from || filters.to,
			filters.requestId,
			filters.recordId
		].filter(Boolean).length
	);

	/** The address with one filter changed; `undefined` removes it. */
	function withFilter(changes: Record<string, string | undefined>): string {
		const q = new SvelteURLSearchParams(page.url.searchParams);
		for (const [key, value] of Object.entries(changes)) {
			q.delete(key);
			if (value) q.set(key, value);
		}
		const query = q.toString();
		return `${resolve('/(app)/audit')}${query ? `?${query}` : ''}`;
	}

	function setFilter(changes: Record<string, string | undefined>) {
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- withFilter() starts from resolve(); the rule cannot see through the call.
		void goto(withFilter(changes), { replaceState: true, noScroll: true, keepFocus: true });
	}

	function clearAll() {
		void goto(resolve('/(app)/audit'), { replaceState: true, noScroll: true, keepFocus: true });
	}

	// Dates are picked in the viewer's own days and sent as instants, because
	// the log is stored in UTC.
	function localDate(iso: string | undefined): string {
		if (!iso) return '';
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return '';
		const pad = (n: number) => String(n).padStart(2, '0');
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	}
	// svelte-ignore state_referenced_locally
	let dateFrom = $state(localDate(data.filters.from));
	// svelte-ignore state_referenced_locally
	let dateTo = $state(localDate(data.filters.to));
	$effect(() => {
		const from = dateFrom ? new Date(`${dateFrom}T00:00:00`).toISOString() : undefined;
		const to = dateTo ? new Date(`${dateTo}T23:59:59.999`).toISOString() : undefined;
		if (localDate(from) === localDate(filters.from) && localDate(to) === localDate(filters.to)) return;
		setFilter({ from, to });
	});
	$effect(() => {
		dateFrom = localDate(filters.from);
		dateTo = localDate(filters.to);
	});

	function apiQuery(cursor: Record<string, string>): string {
		const q = new SvelteURLSearchParams(page.url.searchParams);
		for (const [key, value] of Object.entries(cursor)) q.set(key, value);
		return `/api/audit?${q.toString()}`;
	}

	let loadingMore = $state(false);
	async function loadMore() {
		if (nextCursor === null || loadingMore) return;
		loadingMore = true;
		try {
			const res = await fetch(apiQuery({ before: String(nextCursor) }));
			if (!res.ok) return;
			const body = (await res.json()) as { entries: Entry[]; nextCursor: number | null };
			const known = new Set(entries.map((e) => e.id));
			entries = [...entries, ...body.entries.filter((e) => !known.has(e.id))];
			nextCursor = body.nextCursor;
		} finally {
			loadingMore = false;
		}
	}

	// Live: the stream says only that something was written. One fetch per
	// burst asks for what is newer than the top row, with this page's filters.
	let pending: ReturnType<typeof setTimeout> | undefined;
	async function fetchNewer() {
		const newest = entries.reduce((max, e) => Math.max(max, e.id), 0);
		const res = await fetch(
			apiQuery(newest > 0 ? { after: String(newest) } : {})
		);
		if (!res.ok) return;
		const body = (await res.json()) as { entries: Entry[] };
		const known = new Set(entries.map((e) => e.id));
		const fresh = body.entries.filter((e) => !known.has(e.id));
		if (fresh.length) entries = [...fresh, ...entries];
	}
	createResourceStream<{ type: string }>('/api/audit/stream', (msg) => {
		if (msg.type !== 'entry-added') return;
		clearTimeout(pending);
		pending = setTimeout(() => void fetchNewer(), 500);
	});

	function entryHref(id: number) {
		return resolve('/(app)/audit/[id]', { id: String(id) });
	}

	const VIA_OPTIONS: [string, string][] = [
		['agent', 'Tokens and apps'],
		['oauth', VIA_LABELS.oauth],
		['pat', VIA_LABELS.pat],
		['session', VIA_LABELS.session],
		['system', VIA_LABELS.system]
	];
	const ACTION_OPTIONS = Object.entries(ACTION_LABELS);
	const TYPE_OPTIONS = Object.entries(RECORD_TYPE_LABELS).sort((a, b) => a[1].localeCompare(b[1]));
	const typeFilter = $derived(filters.recordTypes?.[0]);
	const credentialLabel = $derived(
		filters.credentialId
			? data.options.tokens.find((t) => t.credentialId === filters.credentialId)?.label
			: filters.clientId
				? data.options.apps.find((a) => a.clientId === filters.clientId)?.label
				: undefined
	);
</script>

<svelte:head><title>Audit log - Akaun</title></svelte:head>

{#snippet optionList(
	title: string,
	options: [string, string][],
	selected: string | undefined,
	choose: (value: string | undefined) => void
)}
	<div class="opt-list">
		<div class="opt-head">
			<span>{title}</span>
			{#if selected}<button class="opt-clear" onclick={() => choose(undefined)}>Clear</button>{/if}
		</div>
		{#each options as [value, label] (value)}
			<button class="opt" class:on={selected === value} onclick={() => choose(value)}>
				<span class="opt-radio"></span>{label}
			</button>
		{:else}
			<div class="opt-empty">Nothing yet</div>
		{/each}
	</div>
{/snippet}

<div class="screen" style="position:relative;">
	<header class="topbar">
		<div class="topbar-left">
			<h1 class="page-title">Audit log</h1>
			<p class="page-sub">
				Every change, who made it, and whether it came through the app, a token or a connected app.
			</p>
		</div>
	</header>
	<div class="work">
		<div class="work-main layout-standard" style="padding-top:12px;">
			<div class="toolbar">
				<div class="status-tabs">
					<button class="status-tab" class:active={!filters.via} onclick={() => setFilter({ via: undefined })}>
						Everything
					</button>
					<button
						class="status-tab"
						class:active={filters.via === 'agent'}
						onclick={() => setFilter({ via: 'agent' })}
					>
						Tokens and apps
					</button>
				</div>
				<div class="toolbar-filters audit-filters">
					{#if activeCount > 0}
						<button class="clear-filters" onclick={clearAll}><X size={13} /> Clear</button>
					{/if}
					<FilterDropdown label="Channel" active={!!filters.via} align="right">
						{#snippet icon()}<Activity size={14} />{/snippet}
						{@render optionList('Came through', VIA_OPTIONS, filters.via, (v) => setFilter({ via: v }))}
					</FilterDropdown>
					<FilterDropdown label={credentialLabel ?? 'Token or app'} active={!!(filters.credentialId || filters.clientId)} align="right">
						{#snippet icon()}<KeyRound size={14} />{/snippet}
						{@render optionList(
							'Access tokens',
							data.options.tokens.map((t) => [t.credentialId, t.label]),
							filters.credentialId,
							(v) => setFilter({ credential: v, client: undefined })
						)}
						{@render optionList(
							'Connected apps',
							data.options.apps.map((a) => [a.clientId, a.label]),
							filters.clientId,
							(v) => setFilter({ client: v, credential: undefined })
						)}
					</FilterDropdown>
					<FilterDropdown label="Person" active={!!filters.userId} align="right">
						{#snippet icon()}<User size={14} />{/snippet}
						{@render optionList(
							'Changed by',
							data.options.actors.map((a) => [String(a.userId), a.name]),
							filters.userId ? String(filters.userId) : undefined,
							(v) => setFilter({ user: v })
						)}
					</FilterDropdown>
					<FilterDropdown label="Type" active={!!(typeFilter || filters.action)} align="right">
						{#snippet icon()}<Shapes size={14} />{/snippet}
						{@render optionList('What changed', TYPE_OPTIONS, typeFilter, (v) => setFilter({ type: v }))}
						{@render optionList('Action', ACTION_OPTIONS, filters.action, (v) => setFilter({ action: v }))}
					</FilterDropdown>
					<DateRangeFilter variant="dropdown" bind:from={dateFrom} bind:to={dateTo} />
				</div>
			</div>

			{#if filters.requestId || filters.recordId}
				<div class="result-meta">
					<span>
						{filters.requestId ? 'Showing one request’s changes' : `Showing one ${RECORD_TYPE_LABELS[typeFilter ?? ''] ?? 'record'}’s changes`}
					</span>
					<button class="link-btn" onclick={() => setFilter({ request: undefined, record: undefined })}>
						Show all
					</button>
				</div>
			{/if}

			<div class="table-card">
				<table class="exp-table">
					<thead>
						<tr>
							<th>When</th>
							<th>Who</th>
							<th>What</th>
							<th>Change</th>
						</tr>
					</thead>
					<tbody>
						{#each entries as entry (entry.id)}
							<tr
								class="exp-row"
								class:agent-row={isAgent(entry)}
								onclick={(ev) => {
									if ((ev.target as HTMLElement).closest('a')) return;
									void goto(entryHref(entry.id));
								}}
							>
								<td class="td-date" data-label="When">
									<a class="row-link" href={entryHref(entry.id)}>{formatAuditTime(entry.createdAt)}</a>
								</td>
								<td data-label="Who">
									<div class="who">
										<span>{entry.actorName ?? (entry.via === 'system' ? 'System' : 'A deleted user')}</span>
										{#if entry.via !== 'session'}
											<span class="via-chip via-{entry.via}" title={actorLine(entry)}>
												{entry.via === 'system' ? VIA_LABELS.system : (entry.credentialLabel ?? VIA_LABELS[entry.via])}
											</span>
										{/if}
									</div>
								</td>
								<td data-label="What">
									<div class="what">
										<span class="what-type">{RECORD_TYPE_LABELS[entry.recordType] ?? entry.recordType}</span>
										<span class="what-label">{entry.recordLabel ?? `#${entry.recordId}`}</span>
									</div>
								</td>
								<td data-label="Change">
									<div class="change">
										<span class="statusbadge tone-{entry.action === 'create' ? 'green' : entry.action === 'delete' ? 'red' : 'blue'}">
											<span class="statusdot"></span>{ACTION_LABELS[entry.action] ?? entry.action}
										</span>
										{#if entry.action === 'update'}
											<span class="change-text">{changesSummary(entry.recordType, entry.action, entry.changes, 2)}</span>
										{/if}
									</div>
								</td>
							</tr>
						{:else}
							<tr class="empty-row">
								<td colspan="4">
									<EmptyState
										title={activeCount > 0 ? 'No changes match your filters' : 'No changes yet'}
										sub={activeCount > 0
											? 'Try a wider date range or fewer filters.'
											: 'Every change anyone makes will appear here.'}
									>
										{#snippet icon()}<History size={20} />{/snippet}
										{#snippet action()}
											{#if activeCount > 0}<button class="link-btn" onclick={clearAll}>Clear filters</button>{/if}
										{/snippet}
									</EmptyState>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			<div class="table-foot">
				<span>{entries.length} change{entries.length === 1 ? '' : 's'} shown</span>
				{#if nextCursor !== null}
					<button class="sheet-btn" disabled={loadingMore} onclick={loadMore}>
						{loadingMore ? 'Loading…' : 'Load older changes'}
					</button>
				{/if}
			</div>
		</div>
	</div>
</div>

<style>
	.row-link {
		color: inherit;
		text-decoration: none;
	}
	.row-link:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
		border-radius: 4px;
	}
	.audit-filters {
		flex-wrap: wrap;
	}
	.who,
	.what {
		display: flex;
		flex-direction: column;
		gap: 3px;
		min-width: 0;
	}
	.what-type {
		font-size: 11px;
		color: var(--muted-foreground);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.what-label {
		font-weight: 500;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 260px;
	}
	.via-chip {
		align-self: flex-start;
		font-size: 11px;
		font-weight: 500;
		padding: 1px 8px;
		border-radius: 999px;
		background: var(--secondary);
		color: var(--secondary-foreground);
		max-width: 200px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.via-chip.via-oauth,
	.via-chip.via-pat {
		background: var(--primary-soft, var(--accent));
		color: var(--primary);
	}
	.change {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 4px;
	}
	.change-text {
		font-size: 12.5px;
		color: var(--muted-foreground);
		max-width: 420px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.agent-row td:first-child {
		box-shadow: inset 3px 0 0 var(--primary);
	}
	.table-foot {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}
	.opt-list {
		padding: 5px;
		min-width: 220px;
	}
	.opt-list + .opt-list {
		border-top: 1px solid var(--border);
	}
	.opt-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 6px 8px 8px;
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--muted-foreground);
	}
	.opt-clear {
		border: none;
		background: none;
		color: var(--primary);
		cursor: pointer;
		font-size: 11px;
		font-weight: 600;
	}
	.opt {
		display: flex;
		align-items: center;
		gap: 9px;
		width: 100%;
		border: none;
		background: none;
		font-family: inherit;
		font-size: 13px;
		color: var(--foreground);
		padding: 7px 8px;
		border-radius: 7px;
		cursor: pointer;
		text-align: left;
	}
	.opt:hover {
		background: var(--accent);
	}
	.opt-radio {
		width: 16px;
		height: 16px;
		border-radius: 50%;
		border: 1.5px solid var(--border-strong);
		background: var(--card);
		flex-shrink: 0;
		display: grid;
		place-items: center;
	}
	.opt.on .opt-radio {
		border-color: var(--primary);
		background: var(--primary);
	}
	.opt.on .opt-radio::after {
		content: '';
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: white;
	}
	.opt-empty {
		padding: 6px 8px 8px;
		font-size: 12.5px;
		color: var(--muted-foreground);
	}
</style>
