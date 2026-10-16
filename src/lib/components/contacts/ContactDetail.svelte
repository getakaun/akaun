<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { ChevronRight, Scale, Trash2 } from '@lucide/svelte';
	import DetailPage from '$lib/components/ui/DetailPage.svelte';
	import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte';
	import AuditTrail from '$lib/components/ui/AuditTrail.svelte';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import { formatMinor } from '$lib/format.js';
	import { EntityType, EntityTypeLabels, Role, RoleLabels } from '$lib/enums.js';
	import type { loadContactDetail } from '$lib/server/loaders/contacts.js';

	/**
	 * One contact, on its own page.
	 *
	 * Contacts never had a read view — the edit form was the detail — so what a
	 * contact actually is to this business, the balance owed either way, had
	 * nowhere to be shown. That figure is the whole reason a contact exists here
	 * (CLAUDE.md § The three ledgers), and it is now the hero.
	 */
	let {
		data,
		form
	}: {
		data: Awaited<ReturnType<typeof loadContactDetail>>;
		form: { error?: string; success?: boolean } | null;
	} = $props();

	const contact = $derived(data.contact);

	const ROLE_OPTIONS = [Role.Customer, Role.Supplier, Role.Employee, Role.Partner];

	let entityType = $state<number>(EntityType.Individual);
	let legalName = $state('');
	let roles = $state<number[]>([]);
	let registrationNo = $state('');
	let email = $state('');
	let phone = $state('');
	let address = $state('');
	let remark = $state('');
	let snapshot = $state('');
	let saving = $state(false);
	let deleteDialogOpen = $state(false);
	let saveFormEl = $state<HTMLFormElement | null>(null);
	let auditTrailRef = $state<{ refresh: () => Promise<void> } | null>(null);

	function fingerprint(): string {
		return JSON.stringify([
			entityType,
			legalName,
			[...roles].sort(),
			registrationNo,
			email,
			phone,
			address,
			remark
		]);
	}

	function seed() {
		entityType = contact.entityType;
		legalName = contact.legalName;
		roles = [...contact.roles];
		registrationNo = contact.registrationNo ?? '';
		email = contact.email ?? '';
		phone = contact.phone ?? '';
		address = contact.address ?? '';
		remark = contact.remark ?? '';
		snapshot = fingerprint();
	}

	let seededId = $state<number | null>(null);
	$effect(() => {
		if (seededId === contact.id) return;
		seededId = contact.id;
		seed();
	});

	const dirty = $derived(snapshot !== '' && fingerprint() !== snapshot);
	const canEdit = $derived(data.perms.change);

	// Mirrors `deleteContact`'s refusal in services/contacts.ts: a contact
	// anything points at is archived, never deleted (FR-009a). The rule lives
	// server-side and cannot be imported here, so the sentence is kept in step
	// by hand.
	const deleteBlockedReason = $derived(
		data.usage.records === 0 && data.usage.quotations === 0 && data.usage.invoices === 0
			? null
			: 'Transactions or documents refer to this contact, so you cannot delete it. Archive it instead. The existing records do not change.'
	);

	/**
	 * This contact's statement: the Records list narrowed to them.
	 *
	 * `resolve()` builds the route and the contact is appended as a query
	 * parameter — a value, not part of the route — so the lint rule below cannot
	 * see through the template string.
	 */
	const statementHref = $derived(`${resolve('/(app)/records')}?contact=${contact.id}`);

	function toggleRole(r: number) {
		roles = roles.includes(r) ? roles.filter((x) => x !== r) : [...roles, r];
	}

	$effect(() => {
		if (form?.success) {
			snapshot = fingerprint();
			void auditTrailRef?.refresh();
		}
	});
</script>

<svelte:head><title>{contact.legalName} - Akaun</title></svelte:head>

<DetailPage
	backHref="/contacts"
	backLabel="Contacts"
	{dirty}
	{saving}
	onsave={() => saveFormEl?.requestSubmit()}
	onrevert={seed}
