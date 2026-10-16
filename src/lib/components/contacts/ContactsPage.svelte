<script lang="ts">
	import { enhance } from '$app/forms';
	import { formatMinor } from '$lib/format.js';
	import { useIsMobile } from '$lib/hooks/useIsMobile.svelte.js';
	import { createResourceStream, mergeById } from '$lib/sse.js';
	import { fly } from 'svelte/transition';
	import {
		Plus,
		Search,
		X,
		Users,
		Merge,
		SlidersHorizontal,
		Building2
	} from '@lucide/svelte';
	import * as Sheet from '$lib/components/ui/sheet/index.js';
	import FilterDropdown from '$lib/components/ui/FilterDropdown.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import { Checkbox } from '$lib/components/ui/checkbox/index.js';
	import BulkActionBar from '$lib/components/ui/BulkActionBar.svelte';
	import ContactMergeCompare from '$lib/components/ContactMergeCompare.svelte';
	import { EntityType, Role, EntityTypeLabels, RoleLabels } from '$lib/enums.js';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import type { loadContactsPage } from '$lib/server/loaders/contacts.js';

	type PageData = ReturnType<typeof loadContactsPage>;
	type ActionData = { error?: string; success?: boolean; id?: number } | null;

	let { data, form }: { data: PageData; form: ActionData } = $props();

	type Contact = (typeof data.contacts)[0];
	type Usage = PageData['usage'][number];
	const NO_USAGE: Usage = { records: 0, expenses: 0, incomes: 0, quotations: 0, invoices: 0 };

	// svelte-ignore state_referenced_locally
	let contacts = $state<Contact[]>(data.contacts);
	$effect(() => { contacts = data.contacts; });

	// Mirrors src/lib/server/queries/contacts.ts's cannotDeleteContactReason — a
	// (`deleteBlockedReason` moved to ContactDetail.svelte with the delete button
	// itself — a contact is deleted from its own page.)

	let searchRaw = $state('');
	let search = $state('');
	let roleFilter = $state<number | 0>(0);
	let entityFilter = $state<number | 0>(0);

	// Mobile UI state
	let mobileSearchOpen = $state(false);
	let mobileSearchEl = $state<HTMLInputElement | null>(null);
	let mobileFilterOpen = $state(false);
	$effect(() => { if (mobileSearchOpen && mobileSearchEl) mobileSearchEl.focus(); });

	// Mobile panel detection — full-screen bottom sheet on mobile
	const screen = useIsMobile();
	const isMobile = $derived(screen.current);
	const panelSide = $derived(isMobile ? 'bottom' : 'right');

	$effect(() => {
		const v = searchRaw;
		const t = setTimeout(() => (search = v), 300);
		return () => clearTimeout(t);
	});

	const ROLE_OPTIONS = [Role.Customer, Role.Supplier, Role.Employee, Role.Partner];

	const counts = $derived.by(() => {
		const base = contacts;
		return {
			all: base.length,
			customer: base.filter((c) => c.roles.includes(Role.Customer)).length,
			supplier: base.filter((c) => c.roles.includes(Role.Supplier)).length,
			employee: base.filter((c) => c.roles.includes(Role.Employee)).length,
			partner: base.filter((c) => c.roles.includes(Role.Partner)).length,
		};
	});

	const filtered = $derived.by(() => {
		let rows = contacts.slice();
		if (entityFilter) rows = rows.filter((c) => c.entityType === entityFilter);
		if (roleFilter) rows = rows.filter((c) => c.roles.includes(roleFilter));
		if (search.trim()) {
			const q = search.toLowerCase();
			rows = rows.filter(
				(c) =>
					c.legalName.toLowerCase().includes(q) ||
					(c.email ?? '').toLowerCase().includes(q) ||
					(c.registrationNo ?? '').toLowerCase().includes(q)
			);
		}
		return rows.sort((a, b) => a.legalName.localeCompare(b.legalName));
	});

	const activeFilterCount = $derived((entityFilter ? 1 : 0) + (search.trim() ? 1 : 0));

	function clearAllFilters() {
		roleFilter = 0;
		entityFilter = 0;
		searchRaw = '';
	}

	// --- Manual multi-select / merge ---
	let selected = $state(new Set<number>());
	const allSelected = $derived(filtered.length > 0 && filtered.every((c) => selected.has(c.id)));
	const someSelected = $derived(filtered.some((c) => selected.has(c.id)) && !allSelected);
	const selectedContacts = $derived(filtered.filter((c) => selected.has(c.id)));

	function toggleAll() {
		if (allSelected) {
			filtered.forEach((c) => selected.delete(c.id));
		} else {
			filtered.forEach((c) => selected.add(c.id));
		}
		selected = new Set(selected);
	}
	function toggleOne(id: number) {
		if (selected.has(id)) selected.delete(id);
		else selected.add(id);
		selected = new Set(selected);
	}
	function clearSel() {
		selected = new Set();
	}

	let showManualMerge = $state(false);
	// Snapshot of *which* ids are being merged, taken once at open time — does not
	// change as the sheet stays open. Field values still stay fresh: re-derived from
	// the live `contacts` array on every render, so an SSE update is reflected, but a
	// concurrent delete drops that id out cleanly via the `.filter(Boolean)` below.
	let manualMergeIds = $state<number[]>([]);
	let manualMergeUsage = $state<Record<number, Usage>>({});
	let manualMergeError = $state('');

	const manualMergeContacts = $derived(
		manualMergeIds
			.map((id) => contacts.find((c) => c.id === id))
			.filter((c): c is Contact => !!c)
			.map((c) => ({ ...c, usage: manualMergeUsage[c.id] ?? NO_USAGE }))
	);

	async function openManualMerge() {
		manualMergeError = '';
		const ids = selectedContacts.map((c) => c.id);
		const res = await fetch('/api/contacts/merge/preview', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ contactIds: ids })
		});
		if (!res.ok) {
			manualMergeError = 'Could not load selected contacts.';
			return;
		}
		const data2 = await res.json();
		manualMergeUsage = Object.fromEntries(
			data2.contacts.map((c: { id: number; usage: Usage }) => [c.id, c.usage])
		);
		manualMergeIds = ids;
		showManualMerge = true;
	}

	function onManualMerged() {
		showManualMerge = false;
		clearSel();
	}

	// Auto-close if a concurrent merge/delete drops the selection below 2 while open.
	$effect(() => {
		if (showManualMerge && manualMergeContacts.length < 2) {
			showManualMerge = false;
			manualMergeError = 'Selection changed — fewer than 2 contacts remain.';
		}
	});

	// --- Create / edit sheet ---
	let showForm = $state(false);
	let auditTrailRef = $state<{ refresh: () => Promise<void> } | null>(null);
	let fEntityType = $state<number | 0>(0);
	let fRoles = $state<number[]>([]);

	function openCreate() {
		fEntityType = 0;
		fRoles = [];
		showForm = true;
	}
	function contactHref(id: number): string {
		return resolve('/(app)/contacts/[id]', { id: String(id) });
	}

	function openContact(c: Contact) {
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- `contactHref` is resolve(); the rule cannot see through the call.
		void goto(contactHref(c.id));
	}

	function toggleRole(r: number) {
		fRoles = fRoles.includes(r) ? fRoles.filter((x) => x !== r) : [...fRoles, r];
	}

	function closeForm() {
		showForm = false;
	}

	$effect(() => { if (form?.success) closeForm(); });

	// --- Duplicates / merge ---
	type Cluster = {
		normalized: string;
		matchedOn: string[];
		contacts: (Contact & { usage: Usage })[];
	};
	let showMerge = $state(false);
	let clusters = $state<Cluster[]>([]);

	async function loadDuplicates() {
		const res = await fetch('/api/contacts/duplicates');
		clusters = res.ok ? await res.json() : [];
		showMerge = true;
	}

	function dismissCluster(cl: Cluster) {
		clusters = clusters.filter((c) => c !== cl);
	}

	const MATCH_LABELS: Record<string, string> = {
		name: 'Same name',
		email: 'Same email',
		phone: 'Same phone',
		registrationNo: 'Same registration no.'
	};

	// --- SSE ---
	type ContactStreamMsg =
		| { type: 'contact-update'; item: Contact }
		| { type: 'contact-delete'; id: number };
	createResourceStream<ContactStreamMsg>('/api/contacts/stream', (msg) => {
		if (msg.type === 'contact-update') contacts = mergeById(contacts, [msg.item]);
		else if (msg.type === 'contact-delete') {
			contacts = contacts.filter((c) => c.id !== msg.id);
			if (selected.delete(msg.id)) selected = new Set(selected);
		}
	});
