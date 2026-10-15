<script lang="ts">
	import { createResourceStream, mergeById } from '$lib/sse.js';
	import { fly } from 'svelte/transition';
	import {
		Search,
		Plus,
		SlidersHorizontal,
		X,
		FileText
	} from '@lucide/svelte';
	import StatusBadge from '$lib/components/ui/StatusBadge.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import StatCard from '$lib/components/ui/StatCard.svelte';
	import DateRangeFilter from '$lib/components/ui/DateRangeFilter.svelte';
	import * as Sheet from '$lib/components/ui/sheet/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { formatMoney, formatMoneyRM, formatDateShort } from '$lib/format.js';
	import { mainCurrency, mainCurrencySymbol } from '$lib/currency-state.svelte.js';
	import { formatCurrencyAmount } from '$lib/currency.js';
	import { QuotationStatus } from '$lib/enums.js';
	import { quotationStatusKey } from '$lib/sales/status.js';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import type { loadQuotationsPage } from '$lib/server/loaders/quotations.js';

	type PageData = ReturnType<typeof loadQuotationsPage>;

	let {
		data,
	}: { data: PageData } = $props();

	// Local reactive list — updated by SSE events and re-synced on SvelteKit data reload
	// svelte-ignore state_referenced_locally
	let quotations = $state(data.quotations);
	$effect(() => {
		quotations = data.quotations;
	});

	// --- State ---
	let searchRaw = $state('');
	let search = $state('');
	// Which ids the server matched for the current search term — server-side
	// because the search text (notes, terms, line items) isn't part of the row
	// already loaded into the browser. `null` means no search is active.
	let searchMatchedIds = $state<Set<number> | null>(null);
	let statusTab = $state('all');
	let dateFrom = $state('');
	let dateTo = $state('');
	let sort = $state({ key: 'issueDate', dir: 'desc' as 'asc' | 'desc' });
	let mobileFilterOpen = $state(false);
	let mobileSearchOpen = $state(false);
	let mobileSearchEl = $state<HTMLInputElement | null>(null);
	$effect(() => {
		if (mobileSearchOpen && mobileSearchEl) mobileSearchEl.focus();
	});

	// Debounced search
	$effect(() => {
		const v = searchRaw;
		const t = setTimeout(() => (search = v), 300);
		return () => clearTimeout(t);
	});

	// A keyword can live in a line item, a note or the terms — none of which is
	// in the rows already loaded into the browser — so the term goes to the
	// server instead of a client-only field check (the same as the invoices list).
	$effect(() => {
		const term = search.trim();
		if (!term) {
			searchMatchedIds = null;
			return;
		}
		// A newer term (or clearing it) supersedes this request: a slow reply for
		// "ab" must not land after the one for "abc".
		let stale = false;
		fetch(`/api/quotations?search=${encodeURIComponent(term)}&limit=500`)
			.then((r) => (r.ok ? r.json() : null))
			.then((rows: Quotation[] | null) => {
				if (stale) return;
				if (!rows) {
					searchMatchedIds = new Set();
					return;
				}
				quotations = mergeById(quotations, rows);
				searchMatchedIds = new Set(rows.map((r) => r.id));
			})
			.catch(() => {
				if (stale) return;
				searchMatchedIds = new Set();
			});
		return () => {
			stale = true;
		};
	});

	// SSE — real-time updates from server
	type QuotationStreamMsg =
		| { type: 'quotation-update'; item: (typeof data.quotations)[0] }
		| { type: 'quotation-delete'; id: number };

	type Quotation = (typeof data.quotations)[0];

	// Which tab a quotation belongs under. An expired draft or sent quote is
	// listed under Expired only, the same as its badge says.
	const IN_TAB: Record<string, (q: Quotation) => boolean> = {
		draft: (q) => q.status === QuotationStatus.Draft && !q.isExpired,
		sent: (q) => q.status === QuotationStatus.Sent && !q.isExpired,
		accepted: (q) => q.status === QuotationStatus.Accepted,
		declined: (q) => q.status === QuotationStatus.Declined,
		converted: (q) => q.status === QuotationStatus.Converted,
		superseded: (q) => q.status === QuotationStatus.Superseded,
		expired: (q) => q.isExpired
	};

	// Derived counts (from local state for real-time accuracy)
	const counts = $derived.by(() => ({
		all: quotations.length,
		draft: quotations.filter(IN_TAB.draft).length,
		sent: quotations.filter(IN_TAB.sent).length,
		accepted: quotations.filter(IN_TAB.accepted).length,
		declined: quotations.filter(IN_TAB.declined).length,
		converted: quotations.filter(IN_TAB.converted).length,
		superseded: quotations.filter(IN_TAB.superseded).length,
		expired: quotations.filter(IN_TAB.expired).length
	}));

	// Stats
	const stats = $derived.by(() => {
		const accepted = quotations.filter((q) => q.status === QuotationStatus.Accepted);
		const sent = quotations.filter((q) => q.status === QuotationStatus.Sent);
		const now = new Date();
		const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
		const thisMonth = quotations.filter((q) => q.issueDate.startsWith(monthKey));
		return {
			acceptedTotal: accepted.reduce((s, q) => s + q.mainAmount, 0),
			acceptedCount: accepted.length,
			sentTotal: sent.reduce((s, q) => s + q.mainAmount, 0),
			sentCount: sent.length,
			monthTotal: thisMonth.reduce((s, q) => s + q.mainAmount, 0),
			monthCount: thisMonth.length,
			allTotal: quotations.reduce((s, q) => s + q.mainAmount, 0)
		};
	});

	// Filtered + sorted list
	const filtered = $derived.by(() => {
		let rows = quotations.slice();
		if (statusTab !== 'all') rows = rows.filter(IN_TAB[statusTab]);
		if (dateFrom) rows = rows.filter((q) => q.issueDate >= dateFrom);
		if (dateTo) rows = rows.filter((q) => q.issueDate <= dateTo);
		if (searchMatchedIds) {
			const matched = searchMatchedIds;
			rows = rows.filter((q) => matched.has(q.id));
		}
		rows.sort((a, b) => {
			const ak = sort.key as keyof typeof a;
			const av = (a[ak] ?? '') as string | number;
			const bv = (b[ak] ?? '') as string | number;
			let cmp = av < bv ? -1 : av > bv ? 1 : 0;
			if (cmp === 0) cmp = a.id - b.id;
			return sort.dir === 'asc' ? cmp : -cmp;
		});
		return rows;
	});

	const filteredTotal = $derived(filtered.reduce((s, q) => s + q.mainAmount, 0));
	const activeFilterCount = $derived((dateFrom || dateTo ? 1 : 0) + (search.trim() ? 1 : 0));

	function onSort(key: string) {
		if (sort.key === key) {
			sort = { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' };
		} else {
			sort = { key, dir: key === 'issueDate' || key === 'mainAmount' ? 'desc' : 'asc' };
		}
	}

	function clearAllFilters() {
		dateFrom = '';
		dateTo = '';
		searchRaw = '';
		statusTab = 'all';
	}

	function quotationHref(id: number): string {
		return resolve('/(app)/quotations/[id]', { id: String(id) });
	}

	function openQuotation(q: (typeof data.quotations)[0]) {
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- the href comes from resolve(); the rule cannot see through the helper call.
		void goto(quotationHref(q.id));
	}

	createResourceStream<QuotationStreamMsg>('/api/quotations/stream', (msg) => {
		if (msg.type === 'quotation-update') quotations = mergeById(quotations, [msg.item]);
		else if (msg.type === 'quotation-delete')
			quotations = quotations.filter((q) => q.id !== msg.id);
	});

</script>

<div class="screen" style="position:relative;">
	<!-- Top bar -->
	<header class="topbar">
		<div class="topbar-left">
			<h1 class="page-title">Quotations</h1>
			<p class="page-sub">
				{counts.all} records · <span class="num">{formatMoneyRM(stats.allTotal)}</span> total
			</p>
		</div>
		<div class="topbar-right">
			<div class="search-box">
				<div style="position:relative; display:flex; align-items:center;">
					<span style="position:absolute; left:10px; color:var(--muted-foreground); display:flex; pointer-events:none;">
						<Search size={15} />
					</span>
					<Input
						type="search"
						placeholder="Search QT#, customer, ref…"
						bind:value={searchRaw}
						class="h-[34px] pl-8 text-[13px]"
					/>
				</div>
			</div>
			{#if mobileSearchOpen}
				<div class="mobile-search-inline" transition:fly={{ x: 12, duration: 180 }}>
					<span class="mobile-search-inline-icon"><Search size={15} /></span>
					<input
						class="mobile-search-inline-input"
						type="search"
						placeholder="Search QT#, customer, ref…"
						bind:value={searchRaw}
						bind:this={mobileSearchEl}
					/>
				</div>
			{/if}
			<button
				class="mobile-search-toggle"
				class:active={mobileSearchOpen}
				onclick={() => {
					mobileSearchOpen = !mobileSearchOpen;
					if (!mobileSearchOpen) searchRaw = '';
				}}
			>
				{#if mobileSearchOpen}<X size={16} />{:else}<Search size={16} />{/if}
			</button>
			{#if data.perms.add}
				<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the href comes from resolve(); the rule cannot see through the helper call. -->
				<a
					href={resolve('/(app)/quotations/new')}
					style="display:inline-flex; align-items:center; gap:6px; height:32px; padding:0 12px; background:var(--primary); color:var(--primary-foreground); border:none; border-radius:8px; font-family:inherit; font-size:13px; font-weight:500; cursor:pointer; text-decoration:none;"
				>
					<Plus size={15} /> <span class="btn-text">New quotation</span>
				</a>
			{/if}
		</div>
	</header>

	<!-- Stat strip -->
	<div class="stat-strip">
		<StatCard
			tone="amber"
			label="Sent"
			cur={mainCurrencySymbol()}
			value={formatMoney(stats.sentTotal)}
			sub="{stats.sentCount} awaiting response"
		/>
		<StatCard
			tone="green"
			label="Accepted"
			cur={mainCurrencySymbol()}
			value={formatMoney(stats.acceptedTotal)}
			sub="{stats.acceptedCount} won"
		/>
		<StatCard
			label="This month"
			cur={mainCurrencySymbol()}
			value={formatMoney(stats.monthTotal)}
			sub="{stats.monthCount} issued"
		/>
		<StatCard
			label="All recorded"
			cur={mainCurrencySymbol()}
			value={formatMoney(stats.allTotal)}
			sub="{counts.all} quotations"
		/>
	</div>

	<div class="work">
		<div class="work-main layout-standard" style="padding-top:12px;">
			<!-- Toolbar -->
			<div class="toolbar">
				<div class="status-tabs">
					{#each [['all', 'All'], ['draft', 'Draft'], ['sent', 'Sent'], ['accepted', 'Accepted'], ['declined', 'Declined'], ['converted', 'Converted'], ['superseded', 'Superseded'], ['expired', 'Expired']] as [id, label]}
						<button
							class="status-tab"
							class:active={statusTab === id}
							onclick={() => (statusTab = id)}
						>
							{label}<span class="tab-count">{counts[id as keyof typeof counts]}</span>
						</button>
					{/each}
				</div>
				<div class="mobile-filter-row">
					<button
						class="btn-outline btn-sm"
						style="display:inline-flex; align-items:center; gap:6px;"
						onclick={() => (mobileFilterOpen = true)}
					>
						<SlidersHorizontal size={13} /> Filters
						{#if activeFilterCount > 0}<span class="filter-count">{activeFilterCount}</span>{/if}
					</button>
					{#if activeFilterCount > 0}
						<button class="clear-filters" onclick={clearAllFilters}><X size={13} /> Clear</button>
					{/if}
				</div>
				<div class="toolbar-filters">
					{#if activeFilterCount > 0}
						<button class="clear-filters" onclick={clearAllFilters}>
							<X size={13} /> Clear
						</button>
					{/if}
					<DateRangeFilter variant="dropdown" bind:from={dateFrom} bind:to={dateTo} />
				</div>
			</div>

			<!-- Result meta -->
			{#if filtered.length > 0 || activeFilterCount > 0}
				<div class="result-meta">
					<span>Showing <b>{filtered.length}</b> of {counts.all}</span>
					<span class="result-total"
						>Filtered total <b class="num">{formatMoneyRM(filteredTotal)}</b></span
					>
				</div>
			{/if}

			<!-- Table -->
			<div class="table-card">
				<table class="exp-table">
					<thead>
						<tr>
							<th
								class={`sortable ${sort.key === 'quotationNumber' ? 'sorted' : ''}`}
								onclick={() => onSort('quotationNumber')}
								style="cursor:pointer; user-select:none;"
							>
								<span class="th-inner"
									>Quotation {sort.key === 'quotationNumber'
										? sort.dir === 'asc'
											? '↑'
											: '↓'
										: ''}</span
								>
							</th>
							<th
								class={`sortable ${sort.key === 'status' ? 'sorted' : ''}`}
								onclick={() => onSort('status')}
								style="cursor:pointer; user-select:none;"
							>
								<span class="th-inner"
									>Status {sort.key === 'status'
										? sort.dir === 'asc'
											? '↑'
											: '↓'
										: ''}</span
								>
							</th>
							<th
								class={`sortable ${sort.key === 'issueDate' ? 'sorted' : ''}`}
								onclick={() => onSort('issueDate')}
								style="cursor:pointer; user-select:none;"
							>
								<span class="th-inner"
									>Date {sort.key === 'issueDate'
										? sort.dir === 'asc'
											? '↑'
											: '↓'
										: ''}</span
								>
							</th>
							<th onclick={() => onSort('expiryDate')} style="cursor:pointer; user-select:none;">
								<span class="th-inner"
									>Expires {sort.key === 'expiryDate'
										? sort.dir === 'asc'
											? '↑'
											: '↓'
										: ''}</span
								>
							</th>
							<th
								class={`sortable ta-right ${sort.key === 'mainAmount' ? 'sorted' : ''}`}
								onclick={() => onSort('mainAmount')}
								style="cursor:pointer; user-select:none;"
							>
								<span class="th-inner"
									>Amount {sort.key === 'mainAmount'
										? sort.dir === 'asc'
											? '↑'
											: '↓'
										: ''}</span
								>
							</th>
						</tr>
					</thead>
					<tbody>
						{#each filtered as q}
							<tr
								class="exp-row"
								onclick={(ev) => {
									// The name cell is a real anchor; this is the rest of the row.
									if ((ev.target as HTMLElement).closest('a')) return;
									openQuotation(q);
								}}
							>
								<td class="td-primary">
									<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the href comes from resolve(); the rule cannot see through the helper call. -->
									<a class="cell-item row-link" href={quotationHref(q.id)}>
										<span class="cell-itemname">{q.contactName || '—'}</span>
										<span class="cell-itemnum">{q.quotationNumber}</span>
									</a>
								</td>
								<td class="td-status" data-label="Status">
									<StatusBadge status={quotationStatusKey(q)} />
								</td>
								<td class="td-date" data-label="Date">
									{formatDateShort(q.issueDate)}<span class="td-year"
										>{q.issueDate.slice(0, 4)}</span
									>
								</td>
								<td class="td-date" data-label="Expires">
									{#if q.expiryDate}
										{formatDateShort(q.expiryDate)}<span class="td-year"
											>{q.expiryDate.slice(0, 4)}</span
										>
									{:else}
										<span style="color:var(--muted-foreground);">—</span>
									{/if}
								</td>
								<td class="td-amount" data-label="Amount">
									<span class="amount-num">{mainCurrencySymbol()} {formatMoney(q.mainAmount)}</span>
									{#if q.currency !== mainCurrency()}
										<span class="amount-orig"
											>{q.currency} {formatCurrencyAmount(q.total, q.currency)}</span
										>
									{/if}
								</td>
							</tr>
						{/each}
						{#if quotations.length === 0}
							<tr class="empty-row">
								<td colspan="5">
									<EmptyState
										title="No quotations yet"
										sub="Your quotations will appear here once created."
									>
										{#snippet icon()}<FileText size={20} />{/snippet}
									</EmptyState>
								</td>
							</tr>
						{:else if filtered.length === 0}
							<tr class="empty-row">
								<td colspan="5">
									<EmptyState
										title="No quotations match your filters"
										sub="Try adjusting your search or filters."
									>
										{#snippet icon()}<Search size={20} />{/snippet}
										{#snippet action()}
											<button class="link-btn" onclick={clearAllFilters}>Clear filters</button>
										{/snippet}
									</EmptyState>
								</td>
							</tr>
						{/if}
					</tbody>
				</table>
			</div>
			<div class="table-foot">
				<span>{filtered.length} of {counts.all} quotations</span>
				<span class="muted">Updated just now</span>
			</div>
		</div>
	</div>
</div>

<!-- Mobile filter sheet -->
<Sheet.Root bind:open={mobileFilterOpen}>
		<Sheet.Content
			side="bottom"
			style="border-radius:16px 16px 0 0; max-height:85vh; overflow-y:auto; padding:20px 20px calc(20px + var(--safe-bottom));"
		>
			<div
				style="display:flex; align-items:center; justify-content:space-between; margin-bottom:16px;"
			>
				<div style="font-size:15px; font-weight:600;">Filters</div>
				<Sheet.Close class="sheet-close"><X size={16} /></Sheet.Close>
			</div>
			<DateRangeFilter variant="sheet" bind:from={dateFrom} bind:to={dateTo} />
			<Button class="w-full" onclick={() => (mobileFilterOpen = false)}>Show results</Button>
		</Sheet.Content>
</Sheet.Root>

<style>
	.row-link {
		color: inherit;
		text-decoration: none;
		display: flex;
		flex-direction: column;
		gap: 1px;
	}
	.row-link:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
		border-radius: 4px;
	}
	.result-total {
		color: var(--muted-foreground);
	}

	@media (max-width: 767px) {
		td[data-label='Expires'] {
			order: 6 !important;
		}
		td[data-label='Status'] {
			order: 5 !important;
		}
	}
</style>
