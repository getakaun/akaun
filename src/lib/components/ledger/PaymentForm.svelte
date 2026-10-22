<script lang="ts">
	import { createResourceStream } from '$lib/sse.js';
	import { planCreditApplication } from './credit-application.js';
	import { Checkbox } from '$lib/components/ui/checkbox/index.js';
	import DatePicker from '$lib/components/ui/date-picker/DatePicker.svelte';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import { formatDate, formatMinor } from '$lib/format.js';
	import { mainCurrency, mainCurrencySymbol } from '$lib/currency-state.svelte.js';
	import AccountSelect from './AccountSelect.svelte';
	import type { AccountView, OutstandingItem, RecordView } from '$lib/server/ledger/types.js';

	/**
	 * The fields for recording a payment, and ticking what it covers.
	 *
	 * One definition, so a future second host (an edit surface, if one is ever
	 * added) cannot offer a different set of fields than the create page does —
	 * the same reason `RecordForm` is its own component.
	 *
	 * The payment and the note saying what it paid off are one action for the
	 * user, so they are one request: `POST /api/records` takes the payment and
	 * its allocations together and takes the payment back if the allocations are
	 * refused, rather than leaving money recorded against nothing (FR-015).
	 */
	type Direction = 'we-pay' | 'we-receive' | 'refund-received' | 'refund-paid' | 'reimburse';
	const formTitles: Record<Direction, string> = {
		'we-pay': 'Payment',
		reimburse: 'Reimbursement',
		'we-receive': 'Receipt',
		'refund-received': 'Refund received',
		'refund-paid': 'Refund paid'
	};

	let {
		direction = 'reimburse',
		accounts,
		contacts = [],
		defaultAccountId = null,
		settlementAccountId = null,
		contactId: initialContactId = null,
		preselectMovementId = null,
		// Write-only out-parameters: the frame around this form reads them to
		// decide whether to show a save bar and what to put on it.
		// eslint-disable-next-line no-useless-assignment
		dirty = $bindable(false),
		// eslint-disable-next-line no-useless-assignment
		saving = $bindable(false),
		error = $bindable('')
	}: {
		/** we-pay: we are paying someone. we-receive: someone is paying us. */
		direction?: Direction;
		/** The asset and liability accounts the payment or receipt account offers. */
		accounts: AccountView[];
		contacts?: { id: number; legalName: string }[];
		defaultAccountId?: number | null;
		settlementAccountId?: number | null;
		/** Opens with this person already chosen, from a row that names them. */
		contactId?: number | null;
		/**
		 * One owed item to tick on arrival — the invoice "Record payment" came
		 * from. Ticked once, when the opening contact's items first load.
		 */
		preselectMovementId?: number | null;
		dirty?: boolean;
		saving?: boolean;
		error?: string;
	} = $props();

	// --- Form state ---------------------------------------------------------
	let date = $state('');
	let description = $state('');
	let reference = $state('');
	let remark = $state('');
	let contactId = $state<number | null>(null);
	let moneyAccountId = $state<number | null>(null);
	let amountInput = $state('0.00');
	// Until the user types an amount of their own, the payment is worth exactly
	// what it covers — which is the ordinary case and saves a keystroke.
	let amountEdited = $state(false);
	/**
	 * movement id → how much of this payment goes against it, exactly as typed.
	 * Held as the typed text rather than as cents so that reformatting never
	 * fights the person filling the box in; it becomes cents once, on the way
	 * out, and the arithmetic is only ever done on those whole cents.
	 */
	let picked = $state<Record<number, string>>({});
	let items = $state<OutstandingItem[]>([]);
	// Only shown for compatibility when an older separate payable account has items.
	let reimbursementAccounts = $state<{ id: number; name: string }[]>([]);
	let reimbursementAccountId = $state<number | null>(null);
	let loading = $state(false);
	let availableCredits = $state<OutstandingItem[]>([]);
	let creditPicked = $state<Record<number, string>>({});
	let loadError = $state('');
	let revision = $state(0);
	createResourceStream('/api/records/stream', () => {
		revision += 1;
	});

	let snapshot = $state('');
	function fingerprint(): string {
		return JSON.stringify([
			date,
			description,
			reference,
			remark,
			contactId,
			moneyAccountId,
			amountInput,
			picked,
			creditPicked,
			direction
		]);
	}
	function seed() {
		date = new Date().toISOString().slice(0, 10);
		description = '';
		reference = '';
		remark = '';
		contactId = initialContactId;
		moneyAccountId = null;
		amountInput = '0.00';
		amountEdited = false;
		picked = {};
		creditPicked = {};
		error = '';
		snapshot = fingerprint();
	}
	seed();

	$effect(() => {
		dirty = snapshot !== '' && fingerprint() !== snapshot;
	});

	export function revert(): void {
		seed();
	}

	// Paying what we owe clears the money-we-owe side; being paid clears the
	// money-owed-to-us side. The list of what can be covered follows from that.
	const isReimbursement = $derived(direction === 'reimburse');
	const isRefund = $derived(direction === 'refund-received' || direction === 'refund-paid');
	const outgoing = $derived(
		direction === 'we-pay' || direction === 'reimburse' || direction === 'refund-paid'
	);
	const listDirection = $derived(
		direction === 'we-pay' || direction === 'reimburse' || direction === 'refund-received'
			? 'we-owe'
			: 'owed-to-us'
	);
	function acceptItems(body: { items?: OutstandingItem[] } | null) {
		const list = body?.items ?? [];
		items = list.filter((i) => (isRefund ? i.position === 'credit' : i.position !== 'credit'));
		availableCredits = isRefund ? [] : list.filter((i) => i.position === 'credit');
	}

	/** Every item ticked, at its full outstanding amount — the ordinary "pay it all" case. */
	function tickAll(list: OutstandingItem[]): Record<number, string> {
		const next: Record<number, string> = {};
		for (const item of list) next[item.movementId] = (item.outstandingMinor / 100).toFixed(2);
		return next;
	}

	export function selectAll(): void {
		picked = tickAll(items);
	}

	export function selectNone(): void {
		picked = {};
	}

	// A stale answer must never overwrite a newer one, so each request carries a
	// token and only the newest one is allowed to land.
	let loadToken = 0;

	// Not reactive: once used — or once the opening contact's items have come
	// back without it, already paid — it never ticks anything again.
	let preselectDone = false;

	/**
	 * Ticks the preselected item at its full outstanding amount, exactly as a
	 * click on its box would. Runs when the items land, which is always after
	 * the effect below has cleared the picks for the opening contact, so the
	 * tick is not wiped; and because it is a change from the seeded snapshot,
	 * the form is dirty and the save bar shows, as it would for a user's tick.
	 */
	function applyPreselect(person: number) {
		if (preselectDone || preselectMovementId === null) return;
		if (person !== initialContactId) return;
		preselectDone = true;
		const item = items.find((i) => i.movementId === preselectMovementId);
		if (item) picked = { [item.movementId]: (item.outstandingMinor / 100).toFixed(2) };
	}
	$effect(() => {
		void revision;
		void direction;
		loadError = '';
		const person = contactId;
		const dir = listDirection;
		const token = ++loadToken;

		{
			if (person === null) {
				items = [];
				availableCredits = [];
				loading = false;
				return;
			}
			loading = true;
			const endpoint = isReimbursement
				? `/api/reimbursements/candidates?contactId=${person}${reimbursementAccountId !== null ? `&accountId=${reimbursementAccountId}` : ''}`
				: `/api/settlements?direction=${dir}&contactId=${person}${settlementAccountId !== null ? `&settlementAccountId=${settlementAccountId}` : ''}`;
			fetch(endpoint)
				.then((res) => {
					if (!res.ok) throw new Error('load');
					return res.json();
				})
				.then((body) => {
					if (token !== loadToken) return;
					if (isReimbursement) reimbursementAccounts = body.accounts ?? [];
					acceptItems(body);
					loading = false;
					applyPreselect(person);
				})
				.catch(() => {
					if (token !== loadToken) return;
					items = [];
					availableCredits = [];
					loadError = 'Open items could not be loaded. Reload before saving.';
					loading = false;
				});
			return;
		}
	});

	$effect(() => {
		void contactId;
		reimbursementAccountId = null;
	});

	// Changing the recipient invalidates the previous selections.
	$effect(() => {
		void contactId;
		void direction;
		void reimbursementAccountId;
		picked = {};
		creditPicked = {};
	});

	// A box left empty is the same as not having ticked the item, so it is
	// dropped here rather than sent as an allocation of nothing and bounced.
	const allocations = $derived(
		Object.entries(picked)
			.map(([movementId, raw]) => ({
				owedMovementId: Number(movementId),
				amountMinor: Math.round(parseFloat(String(raw ?? '')) * 100) || 0
			}))
			.filter((a) => a.amountMinor > 0)
	);

	const allocatedMinor = $derived(allocations.reduce((sum, a) => sum + a.amountMinor, 0));

	const creditPlan = $derived(
		planCreditApplication(
			allocations,
			Object.entries(creditPicked).map(([id, raw]) => ({
				paymentMovementId: Number(id),
				amountMinor: Math.round(Number(raw) * 100) || 0
			}))
		)
	);
	$effect(() => {
		const total = allocatedMinor - creditPlan.creditAppliedMinor;
		if (amountEdited) return;
		amountInput = (total / 100).toFixed(2);
	});

	const amountMinor = $derived(Math.round(parseFloat(String(amountInput ?? '')) * 100) || 0);
	const unallocatedMinor = $derived(amountMinor - allocatedMinor + creditPlan.creditAppliedMinor);

	const contactLabel = $derived(outgoing ? 'Payee *' : 'Payer *');
	const moneyLabel = $derived(outgoing ? 'Payment account' : 'Receipt account');

	function isPicked(item: OutstandingItem): boolean {
		return item.movementId in picked;
	}

	function toggle(item: OutstandingItem) {
		if (isPicked(item)) {
			delete picked[item.movementId];
		} else {
			// Ticking an item offers to clear all of what is left on it, which is
			// what a payment usually does.
			picked[item.movementId] = (item.outstandingMinor / 100).toFixed(2);
		}
	}

	export function blockedBy(): string | null {
		if (contactId === null) {
			return outgoing ? 'Select the payee.' : 'Select the payer.';
		}
		if (loading || loadError) return loadError || 'Wait for open items to load.';
		if (moneyAccountId === null && amountMinor !== 0) return 'Choose an account.';
		if (isReimbursement && !description.trim()) return 'Enter a reimbursement description.';
		if (isReimbursement && !allocations.length) return 'Select the expenses to reimburse.';
		if (isRefund && (allocations.length === 0 || amountMinor !== allocatedMinor))
			return 'Apply the full refund to an existing overpayment.';
		if (
			Object.values(creditPicked).reduce((n, raw) => n + Math.round(Number(raw) * 100), 0) >
			allocatedMinor
		)
			return 'The credit amount exceeds the selected claims. Reduce the credit amount.';
		if (!isReimbursement && unallocatedMinor < 0)
			return 'The cash amount and applied credit do not cover the selected items.';
		for (const [id, raw] of Object.entries(creditPicked)) {
			const available = availableCredits.find((i) => i.movementId === Number(id));
			if (
				!available ||
				!Number.isFinite(Number(raw)) ||
				Number(raw) <= 0 ||
				Math.round(Number(raw) * 100) > available.outstandingMinor
			)
				return 'Review the credit amounts before saving.';
		}
		if (
			amountMinor < 0 ||
			(!isReimbursement && amountMinor === 0 && creditPlan.creditAppliedMinor === 0)
		)
			return 'Enter an amount or apply available credit.';
		return null;
	}

	export async function submit(): Promise<RecordView | null> {
		if (blockedBy()) return null;
		saving = true;
		error = '';

		try {
			const res = await fetch(isReimbursement ? '/api/reimbursements' : '/api/records', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(
					isReimbursement
						? {
								contactId,
								date,
								description,
								reference,
								remark,
								personallyPaid: true,
								items: allocations,
								cashMinor: amountMinor,
								paidFromAccountId: moneyAccountId ?? defaultAccountId ?? accounts[0]?.id ?? null,
								credits: Object.entries(creditPicked).map(([id, raw]) => ({
									paymentMovementId: Number(id),
									amountMinor: Math.round(Number(raw) * 100)
								}))
							}
						: {
								kind: 'payment',
								...(settlementAccountId !== null ? { settlementAccountId } : {}),
								date,
								description,
								amount: amountMinor / 100,
								currency: mainCurrency(),
								exchangeRate: 1,
								reference,
								remark,
								contactId,
								paidFromAccountId: moneyAccountId ?? defaultAccountId ?? accounts[0]?.id,
								direction,
								settlements: creditPlan.cashAllocations,
								creditApplications: creditPlan.creditApplications
							}
				)
			});

			saving = false;
			if (!res.ok) {
				const body = await res.json().catch(() => null);
				// The rule's own sentence, never a rewrite of it (FR-016).
				error = body?.reason ?? body?.error ?? 'That payment could not be saved.';
				return null;
			}
			const saved = await res.json();
			snapshot = fingerprint();
			return isReimbursement ? saved.record : saved;
		} catch {
			error =
				'The payment result could not be confirmed. Reload and check the records before trying again.';
			return null;
		} finally {
			saving = false;
		}
	}
