<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { fly } from 'svelte/transition';
	import { Eye, EyeOff, Landmark, Plus, Search, X } from '@lucide/svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { formatMinor } from '$lib/format.js';
	import { AccountType, AccountTypeDisplayLabels, type AccountTypeCode } from '$lib/enums.js';
	import type { AccountView } from '$lib/server/ledger/types.js';
	import type { loadAccountsPage } from '$lib/server/loaders/accounts.js';
	import AccountSheet from './AccountSheet.svelte';

	type PageData = ReturnType<typeof loadAccountsPage>;
	type ActionData = { error?: string; success?: boolean; id?: number; deleted?: boolean } | null;

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// Writable `$derived`, so a fresh server load replaces the chart and an
	// incoming stream event can still merge into it.
	let accounts = $derived(data.accounts);

	/** The five fixed types, in balance-sheet then income-statement order. */
	const types = Object.values(AccountType).filter(
		(v): v is AccountTypeCode => typeof v === 'number'
	);

	// Both filters run over the already-loaded list. The loader fetches every
	// account, and a hundred rows cost nothing to filter in the browser.
	let searchRaw = $state('');
	let search = $state('');
	let typeFilter = $state<AccountTypeCode | null>(null);
	let showInactive = $state(false);

	// Mobile UI state — the desktop search box is hidden below 767px, so the
	// topbar toggle is the only way in on a phone (same as Records/Contacts).
	let mobileSearchOpen = $state(false);
	let mobileSearchEl = $state<HTMLInputElement | null>(null);
	$effect(() => {
		if (mobileSearchOpen && mobileSearchEl) mobileSearchEl.focus();
	});

	$effect(() => {
		const v = searchRaw;
		const t = setTimeout(() => (search = v), 300);
		return () => clearTimeout(t);
	});

	const inactiveCount = $derived(accounts.filter((a) => !a.active).length);

	/** Everything the active/inactive toggle and the search box allow through. */
	const listed = $derived.by(() => {
		const q = search.trim().toLowerCase();
		return accounts.filter(
			(a) =>
				(showInactive || a.active) &&
				(!q || String(a.code ?? '').includes(q) || a.name.toLowerCase().includes(q))
		);
	});

	/** The same list with the type tab applied. */
	const rows = $derived(
		typeFilter === null ? listed : listed.filter((a) => a.type === typeFilter)
	);

	/** Which type groups the table draws, and in what order, with their rows. */
	const groups = $derived.by(() =>
		types
			.map((type) => {
				const inType = rows
					.filter((a) => a.type === type)
					.slice()
					.sort((a, b) => (a.code ?? 0) - (b.code ?? 0));
				const totalMinor = inType.reduce((sum, a) => sum + a.balanceMinor, 0);
				return { type, rows: inType, totalMinor };
			})
			.filter((g) => g.rows.length > 0)
	);

	function clearFilters() {
		searchRaw = '';
		search = '';
		typeFilter = null;
	}

	// --- Adding an account --------------------------------------------------
	// The drawer creates; an account is read and renamed on its own page.
	let sheetOpen = $state(false);

	function accountHref(id: number): string {
		return resolve('/(app)/accounts/[id]', { id: String(id) });
	}

	function openAccount(account: AccountView) {
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- the href comes from resolve(); the rule cannot see through the helper call.
		void goto(accountHref(account.id));
	}

	$effect(() => {
		if (form?.success) sheetOpen = false;
	});

	// --- Live updates -------------------------------------------------------
	// Opened in onMount and closed in onDestroy — never in $effect, which re-runs
	// on reactive changes and would tear the connection down (CLAUDE.md).
	let source: EventSource | null = null;

	onMount(() => {
		source = new EventSource('/api/accounts/stream');
		source.onmessage = (event) => {
			let msg: { type: string; account?: AccountView; id?: number };
			try {
				msg = JSON.parse(event.data);
			} catch {
				return;
			}
			if (msg.type === 'accounts-refresh') {
				// The whole chart changed underneath us (an upgrade or a bulk
				// renumber), so nothing short of a reload is trustworthy.
				location.reload();
			} else if (msg.type === 'account-update' && msg.account) {
				const incoming = msg.account;
				accounts = accounts.some((a) => a.id === incoming.id)
					? accounts.map((a) => (a.id === incoming.id ? incoming : a))
					: [...accounts, incoming];
			} else if (msg.type === 'account-deleted' && msg.id !== undefined) {
				accounts = accounts.filter((a) => a.id !== msg.id);
			}
		};
	});

	onDestroy(() => {
		source?.close();
		source = null;
	});
</script>

