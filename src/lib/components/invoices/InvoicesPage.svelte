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
	import { formatMoney, formatMoneyRM, formatMinor, formatDateShort } from '$lib/format.js';
	import { mainCurrency, mainCurrencySymbol } from '$lib/currency-state.svelte.js';
	import { formatCurrencyAmount } from '$lib/currency.js';
	import { InvoiceStatus } from '$lib/enums.js';
	import { invoiceStatusKey } from '$lib/sales/status.js';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import type { loadInvoicesPage } from '$lib/server/loaders/invoices.js';

	type PageData = ReturnType<typeof loadInvoicesPage>;

	let {
		data,
	}: { data: PageData } = $props();

	// Local reactive list — updated by SSE events and re-synced on SvelteKit data reload
	// svelte-ignore state_referenced_locally
	let invoices = $state(data.invoices);
	$effect(() => {
		invoices = data.invoices;
	});

	// --- State ---
	let searchRaw = $state('');
	let search = $state('');
	// Which ids the server matched for the current search term — server-side
	// because the search text (notes, terms, line items) isn't part of the row
	// already loaded into the browser. `null` means no search is active.
	let searchMatchedIds = $state<Set<number> | null>(null);
	let statusTab = $state('all');
	let overdueOnly = $state(false);
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
	// server instead of a client-only field check (mirrors `ContactSelect.svelte`).
	$effect(() => {
		const term = search.trim();
		if (!term) {
			searchMatchedIds = null;
			return;
		}
		// A newer term (or clearing it) supersedes this request: a slow reply for
		// "ab" must not land after the one for "abc".
		let stale = false;
		fetch(`/api/invoices?search=${encodeURIComponent(term)}&limit=500`)
			.then((r) => (r.ok ? r.json() : null))
			.then((rows: Invoice[] | null) => {
				if (stale) return;
				if (!rows) {
					searchMatchedIds = new Set();
					return;
				}
				invoices = mergeById(invoices, rows);
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
	type InvoiceStreamMsg =
		| { type: 'invoice-update'; item: Invoice }
		| { type: 'invoice-delete'; id: number };

	// Which tab an invoice belongs under. "Paid" is worked out from what has
	// actually been paid against it, never from a stored status (D-10): a draft is
	// a draft, a cancelled invoice is cancelled, and everything else is either
	// paid or still waiting.
	type Invoice = (typeof data.invoices)[0];
	function isDraft(inv: Invoice): boolean {
		return inv.status === InvoiceStatus.Draft;
	}
	function isCancelled(inv: Invoice): boolean {
		return inv.status === InvoiceStatus.Cancelled;
	}
	function isAwaitingPayment(inv: Invoice): boolean {
		return !isDraft(inv) && !isCancelled(inv) && !inv.paid;
	}
	function isPaid(inv: Invoice): boolean {
		return !isDraft(inv) && !isCancelled(inv) && inv.paid;
	}

	const IN_TAB: Record<string, (inv: Invoice) => boolean> = {
		draft: isDraft,
		sent: isAwaitingPayment,
		paid: isPaid,
		cancelled: isCancelled
	};

	// Derived counts (from local state for real-time accuracy)
	const counts = $derived.by(() => ({
		all: invoices.length,
		draft: invoices.filter(isDraft).length,
		sent: invoices.filter(isAwaitingPayment).length,
		paid: invoices.filter(isPaid).length,
		cancelled: invoices.filter(isCancelled).length
	}));

	// Stats
	const stats = $derived.by(() => {
		const sent = invoices.filter(isAwaitingPayment);
		const paid = invoices.filter(isPaid);
		const overdue = invoices.filter((inv) => inv.isOverdue);
		const now = new Date();
		const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
		const thisMonth = invoices.filter((inv) => inv.issueDate.startsWith(monthKey));
		// A cancelled invoice is owed by nobody, so it is not part of what was invoiced.
		const recorded = invoices.filter((inv) => !isCancelled(inv));
		return {
			// What is still owed on them, not what they were written for — a part-paid
			// invoice should not keep counting its whole amount as money to come in.
			sentTotal: sent.reduce((s, inv) => s + inv.outstandingMinor, 0) / 100,
			sentCount: sent.length,
			paidTotal: paid.reduce((s, inv) => s + inv.paidMinor, 0) / 100,
			paidCount: paid.length,
			overdueTotal: overdue.reduce((s, inv) => s + inv.outstandingMinor, 0) / 100,
			overdueCount: overdue.length,
			monthTotal: thisMonth.reduce((s, inv) => s + inv.mainAmount, 0),
			monthCount: thisMonth.length,
			allTotal: recorded.reduce((s, inv) => s + inv.mainAmount, 0),
			allCount: recorded.length
		};
	});

	// Filtered + sorted list
	const filtered = $derived.by(() => {
		let rows = invoices.slice();
		if (overdueOnly) {
			rows = rows.filter((inv) => inv.isOverdue);
		} else if (statusTab !== 'all') {
			rows = rows.filter(IN_TAB[statusTab]);
		}
		if (dateFrom) rows = rows.filter((inv) => inv.issueDate >= dateFrom);
		if (dateTo) rows = rows.filter((inv) => inv.issueDate <= dateTo);
		if (searchMatchedIds) {
			const matched = searchMatchedIds;
			rows = rows.filter((inv) => matched.has(inv.id));
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

	const filteredTotal = $derived(filtered.reduce((s, inv) => s + inv.mainAmount, 0));
	const activeFilterCount = $derived(
		(dateFrom || dateTo ? 1 : 0) + (search.trim() ? 1 : 0) + (overdueOnly ? 1 : 0)
	);

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
		overdueOnly = false;
	}

	// Deep-link: open an invoice detail sheet
	function invoiceHref(id: number): string {
		return resolve('/(app)/invoices/[id]', { id: String(id) });
	}

	function openInvoice(inv: Invoice) {
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- the href comes from resolve(); the rule cannot see through the helper call.
		void goto(invoiceHref(inv.id));
	}

	createResourceStream<InvoiceStreamMsg>('/api/invoices/stream', (msg) => {
		if (msg.type === 'invoice-update') invoices = mergeById(invoices, [msg.item]);
		else if (msg.type === 'invoice-delete')
			invoices = invoices.filter((inv) => inv.id !== msg.id);
	});

</script>

<div class="screen" style="position:relative;">
	<!-- Top bar -->
	<header class="topbar">
		<div class="topbar-left">
			<h1 class="page-title">Invoices</h1>
			<p class="page-sub">
				{stats.allCount} records · <span class="num">{formatMoneyRM(stats.allTotal)}</span> total
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
						placeholder="Search IV#, customer, ref…"
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
						placeholder="Search IV#, customer, ref…"
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
					href={resolve('/(app)/invoices/new')}
					style="display:inline-flex; align-items:center; gap:6px; height:32px; padding:0 12px; background:var(--primary); color:var(--primary-foreground); border:none; border-radius:8px; font-family:inherit; font-size:13px; font-weight:500; cursor:pointer; text-decoration:none;"
				>
					<Plus size={15} /> <span class="btn-text">New invoice</span>
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
			sub="{stats.sentCount} awaiting payment"
		/>
		<StatCard
			tone="red"
			label="Overdue"
			cur={mainCurrencySymbol()}
			value={formatMoney(stats.overdueTotal)}
			sub="{stats.overdueCount} overdue"
		/>
		<StatCard
			tone="green"
			label="Paid"
			cur={mainCurrencySymbol()}
			value={formatMoney(stats.paidTotal)}
			sub="{stats.paidCount} collected"
		/>
		<StatCard
			label="All recorded"
			cur={mainCurrencySymbol()}
			value={formatMoney(stats.allTotal)}
			sub="{stats.allCount} invoices"
		/>
	</div>

	<div class="work">
		<div class="work-main layout-standard" style="padding-top:12px;">
			<!-- Toolbar -->
			<div class="toolbar">
				<div class="status-tabs">
					{#each [['all', 'All'], ['draft', 'Draft'], ['sent', 'Sent'], ['paid', 'Paid'], ['cancelled', 'Cancelled']] as [id, label]}
						<button
							class="status-tab"
							class:active={statusTab === id && !overdueOnly}
							onclick={() => {
								statusTab = id;
								overdueOnly = false;
							}}
						>
							{label}<span class="tab-count">{counts[id as keyof typeof counts]}</span>
						</button>
					{/each}
					<button
						class="status-tab"
						class:active={overdueOnly}
						onclick={() => {
							overdueOnly = !overdueOnly;
							if (overdueOnly) statusTab = 'all';
						}}
					>
						Overdue<span class="tab-count">{stats.overdueCount}</span>
					</button>
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
								class={`sortable ${sort.key === 'invoiceNumber' ? 'sorted' : ''}`}
								onclick={() => onSort('invoiceNumber')}
								style="cursor:pointer; user-select:none;"
							>
								<span class="th-inner"
									>Invoice {sort.key === 'invoiceNumber'
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
							<th onclick={() => onSort('dueDate')} style="cursor:pointer; user-select:none;">
								<span class="th-inner"
									>Due {sort.key === 'dueDate'
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
						{#each filtered as inv}
							<tr
								class="exp-row"
								onclick={(ev) => {
									// The name cell is a real anchor; this is the rest of the row.
									if ((ev.target as HTMLElement).closest('a')) return;
									openInvoice(inv);
								}}
							>
								<td class="td-primary">
									<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the href comes from resolve(); the rule cannot see through the helper call. -->
									<a class="cell-item row-link" href={invoiceHref(inv.id)}>
										<span class="cell-itemname">{inv.contactName || '—'}</span>
										<span class="cell-itemnum">{inv.invoiceNumber}</span>
									</a>
								</td>
								<td class="td-status" data-label="Status">
									<StatusBadge status={invoiceStatusKey(inv)} />
								</td>
								<td class="td-date" data-label="Date">
									{formatDateShort(inv.issueDate)}<span class="td-year"
										>{inv.issueDate.slice(0, 4)}</span
									>
								</td>
								<td class="td-date" data-label="Due">
									{#if inv.dueDate}
										{formatDateShort(inv.dueDate)}<span class="td-year"
											>{inv.dueDate.slice(0, 4)}</span
										>
									{:else}
										<span style="color:var(--muted-foreground);">—</span>
									{/if}
								</td>
								<td class="td-amount" data-label="Amount">
									<span class="amount-num">{mainCurrencySymbol()} {formatMoney(inv.mainAmount)}</span>
									{#if inv.currency !== mainCurrency()}
										<span class="amount-orig"
											>{inv.currency} {formatCurrencyAmount(inv.total, inv.currency)}</span
										>
									{/if}
									{#if inv.paidMinor > 0 && !inv.paid}
										<span class="amount-orig">{formatMinor(inv.outstandingMinor)} outstanding</span>
									{/if}
								</td>
							</tr>
						{/each}
						{#if invoices.length === 0}
							<tr class="empty-row">
								<td colspan="5">
									<EmptyState
										title="No invoices yet"
										sub="Your invoices will appear here once created."
									>
										{#snippet icon()}<FileText size={20} />{/snippet}
									</EmptyState>
								</td>
							</tr>
						{:else if filtered.length === 0}
							<tr class="empty-row">
								<td colspan="5">
									<EmptyState
										title="No invoices match your filters"
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
				<span>{filtered.length} of {counts.all} invoices</span>
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
		td[data-label='Due'] {
			order: 6 !important;
		}
		td[data-label='Status'] {
			order: 5 !important;
		}
	}
</style>
