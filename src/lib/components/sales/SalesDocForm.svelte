<script lang="ts" generics="K extends SalesDocKind">
	import ContactSelect from '$lib/components/ui/ContactSelect.svelte';
	import LineItemEditor from '$lib/components/ui/LineItemEditor.svelte';
	import DatePicker from '$lib/components/ui/date-picker/DatePicker.svelte';
	import * as Select from '$lib/components/ui/select/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import { mainCurrency } from '$lib/currency-state.svelte.js';
	import { CURRENCIES } from '$lib/currency.js';
	import { EntityType } from '$lib/enums.js';
	import { addDaysISO, daysBetweenISO, localToday } from '$lib/local-date.js';
	import { isQuotationSealed } from '$lib/sales/status.js';
	import {
		SALES_DOC_KINDS,
		secondDateOf,
		type Invoice,
		type Quotation,
		type SalesDoc,
		type SalesDocKind
	} from './sales-doc-kinds.js';

	/**
	 * The fields that describe a quotation or an invoice — nothing else.
	 *
	 * One definition, four frames: the create pages at `/quotations/new` and
	 * `/invoices/new`, and the editors on their detail pages. The two kinds
	 * were separate, line-for-line copies that differed only in what
	 * `SALES_DOC_KINDS` now holds — the same risk `RecordForm` exists to avoid
	 * for records, applied here for the same reason.
	 *
	 * A sent invoice or quotation is **sealed**: the customer has a copy (and an
	 * invoice's amount is in the books), so the customer, issue date, currency,
	 * rate and lines are shown but cannot change, and only the wording around
	 * them and the second date are sent. The server refuses the rest anyway
	 * (`SEALED_SALES_FIELDS`); sending it made every edit of a sent one fail.
	 */
	type LineInput = { description: string; quantity: number; unitPrice: number };

	let {
		kind,
		doc = null,
		// Days from the issue date a new document's second date starts at; null
		// leaves it empty. Ignored when editing (`doc` set).
		defaultDays = null,
		// Write-only out-parameters: the frame around this form reads them to
		// decide whether to show a save bar and what to put on it.
		// eslint-disable-next-line no-useless-assignment
		dirty = $bindable(false),
		// eslint-disable-next-line no-useless-assignment
		saving = $bindable(false),
		// The hosting page shows this near the hero, not this form itself.
		// eslint-disable-next-line no-useless-assignment
		error = $bindable('')
	}: {
		kind: K;
		doc?: SalesDoc<K> | null;
		defaultDays?: number | null;
		dirty?: boolean;
		saving?: boolean;
		error?: string;
	} = $props();

	const cfg = $derived(SALES_DOC_KINDS[kind]);
	// The conditional `SalesDoc<K>` is for callers; inside, either shape will do.
	const source = $derived(doc as Invoice | Quotation | null);
	const isNew = $derived(source === null);
	const sealed = $derived(
		source !== null &&
			('ledgerRecordId' in source ? source.ledgerRecordId !== null : isQuotationSealed(source))
	);
	const id = (name: string) => `${cfg.idPrefix}-${name}`;

	let issueDate = $state('');
	// The due date (invoice) or expiry date (quotation).
	let secondDate = $state('');
	let contactId = $state<number | null>(null);
	let contactName = $state<string | null>(null);
	let currency = $state('');
	let exchangeRate = $state('1');
	let notes = $state('');
	let terms = $state('');
	let reference = $state('');
	let lines = $state<LineInput[]>([]);
	let rateFetching = $state(false);
	let rateError = $state('');
	// Bumped by every seed, so the contact picker (which keeps its own label)
	// starts again from the document's customer on a revert.
	let seedCount = $state(0);

	/**
	 * The payment term the second date follows, in days after the issue date.
	 * The screen's own state, never saved: what is saved is the date. While it
	 * is set, moving the issue date moves the second date with it.
	 */
	let termDays = $state<number | null>(null);

	/** The quick-pick a gap of `days` is, if it is one. */
	function chipFor(days: number): number | null {
		return cfg.terms.some((t) => t.days === days) ? days : null;
	}

	function pickTerm(days: number) {
		if (!issueDate) return;
		termDays = days;
		secondDate = addDaysISO(issueDate, days);
	}

	// The date picker has no way to empty itself, so this is how a due date or
	// an expiry, once set, is taken off again.
	function clearSecondDate() {
		termDays = null;
		secondDate = '';
	}

	function onIssueDateChange(v: string) {
		if (termDays !== null && v) secondDate = addDaysISO(v, termDays);
	}

	// A date picked by hand is a term only if it lands on a quick-pick.
	function onSecondDateChange(v: string) {
		termDays = v && issueDate ? chipFor(daysBetweenISO(issueDate, v)) : null;
	}

	let snapshot = $state('');
	function fingerprint(): string {
		// A sealed document sends only these four, so only these can make it dirty.
		if (sealed) return JSON.stringify([secondDate, notes, terms, reference]);
		return JSON.stringify([
			issueDate,
			secondDate,
			contactId,
			contactName,
			currency,
			exchangeRate,
			notes,
			terms,
			reference,
			lines
		]);
	}
	function seed(from: Invoice | Quotation | null) {
		// The user's own calendar day, not UTC's (see `$lib/local-date.ts`).
		issueDate = from?.issueDate ?? localToday();
		if (from) {
			secondDate = secondDateOf(from) ?? '';
			termDays = secondDate ? chipFor(daysBetweenISO(issueDate, secondDate)) : null;
		} else {
			// The default term may be one with no quick-pick (45 days, say); it
			// still follows the issue date, it just has no chip to light up.
			secondDate = defaultDays === null ? '' : addDaysISO(issueDate, defaultDays);
			termDays = defaultDays;
		}
		contactId = from?.contactId ?? null;
		contactName = null;
		currency = from?.currency ?? mainCurrency();
		exchangeRate = from ? String(from.exchangeRate) : '1';
		notes = from?.notes ?? '';
		terms = from?.terms ?? '';
		reference = from?.reference ?? '';
		lines = from
			? from.lines.map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unitPrice }))
			: [{ description: '', quantity: 1, unitPrice: 0 }];
		rateError = '';
		error = '';
		seedCount += 1;
		snapshot = fingerprint();
	}
	// Re-seeds if a different document ever arrives without a remount (keyed
	// on id, not the object, the same guard `RecordForm` uses).
	let seededId = $state<number | null | undefined>(undefined);
	$effect(() => {
		const docId = source?.id ?? null;
		if (docId === seededId) return;
		seededId = docId;
		seed(source);
	});

	$effect(() => {
		dirty = snapshot !== '' && fingerprint() !== snapshot;
	});

	export function revert(): void {
		seed(source);
	}

	/**
	 * Looked up only while creating. An existing document keeps the rate it
	 * was written at — editing never re-fetches it behind the user's back.
	 */
	$effect(() => {
		if (!isNew) return;
		const cur = currency;
		const d = issueDate;
		if (cur === mainCurrency() || !d) {
			exchangeRate = '1';
			rateError = '';
			return;
		}
		rateFetching = true;
		rateError = '';
		const timer = setTimeout(async () => {
			try {
				const res = await fetch(`/api/exchange-rate?from=${cur}&to=${mainCurrency()}&date=${d}`);
				const json = await res.json();
				if (json.rate != null) exchangeRate = String(json.rate);
				else rateError = 'No rate found — enter manually';
			} catch {
				rateError = 'Could not fetch rate — enter manually';
			} finally {
				rateFetching = false;
			}
		}, 400);
		return () => clearTimeout(timer);
	});

	export function blockedBy(): string | null {
		// What a sealed document could be blocked on is fixed, and was fine when sent.
		if (sealed) return null;
		if (!contactId && !contactName) return 'Choose a customer.';
		if (!lines.some((l) => l.description.trim())) return 'Add at least one line item.';
		// A blank line is dropped on save; one with a price is not blank, and
		// dropping it would quietly change the total.
		if (lines.some((l) => !l.description.trim() && l.unitPrice))
			return 'Give every priced line a description.';
		const rate = parseFloat(exchangeRate);
		if (exchangeRate.trim() && !(rate > 0)) return 'The exchange rate must be more than zero.';
		return null;
	}

	function payload(resolvedContactId: number | null): Record<string, unknown> {
		const wording = {
			[cfg.dateField]: secondDate || null,
			notes: notes || null,
			terms: terms || null,
			reference: reference || null
		};
		if (sealed) return wording;
		return {
			...wording,
			issueDate,
			contactId: resolvedContactId,
			currency,
			exchangeRate: parseFloat(exchangeRate) || 1,
			// The server refuses a line with no description.
			lines: lines.filter((l) => l.description.trim())
		};
	}

	export async function submit(): Promise<SalesDoc<K> | null> {
		const reason = blockedBy();
		if (reason) {
			error = reason;
			return null;
		}
		saving = true;
		error = '';
		try {
			let resolvedContactId = contactId;
			if (!sealed && !resolvedContactId && contactName) {
				const cr = await fetch('/api/contacts', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ entityType: EntityType.Business, legalName: contactName, roles: [cfg.contactRole] })
				});
				if (!cr.ok) {
					error = 'Failed to create contact — try again';
					return null;
				}
				resolvedContactId = (await cr.json()).id;
			}
			const res = await fetch(isNew ? cfg.apiBase : `${cfg.apiBase}/${source!.id}`, {
				method: isNew ? 'POST' : 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload(resolvedContactId))
			});
			if (!res.ok) {
				const body = await res.json().catch(() => null);
				error = body?.error ?? (isNew ? `Failed to create ${cfg.noun.toLowerCase()}` : 'Save failed');
				return null;
			}
			const saved = await res.json();
			snapshot = fingerprint();
			return saved;
		} catch {
			error = 'Network error — try again';
			return null;
		} finally {
			saving = false;
		}
	}