</script>

<div class="screen" style="position:relative;">
	<!-- Top bar -->
	<header class="topbar">
		<div class="topbar-left">
			<h1 class="page-title">Contacts</h1>
			<p class="page-sub">
				{contacts.length} total
				{#if data.perms.records && (data.totals.weOweMinor > 0 || data.totals.owedToUsMinor > 0)}
					· Payables <span class="num">{formatMinor(data.totals.weOweMinor)}</span>
					· Receivables <span class="num">{formatMinor(data.totals.owedToUsMinor)}</span>
				{/if}
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
						placeholder="Search name, email, reg no…"
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
						placeholder="Search name, email…"
						bind:value={searchRaw}
						bind:this={mobileSearchEl}
					/>
				</div>
			{/if}
			<button
				class="mobile-search-toggle"
				class:active={mobileSearchOpen}
				onclick={() => { mobileSearchOpen = !mobileSearchOpen; if (!mobileSearchOpen) searchRaw = ''; }}
			>
				{#if mobileSearchOpen}<X size={16} />{:else}<Search size={16} />{/if}
			</button>
			{#if data.perms.merge}
				<Button variant="outline" size="sm" onclick={loadDuplicates}>
					<Merge size={14} /> <span class="btn-text">Find duplicates</span>
				</Button>
			{/if}
			{#if data.perms.add}
				<Button size="sm" onclick={openCreate}>
					<Plus size={15} /> <span class="btn-text">New contact</span>
				</Button>
			{/if}
		</div>
	</header>

	<div class="work">
		<div class="work-main layout-standard" style="padding-top:12px;">
			<!-- Toolbar -->
			<div class="toolbar">
				<div class="status-tabs">
					{#each [[0, 'All', counts.all], [Role.Customer, 'Customer', counts.customer], [Role.Supplier, 'Supplier', counts.supplier], [Role.Employee, 'Employee', counts.employee], [Role.Partner, 'Partner', counts.partner]] as [val, label, count]}
						<button
							class="status-tab"
							class:active={roleFilter === val}
							onclick={() => (roleFilter = val as number)}
						>
							{label}<span class="tab-count">{count}</span>
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
						<button class="clear-filters" onclick={clearAllFilters}><X size={13} /> Clear</button>
					{/if}
					<FilterDropdown label="Type" active={entityFilter !== 0} align="right">
						{#snippet icon()}<Building2 size={14} />{/snippet}
						<div style="padding:5px;">
							<div style="display:flex; align-items:center; justify-content:space-between; padding:6px 8px 8px; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted-foreground);">
								<span>Entity type</span>
								{#if entityFilter !== 0}<button onclick={() => (entityFilter = 0)} style="border:none; background:none; color:var(--primary); cursor:pointer; font-size:11px; font-weight:600;">Clear</button>{/if}
							</div>
							{#each [[0, 'All types'], [EntityType.Individual, 'Individual'], [EntityType.Business, 'Business']] as [val, label]}
								<button
									onclick={() => (entityFilter = val as number)}
									style="display:flex; align-items:center; gap:9px; width:100%; border:none; background:none; font-family:inherit; font-size:13px; color:var(--foreground); padding:7px 8px; border-radius:7px; cursor:pointer; text-align:left;"
									onmouseover={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--accent)'; }}
									onmouseout={(e) => { (e.currentTarget as HTMLButtonElement).style.background = ''; }}
									onfocus={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--accent)'; }}
									onblur={(e) => { (e.currentTarget as HTMLButtonElement).style.background = ''; }}
								>
									<span style="width:16px; height:16px; border-radius:50%; border:1.5px solid {entityFilter === val ? 'var(--primary)' : 'var(--border-strong)'}; background:{entityFilter === val ? 'var(--primary)' : 'var(--card)'}; display:grid; place-items:center; flex-shrink:0;">
										{#if entityFilter === val}<span style="width:6px; height:6px; border-radius:50%; background:white; display:block;"></span>{/if}
									</span>
									{label}
								</button>
							{/each}
						</div>
					</FilterDropdown>
				</div>
			</div>

			<!-- Result meta -->
			{#if filtered.length > 0 || activeFilterCount > 0}
			<div class="result-meta">
				<span>Showing <b>{filtered.length}</b> of {contacts.length}</span>
			</div>
			{/if}

			<!-- Table -->
			<div class="table-card">
				<table class="exp-table">
					<thead>
						<tr>
							{#if data.perms.merge}
								<th class="td-check">
									<Checkbox
										checked={allSelected}
										indeterminate={someSelected}
										onCheckedChange={toggleAll}
										aria-label="Select all"
									/>
								</th>
							{/if}
							<th>Name</th>
							<th>Type</th>
							<th>Roles</th>
							<th>Email</th>
							{#if data.perms.records}<th class="ta-right">Balance</th>{/if}
						</tr>
					</thead>
					<tbody>
						{#each filtered as c (c.id)}
							<tr
								class="exp-row"
								class:selected={selected.has(c.id)}
								onclick={(ev) => {
									// The name cell is a real anchor; this is the rest of the row.
									if ((ev.target as HTMLElement).closest('a')) return;
									openContact(c);
								}}
							>
								{#if data.perms.merge}
									<td class="td-check" onclick={(ev) => { ev.stopPropagation(); toggleOne(c.id); }}>
										<Checkbox checked={selected.has(c.id)} aria-label="Select {c.legalName}" />
									</td>
								{/if}
								<td class="td-primary" data-label="Name">
									<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- `contactHref` is resolve(); the rule cannot see through the call. -->
									<a class="cell-item row-link" href={contactHref(c.id)}>
										<span class="cell-itemname">{c.legalName}</span>
									</a>
								</td>
								<td data-label="Type" style="font-size:13px; color:var(--muted-foreground);">
									{EntityTypeLabels[c.entityType] ?? '—'}
								</td>
								<td data-label="Roles">
									{#if c.roles.length === 0}
										<span class="badge-warn">no roles</span>
									{:else}
										{#each c.roleLabels as rl}
											<span style="display:inline-flex; align-items:center; font-size:11.5px; background:var(--secondary); color:var(--secondary-foreground); padding:2px 9px; border-radius:999px; white-space:nowrap; margin-right:4px;">{rl}</span>
										{/each}
									{/if}
								</td>
								<td data-label="Email" style="color:var(--muted-foreground); font-size:13px;">{c.email ?? '—'}</td>
								{#if data.perms.records}
									<!--
										The purchase and sales ledger, per contact. Positive when they
										owe us, negative when we owe them; a contact on both sides nets
										out. Derived from movements, never stored (FR-008).
									-->
									<td class="td-amount" data-label="Balance">
										{#if (data.balances[c.id] ?? 0) === 0}
											<span class="ct-settled">—</span>
										{:else}
											<span
												class="amount-num"
												class:ct-owed-to-us={(data.balances[c.id] ?? 0) > 0}
											>
												{formatMinor(Math.abs(data.balances[c.id] ?? 0))}
											</span>
											<span class="ct-owed-label">
												{(data.balances[c.id] ?? 0) > 0 ? 'Receivable' : 'Payable'}
											</span>
										{/if}
									</td>
								{/if}
							</tr>
						{:else}
							<tr class="empty-row">
								<td colspan="6">
									<EmptyState
										title={activeFilterCount > 0 ? 'No contacts match your filters' : 'No contacts yet'}
										sub={activeFilterCount > 0 ? 'Try adjusting your search or filters.' : 'Your contacts will appear here.'}
									>
										{#snippet icon()}<Users size={20} />{/snippet}
										{#snippet action()}{#if activeFilterCount > 0}<button class="link-btn" onclick={clearAllFilters}>Clear filters</button>{/if}{/snippet}
									</EmptyState>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			<div class="table-foot">
				<span>{filtered.length} of {contacts.length} contacts</span>
			</div>
		</div>
	</div>

	<!-- Bulk action bar -->
	{#if data.perms.merge}
		<BulkActionBar show={selected.size > 0} count={selected.size} onclear={clearSel}>
			{#snippet actions()}
				<button
					type="button"
					disabled={selected.size < 2}
					onclick={openManualMerge}
					style="display:inline-flex; align-items:center; gap:6px; height:32px; padding:0 12px; background:var(--primary); color:var(--primary-foreground); border:none; border-radius:8px; font-family:inherit; font-size:13px; font-weight:500; cursor:pointer; opacity:{selected.size < 2 ? 0.5 : 1};"
				>
					<Merge size={14} /> Merge selected ({selected.size})
				</button>
			{/snippet}
		</BulkActionBar>
	{/if}

</div>

<!-- Mobile filter sheet -->
<Sheet.Root bind:open={mobileFilterOpen}>
		<Sheet.Content side="bottom" style="border-radius:16px 16px 0 0; max-height:85vh; overflow-y:auto; padding:20px 20px calc(20px + var(--safe-bottom));">
			<div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:16px;">
				<div style="font-size:15px; font-weight:600;">Filters</div>
				<Sheet.Close class="sheet-close"><X size={16} /></Sheet.Close>
			</div>
			<div style="margin-bottom:16px;">
				<div style="font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted-foreground); margin-bottom:10px; display:flex; align-items:center; justify-content:space-between;">
					<span>Entity type</span>
					{#if entityFilter !== 0}<button onclick={() => (entityFilter = 0)} style="border:none; background:none; color:var(--primary); cursor:pointer; font-size:11px; font-weight:600;">Clear</button>{/if}
				</div>
				<div style="display:flex; flex-direction:column; gap:2px;">
					{#each [[0, 'All types'], [EntityType.Individual, 'Individual'], [EntityType.Business, 'Business']] as [val, label]}
						<button
							onclick={() => (entityFilter = val as number)}
							style="display:flex; align-items:center; gap:9px; width:100%; border:none; background:none; font-family:inherit; font-size:13px; color:var(--foreground); padding:8px 4px; border-radius:7px; cursor:pointer; text-align:left;"
							onmouseover={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--accent)'; }}
							onmouseout={(e) => { (e.currentTarget as HTMLButtonElement).style.background = ''; }}
							onfocus={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--accent)'; }}
							onblur={(e) => { (e.currentTarget as HTMLButtonElement).style.background = ''; }}
						>
							<span style="width:16px; height:16px; border-radius:50%; border:1.5px solid {entityFilter === val ? 'var(--primary)' : 'var(--border-strong)'}; background:{entityFilter === val ? 'var(--primary)' : 'var(--card)'}; display:grid; place-items:center; flex-shrink:0;">
								{#if entityFilter === val}<span style="width:6px; height:6px; border-radius:50%; background:white; display:block;"></span>{/if}
							</span>
							{label}
						</button>
					{/each}
				</div>
			</div>
			<Button class="w-full" onclick={() => (mobileFilterOpen = false)}>
				Show results
			</Button>
		</Sheet.Content>
</Sheet.Root>

<!-- Create / edit sheet -->
<Sheet.Root open={showForm} onOpenChange={(o) => { if (!o) closeForm(); }}>
		<Sheet.Content side={panelSide} style={isMobile ? 'height:100dvh; border-radius:0; border-top:none; display:flex; flex-direction:column; overflow:hidden; gap:0;' : 'width:500px; max-width:95vw; display:flex; flex-direction:column; overflow:hidden; gap:0;'}>
			<div style="display:flex; align-items:flex-start; justify-content:space-between; padding:22px 22px 16px; border-bottom:1px solid var(--border);">
				<div>
					<div class="sheet-eyebrow">New</div>
					<div class="sheet-title-text">Add contact</div>
				</div>
				<Sheet.Close class="sheet-close"><X size={16} /></Sheet.Close>
			</div>
			<form
				method="POST"
				action="?/create"
				use:enhance={() => async ({ update }) => {
					await update();
					auditTrailRef?.refresh();
				}}
				style="flex:1; display:flex; flex-direction:column; overflow:hidden;"
			>
				<div style="flex:1; overflow-y:auto; padding:20px 22px;">
					{#if form?.error}<div style="background:var(--red-soft); color:var(--red); border-radius:8px; padding:10px 14px; font-size:13px; margin-bottom:16px;">{form.error}</div>{/if}

					<div class="field">
						<span class="field-label">Entity type *</span>
						<div style="display:flex; gap:8px; flex-wrap:wrap;">
							<label style="display:inline-flex; align-items:center; gap:6px; border:1px solid {fEntityType === EntityType.Individual ? 'var(--primary)' : 'var(--border)'}; border-radius:8px; padding:6px 12px; font-size:13px; cursor:pointer; background:{fEntityType === EntityType.Individual ? 'color-mix(in srgb, var(--primary) 10%, transparent)' : 'var(--card)'};">
								<input type="radio" name="entityType" value={EntityType.Individual} bind:group={fEntityType} style="display:none;" /> Individual
							</label>
							<label style="display:inline-flex; align-items:center; gap:6px; border:1px solid {fEntityType === EntityType.Business ? 'var(--primary)' : 'var(--border)'}; border-radius:8px; padding:6px 12px; font-size:13px; cursor:pointer; background:{fEntityType === EntityType.Business ? 'color-mix(in srgb, var(--primary) 10%, transparent)' : 'var(--card)'};">
								<input type="radio" name="entityType" value={EntityType.Business} bind:group={fEntityType} style="display:none;" /> Business
							</label>
						</div>
					</div>

					<div class="field">
						<label class="field-label" for="legalName">Legal name *</label>
						<Input id="legalName" name="legalName" required class="w-full" />
					</div>

					<div class="field">
						<span class="field-label">Roles</span>
						<div style="display:flex; gap:8px; flex-wrap:wrap;">
							{#each ROLE_OPTIONS as r}
								<label style="display:inline-flex; align-items:center; gap:6px; border:1px solid {fRoles.includes(r) ? 'var(--primary)' : 'var(--border)'}; border-radius:8px; padding:6px 12px; font-size:13px; cursor:pointer; background:{fRoles.includes(r) ? 'color-mix(in srgb, var(--primary) 10%, transparent)' : 'var(--card)'};">
									<input type="checkbox" name="roles" value={r} checked={fRoles.includes(r)} onchange={() => toggleRole(r)} style="display:none;" />
									{RoleLabels[r]}
								</label>
							{/each}
						</div>
						{#if fRoles.includes(Role.Partner)}
							<p class="field-hint">
								A partner gets a capital account and a drawings account (equity). The partner
								statement shows these accounts by name. Removing the role archives these accounts.
								Their balances do not change.
							</p>
						{/if}
					</div>

					<div class="field">
						<label class="field-label" for="registrationNo">Registration no.</label>
						<Input id="registrationNo" name="registrationNo" class="w-full" />
					</div>
					<div class="field">
						<label class="field-label" for="email">Email</label>
						<Input id="email" name="email" type="email" class="w-full" />
					</div>
					<div class="field">
						<label class="field-label" for="phone">Phone</label>
						<Input id="phone" name="phone" class="w-full" />
					</div>
					<div class="field">
						<label class="field-label" for="address">Address</label>
						<Textarea id="address" name="address" rows={2} class="leading-relaxed" />
					</div>
					<div class="field">
						<label class="field-label" for="remark">Remark</label>
						<Textarea id="remark" name="remark" rows={2} class="leading-relaxed" />
					</div>
				</div>
				<div class="sheet-foot">
					<div class="sheet-foot-actions">
						<button type="button" class="sheet-btn" onclick={closeForm}>Cancel</button>
						<button type="submit" class="sheet-btn sheet-btn-primary" disabled={!fEntityType}>
							Create contact
						</button>
					</div>
				</div>
			</form>
		</Sheet.Content>
</Sheet.Root>

<!-- Find duplicates / merge sheet -->
<Sheet.Root open={showMerge} onOpenChange={(o) => (showMerge = o)}>
		<Sheet.Content side={panelSide} style={isMobile ? 'height:100dvh; border-radius:0; border-top:none; display:flex; flex-direction:column; overflow:hidden; gap:0;' : 'width:500px; max-width:95vw; display:flex; flex-direction:column; overflow:hidden; gap:0;'}>
			<div style="display:flex; align-items:flex-start; justify-content:space-between; padding:22px 22px 16px; border-bottom:1px solid var(--border);">
				<div>
					<div class="sheet-eyebrow">Contacts</div>
					<div class="sheet-title-text">Duplicate contacts</div>
				</div>
				<Sheet.Close class="sheet-close"><X size={16} /></Sheet.Close>
			</div>
			<div style="flex:1; overflow-y:auto; padding:20px 22px;">
				{#if clusters.length === 0}
					<EmptyState title="No duplicates found" sub="All your contacts appear to be unique." style="padding:40px 20px;">
						{#snippet icon()}<Users size={20} />{/snippet}
					</EmptyState>
				{/if}
				{#each clusters as cl}
					<div class="cluster">
						<div class="cluster-head">
							<div>
								<div class="cluster-name">"{cl.normalized}"</div>
								<div class="cluster-matched">
									{cl.matchedOn.map((m) => MATCH_LABELS[m] ?? m).join(' · ')}
								</div>
							</div>
							<button type="button" class="link-btn" onclick={() => dismissCluster(cl)}>Not duplicates</button>
						</div>
						<ContactMergeCompare
							contacts={cl.contacts}
							formAction="?/merge"
							onMerged={() => dismissCluster(cl)}
						/>
					</div>
				{/each}
			</div>
		</Sheet.Content>
</Sheet.Root>

<!-- Manual multi-select merge sheet -->
<Sheet.Root open={showManualMerge} onOpenChange={(o) => (showManualMerge = o)}>
		<Sheet.Content side={panelSide} style={isMobile ? 'height:100dvh; border-radius:0; border-top:none; display:flex; flex-direction:column; overflow:hidden; gap:0;' : 'width:500px; max-width:95vw; display:flex; flex-direction:column; overflow:hidden; gap:0;'}>
			<div style="display:flex; align-items:flex-start; justify-content:space-between; padding:22px 22px 16px; border-bottom:1px solid var(--border);">
				<div>
					<div class="sheet-eyebrow">Contacts</div>
					<div class="sheet-title-text">Merge selected contacts</div>
				</div>
				<Sheet.Close class="sheet-close"><X size={16} /></Sheet.Close>
			</div>
			<div style="flex:1; overflow-y:auto; padding:20px 22px;">
				{#if manualMergeError}
					<div style="background:var(--red-soft); color:var(--red); border-radius:8px; padding:10px 14px; font-size:13px; margin-bottom:16px;">{manualMergeError}</div>
				{/if}
				{#if manualMergeContacts.length >= 2}
					<ContactMergeCompare
						contacts={manualMergeContacts}
						formAction="?/merge"
						onMerged={onManualMerged}
					/>
				{/if}
			</div>
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
	/* The purchase and sales ledger, shown per contact. */
	.ct-owed-label {
		display: block;
		font-size: 11px;
		color: var(--muted-foreground);
	}
	.ct-owed-to-us {
		color: var(--green);
	}
	.ct-settled {
		color: var(--muted-foreground);
	}

	.badge-warn { display: inline-flex; align-items: center; font-size: 11.5px; background: var(--amber-soft); color: var(--amber); padding: 2px 9px; border-radius: 999px; white-space: nowrap; }
	.cluster { margin-bottom: 16px; }
	.cluster-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; margin-bottom: 8px; }
	.cluster-name { font-weight: 600; font-size: 13.5px; }
	.cluster-matched { font-size: 11.5px; color: var(--muted-foreground); margin-top: 2px; }

	/* This is a mobile-first PWA — unlike expenses/income, keep the bulk-select
	   checkbox visible on the mobile card layout instead of inheriting the
	   shared ".exp-row .td-check { display:none }" desktop-only rule. The extra
	   ".table-card" ancestor class gives this override enough specificity to win
	   regardless of stylesheet load order, scoped to this page only. */
	@media (max-width: 767px) {
		.table-card .exp-row .td-check {
			display: flex !important;
			order: 1;
			flex: 0 0 auto;
			align-self: center;
			min-width: 44px;
			min-height: 44px;
			align-items: center;
			justify-content: center;
			margin-right: 2px;
		}
	}
</style>
