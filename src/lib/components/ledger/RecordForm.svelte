<script lang="ts">
	import { tick } from 'svelte';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import ContactSelect from '$lib/components/ui/ContactSelect.svelte';
	import { X } from '@lucide/svelte';
	import { mainCurrency, mainCurrencySymbol } from '$lib/currency-state.svelte.js';
	import { formatMoneyRM } from '$lib/format.js';
	import { CURRENCIES, currencySymbol } from '$lib/currency.js';
	import { AccountSubType, AccountType, EntityType, LedgerRecordKind, Role } from '$lib/enums.js';
	import EntryBlock from './EntryBlock.svelte';
	// The running difference itself is drawn by `EntryBlock`, which owns the
	// lines it is computed from.
	import { sideMinor, whyNotSaveable, type SideDraft } from './journal-rules.js';
	import type { AccountView, RecordView } from '$lib/server/ledger/types.js';

	/**
	 * The fields that describe a record — nothing else.
	 *
	 * One definition, two frames: the create page at `/records/new`, and the
	 * editor on `/records/[id]`. Splitting the fields out this way means the
	 * two pages can never offer two different forms, and two copies of "which
	 * accounts may this side name" is two answers waiting to disagree.
	 *
	 * Writes go through `/api/records`. Labels use the standard accounting term
	 * (debit, credit, receivable, payable), with a short ASD-STE100 hint where a
	 * hint helps.
	 */
	let {
		record = null,
		accounts,
		categories,
		allAccounts = [],
		contacts = [],
		defaultAccountId = null,
		lastForeignCurrencyExpense = null,
		lastForeignCurrencyIncome = null,
		canChange = false,
		canAdjust = false,
		onsaved,
		// Write-only out-parameters: the frame around this form reads them to
		// decide whether to show a save bar and what to put on it.
		// eslint-disable-next-line no-useless-assignment
		dirty = $bindable(false),
		saving = $bindable(false),
		error = $bindable('')
	}: {
		record?: RecordView | null;
		/** Every place money sits — what "which account?" offers. */
		accounts: AccountView[];
		/** The category accounts — what a record was for, either direction. */
		categories: AccountView[];
		/** Every account, for the full list a user with `adjustments` can reach. */
		allAccounts?: AccountView[];
		contacts?: { id: number; legalName: string }[];
		defaultAccountId?: number | null;
		/** The last foreign currency this user recorded an expense in. */
		lastForeignCurrencyExpense?: string | null;
		/** The last foreign currency this user recorded income in. */
		lastForeignCurrencyIncome?: string | null;
		canChange?: boolean;
		/** Free choice of account, and a third side (FR-031). */
		canAdjust?: boolean;
		onsaved?: (record: RecordView) => void;
		dirty?: boolean;
		saving?: boolean;
		error?: string;
	} = $props();

	const isNew = $derived(record === null);
	const locked = $derived(record?.locked ?? false);
	const lockedReason = $derived(record?.lockedReason ?? '');

	// --- Form state ---------------------------------------------------------
	let date = $state('');
	let description = $state('');
	let amount = $state('');
	let reference = $state('');
	let remark = $state('');
	let contactId = $state<number | null>(null);
	/** Typed but not yet created — resolved into a real contact on save. */
	let contactName = $state<string | null>(null);
	// The two everyday questions, and the only two the form asks about accounts:
	// which account the money left, and which it went to. The kind is derived
	// from them on the server and never picked here (D-01, FR-006).
	let fromAccountId = $state<number | null>(null);
	let toAccountId = $state<number | null>(null);
	// Third and later sides, shown only with `adjustments` (FR-010).
	let extraSides = $state<SideDraft[]>([]);
	let nextSideKey = 0;
	/**
	 * The named category's own typed amount, once there is more than one —
	 * before that it simply follows the Amount field, the way it always has.
	 * A plain typed number, not a formula: the user is free to put whatever
	 * they want here, and the running difference (not this field) says
	 * whether it and the extra sides still add up to the Amount total.
	 */
	let categoryAmount = $state('');
	/**
	 * The named category's own name, once there is more than one — blank means
	 * "fall back to the record's description", the same convention as an
	 * extra side's own `label`.
	 */
	let categoryLabel = $state('');

	// --- Foreign currency, hidden until asked for --------------------------
	// A record keeps the amount exactly as it was typed, in the currency it was
	// typed in, plus the rate that applied on its date — locked at that point so
	// a historical figure never drifts when rates move (FR-005). Everything the
	// ledger totals is the converted value; this is what produces it.
	let showForeign = $state(false);
	let entryCurrency = $state('');
	let foreignAmount = $state('');
	let rate = $state('');
	let rateFetching = $state(false);
	let rateError = $state('');

	/** What the server last told us, so `dirty` has something to compare against. */
	let snapshot = $state('');

	async function seed(source: RecordView | null) {
		date = source?.date ?? new Date().toISOString().slice(0, 10);
		description = source?.description ?? '';
		amount = source ? String(source.amount) : '';
		reference = source?.reference ?? '';
		remark = source?.remark ?? '';
		contactId = source?.contactId ?? null;
		contactName = null;
		error = '';

		// An existing record opens in the currency it was recorded in, at the rate
		// it was recorded at — never re-fetched behind the user's back, because
		// that rate is part of what the record says.
		const recordedCurrency = source?.currency ?? mainCurrency();
		showForeign = recordedCurrency !== mainCurrency();
		entryCurrency = showForeign ? recordedCurrency : (preferredForeignCurrency ?? mainCurrency());
		rate = source ? String(source.exchangeRate) : '';
		foreignAmount = showForeign && source ? String(source.amount) : '';
		rateError = '';

		if (source) {
			// Value leaving an account is negative and value arriving is positive,
			// so the two sides name themselves — the same rule for every kind, with
			// no per-screen branch to get wrong. An expense somebody else paid
			// simply has Accounts Payable as its paying side, which is exactly what
			// the user picked to record it that way (FR-008).
			const into = source.movements.find((m) => m.amountMinor > 0);
			const outOf = source.movements.find((m) => m.amountMinor < 0);
			fromAccountId = outOf?.accountId ?? null;
			toAccountId = into?.accountId ?? null;

			// A record with more than two sides keeps the rest of them editable.
			const [, ...rest] = source.movements
				.filter((m) => m.accountId !== outOf?.accountId && m.accountId !== into?.accountId)
				.map((m) => m);
			extraSides = (rest.length ? rest : source.movements.slice(2)).map((m) => ({
				key: nextSideKey++,
				accountId: m.accountId,
				direction: m.amountMinor >= 0 ? ('in' as const) : ('out' as const),
				amount: (Math.abs(m.amountMinor) / 100).toFixed(2),
				label: m.label ?? ''
			}));
			// Expense's category is `into`; Income's is `outOf` (see `sidesFor`).
			// Kept even with no extra sides yet — harmless, since it is only shown
			// once there is more than one category.
			const categoryMovement =
				source.kind === LedgerRecordKind.Expense
					? into
					: source.kind === LedgerRecordKind.Income
						? outOf
						: null;
			categoryAmount = categoryMovement
				? (Math.abs(categoryMovement.amountMinor) / 100).toFixed(2)
				: '';
			categoryLabel = categoryMovement?.label ?? '';
		} else {
			fromAccountId = null;
			toAccountId = null;
			extraSides = [];
			categoryAmount = '';
			categoryLabel = '';
		}
		// AccountSelect fills a blank from/to with its default the moment it
		// mounts (FR-011) — wait for that pending update to land before taking
		// the baseline, or a freshly opened create page reads as already dirty.
		await tick();
		snapshot = fingerprint();
	}

	/** Everything the user can change, as one comparable string. */
	function fingerprint(): string {
		return JSON.stringify([
			date,
			description,
			amount,
			foreignAmount,
			rate,
			entryCurrency,
			showForeign,
			reference,
			remark,
			contactId,
			contactName,
			fromAccountId,
			toAccountId,
			categoryAmount,
			categoryLabel,
			extraSides.map((s) => [s.accountId, s.direction, s.amount, s.label])
		]);
	}

	/**
	 * Re-seeds whenever a different record arrives.
	 *
	 * Keyed on the id, not the object: the stream hands over a fresh object every
	 * time anything about the record changes, and re-seeding on that would throw
	 * away whatever the user was in the middle of typing.
	 */
	let seededId = $state<number | null | undefined>(undefined);
	$effect(() => {
		const id = record?.id ?? null;
		if (id === seededId) return;
		seededId = id;
		seed(record);
	});

	$effect(() => {
		dirty = snapshot !== '' && fingerprint() !== snapshot;
	});

	// A foreign currency is offered only on an expense or income (see
	// `looksLikeExpenseOrIncome`). Re-picking the "to" account into a transfer
	// or opening balance, say, closes the box the same way the X does, rather
	// than leaving a foreign figure attached to a kind that cannot carry one.
	$effect(() => {
		if (looksLikeExpenseOrIncome || !showForeign) return;
		// Carry over what was being shown as the main-currency figure, rather
		// than reverting to whatever `amount` last held — for a record seeded
		// from a foreign record that is still its own typed figure, in the
		// wrong currency (FR-005).
		if (convertedMain != null) amount = convertedMain.toFixed(2);
		showForeign = false;
		rate = '';
		rateError = '';
		foreignAmount = '';
	});

	export function revert(): void {
		seed(record);
	}

	const isForeign = $derived(showForeign && entryCurrency !== mainCurrency());

	/**
	 * Looks the rate up for the currency AND the date.
	 *
	 * The date matters as much as the currency: a purchase made in March is worth
	 * what March's rate said, not today's. So changing either re-queries, and the
	 * answer is only ever a starting point — the field stays editable, and a
	 * failed lookup leaves it blank with a hint rather than blocking the entry.
	 * Debounced, because both inputs change as the user types.
	 */
	$effect(() => {
		if (!isForeign || !date) return;
		const from = entryCurrency;
		const on = date;
		rateFetching = true;
		rateError = '';
		const timer = setTimeout(async () => {
			try {
				const res = await fetch(`/api/exchange-rate?from=${from}&to=${mainCurrency()}&date=${on}`);
				const body = await res.json();
				if (body.rate != null) {
					rate = String(body.rate);
				} else {
					rate = '';
					rateError = 'No rate found for that date — enter it yourself.';
				}
			} catch {
				rate = '';
				rateError = 'Could not look the rate up — enter it yourself.';
			} finally {
				rateFetching = false;
			}
		}, 400);
		return () => clearTimeout(timer);
	});

	/** What the foreign amount comes to in the main currency, at the rate shown. */
	const convertedMain = $derived.by(() => {
		const typed = parseFloat(foreignAmount);
		const r = parseFloat(rate);
		if (!isForeign || Number.isNaN(typed) || Number.isNaN(r) || r <= 0) return null;
		return typed * r;
	});

	/** A foreign entry cannot be saved without a rate to convert it by. */
	const rateMissing = $derived(isForeign && !(parseFloat(rate) > 0));

	/**
	 * What each side offers, before the full list is asked for.
	 *
	 * Money usually leaves a place it was being held and arrives at what it was
	 * for, or the other way round for a sale, so both shortlists carry both — the
	 * user is never asked which direction they are recording, only where the
	 * money came from and where it went. Accounts Payable and Accounts Receivable
	 * belong on the shortlist too: choosing one is how somebody records that
	 * another person paid, or that a customer has not yet (FR-008, FR-011).
	 */
	const sideChoices = $derived(
		[...accounts, ...categories].filter((a, i, all) => all.findIndex((b) => b.id === a.id) === i)
	);

	// Money cannot move to the account it came from, so the destination never
	// offers the source. Clearing a destination the source has just become lets
	// AccountSelect pick the next one, rather than leaving a choice sitting in a
	// picker that no longer lists it.
	const toAccountChoices = $derived(sideChoices.filter((a) => a.id !== fromAccountId));
	$effect(() => {
		if (toAccountId !== null && toAccountId === fromAccountId) toAccountId = null;
	});

	/**
	 * Whether this record looks like an everyday expense or income — the only
	 * two kinds a foreign currency is offered on (FR-005 scope). A saved record
	 * already knows its kind; an unsaved one is read off the two chosen
	 * accounts' own `type`, the same direct check the form already makes for
	 * `contactRole` below.
	 */
	const accountTypeOf = $derived(
		(accountId: number | null) =>
			accountId === null
				? null
				: (allAccounts.concat(sideChoices).find((a) => a.id === accountId)?.type ?? null)
	);

	const predictedKind = $derived.by(() => {
		if (record) return record.kind;
		const fromType = accountTypeOf(fromAccountId);
		const toType = accountTypeOf(toAccountId);
		if (fromType === AccountType.Expense || toType === AccountType.Expense) {
			return LedgerRecordKind.Expense;
		}
		if (fromType === AccountType.Revenue || toType === AccountType.Revenue) {
			return LedgerRecordKind.Income;
		}
		return null;
	});

	const looksLikeExpenseOrIncome = $derived(
		predictedKind === LedgerRecordKind.Expense || predictedKind === LedgerRecordKind.Income
	);

	/**
	 * Without `adjustments`, a third line may still be added — but only a same-
	 * type category, and never a genuine adjustment. `sides-from-accounts.ts`'s
	 * `everydayKindFor` already treats "one money side and every other side a
	 * category of the same kind" as an ordinary Expense or Income (FR-031c);
	 * offering exactly that shape here, and nothing else, is what keeps the
	 * server from ever refusing what this control lets someone build.
	 *
	 * Direction follows `entry-builder.ts`'s `twoSided()`: an expense's category
	 * is the positive/"into" side, an income's is the negative/"out of" side —
	 * so it is fixed rather than asked, the same way the two named sides' own
	 * direction already is.
	 */
	const extraSideDirection = $derived<'in' | 'out' | null>(
		predictedKind === LedgerRecordKind.Expense
			? 'in'
			: predictedKind === LedgerRecordKind.Income
				? 'out'
				: null
	);

	const extraSideAccountChoices = $derived.by((): AccountView[] => {
		if (canAdjust) return allAccounts;
		if (extraSideDirection === null) return [];
		const wantType =
			extraSideDirection === 'in' ? AccountType.Expense : AccountType.Revenue;
		const used = new Set(
			[fromAccountId, toAccountId, ...extraSides.map((s) => s.accountId)].filter(
				(id): id is number => id !== null
			)
		);
		return categories.filter((a) => a.type === wantType && !used.has(a.id));
	});

	/**
	 * Per-kind memory, so a supplier paid abroad and a customer billed abroad
	 * each keep their own last-used currency, mirroring the server's own split
	 * (`USER_PREF_KEYS.lastForeignCurrencyExpense` / `...Income`).
	 */
	const preferredForeignCurrency = $derived(
		predictedKind === LedgerRecordKind.Income
			? lastForeignCurrencyIncome ?? lastForeignCurrencyExpense
			: lastForeignCurrencyExpense ?? lastForeignCurrencyIncome
	);

	/** A record created by issuing an invoice is read-only here (FR-013). */
	const fromInvoice = $derived(record?.kind === LedgerRecordKind.InvoiceIssue);
	const readOnly = $derived(fromInvoice || locked || (!canChange && !isNew));

	/** A payment's sides are decided in the payment drawer, not restated here. */
	const isPayment = $derived(record?.kind === LedgerRecordKind.Payment);

	/**
	 * Whether this kind's category side is safe to unlock even while the money
	 * side is settled or reconciled — a settlement or a bank match never
	 * points at a category account, so correcting what the record was for
	 * cannot make either one wrong (FR-017a).
	 */
	const categoryUnlockable = $derived(
		locked &&
			canChange &&
			!fromInvoice &&
			(record?.kind === LedgerRecordKind.Expense || record?.kind === LedgerRecordKind.Income)
	);

	/** Expense's category is `toAccountId`; Income's is `fromAccountId` (see `sidesFor`). */
	const fromReadOnly = $derived(
		readOnly && !(categoryUnlockable && record?.kind === LedgerRecordKind.Income)
	);
	const toReadOnly = $derived(
		readOnly && !(categoryUnlockable && record?.kind === LedgerRecordKind.Expense)
	);

	/**
	 * A category is not itself settled or reconciled, whether it is the one
	 * named side or a third and later one — `categoryUnlockable`'s reasoning
	 * extends to every line the money was split across, not only the first.
	 */
	const extraSidesReadOnly = $derived(readOnly && !categoryUnlockable);

	// --- The running difference, live (FR-010) -------------------------------
	// The two named sides always cancel — the builder fills them from the
	// record's own figure — so only the extra sides can push it away from zero.
	const requiresContact = $derived(
		(accountId: number) =>
			allAccounts.concat(sideChoices).find((a) => a.id === accountId)?.owedContactRequired ?? false
	);

	const typedAmount = $derived(
		isForeign ? parseFloat(foreignAmount || '0') : parseFloat(amount || '0')
	);

	/** The record's own figure in cents — what both named sides are worth. */
	const mainAmountMinor = $derived(Math.round(Math.abs(typedAmount || 0) * 100));

	/**
	 * The named category's own typed share once extras exist — `categoryAmount`
	 * itself, not derived from the total. The other named side is always the
	 * money side and keeps the record's whole figure.
	 */
	const typedCategoryAmount = $derived(parseFloat(categoryAmount || '0'));
	const primaryAmountMinor = $derived(
		extraSides.length > 0
			? Math.round(Math.abs(typedCategoryAmount || 0) * 100)
			: mainAmountMinor
	);

	const allSides = $derived.by((): SideDraft[] => {
		const fromMinor = extraSideDirection === 'out' ? primaryAmountMinor : mainAmountMinor;
		const toMinor = extraSideDirection === 'in' ? primaryAmountMinor : mainAmountMinor;
		return [
			{ key: -1, accountId: fromAccountId, direction: 'out' as const, amount: (fromMinor / 100).toFixed(2), label: '' },
			{ key: -2, accountId: toAccountId, direction: 'in' as const, amount: (toMinor / 100).toFixed(2), label: '' },
			...extraSides
		];
	});

	/** Why this cannot be saved yet, in the words the server would use. */
	const blockedReason = $derived(
		extraSides.length > 0 ? whyNotSaveable(allSides, requiresContact, contactId) : null
	);

	/** What the frame around this form shows above its Save button. */
	export function blockedBy(): string | null {
		if (rateMissing) return 'Enter the exchange rate before saving.';
		return blockedReason;
	}

	function addSide() {
		// The first line the named category still gets the whole Amount, so
		// this is the moment it stops following that field and starts being its
		// own typed number — seeded from what it already showed, so nothing
		// visibly changes until the user actually edits either figure.
		if (extraSides.length === 0) categoryAmount = (mainAmountMinor / 100).toFixed(2);
		const direction = canAdjust ? 'in' : (extraSideDirection ?? 'in');
		extraSides = [...extraSides, { key: nextSideKey++, accountId: null, direction, amount: '', label: '' }];
	}

	function removeSide(key: number) {
		extraSides = extraSides.filter((side) => side.key !== key);
	}

	/**
	 * Whether either named side is a shared owed account.
	 *
	 * Choosing Accounts Payable as the paying side is how somebody records that
	 * another person paid for this, and choosing Accounts Receivable is how a sale
	 * not yet settled is recorded. Either way the record is owed to or by
	 * somebody, and saving it without saying who would leave a balance owed to
	 * nobody — so the same sentence the server refuses with is shown here first
	 * (FR-008, FR-011).
	 */
	const needsContact = $derived.by(() => {
		for (const id of [fromAccountId, toAccountId]) {
			if (id === null) continue;
			if (requiresContact(id)) return true;
		}
		return false;
	});

	/**
	 * Which kind of contact this record's shape calls for.
	 *
	 * There is no upfront "kind" picker here (D-01), so this reads the same two
	 * chosen sides `needsContact` does: a category names what the money was for
	 * (an expense category → a supplier, an income category → a customer), and a
	 * shared owed account with no category side names who it is owed to or by
	 * the same way (FR-008, FR-011).
	 */
	const contactRole = $derived.by(() => {
		const categoryId = [fromAccountId, toAccountId].find(
			(id) => id !== null && categories.some((c) => c.id === id)
		);
		const category = categories.find((c) => c.id === categoryId);
		if (category?.type === AccountType.Expense) return Role.Supplier;
		if (category?.type === AccountType.Revenue) return Role.Customer;

		const list = allAccounts.concat(sideChoices);
		for (const id of [fromAccountId, toAccountId]) {
			if (id === null) continue;
			const subType = list.find((a) => a.id === id)?.subType;
			if (subType === AccountSubType.Receivable) return Role.Customer;
			if (subType === AccountSubType.AccountsPayable) return Role.Supplier;
		}
		return Role.Customer;
	});

	/** `ContactSelect` starts blank until it has fetched anything itself. */
	const contactInitialLabel = $derived(record?.contactName ?? null);

	/** The body the records API expects, in the everyday terms of this screen. */
	function payload() {
		// The record keeps what was actually typed — the foreign figure and its
		// currency — plus the rate that turns it into the main currency. The
		// ledger converts once, from these (FR-005).
		const base = {
			date,
			description,
			amount: isForeign ? parseFloat(foreignAmount || '0') : parseFloat(amount || '0'),
			currency: isForeign ? entryCurrency : mainCurrency(),
			exchangeRate: isForeign ? parseFloat(rate) : 1,
			reference,
			remark,
			contactId
		};
		// Two accounts and no kind. The server derives which of the seven shapes
		// this is from the two accounts named, and refuses with a plain sentence
		// if they do not make one (D-01, FR-009).
		return {
			...base,
			fromAccountId,
			toAccountId,
			...(extraSides.length > 0
				? {
						extraSides: extraSides.map((side) => ({
							accountId: side.accountId,
							amountMinor: sideMinor(side),
							label: side.label.trim() || null
						})),
						categoryAmountMinor: primaryAmountMinor,
						categoryLabel: categoryLabel.trim() || null
					}
				: {})
		};
	}

	/** The fields a patch may carry: everything on a free record, the rest on a locked one. */
	function patchPayload() {
		const everyday = { description, reference, remark, contactId };
		// A locked record refuses its amount, date and the account it moved
		// through, and a payment is described by the payment drawer, which is
		// where its direction and what it covers are decided. This form only
		// reads one back, so it never tries to restate its sides (FR-012).
		if (locked || isPayment) {
			// The category side is not itself settled or reconciled — only the
			// money side is — so it stays editable, and a corrected
			// miscategorization (or a first split, or a bigger or smaller one) is
			// sent on its own rather than restating both accounts (FR-017a).
			if (categoryUnlockable) {
				return {
					...everyday,
					categoryAccountId:
						record?.kind === LedgerRecordKind.Expense ? toAccountId : fromAccountId,
					extraSides: extraSides.map((side) => ({
						accountId: side.accountId,
						amountMinor: sideMinor(side),
						label: side.label.trim() || null
					})),
					categoryAmountMinor: primaryAmountMinor,
					categoryLabel: categoryLabel.trim() || null
				};
			}
			return everyday;
		}

		return {
			...everyday,
			date,
			amount: isForeign ? parseFloat(foreignAmount || '0') : parseFloat(amount || '0'),
			currency: isForeign ? entryCurrency : mainCurrency(),
			exchangeRate: isForeign ? parseFloat(rate) : 1,
			// Both accounts, so the server re-derives the kind: an expense whose
			// paying side becomes another bank account really is a transfer now.
			fromAccountId,
			toAccountId,
			// Restated here too, or a record split across more than one category
			// would lose every line but the first, and the category's own typed
			// share, the moment anything else about it was edited.
			...(extraSides.length > 0
				? {
						extraSides: extraSides.map((side) => ({
							accountId: side.accountId,
							amountMinor: sideMinor(side),
							label: side.label.trim() || null
						})),
						categoryAmountMinor: primaryAmountMinor,
						categoryLabel: categoryLabel.trim() || null
					}
				: {})
		};
	}

	/** Saves, and reports whether it went through. The frame decides what to do next. */
	export async function submit(): Promise<RecordView | null> {
		if (saving) return null;
		saving = true;
		error = '';

		if (!contactId && contactName) {
			const created = await fetch('/api/contacts', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					entityType: EntityType.Business,
					legalName: contactName,
					roles: [contactRole]
				})
			});
			if (!created.ok) {
				saving = false;
				error = 'Could not create that contact — try again.';
				return null;
			}
			contactId = (await created.json()).id;
			contactName = null;
		}

		const res = await fetch(record ? `/api/records/${record.id}` : '/api/records', {
			method: record ? 'PATCH' : 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(record ? patchPayload() : payload())
		});

		saving = false;
		if (!res.ok) {
			const body = await res.json().catch(() => null);
			error = body?.reason ?? body?.error ?? 'That could not be saved.';
			return null;
		}
		const saved: RecordView = await res.json();
		snapshot = fingerprint();
		onsaved?.(saved);
		return saved;
	}
