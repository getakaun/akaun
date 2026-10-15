<script lang="ts">
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
	type Direction = 'we-pay' | 'we-receive';

	let {
		direction = 'we-pay',
		accounts,
		contacts = [],
		defaultAccountId = null,
		contactId: initialContactId = null,
		batch: initialBatch = false,
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
		/** Opens with this person already chosen, from a row that names them. */
		contactId?: number | null;
		/** Opens in batch mode, every contact's outstanding items already ticked. */
		batch?: boolean;
		/**
		 * One owed item to tick on arrival — the invoice "Record payment" came
		 * from. Ticked once, when the opening contact's items first load.
		 */
		preselectMovementId?: number | null;
		dirty?: boolean;
		saving?: boolean;
		error?: string;
	} = $props();

	/**
	 * One contact, chosen up front — or several at once, one real bank transfer
	 * settling items across all of them, with no single contact of its own
	 * (the payment's settlements carry that attribution instead, see FR-008's
	 * exception for a batch payment).
	 */
	let mode = $state<'single' | 'batch'>('single');

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
	let loading = $state(false);

	let snapshot = $state('');
	function fingerprint(): string {
		return JSON.stringify([date, description, reference, remark, contactId, moneyAccountId, amountInput, picked]);
	}
	function seed() {
		date = new Date().toISOString().slice(0, 10);
		description = '';
		reference = '';
		remark = '';
		contactId = initialContactId;
		mode = initialBatch ? 'batch' : 'single';
		moneyAccountId = null;
		amountInput = '0.00';
		amountEdited = false;
		picked = {};
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
	const listDirection = $derived(direction === 'we-pay' ? 'we-owe' : 'owed-to-us');

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
		const currentMode = mode;
		const person = contactId;
		const dir = listDirection;
		const token = ++loadToken;

		if (currentMode === 'single') {
			if (person === null) {
				items = [];
				loading = false;
				return;
			}
			loading = true;
			fetch(`/api/settlements?direction=${dir}&contactId=${person}`)
				.then((res) => (res.ok ? res.json() : null))
				.then((body) => {
					if (token !== loadToken) return;
					items = body?.items ?? [];
					loading = false;
					applyPreselect(person);
				})
				.catch(() => {
					if (token !== loadToken) return;
					items = [];
					loading = false;
				});
			return;
		}

		// Batch mode: every contact's outstanding items at once, ticked by
		// default — the user asked to pay it all, and deselects what should
		// wait rather than hunting down and ticking each item by hand.
		loading = true;
		fetch(`/api/settlements?direction=${dir}`)
			.then((res) => (res.ok ? res.json() : null))
			.then((body) => {
				if (token !== loadToken) return;
				items = body?.items ?? [];
				picked = tickAll(items);
				loading = false;
			})
			.catch(() => {
				if (token !== loadToken) return;
				items = [];
				loading = false;
			});
	});

	// Changing who the payment is with invalidates every tick against the old
	// person's items — those movements are not theirs to pay off. Irrelevant in
	// batch mode, where no single contact is chosen at all.
	$effect(() => {
		if (mode !== 'single') return;
		void contactId;
		picked = {};
	});

	/** Every ticked item, grouped by who it belongs to (batch mode only). */
	const groupedItems = $derived.by(() => {
		const byContact = new Map<
			number,
			{ contactId: number; contactName: string; items: OutstandingItem[] }
		>();
		for (const item of items) {
			if (item.contactId === null) continue;
			let group = byContact.get(item.contactId);
			if (!group) {
				group = { contactId: item.contactId, contactName: item.contactName ?? '', items: [] };
				byContact.set(item.contactId, group);
			}
			group.items.push(item);
		}
		return [...byContact.values()].sort((a, b) => a.contactName.localeCompare(b.contactName));
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

	$effect(() => {
		const total = allocatedMinor;
		if (amountEdited) return;
		amountInput = (total / 100).toFixed(2);
	});

	const amountMinor = $derived(Math.round(parseFloat(String(amountInput ?? '')) * 100) || 0);
	const unallocatedMinor = $derived(amountMinor - allocatedMinor);

	const contactLabel = $derived(direction === 'we-pay' ? 'Who was paid? *' : 'Who paid you? *');
	const moneyLabel = $derived(direction === 'we-pay' ? 'Payment account' : 'Receipt account');

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
		if (mode === 'single' && contactId === null) {
			return direction === 'we-pay' ? 'Choose who this pays.' : 'Choose who paid this.';
		}
		if (moneyAccountId === null) return 'Choose an account.';
		if (mode === 'batch' && allocations.length === 0) return 'Tick at least one item to pay.';
		if (amountMinor <= 0) return 'Enter an amount.';
		return null;
	}

	export async function submit(): Promise<RecordView | null> {
		if (blockedBy()) return null;
		saving = true;
		error = '';

		const res = await fetch('/api/records', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				kind: 'payment',
				date,
				description,
				amount: amountMinor / 100,
				currency: mainCurrency(),
				exchangeRate: 1,
				reference,
				remark,
				// A batch payment names no single contact — each settlement it
				// creates already points at the contact its own item belongs to.
				contactId: mode === 'batch' ? null : contactId,
				paidFromAccountId: moneyAccountId,
				direction,
				settlements: allocations
			})
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
		return saved;
	}