</script>

{#if sealed}
	<!-- Same reason, and the same way out, as the server gives for refusing them. -->
	<p class="locked-note">
		{#if kind === 'invoice'}
			This invoice has been sent, so its customer, date, currency and line items are fixed. To
			change them, use Cancel &amp; reissue. The due date, reference, notes and terms can still
			change.
		{:else}
			This quotation has gone to the customer, so its customer, date, currency and line items are
			fixed. To change them, use Revise. The expiry date, reference, notes and terms can still
			change.
		{/if}
	</p>
{/if}

<section class="detail-card">
	<div class="detail-card-head"><span class="detail-card-title">{cfg.noun}</span></div>

	<div class="field-grid field">
		<div>
			<label class="field-label" for={id('issue-date')}>Issue date *</label>
			<DatePicker
				name="issueDate"
				bind:value={issueDate}
				onchange={onIssueDateChange}
				disabled={sealed}
			/>
		</div>
		<div>
			<label class="field-label" for={id('second-date')}>{cfg.dateLabel}</label>
			<DatePicker
				name={cfg.dateField}
				bind:value={secondDate}
				onchange={onSecondDateChange}
				placeholder={cfg.datePlaceholder}
			/>
			<div class="seg sm term-chips" role="group" aria-label={cfg.termsLabel}>
				<button
					type="button"
					class="seg-btn"
					class:active={!secondDate}
					aria-pressed={!secondDate}
					title={cfg.datePlaceholder}
					onclick={clearSecondDate}
				>
					None
				</button>
				{#each cfg.terms as t (t.days)}
					<button
						type="button"
						class="seg-btn"
						class:active={termDays === t.days}
						aria-pressed={termDays === t.days}
						title={t.title}
						onclick={() => pickTerm(t.days)}
					>
						{t.label}
					</button>
				{/each}
			</div>
		</div>
	</div>

	<div class="field">
		<label class="field-label" for={id('customer')}>Customer</label>
		{#key seedCount}
			<ContactSelect
				role={cfg.contactRole}
				bind:value={contactId}
				bind:newName={contactName}
				initialLabel={source?.contactName ?? null}
				disabled={sealed}
				placeholder="Search or select a customer…"
			/>
		{/key}
	</div>

	<div class="field-grid field">
		<div>
			<label class="field-label" for={id('currency')}>Currency</label>
			<Select.Root type="single" bind:value={currency}>
				<Select.Trigger id={id('currency')} class="w-full" disabled={sealed}>{currency}</Select.Trigger>
				<Select.Content>
					{#each CURRENCIES as c (c.code)}
						<Select.Item value={c.code} label={`${c.code} — ${c.name}`} />
					{/each}
				</Select.Content>
			</Select.Root>
		</div>
		{#if currency !== mainCurrency()}
			<div>
				<label class="field-label" for={id('rate')}>Rate (1 {currency} = ? {mainCurrency()})</label>
				<Input
					id={id('rate')}
					type="text"
					inputmode="decimal"
					placeholder={isNew && rateFetching ? 'Fetching…' : '1.0'}
					disabled={sealed || (isNew && rateFetching)}
					bind:value={exchangeRate}
				/>
				{#if isNew && (rateFetching || rateError)}
					<p class="foreign-note">{rateFetching ? 'Fetching rate…' : rateError}</p>
				{/if}
			</div>
		{/if}
	</div>

	<div class="field" style="margin-bottom:0;">
		<label class="field-label" for={id('reference')}>Reference</label>
		<Input id={id('reference')} type="text" placeholder="Optional reference…" bind:value={reference} />
	</div>
</section>

<section class="detail-card">
	<div class="detail-card-head"><span class="detail-card-title">Line items *</span></div>
	<LineItemEditor bind:lines currency={currency} disabled={sealed} />
</section>

<section class="detail-card">
	<div class="detail-card-head"><span class="detail-card-title">Notes and terms</span></div>
	<div class="field">
		<label class="field-label" for={id('notes')}>Notes</label>
		<Textarea id={id('notes')} placeholder="Optional notes for the customer…" class="leading-relaxed" bind:value={notes} />
	</div>
	<div class="field" style="margin-bottom:0;">
		<label class="field-label" for={id('terms')}>Terms &amp; conditions</label>
		<Textarea id={id('terms')} placeholder="Optional terms…" class="leading-relaxed" bind:value={terms} />
	</div>
</section>

<style>
	.locked-note {
		background: var(--muted);
		color: var(--muted-foreground);
		border-radius: 8px;
		padding: 10px 12px;
		font-size: 12.5px;
		line-height: 1.5;
		margin: 0 0 14px;
	}
	/* The shared segmented control, a little tighter, and allowed to wrap when
	   the date column is narrow (a phone, or the detail page's main column). */
	.term-chips {
		display: flex;
		flex-wrap: wrap;
		width: fit-content;
		max-width: 100%;
		margin-top: 6px;
	}
	.term-chips .seg-btn {
		padding: 3px 8px;
		font-size: 12px;
	}
</style>