>
	{#snippet actions()}
		{#if data.perms.delete}
			<button
				class="sheet-btn sheet-btn-delete"
				disabled={!!deleteBlockedReason}
				title={deleteBlockedReason ?? undefined}
				onclick={() => (deleteDialogOpen = true)}
			>
				<Trash2 size={14} /> Delete
			</button>
		{/if}
	{/snippet}

	{#snippet hero()}
		<div class="detail-hero-eyebrow">
			<span>{EntityTypeLabels[contact.entityType]}</span>
			{#each contact.roles as role (role)}
				<span>·</span><span>{RoleLabels[role]}</span>
			{/each}
		</div>
		<h1 class="detail-hero-title">{contact.legalName}</h1>
		{#if data.perms.records}
			<div class="detail-hero-figure">
				<span class="detail-hero-amount">{formatMinor(Math.abs(data.balanceMinor))}</span>
				<span class="detail-hero-note">
					{#if data.balanceMinor === 0}
						No open balance
					{:else if data.balanceMinor > 0}
						Receivable
					{:else}
						Payable
					{/if}
				</span>
			</div>
		{/if}
		{#if form?.error}<p class="hero-error">{form.error}</p>{/if}
	{/snippet}

	{#snippet main()}
		<form
			method="POST"
			action="?/update"
			bind:this={saveFormEl}
			use:enhance={() => {
				saving = true;
				return async ({ update }) => {
					await update();
					saving = false;
				};
			}}
		>
			<input type="hidden" name="id" value={contact.id} />

			<section class="detail-card">
				<div class="detail-card-head"><span class="detail-card-title">Contact details</span></div>

				<div class="field">
					<span class="field-label">Entity type *</span>
					<div class="chip-row">
						{#each [EntityType.Individual, EntityType.Business] as option (option)}
							<label class="chip" class:on={entityType === option}>
								<input
									type="radio"
									name="entityType"
									value={option}
									bind:group={entityType}
									disabled={!canEdit}
								/>
								{EntityTypeLabels[option]}
							</label>
						{/each}
					</div>
				</div>

				<div class="field">
					<label class="field-label" for="legalName">Legal name *</label>
					<Input
						id="legalName"
						name="legalName"
						bind:value={legalName}
						required
						disabled={!canEdit}
						class="w-full"
					/>
				</div>

				<div class="field" style="margin-bottom:0;">
					<span class="field-label">Roles</span>
					<div class="chip-row">
						{#each ROLE_OPTIONS as r (r)}
							<label class="chip" class:on={roles.includes(r)}>
								<input
									type="checkbox"
									name="roles"
									value={r}
									checked={roles.includes(r)}
									onchange={() => toggleRole(r)}
									disabled={!canEdit}
								/>
								{RoleLabels[r]}
							</label>
						{/each}
					</div>
					{#if roles.includes(Role.Partner)}
						<p class="field-hint">
							Capital contributions and drawings of a partner are posted to equity accounts.
							The partner statement shows these accounts by name.
						</p>
					{/if}
				</div>
			</section>

			<section class="detail-card" style="margin-top:16px;">
				<div class="detail-card-head"><span class="detail-card-title">Contact information</span></div>

				<div class="field-grid">
					<div class="field">
						<label class="field-label" for="email">Email</label>
						<Input
							id="email"
							name="email"
							type="email"
							bind:value={email}
							disabled={!canEdit}
							class="w-full"
						/>
					</div>
					<div class="field">
						<label class="field-label" for="phone">Phone</label>
						<Input id="phone" name="phone" bind:value={phone} disabled={!canEdit} class="w-full" />
					</div>
				</div>

				<div class="field">
					<label class="field-label" for="registrationNo">Registration no.</label>
					<Input
						id="registrationNo"
						name="registrationNo"
						bind:value={registrationNo}
						disabled={!canEdit}
						class="w-full"
					/>
				</div>

				<div class="field">
					<label class="field-label" for="address">Address</label>
					<Textarea
						id="address"
						name="address"
						rows={2}
						bind:value={address}
						disabled={!canEdit}
						class="leading-relaxed"
					/>
				</div>

				<div class="field" style="margin-bottom:0;">
					<label class="field-label" for="remark">Remark</label>
					<Textarea
						id="remark"
						name="remark"
						rows={2}
						bind:value={remark}
						disabled={!canEdit}
						class="leading-relaxed"
					/>
				</div>
			</section>
		</form>
	{/snippet}

	{#snippet rail()}
		{#if data.perms.records}
			<section class="detail-card">
				<div class="detail-card-head"><span class="detail-card-title">Contact ledger</span></div>
				<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the route comes from resolve(); only the query string is appended. -->
				<a class="related-link ob-card" href={statementHref}>
					<span class="ob-icon"><Scale size={15} /></span>
					<span class="ob-main">
						<span class="ob-title">View contact ledger</span>
						<span class="ob-sub">
							{data.usage.records} record{data.usage.records === 1 ? '' : 's'},
							{data.usage.invoices} invoice{data.usage.invoices === 1 ? '' : 's'}
						</span>
					</span>
					<ChevronRight size={14} color="var(--muted-foreground)" />
				</a>
			</section>
		{/if}

		<section class="detail-card">
			<div class="detail-card-head"><span class="detail-card-title">History</span></div>
			<AuditTrail bind:this={auditTrailRef} recordType="contact" recordId={contact.id} />
		</section>
	{/snippet}
</DetailPage>

<form method="POST" action="?/delete" use:enhance id="contact-delete-form" hidden>
	<input type="hidden" name="id" value={contact.id} />
</form>

<ConfirmDialog
	bind:open={deleteDialogOpen}
	title="Delete this contact?"
	description="This removes the contact. You cannot delete it while transactions or documents refer to this contact."
	confirmLabel="Delete"
	danger
	onConfirm={() =>
		(document.getElementById('contact-delete-form') as HTMLFormElement)?.requestSubmit()}
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
	.chip-row {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 6px 12px;
		font-size: 13px;
		cursor: pointer;
		background: var(--card);
	}
	.chip.on {
		border-color: var(--primary);
		background: var(--primary-soft);
	}
	.chip input {
		display: none;
	}
	.chip:has(input:disabled) {
		cursor: not-allowed;
		opacity: 0.7;
	}
</style>