</script>

{#if error}
	<div class="form-error">{error}</div>
{/if}

<section class="detail-card">
	<div class="detail-card-head"><span class="detail-card-title">Payment</span></div>

	<div class="field">
		<span class="field-label">Who</span>
		<div class="mode-toggle" role="radiogroup" aria-label="One contact or several">
			<button
				type="button"
				class="mode-btn"
				class:active={mode === 'single'}
				onclick={() => (mode = 'single')}
			>
				One contact
			</button>
			<button
				type="button"
				class="mode-btn"
				class:active={mode === 'batch'}
				onclick={() => (mode = 'batch')}
			>
				Several at once
			</button>
		</div>
	</div>

	{#if mode === 'single'}
		<div class="field">
			<label class="field-label" for="pay-contact">{contactLabel}</label>
			<Select.Root
				type="single"
				value={contactId === null ? '' : String(contactId)}
				onValueChange={(next) => (contactId = next ? Number(next) : null)}
			>
				<Select.Trigger id="pay-contact" class="w-full justify-between">
					{#if contactId === null}
						Choose a person
					{:else}
						{contacts.find((contact) => contact.id === contactId)?.legalName ?? 'Choose a person'}
					{/if}
				</Select.Trigger>
				<Select.Content>
					{#each contacts as contact (contact.id)}
						<Select.Item value={String(contact.id)} label={contact.legalName} />
					{/each}
				</Select.Content>
			</Select.Root>
		</div>
	{:else}
		<p class="covers-note" style="margin-bottom:0;">
			One transfer, split across every outstanding item below — tick off what it does not cover
			yet.
		</p>
	{/if}

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
			disabled={mode === 'batch'}
			required
			class="w-full"
		/>
		{#if mode === 'batch'}
			<p class="field-hint">The sum of what is ticked below — there is nobody to put a remainder on.</p>
		{/if}
	</div>

	<div class="field">
		<label class="field-label" for="pay-date">Date *</label>
		<Input id="pay-date" type="date" bind:value={date} required class="w-full" />
	</div>

	<AccountSelect {accounts} bind:value={moneyAccountId} name="paymentAccount" label={moneyLabel} {defaultAccountId} />
</section>

<section class="detail-card">
	<div class="detail-card-head">
		<span class="detail-card-title">Allocation</span>
		{#if mode === 'batch' && items.length > 0}
			<div class="covers-bulk">
				<button type="button" class="covers-bulk-btn" onclick={selectAll}>Select all</button>
				<button type="button" class="covers-bulk-btn" onclick={selectNone}>Select none</button>
			</div>
		{/if}
	</div>

	{#if mode === 'single'}
		{#if contactId === null}
			<p class="covers-note">Choose a contact to see what is outstanding.</p>
		{:else if loading}
			<p class="covers-note">Looking…</p>
		{:else if items.length === 0}
			<p class="covers-note">Nothing is outstanding with this person.</p>
		{:else}
			<div class="covers-list">
				{#each items as item (item.movementId)}
					<div class="covers-row" class:on={isPicked(item)}>
						<label class="covers-tick">
							<input type="checkbox" checked={isPicked(item)} onchange={() => toggle(item)} />
							<span class="covers-main">
								<span class="covers-name">{item.description || 'Record'}</span>
								<span class="covers-sub">
									{formatDate(item.date)}{item.recordNumber ? ` · ${item.recordNumber}` : ''} · {formatMinor(
										item.outstandingMinor
									)} outstanding
									{#if item.daysOverdue > 0}
										· {item.daysOverdue} days late
									{/if}
								</span>
							</span>
						</label>
						{#if isPicked(item)}
							<input
								class="covers-amount"
								type="number"
								step="0.01"
								aria-label="Amount put against {item.description || 'this record'}"
								bind:value={picked[item.movementId]}
							/>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	{:else if loading}
		<p class="covers-note">Looking…</p>
	{:else if groupedItems.length === 0}
		<p class="covers-note">Nothing is outstanding with anyone.</p>
	{:else}
		{#each groupedItems as group (group.contactId)}
			<div class="covers-group">
				<span class="covers-group-title">{group.contactName}</span>
				<div class="covers-list">
					{#each group.items as item (item.movementId)}
						<div class="covers-row" class:on={isPicked(item)}>
							<label class="covers-tick">
								<input type="checkbox" checked={isPicked(item)} onchange={() => toggle(item)} />
								<span class="covers-main">
									<span class="covers-name">{item.description || 'Record'}</span>
									<span class="covers-sub">
										{formatDate(item.date)}{item.recordNumber
											? ` · ${item.recordNumber}`
											: ''} · {formatMinor(item.outstandingMinor)} outstanding
										{#if item.daysOverdue > 0}
											· {item.daysOverdue} days late
										{/if}
									</span>
								</span>
							</label>
							{#if isPicked(item)}
								<input
									class="covers-amount"
									type="number"
									step="0.01"
									aria-label="Amount put against {item.description || 'this record'}"
									bind:value={picked[item.movementId]}
								/>
							{/if}
						</div>
					{/each}
				</div>
			</div>
		{/each}
	{/if}

	{#if mode === 'single'}
		{#if allocatedMinor > 0 && unallocatedMinor > 0}
			<p class="covers-note">{formatMinor(unallocatedMinor)} of this payment is not put against anything yet.</p>
		{:else if allocatedMinor > 0}
			<p class="covers-note">This pays off {formatMinor(allocatedMinor)}.</p>
		{/if}
	{:else if allocations.length > 0}
		<p class="covers-note">
			This pays off {formatMinor(allocatedMinor)} across {allocations.length}
			{allocations.length === 1 ? 'item' : 'items'}.
		</p>
	{/if}
</section>

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
	.mode-toggle {
		display: flex;
		gap: 6px;
	}
	.mode-btn {
		flex: 1;
		padding: 7px 10px;
		border: 1px solid var(--border);
		border-radius: 7px;
		background: var(--card);
		color: var(--muted-foreground);
		font-family: inherit;
		font-size: 12.5px;
		font-weight: 500;
		cursor: pointer;
	}
	.mode-btn.active {
		border-color: var(--primary);
		background: var(--accent);
		color: var(--foreground);
	}
	.covers-bulk {
		display: flex;
		gap: 8px;
	}
	.covers-bulk-btn {
		border: none;
		background: none;
		color: var(--primary);
		font-family: inherit;
		font-size: 12px;
		font-weight: 500;
		cursor: pointer;
		padding: 0;
	}
	.covers-group {
		margin-bottom: 14px;
	}
	.covers-group:last-child {
		margin-bottom: 0;
	}
	.covers-group-title {
		display: block;
		font-size: 12px;
		font-weight: 600;
		color: var(--muted-foreground);
		margin-bottom: 6px;
	}
	.covers-amount {
		width: 92px;
		height: 30px;
		padding: 0 8px;
		border: 1px solid var(--border);
		border-radius: 7px;
		background: var(--card);
		color: var(--foreground);
		font-family: inherit;
		font-size: 13px;
		text-align: right;
		flex-shrink: 0;
	}
</style>