</script>

{#if error}
	<div class="form-error" role="alert">{error}</div>
{/if}

<section class="detail-card">
	<div class="detail-card-head"><span class="detail-card-title">{formTitles[direction]}</span></div>

	<div class="field">
		<label class="field-label" for="pay-contact">{contactLabel}</label>
		<Select.Root
			type="single"
			value={contactId === null ? '' : String(contactId)}
			onValueChange={(next) => (contactId = next ? Number(next) : null)}
		>
			<Select.Trigger id="pay-contact" class="w-full justify-between">
				{#if contactId === null}
					Select contact
				{:else}
					{contacts.find((contact) => contact.id === contactId)?.legalName ?? 'Select contact'}
				{/if}
			</Select.Trigger>
			<Select.Content>
				{#each contacts as contact (contact.id)}
					<Select.Item value={String(contact.id)} label={contact.legalName} />
				{/each}
			</Select.Content>
		</Select.Root>
	</div>
	<div class="field">
		<label class="field-label" for="pay-description">Description *</label>
		<Input id="pay-description" bind:value={description} required maxlength={500} class="w-full" />
	</div>

	<div class="field">
		<label class="field-label" for="pay-amount">Amount ({mainCurrencySymbol()}) *</label>
		<Input
			id="pay-amount"
			type="number"
			step="0.01"
			bind:value={amountInput}
			oninput={() => (amountEdited = true)}
			required
			class="w-full"
		/>
	</div>

	<div class="field">
		<span id="pay-date-label" class="field-label">Date *</span>
		<DatePicker name="date" bind:value={date} labelledBy="pay-date-label" />
	</div>

	<AccountSelect
		{accounts}
		bind:value={moneyAccountId}
		name="paymentAccount"
		label={moneyLabel}
		{defaultAccountId}
	/>
</section>

{#if loadError}<p class="form-error" role="alert">{loadError}</p>{/if}
{#if availableCredits.length > 0}
	<section class="detail-card">
		<div class="detail-card-head"><span class="detail-card-title">Available credit</span></div>
		<p class="covers-note">
			Choose Apply to use an earlier payment against the items selected below.
		</p>
		{#each availableCredits as credit (credit.movementId)}
			<div class="covers-row">
				<label for={`apply-credit-${credit.movementId}`} class="covers-tick"
					><Checkbox
						id={`apply-credit-${credit.movementId}`}
						checked={credit.movementId in creditPicked}
						onCheckedChange={(checked) => {
							if (!checked) delete creditPicked[credit.movementId];
							else
								creditPicked[credit.movementId] = (
									Math.min(credit.outstandingMinor, allocatedMinor || credit.outstandingMinor) / 100
								).toFixed(2);
						}}
					/>
					Apply {credit.recordNumber ?? credit.description} · {formatMinor(credit.outstandingMinor)} available
				</label>
				{#if credit.movementId in creditPicked}<Input
						class="h-8 w-[92px] shrink-0 text-right tabular-nums"
						inputmode="decimal"
						name={`creditAmount-${credit.movementId}`}
						type="number"
						min="0.01"
						step="0.01"
						max={credit.outstandingMinor / 100}
						aria-label="Credit amount to apply"
						bind:value={creditPicked[credit.movementId]}
					/>{/if}
			</div>
		{/each}
		<p class="covers-note">
			Claim total: {formatMinor(allocatedMinor)} · Credit applied: {formatMinor(
				creditPlan.creditAppliedMinor
			)} · Cash remaining: {formatMinor(
				Math.max(0, allocatedMinor - creditPlan.creditAppliedMinor)
			)}
		</p>
	</section>
{/if}
<section class="detail-card">
	<div class="detail-card-head">
		<span class="detail-card-title">Allocation</span>
	</div>

	{#if isReimbursement && reimbursementAccounts.length > 1}
		<div class="field">
			<label class="field-label" for="reimbursement-account">Expenses account</label>
			<select
				id="reimbursement-account"
				class="form-input"
				value={reimbursementAccountId ?? reimbursementAccounts[0]?.id}
				onchange={(event) => (reimbursementAccountId = Number(event.currentTarget.value))}
			>
				{#each reimbursementAccounts as account (account.id)}
					<option value={account.id}>{account.name}</option>
				{/each}
			</select>
		</div>
	{/if}

	{#if contactId === null}
		<p class="covers-note">
			{isReimbursement
				? 'Select the reimbursement recipient to see outstanding expenses and their available credit.'
				: 'Select a contact to see the open items.'}
		</p>
	{:else if loading}
		<p class="covers-note">Looking…</p>
	{:else if items.length === 0}
		<p class="covers-note">This contact has no open items.</p>
	{:else}
		<div class="covers-list">
			{#each items as item (item.movementId)}
				<div class="covers-row" class:on={isPicked(item)}>
					<label for={`allocate-item-${item.movementId}`} class="covers-tick">
						<Checkbox
							id={`allocate-item-${item.movementId}`}
							checked={isPicked(item)}
							onCheckedChange={() => toggle(item)}
						/>
						<span class="covers-main">
							<span class="covers-name"
								>{isReimbursement
									? `${item.supplierContactName ?? item.contactName ?? 'Supplier'} · `
									: ''}{item.description || 'Record'}</span
							>
							<span class="covers-sub">
								{formatDate(item.date)}{item.recordNumber ? ` · ${item.recordNumber}` : ''} · {formatMinor(
									item.outstandingMinor
								)} outstanding
								{#if item.daysOverdue > 0}
									· {item.daysOverdue} days overdue
								{/if}
							</span>
						</span>
					</label>
					{#if isPicked(item)}
						<Input
							class="h-8 w-[92px] shrink-0 text-right tabular-nums"
							name={`allocationAmount-${item.movementId}`}
							inputmode="decimal"
							type="number"
							step="0.01"
							aria-label="Amount allocated to {item.description || 'this record'}"
							bind:value={picked[item.movementId]}
						/>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
	{#if allocatedMinor > 0 && unallocatedMinor > 0}
		<p class="covers-note">{formatMinor(unallocatedMinor)} unallocated.</p>
	{:else if allocatedMinor > 0}
		<p class="covers-note">Allocated: {formatMinor(allocatedMinor)}.</p>
	{/if}
</section>

{#if isReimbursement}
	<section class="detail-card">
		<div class="detail-card-head"><span class="detail-card-title">Reimbursement review</span></div>
		<p class="covers-note">
			Recipient: {contacts.find((c) => c.id === contactId)?.legalName ?? 'Select a recipient'} · Claim:
			{formatMinor(allocatedMinor)} · Credit: {formatMinor(creditPlan.creditAppliedMinor)} · Cash: {formatMinor(
				amountMinor
			)} · Still owed: {formatMinor(Math.max(0, -unallocatedMinor))}
		</p>
	</section>
{/if}

<section class="detail-card">
	<div class="detail-card-head"><span class="detail-card-title">Details</span></div>

	<div class="field">
		<label class="field-label" for="pay-reference">Reference</label>
		<Input id="pay-reference" bind:value={reference} maxlength={200} class="w-full" />
	</div>

	<div class="field">
		<label class="field-label" for="pay-remark">Remark</label>
		<Textarea id="pay-remark" bind:value={remark} rows={2} class="leading-relaxed" />
	</div>
</section>

<style>
	.form-error {
		background: var(--red-soft);
		color: var(--red);
		border-radius: 8px;
		padding: 10px 14px;
		font-size: 13px;
		margin-bottom: 16px;
	}
	.covers-note {
		font-size: 12.5px;
		color: var(--muted-foreground);
		margin: 0 0 16px;
	}
	.covers-list {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin-bottom: 16px;
	}
	/* The card's own padding ends it; scoped, so it outranks the margins above. */
	.covers-note:last-child,
	.covers-list:last-child {
		margin-bottom: 0;
	}
	.covers-row {
		display: flex;
		align-items: center;
		gap: 10px;
		border: 1px solid var(--border);
		border-radius: 9px;
		padding: 10px 12px;
		background: var(--card);
	}
	.covers-row.on {
		border-color: var(--primary);
	}
	.covers-tick {
		display: flex;
		align-items: center;
		gap: 10px;
		flex: 1;
		min-width: 0;
		cursor: pointer;
	}
	.covers-main {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}
	.covers-name {
		font-size: 13px;
		font-weight: 500;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.covers-sub {
		font-size: 11.5px;
		color: var(--muted-foreground);
	}
</style>
