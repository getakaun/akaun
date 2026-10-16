<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { ChevronRight, Landmark, Scale, Trash2, Wallet } from '@lucide/svelte';
	import { toast } from 'svelte-sonner';
	import DetailPage from '$lib/components/ui/DetailPage.svelte';
	import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte';
	import AuditTrail from '$lib/components/ui/AuditTrail.svelte';
	import ListExpand, { visibleItems } from '$lib/components/ui/ListExpand.svelte';
	import { Input } from '$lib/components/ui/input/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import OpeningBalanceSheet from './OpeningBalanceSheet.svelte';
	import { createResourceStream } from '$lib/sse.js';
	import { formatDate, formatMinor } from '$lib/format.js';
	import {
		AccountCodeRanges,
		AccountSubTypeDisplayLabels,
		AccountSubTypesByType,
		AccountType,
		AccountTypeDisplayLabels,
		type AccountSubTypeCode,
		type AccountTypeCode
	} from '$lib/enums.js';
	import type { loadAccountDetail } from '$lib/server/loaders/accounts.js';
	import type { AccountView } from '$lib/server/ledger/types.js';

	// Mirrors src/lib/server/ledger/account-type.ts's NEEDS_REVIEW_TYPES — an
	// account of one of these types has no safe default classification, so it
	// shows "Needs review" rather than a silently-assumed sub-type.
	const NEEDS_REVIEW_TYPES: AccountTypeCode[] = [AccountType.Asset, AccountType.Liability];

	// Sentinel for the sub-type Select's "unset" item — bits-ui's Select treats
	// an empty string as no selection, so a real sentinel is used instead
	// (mirrors ledger/AccountSelect.svelte's NONE_VALUE).
	const NONE_SUB_TYPE = '__none__';

	/**
	 * One account, on its own page.
	 *
	 * An account is the entity with the most around it and the least in it. Three
	 * fields name it; its balance, what has moved through it and what it still
	 * has to reconcile are the reasons anyone opens it. A 500px drawer could
	 * hold the three fields, so for a while the three fields were all the app
	 * showed — the balance, the reconciliation card and the way through to the
	 * movements were dropped when the chart was standardised, and their data
	 * went on being loaded for a card that no longer rendered.
	 */
	let { data, form }: { data: Awaited<ReturnType<typeof loadAccountDetail>>; form: { error?: string } | null } =
		$props();

	let chart = $derived<AccountView[]>(data.accounts);
	const account = $derived(chart.find((a) => a.id === data.account.id) ?? data.account);

	const types = Object.values(AccountType).filter(
		(v): v is AccountTypeCode => typeof v === 'number'
	);

	// --- The fields that name it ---------------------------------------------
	let name = $state('');
	let code = $state(0);
	let selectedType = $state<AccountTypeCode>(AccountType.Asset);
	let subType = $state<AccountSubTypeCode | null>(null);
	let snapshot = $state('');
	let saving = $state(false);
	let error = $state('');

	const subTypes = $derived(AccountSubTypesByType[selectedType] ?? []);

	function fingerprint(): string {
		return JSON.stringify([name, code, selectedType, subType]);
	}

	function seed() {
		name = account.name;
		code = account.code ?? account.id;
		selectedType = account.type;
		subType = account.subType ?? null;
		snapshot = fingerprint();
		error = '';
	}

	let seededId = $state<number | null>(null);
	$effect(() => {
		if (seededId === account.id) return;
		seededId = account.id;
		seed();
	});

	const dirty = $derived(snapshot !== '' && fingerprint() !== snapshot);
	const canEdit = $derived(data.perms.change && !account.isSystem);

	async function save() {
		if (saving) return;
		saving = true;
		error = '';
		const body: Record<string, unknown> = { name, code, type: selectedType };
		// `subType` stays absent (never `null`) until a "needs review" account is
		// given one: the PATCH schema accepts a number or nothing, never null.
		if (AccountSubTypesByType[selectedType] !== undefined && subType != null) {
			body.subType = subType;
		}
		const res = await fetch(`/api/accounts/${account.id}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		});
		saving = false;
		if (!res.ok) {
			const body = await res.json().catch(() => null);
			error = body?.reason ?? body?.error ?? 'That could not be saved.';
			return;
		}
		snapshot = fingerprint();
		auditTrailRef?.refresh();
	}

	// --- Related surfaces ---------------------------------------------------
	let openingOpen = $state(false);
	let deleteDialogOpen = $state(false);
	let auditTrailRef = $state<{ refresh: () => Promise<void> } | null>(null);

	/**
	 * This account's statement: the Records list narrowed to it (D-05).
	 *
	 * `resolve()` builds the route and the account is appended as a query
	 * parameter — a value, not part of the route — so the lint rule cannot see
	 * through the template string.
	 */
	// The loader sends the latest few; the card folds them like every other list, and
	// "See all" in its head is the way to the whole ledger.
	let recentExpanded = $state(false);
	const recentShown = $derived(visibleItems(data.recent, recentExpanded));

	const movementsHref = $derived(
		`${resolve('/(app)/records')}?account=${account.id}`
	);
	const reconcileHref = $derived(
		resolve('/(app)/accounts/[id]/reconcile', { id: String(account.id) })
	);

	/**
	 * Whether reconciling is offered at all (FR-049).
	 *
	 * An inactive account has nothing to match a bank line against, so the
	 * card would point at a surface with nothing on it.
	 */
	const canReconcile = $derived(
		data.perms.reconcile && account.active && account.postingEligible
	);

	createResourceStream<{ type: string; account?: AccountView; id?: number }>(
		'/api/accounts/stream',
		(m) => {
			if (m.type === 'accounts-refresh') {
				// The whole chart changed underneath us (an upgrade or a bulk
				// renumber), so nothing short of a reload is trustworthy.
				location.reload();
			} else if (m.type === 'account-update' && m.account) {
				const incoming = m.account;
				chart = chart.some((a) => a.id === incoming.id)
					? chart.map((a) => (a.id === incoming.id ? incoming : a))
					: [...chart, incoming];
			} else if (m.type === 'account-deleted' && m.id === account.id) {
				toast('That account was deleted.');
				void goto(resolve('/(app)/accounts'), { replaceState: true });
			}
		}
	);
</script>

<svelte:head><title>{account.code} {account.name} - Akaun</title></svelte:head>

<DetailPage
	backHref="/accounts"
	backLabel="Accounts"
	{dirty}
	{saving}
	onsave={save}
	onrevert={seed}
>
	{#snippet actions()}
		{#if data.perms.delete && !account.isSystem}
			<button
				class="sheet-btn sheet-btn-delete"
				disabled={!account.canDelete}
				title={account.cannotDeleteReason ?? undefined}
				onclick={() => (deleteDialogOpen = true)}
			>
				<Trash2 size={14} /> Delete
			</button>
		{/if}
		{#if canReconcile}
			<a href={reconcileHref} class="sheet-btn">
				<Scale size={14} />
				Reconcile{#if data.unfinishedStatements > 0}
					&nbsp;· {data.unfinishedStatements} open{/if}
			</a>
		{/if}
		{#if canEdit}
			<form method="POST" action="?/update" use:enhance style="display:contents;">
				<input type="hidden" name="id" value={account.id} />
				<button type="submit" class="sheet-btn" name="active" value={account.active ? 'false' : 'true'}>
					{account.active ? 'Deactivate' : 'Reactivate'}
				</button>
			</form>
		{/if}
	{/snippet}

	{#snippet hero()}
		<div class="detail-hero-eyebrow">
			<span>{account.code}</span>
			<span>·</span>
			<span>{AccountTypeDisplayLabels[account.type]}</span>
			{#if NEEDS_REVIEW_TYPES.includes(account.type)}
				<span>·</span>
				<span>
					{account.subType != null ? AccountSubTypeDisplayLabels[account.subType] : 'Unclassified'}
				</span>
			{:else if account.subType != null}
				<span>·</span>
				<span>{AccountSubTypeDisplayLabels[account.subType]}</span>
			{/if}
			{#if !account.active}<span>·</span><span>Inactive</span>{/if}
			{#if account.id === data.defaultAccountId}<span>·</span><span>Default account</span>{/if}
		</div>
		<h1 class="detail-hero-title">{account.name}</h1>
		<div class="detail-hero-figure">
			<span class="detail-hero-amount">
				{formatMinor(account.balanceMinor)}
			</span>
		</div>
		{#if error || form?.error}<p class="hero-error">{error || form?.error}</p>{/if}
	{/snippet}

	{#snippet main()}
		<!-- What has actually moved through it. The one thing an account is for,
		     and the one thing a drawer could never hold. -->
		<section class="detail-card">
			<div class="detail-card-head">
				<span class="detail-card-title">Recent transactions</span>
				<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the route comes from resolve(); only the query string is appended. -->
				<a class="detail-card-action" href={movementsHref}>
					See all {data.recentTotal} <ChevronRight size={13} />
				</a>
			</div>
			{#if data.recent.length === 0}
				<p class="card-empty">No transactions are posted to this account yet.</p>
			{:else}
				<div class="mv-list">
					{#each recentShown as r (r.id)}
						{@const side = r.movements.find((m) => m.accountId === account.id)}
						<a
							class="mv-row related-link"
							href={resolve('/(app)/records/[id]', { id: String(r.id) })}
						>
							<span class="mv-date">{formatDate(r.date)}</span>
							<span class="mv-desc">{side?.displayLabel ?? r.description}</span>
							<span class="mv-amount" class:out={(side?.amountMinor ?? 0) < 0}>
								{formatMinor(side?.amountMinor ?? 0)}
							</span>
							<ChevronRight size={13} color="var(--muted-foreground)" />
						</a>
					{/each}
				</div>
				<ListExpand total={data.recent.length} bind:expanded={recentExpanded} />
				<p class="empty-note">
					The running balance needs all transactions in date order. It shows only on the
					account ledger.
				</p>
			{/if}
		</section>

		<section class="detail-card">
			<div class="detail-card-head"><span class="detail-card-title">Account details</span></div>

			<div class="field">
				<label class="field-label" for="acc-name">Name *</label>
				<Input id="acc-name" bind:value={name} maxlength={120} disabled={!canEdit} class="w-full" />
			</div>

			<div class="field">
				<label class="field-label" for="acc-code">Code *</label>
				<Input
					id="acc-code"
					type="number"
					bind:value={code}
					min={AccountCodeRanges[selectedType].start}
					max={AccountCodeRanges[selectedType].end}
					disabled={!canEdit}
					class="w-full"
				/>
				<p class="field-hint">
					{AccountCodeRanges[selectedType].start}–{AccountCodeRanges[selectedType].end} for
					{AccountTypeDisplayLabels[selectedType].toLowerCase()} accounts.
				</p>
			</div>

			<div class="field">
				<label class="field-label" for="acc-type">Account type *</label>
				<Select.Root
					type="single"
					value={String(selectedType)}
					onValueChange={(next) => next && (selectedType = Number(next) as AccountTypeCode)}
				>
					<Select.Trigger id="acc-type" class="w-full justify-between" disabled={!canEdit}>
						{AccountTypeDisplayLabels[selectedType]}
					</Select.Trigger>
					<Select.Content>
						{#each types as type (type)}
							<Select.Item value={String(type)} label={AccountTypeDisplayLabels[type]} />
						{/each}
					</Select.Content>
				</Select.Root>
				<p class="field-hint">
					The type decides which report this appears on and which direction its balance
					normally runs.
				</p>
			</div>

			{#if subTypes.length > 0}
				{@const needsReview = NEEDS_REVIEW_TYPES.includes(selectedType)}
				<div class="field">
					<label class="field-label" for="acc-sub-type">
						Sub-type {needsReview ? '*' : ''}
					</label>
					<Select.Root
						type="single"
						value={subType == null ? NONE_SUB_TYPE : String(subType)}
						onValueChange={(next) => {
							subType = next && next !== NONE_SUB_TYPE ? (Number(next) as AccountSubTypeCode) : null;
						}}
					>
						<Select.Trigger id="acc-sub-type" class="w-full justify-between" disabled={!canEdit}>
							{subType == null ? 'Unclassified' : AccountSubTypeDisplayLabels[subType]}
						</Select.Trigger>
						<Select.Content>
							{#if subType == null}
								<Select.Item
									value={NONE_SUB_TYPE}
									label="Unclassified"
								/>
							{/if}
							{#each subTypes as st (st)}
								<Select.Item value={String(st)} label={AccountSubTypeDisplayLabels[st]} />
							{/each}
						</Select.Content>
					</Select.Root>
					<p class="field-hint">
						What kind of {AccountTypeDisplayLabels[selectedType].toLowerCase()} this is.
					</p>
				</div>
			{/if}
		</section>
	{/snippet}

	{#snippet rail()}
		<section class="detail-card">
			<div class="detail-card-head"><span class="detail-card-title">Opening balance</span></div>
			<button class="related-link ob-card" onclick={() => (openingOpen = true)} disabled={!data.perms.change}>
				<span class="ob-icon"><Wallet size={15} /></span>
				<span class="ob-main">
					<span class="ob-title">
						{data.openingBalance ? formatMinor(data.openingBalance.amountMinor) : 'None set'}
					</span>
					<span class="ob-sub">
						{data.openingBalance
							? `As at ${formatDate(data.openingBalance.date)}`
							: 'Balance on the start date of the books'}
					</span>
				</span>
				<ChevronRight size={14} color="var(--muted-foreground)" />
			</button>
		</section>

		<section class="detail-card">
			<div class="detail-card-head"><span class="detail-card-title">Account ledger</span></div>
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the route comes from resolve(); only the query string is appended. -->
			<a class="related-link ob-card" href={movementsHref}>
				<span class="ob-icon"><Landmark size={15} /></span>
				<span class="ob-main">
					<span class="ob-title">View account ledger</span>
					<span class="ob-sub">
						{data.recentTotal} transaction{data.recentTotal === 1 ? '' : 's'}, with a running balance
					</span>
				</span>
				<ChevronRight size={14} color="var(--muted-foreground)" />
			</a>
		</section>

		<section class="detail-card">
			<div class="detail-card-head"><span class="detail-card-title">History</span></div>
			<AuditTrail bind:this={auditTrailRef} recordType="account" recordId={account.id} />
		</section>
	{/snippet}
</DetailPage>

<OpeningBalanceSheet
	bind:open={openingOpen}
	{account}
	existing={data.openingBalance}
	error={form?.error ?? ''}
	onclose={() => (openingOpen = false)}
/>

<!-- Delete posts the form action, which redirects to the list on success: the
     server knows the account is gone, so it says where to go next. -->
<form method="POST" action="?/delete" use:enhance id="account-delete-form" hidden>
	<input type="hidden" name="id" value={account.id} />
</form>

<ConfirmDialog
	bind:open={deleteDialogOpen}
	title="Delete this account?"
	description="This removes the account from the chart. It is only possible while nothing has been recorded against it."
	confirmLabel="Delete"
	danger
	onConfirm={() =>
		(document.getElementById('account-delete-form') as HTMLFormElement)?.requestSubmit()}
/>

<style>
	.hero-error {
		background: var(--red-soft);
		color: var(--red);
		border-radius: 8px;
		padding: 8px 12px;
		font-size: 13px;
		margin: 8px 0 0;
	}
	.empty-note {
		font-size: 12px;
		color: var(--muted-foreground);
		line-height: 1.5;
		margin: 10px 0 0;
	}
	.mv-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.mv-row {
		display: grid;
		grid-template-columns: 92px minmax(0, 1fr) auto 13px;
		align-items: center;
		gap: 12px;
		padding: 9px 12px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--card);
		color: inherit;
		text-decoration: none;
	}
	.mv-date {
		font-family: 'Geist Mono', monospace;
		font-size: 12px;
		color: var(--muted-foreground);
		font-variant-numeric: tabular-nums;
	}
	.mv-desc {
		font-size: 13px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.mv-amount {
		font-family: 'Geist Mono', monospace;
		font-variant-numeric: tabular-nums;
		font-size: 13px;
		font-weight: 600;
		text-align: right;
	}
	.mv-amount.out {
		color: var(--muted-foreground);
	}

	@media (max-width: 767px) {
		.mv-row {
			grid-template-columns: minmax(0, 1fr) auto;
			gap: 4px 10px;
		}
		.mv-date {
			grid-column: 1 / -1;
		}
	}
</style>