<div class="screen" style="position:relative;">
	<!-- Top bar -->
	<header class="topbar">
		<div class="topbar-left">
			<h1 class="page-title">Accounts</h1>
			<p class="page-sub">
				{accounts.length} in the chart · all five types
			</p>
		</div>
		<div class="topbar-right">
			<div class="search-box">
				<div style="position:relative; display:flex; align-items:center;">
					<span
						style="position:absolute; left:10px; color:var(--muted-foreground); display:flex; pointer-events:none;"
					>
						<Search size={15} />
					</span>
					<Input
						type="search"
						placeholder="Search code or name…"
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
						placeholder="Search code, name…"
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
			{#if inactiveCount > 0}
				<Button variant="outline" size="sm" onclick={() => (showInactive = !showInactive)}>
					{#if showInactive}<EyeOff size={14} />{:else}<Eye size={14} />{/if}
					<span class="btn-text">
						{showInactive ? 'Hide' : 'Show'} inactive ({inactiveCount})
					</span>
				</Button>
			{/if}
			{#if data.perms.add}
				<Button size="sm" onclick={() => (sheetOpen = true)}>
					<Plus size={15} /> <span class="btn-text">Add account</span>
				</Button>
			{/if}
		</div>
	</header>

	<div class="work">
		<div class="work-main layout-standard" style="padding-top:12px;">
			{#if form?.error && !sheetOpen}
				<div class="page-error">{form.error}</div>
			{/if}

			<!-- Toolbar: the five fixed types, as tabs, like every other list screen -->
			<div class="toolbar">
				<div class="status-tabs">
					<button
						type="button"
						class="status-tab"
						class:active={typeFilter === null}
						onclick={() => (typeFilter = null)}
					>
						All<span class="tab-count">{listed.length}</span>
					</button>
					{#each types as type (type)}
						<button
							type="button"
							class="status-tab"
							class:active={typeFilter === type}
							onclick={() => (typeFilter = typeFilter === type ? null : type)}
						>
							{AccountTypeDisplayLabels[type]}<span class="tab-count"
								>{listed.filter((a) => a.type === type).length}</span
							>
						</button>
					{/each}
				</div>
			</div>

			{#if rows.length !== accounts.length}
				<div class="result-meta">
					<span>Showing <b>{rows.length}</b> of {accounts.length}</span>
				</div>
			{/if}

			<!-- The same table every other list screen uses, so a reader moving
			     between them meets one shape. The card scrolls, the head and the
			     type bands stay put, and rows become ordered cards on mobile
			     through the shared `.exp-table` rules. -->
			<div class="table-card">
				<table class="exp-table">
					<thead>
						<tr>
							<th>Account</th>
							<th>Transactions</th>
							<th class="ta-right">Balance</th>
						</tr>
					</thead>
					<tbody>
						{#each groups as group (group.type)}
							<tr class="group-row">
								<td colspan="3">
									<div class="group-head">
										<span class="group-label">{AccountTypeDisplayLabels[group.type]}</span>
										<span class="group-meta">
											{group.rows.length}
											{group.rows.length === 1 ? 'account' : 'accounts'} ·
											<span class="num">{formatMinor(group.totalMinor)}</span>
										</span>
									</div>
								</td>
							</tr>
							{#each group.rows as account (account.id)}
								<tr
									class="exp-row"
									class:archived={!account.active}
									onclick={(event) => {
										// The name cell is a real anchor and handles its own
										// click; this is the rest of the row.
										if ((event.target as HTMLElement).closest('a')) return;
										openAccount(account);
									}}
								>
									<td class="td-primary" data-label="Account">
										<!-- A real link, so hover preloads it and Cmd-click opens
										     it in a tab. -->
										<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the href comes from resolve(); the rule cannot see through the helper call. -->
										<a class="cell-item row-link" href={accountHref(account.id)}>
											<span class="cell-itemname">{account.name}</span>
											<span class="cell-itemnum">
												{account.code}{#if !account.active}
													· Inactive{/if}{#if account.id === data.defaultAccountId}
													· Default account{/if}
											</span>
										</a>
									</td>
									<td data-label="Transactions">
										{account.movementCount}
										{account.movementCount === 1 ? 'transaction' : 'transactions'}
									</td>
									<td class="td-amount" data-label="Balance">
										<span class="amount-num">
											{formatMinor(account.balanceMinor)}
										</span>
									</td>
								</tr>
							{/each}
						{/each}
						{#if rows.length === 0}
							<tr class="empty-row">
								<td colspan="3">
									{#if accounts.length === 0}
										<EmptyState
											title="No accounts yet"
											sub="The chart of accounts is where every asset, liability, equity, revenue and expense line lives."
										>
											{#snippet icon()}<Landmark size={20} />{/snippet}
											{#snippet action()}
												{#if data.perms.add}
													<button class="link-btn" onclick={() => (sheetOpen = true)}>
														Add your first account
													</button>
												{/if}
											{/snippet}
										</EmptyState>
									{:else}
										<EmptyState
											title="Nothing to show"
											sub={search.trim()
												? `No account matching “${search.trim()}”.`
												: 'No account matches the current filters.'}
										>
											{#snippet icon()}<Search size={20} />{/snippet}
											{#snippet action()}
												<button class="link-btn" onclick={clearFilters}>Clear filters</button>
											{/snippet}
										</EmptyState>
									{/if}
								</td>
							</tr>
						{/if}
					</tbody>
				</table>
			</div>
			<div class="table-foot">
				<span>{rows.length} of {accounts.length} accounts</span>
				{#if inactiveCount > 0 && !showInactive}
					<span class="muted">{inactiveCount} inactive hidden</span>
				{/if}
			</div>
		</div>
	</div>
</div>

<AccountSheet bind:open={sheetOpen} error={form?.error ?? ''} onclose={() => (sheetOpen = false)} />

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
	.page-error {
		background: var(--red-soft);
		color: var(--red);
		border-radius: 8px;
		padding: 10px 14px;
		font-size: 13px;
		margin-bottom: 12px;
	}

	@media (max-width: 767px) {
		.group-row td {
			position: static;
			border-radius: var(--radius);
		}
		.group-row {
			margin: 2px 0 8px;
		}
	}
</style>