</script>

{#if error}
	<div class="form-error">{error}</div>
{/if}

{#if fromInvoice}
	<!-- A record with no everyday name of its own: it was created by issuing an
	     invoice, and it changes when that invoice does (FR-013). -->
	<p class="locked-note">
		This record was created by issuing an invoice. Change it on the invoice instead.
	</p>
{:else if locked}
	<p class="locked-note">{lockedReason}</p>
{/if}

<section class="detail-card">
	<div class="detail-card-head"><span class="detail-card-title">Transaction details</span></div>

	<div class="field">
		<label class="field-label" for="rec-description">Description *</label>
		<Input
			id="rec-description"
			bind:value={description}
			required
			maxlength={500}
			disabled={!canChange && !isNew}
			class="w-full"
		/>
	</div>

	<div class="field-grid">
		<div class="field">
			<div class="amount-head">
				<label class="field-label" for="rec-amount">Amount ({mainCurrencySymbol()}) *</label>
			</div>

			{#if isForeign}
				<Input
					id="rec-amount"
					type="text"
					value={convertedMain != null ? convertedMain.toFixed(2) : ''}
					disabled
					readonly
					class="w-full"
				/>
			{:else}
				<Input
					id="rec-amount"
					type="number"
					step="0.01"
					bind:value={amount}
					required
					disabled={readOnly}
					class="w-full"
				/>
			{/if}
		</div>

		<div class="field">
			<label class="field-label" for="rec-date">Date *</label>
			<Input
				id="rec-date"
				type="date"
				bind:value={date}
				required
				disabled={readOnly}
				class="w-full"
			/>
		</div>
	</div>

	{#if looksLikeExpenseOrIncome && !readOnly && !showForeign}
		<button
			type="button"
			class="detail-card-action"
			onclick={() => {
				showForeign = true;
				if (entryCurrency === mainCurrency()) {
					entryCurrency = preferredForeignCurrency ?? '';
				}
			}}
		>
			+ Foreign currency
		</button>
	{/if}

	{#if showForeign}
		<div class="foreign-box">
			<div class="foreign-box-head">
				<span class="foreign-box-title">Foreign currency</span>
				{#if !readOnly}
					<button
						type="button"
						class="foreign-box-close"
						aria-label="Remove foreign currency"
						onclick={() => {
							// Carry over what was being shown as the main-currency figure,
							// so undoing "foreign" does not silently swap the amount back
							// to a stale, wrongly-denominated figure.
							if (convertedMain != null) amount = convertedMain.toFixed(2);
							showForeign = false;
							rate = '';
							rateError = '';
							foreignAmount = '';
						}}
					>
						<X size={14} />
					</button>
				{/if}
			</div>

			<div class="field">
				<label class="field-label" for="rec-currency">Currency</label>
				<Select.Root
					type="single"
					value={entryCurrency}
					onValueChange={(next) => next && (entryCurrency = next)}
				>
					<Select.Trigger id="rec-currency" class="w-full justify-between" disabled={readOnly}>
						{@const c = CURRENCIES.find((c) => c.code === entryCurrency)}
						{c ? `${c.code} — ${c.name}` : 'Select currency'}
					</Select.Trigger>
					<Select.Content>
						{#each CURRENCIES as c (c.code)}
							<Select.Item value={c.code} label={`${c.code} — ${c.name}`} />
						{/each}
					</Select.Content>
				</Select.Root>
			</div>

			<div class="field">
				<label class="field-label" for="rec-foreign-amount">Amount ({entryCurrency})</label>
				<div class="foreign-amount-row">
					<span class="foreign-amount-symbol">{currencySymbol(entryCurrency)}</span>
					<Input
						id="rec-foreign-amount"
						type="number"
						step="0.01"
						bind:value={foreignAmount}
						required
						disabled={readOnly}
						class="w-full"
					/>
				</div>
			</div>

			<div class="field" style="margin-bottom:0;">
				<label class="field-label" for="rec-rate">
					Rate (1 {entryCurrency} = ? {mainCurrency()}) *
				</label>
				<Input
					id="rec-rate"
					type="number"
					step="0.000001"
					bind:value={rate}
					required
					disabled={readOnly}
					class="w-full"
				/>
				<p class="field-hint">
					{#if rateFetching}
						Looking up the rate for {date}…
					{:else if rateError}
						{rateError}
					{:else if convertedMain != null}
						Comes to {formatMoneyRM(convertedMain)}. Looked up for {date} and kept with the
						record, so it stays right when rates move.
					{:else}
						The rate on the record's own date. Change the date and it is looked up again.
					{/if}
				</p>
			</div>
		</div>
	{/if}
</section>

<!-- The two sides, and the rule that they cancel. -->
<EntryBlock
	bind:fromAccountId
	bind:toAccountId
	bind:extraSides
	bind:categoryAmount
	bind:categoryLabel
	{sideChoices}
	{toAccountChoices}
	{allAccounts}
	{canAdjust}
	canAddSide={canAdjust || looksLikeExpenseOrIncome}
	{extraSidesReadOnly}
	{extraSideAccountChoices}
	{extraSideDirection}
	{defaultAccountId}
	{readOnly}
	fromDisabled={fromReadOnly}
	toDisabled={toReadOnly}
	{mainAmountMinor}
	onaddside={addSide}
	onremoveside={removeSide}
/>

<section class="detail-card">
	<div class="detail-card-head"><span class="detail-card-title">Details</span></div>

	{#if needsContact && isPayment && contactId === null}
		<!-- A batch payment names no single contact — each settlement it created
		     points at its own instead. Set once, at creation; not editable here. -->
		<div class="field">
			<span class="field-label">Contact</span>
			<p class="field-hint" style="margin-top:0;">
				Batch payment: allocated to several contacts. See the list below.
			</p>
		</div>
	{:else if needsContact}
		<!-- A side on a shared owed account is meaningless without saying whose it
		     is — the balance would be owed to nobody (FR-008). -->
		<div class="field">
			<label class="field-label" for="rec-contact">Contact *</label>
			<ContactSelect
				role={contactRole}
				bind:value={contactId}
				bind:newName={contactName}
				initialLabel={contactInitialLabel}
				disabled={isPayment || (!canChange && !isNew)}
				placeholder="Search or create a contact…"
			/>
			{#if contactId === null && !contactName}
				<p class="field-hint">Select the customer (receivable) or supplier (payable).</p>
			{/if}
		</div>
	{:else if contacts.length > 0}
		<div class="field">
			<label class="field-label" for="rec-contact">Contact</label>
			<ContactSelect
				role={contactRole}
				bind:value={contactId}
				bind:newName={contactName}
				initialLabel={contactInitialLabel}
				disabled={!canChange && !isNew}
				placeholder="Search or create a contact…"
			/>
		</div>
	{/if}

	<div class="field">
		<label class="field-label" for="rec-reference">Reference</label>
		<Input
			id="rec-reference"
			bind:value={reference}
			maxlength={200}
			disabled={!canChange && !isNew}
			class="w-full"
		/>
	</div>

	<div class="field" style="margin-bottom:0;">
		<label class="field-label" for="rec-remark">Remark</label>
		<Textarea
			id="rec-remark"
			bind:value={remark}
			rows={2}
			disabled={!canChange && !isNew}
			class="leading-relaxed"
		/>
	</div>
</section>

<style>
	.form-error {
		background: var(--red-soft);
		color: var(--red);
		border-radius: 8px;
		padding: 10px 12px;
		font-size: 13px;
		margin-bottom: 14px;
	}
	.locked-note {
		background: var(--muted);
		color: var(--muted-foreground);
		border-radius: 8px;
		padding: 10px 12px;
		font-size: 12.5px;
		line-height: 1.5;
		margin: 0 0 14px;
	}
	.amount-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	.foreign-box {
		margin-top: 14px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--muted);
		padding: 14px;
	}
	.foreign-box-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 12px;
	}
	.foreign-box-title {
		font-size: 12px;
		font-weight: 600;
		color: var(--foreground);
	}
	.foreign-box-close {
		display: grid;
		place-items: center;
		width: 22px;
		height: 22px;
		border: none;
		background: none;
		border-radius: 6px;
		color: var(--muted-foreground);
		cursor: pointer;
	}
	.foreign-box-close:hover {
		background: var(--accent);
		color: var(--destructive);
	}
	.foreign-amount-row {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.foreign-amount-symbol {
		font-size: 13.5px;
		color: var(--muted-foreground);
		min-width: 1.2em;
		text-align: center;
	}
</style>
