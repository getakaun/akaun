<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { SvelteSet, SvelteURLSearchParams } from 'svelte/reactivity';
	import { goto, invalidateAll, replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { AlertTriangle, Check, ChevronDown, ChevronRight, ExternalLink, FileText, RotateCcw, Trash2 } from '@lucide/svelte';
	import DetailPage from '$lib/components/ui/DetailPage.svelte';
	import Disclosure from '$lib/components/ui/Disclosure.svelte';
	import StatusBadge from '$lib/components/ui/StatusBadge.svelte';
	import BulkActionBar from '$lib/components/ui/BulkActionBar.svelte';
	import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import ImportReviewCard from './ImportReviewCard.svelte';
	import ReadAgainDialog from './ReadAgainDialog.svelte';
	import { createResourceStream } from '$lib/sse.js';
	import { ImportState, importStateEnum } from '$lib/enums.js';
	import { ignoredSummary, parseExtractionNotes } from '$lib/import-reading.js';
	import { mainCurrency } from '$lib/currency-state.svelte.js';
	import { currencySymbol, formatCurrency } from '$lib/currency.js';
	import { formatDateShort } from '$lib/format.js';
	import {
		describeControlTotal,
		describeReading,
		extraFieldsShown,
		dupMessage,
		formatMoney,
		isTransferRow,
		itemSides,
		readAsOfJob,
		readingLabel,
		reviewRowFrom,
		targetAfterSourceChange,
		type ReviewEdits,
		type ReviewOptions,
		type ReviewRow
	} from './review-card.js';
	import type { AccountView } from '$lib/server/ledger/types.js';
	import type { ImportItemEvent, ImportJobEvent } from '$lib/server/import/job-event.js';
	import type { loadImportDetail } from '$lib/server/loaders/import.js';

	/**
	 * One document read as several items: its page (006 User Story 4).
	 *
	 * The table lists every item the document gave, and each one opens in place
	 * as the same review card a receipt has. The group's own actions — one
	 * account for every item, confirm all, skip all — sit above the table, and
	 * the actions on a selection sit in the bar at the bottom, as on the Records
	 * screen.
	 *
	 * Unlike a receipt, whose corrections stay in the browser until it is
	 * confirmed, every correction to an item is saved on the server as it is
	 * made. A group of hundreds can then be worked through over several visits
	 * and from several tabs, and what this page shows is always what is saved.
	 * Every change made anywhere arrives as a live update on the import stream
	 * (FR-047).
	 *
	 * Whether an item needs attention, and why, is worked out on the server and
	 * sent with the item. Nothing here copies that rule.
	 */
	type PageData = ReturnType<typeof loadImportDetail>;
	let { data }: { data: PageData } = $props();

	type Item = ReviewRow & {
		state: string;
		position: number;
		sourceLine: number | null;
		/** The profile section it was read from (006 FR-017). */
		sectionKey: string;
		feeType: string | null;
		/** The profile's extra fields for this line, as "name: value" (FR-035). */
		extras: string[];
		resultId: number | null;
		/** Why a confirm-all would leave this item behind, or null. */
		attention: string | null;
	};

	function normalizeItem(raw: ImportItemEvent): Item {
		return {
			...reviewRowFrom(raw),
			state: importStateEnum.toLabel(raw.state) ?? 'pending_review',
			position: raw.position,
			sourceLine: raw.sourceLine ?? null,
			sectionKey: raw.sectionKey,
			feeType: raw.feeType ?? null,
			extras: extraFieldsShown(raw.extrasJson),
			resultId: raw.resultId ?? null,
			attention: raw.attention ?? null
		};
	}

	// What the server sent, until the stream says otherwise. Writable, so a live
	// update edits it in place; derived, so a navigation to another group starts
	// again from that group's own answer.
	let job = $derived<ImportJobEvent>(data.job);
	let items = $derived<Item[]>(data.items.map(normalizeItem));

	const options = $derived<ReviewOptions>({
		allAccounts: data.allAccounts,
		categoryAccounts: data.categoryAccounts,
		transferAccounts: data.transferAccounts,
		payableAccountId: data.payableAccountId,
		receivableAccountId: data.receivableAccountId,
		uncategorisedAccountId: data.uncategorisedAccountId,
		uncategorisedIncomeAccountId: data.uncategorisedIncomeAccountId
	});
	const canChange = $derived(data.perms.change);

	// ── Reading an item ────────────────────────────────────────────────────────
	const isWaiting = (item: Item) => item.state === 'pending_review';
	const isDone = (item: Item) => item.state === 'imported' || item.state === 'confirmed';

	function statusOf(item: Item): string {
		if (isDone(item)) return 'import-confirmed';
		if (item.state === 'skipped') return 'import-skipped';
		return item.attention ? 'import-attention' : 'import-ready';
	}

	/** What an item becomes: an expense, an income, or a transfer (FR-058). */
	type Kind = 'expense' | 'income' | 'transfer';
	function kindOf(item: Pick<Item, 'documentType'>): Kind {
		if (isTransferRow(item)) return 'transfer';
		return item.documentType === 'income' ? 'income' : 'expense';
	}
	const KINDS: Kind[] = ['expense', 'income', 'transfer'];
	const KIND_LABELS: Record<Kind, string> = { expense: 'Expense', income: 'Income', transfer: 'Transfer' };

	/**
	 * What the Category column says. A transfer has no category, so it names its
	 * other account there, and which way the money went (FR-058).
	 */
	function categoryCell(item: Item): string {
		if (!isTransferRow(item)) return item.category || '—';
		const other = accountName(item.counterAccountId);
		if (!other) return '—';
		return item.documentType === 'transfer_in' ? `From ${other}` : `To ${other}`;
	}

	function itemTitle(item: Item): string {
		return item.itemName || (item.sourceLine != null ? `Line ${item.sourceLine}` : `Item ${item.position + 1}`);
	}

	// The sections of the profile the document was read with, as they were
	// then (FR-017, FR-038). Empty for the built-in reading, whose one section
	// has no name of its own. With one section, its name says nothing new.
	const sectionNames = $derived(new Map(data.sections.map((section) => [section.key, section.name])));
	// What each line type is called, by section, for an item's line type.
	const feeTypeNames = $derived(new Map(data.sections.map((section) => [section.key, section.feeTypeNames])));
	const showSections = $derived(data.sections.length > 1);

	function itemSub(item: Item): string {
		return [
			showSections ? (sectionNames.get(item.sectionKey) ?? null) : null,
			item.feeType ? (feeTypeNames.get(item.sectionKey)?.[item.feeType] ?? item.feeType) : null,
			...item.extras,
			item.sourceLine != null ? `line ${item.sourceLine}` : null
		]
			.filter(Boolean)
			.join(' · ');
	}

	function recordHref(id: number) {
		return resolve('/(app)/records/[id]', { id: String(id) });
	}

	// ── Counts, the control total, the lines left out ──────────────────────────
	const counts = $derived.by(() => {
		let ready = 0;
		let attention = 0;
		let duplicate = 0;
		let confirmed = 0;
		let skipped = 0;
		for (const item of items) {
			if (isDone(item)) confirmed++;
			else if (item.state === 'skipped') skipped++;
			else if (item.attention) attention++;
			else ready++;
			if (item.duplicateOf != null) duplicate++;
		}
		return { all: items.length, ready, attention, duplicate, confirmed, skipped };
	});
	const waitingCount = $derived(counts.ready + counts.attention);
	const notes = $derived(parseExtractionNotes(job.extractionNotes));
	const ignoredText = $derived(notes ? ignoredSummary(notes) : null);
	const control = $derived(describeControlTotal(job.extractionNotes));

	// The two totals usually share a sign, and then the rail shows them without
	// one, as the document prints them. When they do not, the sign is the
	// difference, so it is kept.
	const signsDiffer = $derived(
		notes?.statedTotal != null &&
			notes.itemsTotalMinor != null &&
			Math.sign(notes.statedTotal.minor) * Math.sign(notes.itemsTotalMinor) < 0
	);

	/** A total in cents as the rail shows it. */
	function showTotal(minor: number): string {
		const currency = notes?.statedTotal?.currency ?? mainCurrency();
		// Cents to a decimal for display only; nothing is added up here.
		return formatCurrency((signsDiffer ? minor : Math.abs(minor)) / 100, currency);
	}

	// ── Filters and paging, kept in the address bar ────────────────────────────
	type Filter = 'all' | 'ready' | 'attention' | 'duplicate' | 'confirmed' | 'skipped';
	const FILTERS: [Filter, string][] = [
		['all', 'All'],
		['ready', 'Ready'],
		['attention', 'Needs attention'],
		['duplicate', 'Possible duplicates'],
		['confirmed', 'Confirmed'],
		['skipped', 'Skipped']
	];
	const PAGE_SIZE = 50;

	let filter = $state<Filter>('all');
	// One section of the profile, or '' for every section (FR-017).
	let sectionFilter = $state('');
	// One kind, or '' for every kind. Offered when the group holds more than one.
	let kindFilter = $state<Kind | ''>('');
	const kindsPresent = $derived(new Set(items.map(kindOf)));
	const showKinds = $derived(kindsPresent.size > 1);
	let pageNo = $state(1);

	function matches(item: Item, f: Filter): boolean {
		switch (f) {
			case 'all':
				return true;
			case 'ready':
				return isWaiting(item) && !item.attention;
			case 'attention':
				return isWaiting(item) && !!item.attention;
			case 'duplicate':
				return item.duplicateOf != null;
			case 'confirmed':
				return isDone(item);
			case 'skipped':
				return item.state === 'skipped';
		}
	}

	// The items of the chosen section; the status tabs count within it.
	const inSection = $derived(
		items.filter(
			(item) =>
				(!sectionFilter || item.sectionKey === sectionFilter) && (!kindFilter || kindOf(item) === kindFilter)
		)
	);
	const tabCounts = $derived.by(() => {
		const tally: Record<Filter, number> = { all: 0, ready: 0, attention: 0, duplicate: 0, confirmed: 0, skipped: 0 };
		for (const item of inSection) for (const [id] of FILTERS) if (matches(item, id)) tally[id]++;
		return tally;
	});
	const filtered = $derived(inSection.filter((item) => matches(item, filter)));
	const pageCount = $derived(Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)));
	// The page asked for, held inside what there is now: confirming the last
	// items of a filtered page can leave fewer pages than there were.
	const currentPage = $derived(Math.min(Math.max(1, pageNo), pageCount));
	const visible = $derived(filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE));

	function setFilter(next: Filter) {
		filter = next;
		pageNo = 1;
	}

	// The select holds text; this stands for "every section". No section key
	// can be it, since a key starts with a letter.
	const ALL_SECTIONS = '*';

	function setSectionFilter(next: string) {
		sectionFilter = next === ALL_SECTIONS ? '' : next;
		pageNo = 1;
	}
	const sectionLabel = $derived(sectionFilter ? (sectionNames.get(sectionFilter) ?? 'Section') : 'All sections');

	// The select holds text; this stands for "every kind".
	const ALL_KINDS = '*';
	function setKindFilter(next: string) {
		kindFilter = next === 'expense' || next === 'income' || next === 'transfer' ? next : '';
		pageNo = 1;
	}
	const kindLabel = $derived(kindFilter ? KIND_LABELS[kindFilter] : 'All kinds');

	// A filtered view is a thing people send each other, so it survives being
	// copied out of the address bar. The URL is written from the state, never the
	// other way round after the first read.
	let urlReady = $state(false);

	function readFiltersFromUrl() {
		const q = page.url.searchParams;
		const show = q.get('show');
		if (show && FILTERS.some(([id]) => id === show)) filter = show as Filter;
		const section = q.get('section');
		if (section && data.sections.some((candidate) => candidate.key === section)) sectionFilter = section;
		const kind = q.get('kind');
		if (kind === 'expense' || kind === 'income' || kind === 'transfer') kindFilter = kind;
		const p = Number(q.get('page'));
		if (Number.isInteger(p) && p > 1) pageNo = p;
	}

	$effect(() => {
		if (!urlReady) return;
		const q = new SvelteURLSearchParams();
		if (filter !== 'all') q.set('show', filter);
		if (sectionFilter) q.set('section', sectionFilter);
		if (kindFilter) q.set('kind', kindFilter);
		if (currentPage > 1) q.set('page', String(currentPage));
		const query = q.toString();
		// The live address, not page.url: a shallow replaceState does not
		// change page.url, so it still shows the address the page loaded with.
		const current = location.search.replace(/^\?/, '');
		if (query === current) return;
		// replaceState, not a navigation: the items are already loaded and the
		// live connection and the scroll position must survive a filter change.
		// SvelteKit's own, so its router keeps track of the address. Untracked,
		// so the page state it reads and writes does not run this again.
		untrack(() => {
			const path = resolve('/(app)/import/[id]', { id: job.id });
			// eslint-disable-next-line svelte/no-navigation-without-resolve -- route is resolved above; only query state is appended.
			replaceState(query ? `${path}?${query}` : path, page.state);
		});
	});

	onMount(() => {
		readFiltersFromUrl();
		// One task later, not now: on a fresh load this runs before SvelteKit's
		// router has started, and its replaceState refuses to run until then.
		// An address that needs tidying on load (`?page=1`, an unknown `show`)
		// would otherwise stop the page.
		const timer = setTimeout(() => (urlReady = true));
		return () => clearTimeout(timer);
	});

	// ── Selection ──────────────────────────────────────────────────────────────
	// Only an item still waiting can be confirmed, skipped or changed, so only
	// those can be selected.
	const selected = new SvelteSet<string>();
	const selectable = $derived(filtered.filter(isWaiting));
	const selectedItems = $derived(items.filter((item) => selected.has(item.id) && isWaiting(item)));
	const allSelected = $derived(selectable.length > 0 && selectable.every((item) => selected.has(item.id)));
	const someSelected = $derived(selectable.some((item) => selected.has(item.id)) && !allSelected);

	function toggleAll() {
		if (allSelected) selectable.forEach((item) => selected.delete(item.id));
		else selectable.forEach((item) => selected.add(item.id));
	}

	function toggleOne(id: string) {
		if (selected.has(id)) selected.delete(id);
		else selected.add(id);
	}

	// ── Opening an item in place ───────────────────────────────────────────────
	let openId = $state<string | null>(null);

	function toggleOpen(id: string) {
		openId = openId === id ? null : id;
	}

	function onRowClick(ev: MouseEvent, item: Item) {
		// The primary cell's link or button handles its own click, and so does the
		// checkbox; this is the rest of the row.
		if ((ev.target as HTMLElement).closest('a, button')) return;
		if (isDone(item) && item.resultId != null) {
			void goto(recordHref(item.resultId));
			return;
		}
		toggleOpen(item.id);
	}

	// ── Live updates ───────────────────────────────────────────────────────────
	/**
	 * Puts these items into the list: each one the list has is replaced, and one
	 * it does not have is added in the document's order. `onlyKnown` is for the
	 * reply to this page's own request, which may update an item but never adds
	 * one; new items arrive by the stream alone (CLAUDE.md, SSE).
	 */
	function applyItems(raws: ImportItemEvent[], onlyKnown = false) {
		let next = items.slice();
		let added = false;
		for (const raw of raws) {
			if (raw.jobId !== job.id) continue;
			const item = normalizeItem(raw);
			const at = next.findIndex((existing) => existing.id === item.id);
			if (at >= 0) next[at] = item;
			else if (!onlyKnown) {
				next.push(item);
				added = true;
			}
			if (!isWaiting(item)) forget(item.id);
		}
		if (added) next = next.sort((a, b) => a.position - b.position);
		items = next;
	}

	/** Drops what this page held for an item that is no longer waiting. */
	function forget(id: string) {
		delete edits[id];
		delete pendingSides[id];
		selected.delete(id);
	}

	type StreamMsg =
		| { type: 'snapshot'; jobs: ImportJobEvent[] }
		| { type: 'job-update'; job: ImportJobEvent }
		| { type: 'job-deleted'; jobId: string }
		| { type: 'item-update'; jobId: string; item: ImportItemEvent }
		| { type: 'item-deleted'; jobId: string; itemId: string };

	// ── Read again (006 FR-023, US9 AS6-7) ────────────────────────────────────
	// While the document is read again it is back in the queue: its items are
	// gone (each `item-deleted` above takes one off the list) and the job says
	// it is queued or being read. What the page shows then depends on what the
	// new reading makes of it.
	const READING_STATES: number[] = [ImportState.Queued, ImportState.Extracting, ImportState.Processing];
	const beingRead = $derived(READING_STATES.includes(job.state));
	// Read again as one receipt, or its reading failed: there is nothing left to
	// review here, and the queue is where it is now.
	const leftForQueue = $derived(job.state === ImportState.PendingReview || job.state === ImportState.Failed);
	// Set when this page saw the document go back into the queue, so the page
	// knows to load the new reading once it is a group again.
	let sawReading = false;

	// How the document is read, for the hero (FR-041). While it is read again
	// with Auto-detect the row says "standard" before anything has been
	// detected, so until the reading is done it says what it waits for. A group
	// always says how it was read, whether or not a profile is turned on.
	const heroReading = $derived(
		readingLabel(job, { profilesEnabled: true, waiting: beingRead }) ?? describeReading(job)
	);

	function takeJob(next: ImportJobEvent) {
		// A reading finished at a different time from the one on screen is a new
		// reading, even when this page missed it going back into the queue (a
		// reconnect whose first message already shows the new group, say).
		const newReading = next.processedAt !== null && job.processedAt !== null && next.processedAt !== job.processedAt;
		if (READING_STATES.includes(next.state)) sawReading = true;
		else if ((sawReading || newReading) && next.state === ImportState.Grouped) {
			// Read again as several items or with a profile. Its items arrive one by
			// one on the stream, but the profile's sections (and so the section
			// filter and each item's section name) come only with the page's own
			// load, so it is loaded again.
			sawReading = false;
			void invalidateAll();
		}
		job = next;
	}

	let readAgainOpen = $state(false);
	const canOfferReadAgain = $derived(data.perms.readAgain);

	createResourceStream<StreamMsg>('/api/import/stream', (msg) => {
		if (msg.type === 'snapshot') {
			// The stream's first message lists every job still in the queue. This
			// group's row in it is newer than what the page loaded.
			const mine = msg.jobs.find((candidate) => candidate.id === job.id);
			if (mine) takeJob(mine);
		} else if (msg.type === 'job-update') {
			if (msg.job.id === job.id) takeJob(msg.job);
		} else if (msg.type === 'job-deleted') {
			// Discarded, here or in another tab, with no record made from it.
			if (msg.jobId === job.id) void goto(resolve('/(app)/import'));
		} else if (msg.type === 'item-update') {
			applyItems([msg.item]);
		} else if (msg.type === 'item-deleted') {
			if (msg.jobId !== job.id) return;
			items = items.filter((item) => item.id !== msg.itemId);
			forget(msg.itemId);
			if (openId === msg.itemId) openId = null;
		}
	});

	// ── Editing one item ───────────────────────────────────────────────────────
	// What the reviewer typed into an item and has not finished with yet. Each
	// field is saved when the reviewer leaves it (`oncommit`), and then dropped.
	let edits = $state<Record<string, ReviewEdits>>({});
	// A source account picked for an item whose target is not settled yet: the
	// two are saved together, so neither is saved until both are known.
	let pendingSides = $state<Record<string, { source: number | null; target: number | null }>>({});
	let itemErrors = $state<Record<string, string>>({});
	const busy = new SvelteSet<string>();
	// The saves still on their way, per item, so each item's saves arrive in the
	// order they were made, and a confirm waits for them.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- bookkeeping only; nothing on screen reads it.
	const inflight = new Map<string, Promise<boolean>>();
	let savingCount = $state<Record<string, number>>({});

	function sidesOf(item: Item) {
		return pendingSides[item.id] ?? itemSides(item, options);
	}

	async function errorText(res: Response): Promise<string> {
		if (res.status === 403) return 'You do not have permission to change imports.';
		const body = await res.json().catch(() => ({}));
		return body.error ?? 'That could not be saved. Try again.';
	}

	/** Saves corrections to one item, after any save of it still on its way. */
	function patchItem(id: string, body: Record<string, unknown>): Promise<boolean> {
		const send = async (): Promise<boolean> => {
			savingCount[id] = (savingCount[id] ?? 0) + 1;
			try {
				const res = await fetch(`/api/import/${job.id}/items/${id}`, {
					method: 'PATCH',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(body),
					credentials: 'include'
				});
				if (!res.ok) {
					itemErrors[id] = await errorText(res);
					return false;
				}
				delete itemErrors[id];
				// The saved item, which the stream also sends. Taking it from the reply
				// keeps the field from flicking back to its old value meanwhile.
				applyItems([await res.json()], true);
				// A field typed into again while this save was on its way stays.
				const pending = edits[id];
				if (pending) {
					for (const [key, value] of Object.entries(body)) {
						if (pending[key] === value) delete pending[key];
					}
				}
				return true;
			} catch {
				itemErrors[id] = 'That could not be saved. Check the connection and try again.';
				return false;
			} finally {
				savingCount[id] = (savingCount[id] ?? 1) - 1;
			}
		};
		const queued = (inflight.get(id) ?? Promise.resolve(true)).then(send);
		inflight.set(id, queued);
		return queued;
	}

	function onEdit(id: string, key: string, value: string | number) {
		edits[id] = { ...(edits[id] ?? {}), [key]: value };
	}

	function onCommit(id: string, key: string) {
		const pending = edits[id];
		if (!pending || !(key in pending)) return;
		void patchItem(id, { [key]: pending[key] });
	}

	function onContact(id: string, v: { value: number | null; newName: string | null }) {
		// Clearing the field changes nothing: the item keeps the name it was read
		// with, as a receipt does when its contact is cleared.
		if (v.value != null) void patchItem(id, { contactId: v.value });
		else if (v.newName) void patchItem(id, { newContactName: v.newName });
	}

	async function onCurrency(item: Item, code: string) {
		const saved = await patchItem(item.id, { currency: code });
		if (!saved || code === mainCurrency()) return;
		// A new foreign currency drops the old rate on the server. Look one up for
		// the item's date, as a receipt card does; if none is found the reviewer
		// types it.
		const date = item.date;
		if (!date) return;
		try {
			const res = await fetch(`/api/exchange-rate?from=${code}&to=${mainCurrency()}&date=${date}`);
			const json = await res.json();
			if (json.rate != null) await patchItem(item.id, { exchangeRate: String(json.rate) });
		} catch {
			// leave blank for manual entry
		}
	}

	async function saveSides(id: string, source: number | null, target: number | null) {
		if (source == null || target == null) {
			pendingSides[id] = { source, target };
			return;
		}
		pendingSides[id] = { source, target };
		const saved = await patchItem(id, { fromAccountId: source, toAccountId: target });
		if (saved) delete pendingSides[id];
	}

	function onSource(item: Item, value: number) {
		const current = sidesOf(item);
		// A transfer's other side stays, unless it is now the same account.
		const target = isTransferRow(item)
			? current.target === value
				? null
				: current.target
			: targetAfterSourceChange(options, value, current.target);
		void saveSides(item.id, value, target);
	}

	function onTarget(item: Item, raw: string) {
		const value = Number(raw);
		const target = Number.isInteger(value) && value > 0 ? value : null;
		void saveSides(item.id, sidesOf(item).source, target);
	}

	/** Saves whatever is still being typed into an item, and waits for every save. */
	async function flush(id: string): Promise<boolean> {
		const pending = edits[id];
		if (pending && Object.keys(pending).length > 0) {
			const ok = await patchItem(id, { ...pending });
			if (!ok) return false;
		}
		return (await inflight.get(id)) ?? true;
	}

	/** Confirms one item: its "Confirm & import", or "Import anyway" for a possible duplicate. */
	async function confirmItem(id: string) {
		if (busy.has(id)) return;
		busy.add(id);
		try {
			if (!(await flush(id))) return;
			const res = await fetch(`/api/import/${job.id}/items/${id}/confirm`, {
				method: 'POST',
				credentials: 'include'
			});
			if (!res.ok) {
				// A rule refused it and nothing was written — say why, on the card.
				itemErrors[id] = await errorText(res);
				return;
			}
			delete itemErrors[id];
			const result = await res.json().catch(() => ({}));
			markItems([{ id, ok: true, recordId: typeof result.id === 'number' ? result.id : undefined }], 'imported');
			if (openId === id) openId = null;
		} finally {
			busy.delete(id);
		}
	}

	async function skipItem(id: string) {
		if (busy.has(id)) return;
		busy.add(id);
		try {
			const res = await fetch(`/api/import/${job.id}/items/${id}/skip`, {
				method: 'POST',
				credentials: 'include'
			});
			if (!res.ok) {
				itemErrors[id] = await errorText(res);
				return;
			}
			markItems([{ id, ok: true }], 'skipped');
			if (openId === id) openId = null;
		} finally {
			busy.delete(id);
		}
	}

	// ── Many items at once ─────────────────────────────────────────────────────
	type Outcome = { id: string; ok: boolean; reason?: string; recordId?: number };

	/**
	 * Takes what a request about these items says it did, before the stream says
	 * the same, so a finished item does not sit in the list as still waiting.
	 * Only an item this page holds as waiting is changed.
	 */
	function markItems(outcomes: Outcome[], state: 'imported' | 'skipped') {
		const done = new Map(outcomes.filter((o) => o.ok).map((o) => [o.id, o]));
		if (done.size === 0) return;
		items = items.map((item) => {
			const outcome = done.get(item.id);
			if (!outcome || !isWaiting(item)) return item;
			return { ...item, state, resultId: outcome.recordId ?? item.resultId, attention: null };
		});
		for (const id of done.keys()) forget(id);
	}

	// A confirm of many runs one item after another on the server, and each item
	// it confirms arrives here as it is done. `run` is the items this page
	// expects it to confirm, so the progress can be counted off the list.
	let run = $state<{ ids: string[] } | null>(null);
	const runDone = $derived(
		run ? run.ids.filter((id) => items.some((item) => item.id === id && !isWaiting(item))).length : 0
	);
	// What the last request about many items left behind, and why (FR-019).
	let report = $state<{ title: string; left: { id: string; name: string; reason: string }[] } | null>(null);
	let bulkError = $state<string | null>(null);

	function nameOf(id: string): string {
		const item = items.find((candidate) => candidate.id === id);
		return item ? itemTitle(item) : 'An item';
	}

	async function bulk(body: Record<string, unknown>): Promise<Outcome[] | null> {
		bulkError = null;
		try {
			const res = await fetch(`/api/import/${job.id}/items/bulk`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				// The reading this page shows, so "all" cannot reach the items of a
				// newer reading the user has not seen (FR-023).
				body: JSON.stringify({ ...body, readAt: job.processedAt }),
				credentials: 'include'
			});
			if (!res.ok) {
				bulkError = await errorText(res);
				return null;
			}
			const reply = await res.json();
			return reply.results as Outcome[];
		} catch {
			bulkError = 'That did not reach the server. Check the connection and try again.';
			return null;
		}
	}

	function leftBehind(outcomes: Outcome[]) {
		return outcomes
			.filter((o) => !o.ok)
			.map((o) => ({ id: o.id, name: nameOf(o.id), reason: o.reason ?? 'It was not done.' }));
	}

	async function confirmMany(selection: string[] | 'all') {
		if (run) return;
		// The items expected to go through: those still waiting with nothing
		// holding them back. The server checks again, item by item.
		const pool = selection === 'all' ? items : items.filter((item) => selection.includes(item.id));
		const expected = pool.filter((item) => isWaiting(item) && !item.attention).map((item) => item.id);
		run = { ids: expected };
		report = null;
		try {
			// Whatever is still being typed into a selected item is saved first.
			// An item whose change could not be saved is left out: confirming it
			// would make its record from the old values, not what the card shows.
			const unsaved: string[] = [];
			for (const item of pool) if (isWaiting(item) && !(await flush(item.id))) unsaved.push(item.id);
			run = { ids: expected.filter((id) => !unsaved.includes(id)) };
			const named = (selection === 'all' ? pool.filter(isWaiting).map((item) => item.id) : selection).filter(
				(id) => !unsaved.includes(id)
			);
			let outcomes: Outcome[] = [];
			if (named.length > 0) {
				const reply = await bulk(
					selection === 'all' && unsaved.length === 0
						? { action: 'confirm', all: true }
						: { action: 'confirm', itemIds: named }
				);
				if (!reply) return;
				outcomes = reply;
			}
			markItems(outcomes, 'imported');
			const confirmed = outcomes.filter((o) => o.ok).length;
			const left = [
				...unsaved.map((id) => ({ id, name: nameOf(id), reason: 'Your change to it could not be saved.' })),
				...leftBehind(outcomes)
			];
			report = {
				title:
					left.length === 0
						? `Confirmed ${confirmed} item${confirmed === 1 ? '' : 's'}.`
						: `Confirmed ${confirmed}. ${left.length} left for you to look at:`,
				left
			};
		} finally {
			run = null;
		}
	}

	async function skipMany(selection: string[] | 'all') {
		report = null;
		const outcomes = await bulk(selection === 'all' ? { action: 'skip', all: true } : { action: 'skip', itemIds: selection });
		if (!outcomes) return;
		markItems(outcomes, 'skipped');
		const skipped = outcomes.filter((o) => o.ok).length;
		const left = leftBehind(outcomes);
		report = {
			title:
				left.length === 0
					? `Skipped ${skipped} item${skipped === 1 ? '' : 's'}.`
					: `Skipped ${skipped}. ${left.length} could not be skipped:`,
			left
		};
	}

	async function fillMany(body: Record<string, unknown>, what: string) {
		report = null;
		const ids = selectedItems.map((item) => item.id);
		if (ids.length === 0) return;
		const outcomes = await bulk({ ...body, itemIds: ids });
		if (!outcomes) return;
		const left = leftBehind(outcomes);
		if (left.length > 0) {
			report = { title: `${what} on ${outcomes.length - left.length}. ${left.length} kept their own:`, left };
		}
	}

	// ── The account every item was paid from (or received into) ───────────────
	const kinds = $derived.by(() => {
		const pool = items.some(isWaiting) ? items.filter(isWaiting) : items;
		return {
			expense: pool.some((item) => kindOf(item) === 'expense'),
			income: pool.some((item) => kindOf(item) === 'income'),
			transfer: pool.some((item) => kindOf(item) === 'transfer')
		};
	});
	// With transfers among the items, the one account is the account the
	// document is about: it pays, receives, and is one side of each transfer.
	const accountLabel = $derived(
		kinds.transfer
			? 'Statement account'
			: kinds.expense && kinds.income
				? 'Payment or deposit account'
				: kinds.income
					? 'Deposit account'
					: 'Payment account'
	);
	/**
	 * The accounts an item of this group can be paid from or received into: the
	 * same lists a receipt card offers for each kind. The server refuses any
	 * other, and an item an account cannot serve keeps its own (FR-018).
	 */
	const accountGroups = $derived.by(() => {
		const groups: { label: string; accounts: AccountView[] }[] = [];
		if (kinds.expense) groups.push({ label: 'Payment account', accounts: data.expensePaymentAccounts });
		if (kinds.income) {
			const shown = new Set(groups.flatMap((g) => g.accounts.map((a) => a.id)));
			groups.push({ label: 'Deposit account', accounts: data.accounts.filter((a) => !shown.has(a.id)) });
		}
		if (kinds.transfer) {
			const shown = new Set(groups.flatMap((g) => g.accounts.map((a) => a.id)));
			groups.push({ label: 'Transfer', accounts: data.transferAccounts.filter((a) => !shown.has(a.id)) });
		}
		return groups.filter((g) => g.accounts.length > 0);
	});

	function accountName(id: number | null): string | null {
		if (id == null) return null;
		const account = data.allAccounts.find((a) => a.id === id);
		return account ? `${account.code} · ${account.name}` : null;
	}

	let groupAccountNote = $state<string | null>(null);

	async function setGroupAccount(raw: string) {
		const id = Number(raw);
		if (!Number.isInteger(id) || id <= 0) return;
		groupAccountNote = null;
		bulkError = null;
		const res = await fetch(`/api/import/${job.id}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ groupAccountId: id }),
			credentials: 'include'
		});
		if (!res.ok) {
			bulkError = await errorText(res);
			return;
		}
		const reply = await res.json().catch(() => ({ results: [] }));
		const misfits = (reply.results as Outcome[]).filter((o) => !o.ok);
		groupAccountNote =
			misfits.length > 0
				? `${misfits.length} item${misfits.length === 1 ? '' : 's'} kept ${misfits.length === 1 ? 'its' : 'their'} own account: ${misfits[0].reason ?? ''}`
				: null;
	}

	// ── Categories for the selection ──────────────────────────────────────────
	const categoryGroups = $derived.by(() => {
		const groups: { label: string; choices: { id: number; name: string }[] }[] = [];
		const pool = selectedItems.length > 0 ? selectedItems : items.filter(isWaiting);
		// A transfer has no category, so it adds no list.
		if (pool.some((item) => kindOf(item) === 'expense'))
			groups.push({ label: 'Expense or revenue deduction', choices: data.expenseCategories });
		if (pool.some((item) => kindOf(item) === 'income'))
			groups.push({ label: 'Income', choices: data.incomeCategories });
		return groups;
	});

	// ── Skipping and discarding, after asking ─────────────────────────────────
	let skipAsk = $state<string[] | 'all' | null>(null);
	let skipDialogOpen = $state(false);
	let discardDialogOpen = $state(false);

	function askSkip(selection: string[] | 'all') {
		skipAsk = selection;
		skipDialogOpen = true;
	}

	async function discardDocument() {
		const res = await fetch(`/api/import/${job.id}`, { method: 'DELETE', credentials: 'include' });
		if (!res.ok) {
			bulkError = await errorText(res);
			return;
		}
		void goto(resolve('/(app)/import'));
	}
</script>

<svelte:head>
	<title>{job.originalFilename} - Auto Import - Akaun</title>
</svelte:head>

<!-- Positioned, so the selection bar sits at the bottom of this page's own area
     and not of the whole window. -->
<div class="group-screen">
	<DetailPage backHref={resolve('/(app)/import')} backLabel="Auto Import">
		{#snippet hero()}
			<div class="detail-hero-eyebrow">
				<span>Auto Import</span><span>·</span><span>{heroReading}</span>
			</div>
			<h1 class="detail-hero-title group-title">{job.originalFilename}</h1>
			<div class="hero-counts">
				<span><b>{counts.ready}</b> ready</span>
				<span class:attention={counts.attention > 0}><b>{counts.attention}</b> {counts.attention === 1 ? 'needs' : 'need'} attention</span>
				<span><b>{counts.confirmed}</b> confirmed</span>
				<span><b>{counts.skipped}</b> skipped</span>
			</div>
			{#if control}
				<span class="control-chip" class:ok={control.matches}>
					{#if control.matches}<Check size={11} strokeWidth={3} />{:else}<AlertTriangle size={11} />{/if}
					{control.text}
				</span>
			{/if}
			{#if waitingCount === 0 && items.length > 0}
				<p class="detail-hero-note">Every item is confirmed or skipped.</p>
			{/if}
		{/snippet}

		{#snippet main()}
			{#if beingRead}
				<div class="group-report reread" role="status">
					<span class="spinner sm"></span>
					This document is being read again. Its new items appear here when the reading is done.
				</div>
			{:else if leftForQueue}
				<div class="group-report reread" role="status">
					<span>
						{job.state === ImportState.Failed
							? `Reading it again failed: ${job.error ?? 'no reason was given'}.`
							: 'This document was read again as one record.'}
						<a href={resolve('/(app)/import')}>Review it on Auto Import</a>
					</span>
				</div>
			{/if}

			{#if canChange && waitingCount > 0}
				<section class="detail-card group-actions">
					<div class="group-account">
						<span class="group-account-label">{accountLabel}</span>
						<Select.Root type="single" value={job.groupAccountId == null ? '' : String(job.groupAccountId)} onValueChange={setGroupAccount}>
							<Select.Trigger class="rinput w-full" aria-label={accountLabel}>
								{accountName(job.groupAccountId) ?? 'Choose one for every item'}
							</Select.Trigger>
							<Select.Content>
								{#each accountGroups as group (group.label)}
									<Select.Group>
										<Select.GroupHeading>{group.label}</Select.GroupHeading>
										{#each group.accounts as account (account.id)}
											<Select.Item value={String(account.id)} label={`${account.code} · ${account.name}`} />
										{/each}
									</Select.Group>
								{/each}
							</Select.Content>
						</Select.Root>
					</div>
					<div class="group-buttons">
						<Button size="sm" disabled={run != null || counts.ready === 0} onclick={() => confirmMany('all')}>
							<Check size={15} /> Confirm all ({counts.ready})
						</Button>
						<Button variant="outline" size="sm" disabled={run != null} onclick={() => askSkip('all')}>Skip all</Button>
					</div>
					{#if groupAccountNote}
						<p class="group-note">{groupAccountNote}</p>
					{/if}
					{#if run}
						<div class="run-progress" role="status">
							<span class="spinner sm"></span>
							Confirming {runDone} of {run.ids.length}…
							<div class="pipe-track run-track">
								<div class="pipe-fill" style="width:{run.ids.length ? (runDone / run.ids.length) * 100 : 0}%"></div>
							</div>
						</div>
					{/if}
				</section>
			{/if}

			{#if bulkError}
				<div class="group-report error" role="alert">{bulkError}</div>
			{/if}
			{#if report}
				<div class="group-report" role="status">
					<div class="group-report-head">
						<span>{report.title}</span>
						<button type="button" class="group-report-close" onclick={() => (report = null)}>Dismiss</button>
					</div>
					{#if report.left.length > 0}
						<ul class="group-report-list">
							{#each report.left as left (left.id)}
								<li><b>{left.name}</b> — {left.reason}</li>
							{/each}
						</ul>
					{/if}
				</div>
			{/if}

			<div class="group-filters">
				<div class="status-tabs group-tabs">
					{#each FILTERS as [id, label] (id)}
						<button class="status-tab" class:active={filter === id} onclick={() => setFilter(id)}>
							{label}<span class="tab-count">{tabCounts[id]}</span>
						</button>
					{/each}
				</div>
				{#if showKinds}
					<!-- Expenses, income and transfers in one document: one kind at a time. -->
					<div class="section-filter">
						<Select.Root type="single" value={kindFilter || ALL_KINDS} onValueChange={setKindFilter}>
							<Select.Trigger class="rinput w-full" aria-label="Kind">{kindLabel}</Select.Trigger>
							<Select.Content>
								<Select.Item value={ALL_KINDS} label="All kinds" />
								{#each KINDS as kind (kind)}
									{#if kindsPresent.has(kind)}
										<Select.Item value={kind} label={KIND_LABELS[kind]} />
									{/if}
								{/each}
							</Select.Content>
						</Select.Root>
					</div>
				{/if}
				{#if showSections}
					<!-- Read with a profile of several sections: one section at a time (FR-017). -->
					<div class="section-filter">
						<Select.Root type="single" value={sectionFilter || ALL_SECTIONS} onValueChange={setSectionFilter}>
							<Select.Trigger class="rinput w-full" aria-label="Section">{sectionLabel}</Select.Trigger>
							<Select.Content>
								<Select.Item value={ALL_SECTIONS} label="All sections" />
								{#each data.sections as section (section.key)}
									<Select.Item value={section.key} label={section.name} />
								{/each}
							</Select.Content>
						</Select.Root>
					</div>
				{/if}
			</div>

			<div class="table-card items-card">
				<table class="exp-table items-table">
					<thead>
						<tr>
							<th class="td-check">
								{#if canChange && selectable.length > 0}
									<button
										type="button"
										class="check-box"
										class:on={allSelected || someSelected}
										onclick={toggleAll}
										aria-label="Select every waiting item shown"
									>
										{#if allSelected}<Check size={10} strokeWidth={3} />{:else if someSelected}<span class="check-dash"></span>{/if}
									</button>
								{/if}
							</th>
							<th><span class="th-inner">Item</span></th>
							<th><span class="th-inner">Other party</span></th>
							<th><span class="th-inner">Category</span></th>
							<th><span class="th-inner">Kind</span></th>
							<th><span class="th-inner">Status</span></th>
							<th><span class="th-inner">Date</span></th>
							<th class="ta-right"><span class="th-inner">Amount</span></th>
							<th class="td-chevron"></th>
						</tr>
					</thead>
					<tbody>
						{#each visible as item (item.id)}
							{@const open = openId === item.id}
							<tr class="exp-row" class:selected={selected.has(item.id)} class:is-open={open} onclick={(ev) => onRowClick(ev, item)}>
								<td class="td-check">
									{#if canChange && isWaiting(item)}
										<button
											type="button"
											class="check-box"
											class:on={selected.has(item.id)}
											onclick={() => toggleOne(item.id)}
											aria-label="Select {itemTitle(item)}"
										>
											{#if selected.has(item.id)}<Check size={10} strokeWidth={3} />{/if}
										</button>
									{/if}
								</td>
								<td class="td-primary">
									{#if isDone(item) && item.resultId != null}
										<!-- A confirmed item is its record now: a real link to it (FR-021). -->
										<a class="row-link" href={recordHref(item.resultId)}>
											<span class="cell-itemname">{itemTitle(item)}</span>
											{#if itemSub(item)}<span class="cell-itemnum">{itemSub(item)}</span>{/if}
										</a>
									{:else}
										<!-- An item has no page of its own: it opens here, in place. -->
										<button type="button" class="row-link item-toggle" aria-expanded={open} onclick={() => toggleOpen(item.id)}>
											<span class="cell-itemname">{itemTitle(item)}</span>
											{#if itemSub(item)}<span class="cell-itemnum">{itemSub(item)}</span>{/if}
										</button>
									{/if}
								</td>
								<td data-label="Other party">{item.supplier || '—'}</td>
								<td data-label="Category">{categoryCell(item)}</td>
								<td data-label="Kind">
									<span
										class="type-chip"
										class:income={kindOf(item) === 'income'}
										class:expense={kindOf(item) === 'expense'}
										class:mixed={kindOf(item) === 'transfer'}
									>
										{KIND_LABELS[kindOf(item)]}
									</span>
								</td>
								<td class="td-status" data-label="Status">
									<StatusBadge status={statusOf(item)} />
									{#if item.duplicateOf != null}
										<span class="dup-flag" title={dupMessage(item)}><AlertTriangle size={11} /> Possible duplicate</span>
									{/if}
								</td>
								<td class="td-date" data-label="Date">{item.date ? formatDateShort(item.date) : '—'}</td>
								<td class="td-amount" data-label="Amount">
									<span class="amount-num">{currencySymbol(item.currency ?? mainCurrency())} {formatMoney(item.amount)}</span>
								</td>
								<td class="td-chevron">
									{#if isDone(item) && item.resultId != null}
										<ChevronRight size={14} color="var(--muted-foreground)" />
									{:else}
										<ChevronDown size={14} color="var(--muted-foreground)" class={open ? 'chev-open' : ''} />
									{/if}
								</td>
								<td class="row-break"></td>
							</tr>
							{#if open}
								{@const sides = sidesOf(item)}
								<tr class="item-open-row">
									<td colspan="9">
										<ImportReviewCard
											row={item}
											edits={edits[item.id] ?? {}}
											sourceAccountId={sides.source}
											targetAccountId={sides.target}
											{options}
											heading={itemTitle(item)}
											error={itemErrors[item.id] ?? (isWaiting(item) ? item.attention : null)}
											note={(savingCount[item.id] ?? 0) > 0 ? 'Saving…' : 'Changes are saved as you make them.'}
											readonly={!canChange || !isWaiting(item)}
											done={!isWaiting(item)}
											busy={busy.has(item.id) || run != null}
											onedit={(key, value) => onEdit(item.id, key, value)}
											oncommit={(key) => onCommit(item.id, key)}
											oncontact={(v) => onContact(item.id, v)}
											oncurrency={(code) => onCurrency(item, code)}
											onsource={(value) => onSource(item, value)}
											ontarget={(raw) => onTarget(item, raw)}
											onconfirm={() => confirmItem(item.id)}
											onskip={() => skipItem(item.id)}
										/>
									</td>
								</tr>
							{/if}
						{/each}
						{#if visible.length === 0}
							<tr class="empty-row">
								<td colspan="9" class="items-empty">
									{beingRead
										? 'Reading the document again…'
										: items.length === 0
											? 'This document has no items left.'
											: 'No item matches this filter.'}
								</td>
							</tr>
						{/if}
					</tbody>
				</table>
			</div>

			{#if filtered.length > PAGE_SIZE}
				<div class="table-foot items-foot">
					<span>
						{(currentPage - 1) * PAGE_SIZE + 1}–{Math.min(currentPage * PAGE_SIZE, filtered.length)} of {filtered.length}
					</span>
					<span class="pager">
						<button type="button" class="sheet-btn" disabled={currentPage <= 1} onclick={() => (pageNo = currentPage - 1)}>
							Previous
						</button>
						<span>Page {currentPage} of {pageCount}</span>
						<button type="button" class="sheet-btn" disabled={currentPage >= pageCount} onclick={() => (pageNo = currentPage + 1)}>
							Next
						</button>
					</span>
				</div>
			{/if}
		{/snippet}

		{#snippet rail()}
			<section class="detail-card">
				<div class="detail-card-head"><span class="detail-card-title">Source document</span></div>
				<!-- The file opens outside the app, so this is a real link: a new tab,
				     the context menu and middle-click all work. -->
				<a
					class="related-link ob-card"
					href={resolve('/api/import/[jobId]/file', { jobId: job.id })}
					target="_blank"
					rel="noopener"
				>
					<span class="ob-icon"><FileText size={15} /></span>
					<span class="ob-main">
						<span class="ob-title rail-file-name">{job.originalFilename}</span>
						<span class="ob-sub">One file, attached to every record made from it</span>
					</span>
					<ExternalLink size={13} color="var(--muted-foreground)" />
				</a>
			</section>

			{#if notes?.statedTotal && control}
				<section class="detail-card">
					<div class="detail-card-head"><span class="detail-card-title">Control total</span></div>
					<div class="detail-list">
						<div class="detail-row">
							<span class="detail-key">On the document</span>
							<span class="detail-val num">{showTotal(notes.statedTotal.minor)}</span>
						</div>
						<div class="detail-row">
							<span class="detail-key">Items as read</span>
							<span class="detail-val num">{showTotal(notes.itemsTotalMinor)}</span>
						</div>
					</div>
					<p class="control-result" class:ok={control.matches}>
						{#if control.matches}<Check size={13} strokeWidth={3} />{:else}<AlertTriangle size={13} />{/if}
						{control.matches ? 'They match.' : `${control.text.replace('Control total ', '')}. Confirming is still allowed.`}
					</p>
					<p class="hint">Checked against the items as they were read. Later edits and skips do not change it.</p>
				</section>
			{/if}

			{#if notes && ignoredText}
				<section class="detail-card">
					<Disclosure label={ignoredText}>
						<!-- A reading from columns counts every row it left out and keeps a
						     sample, such as "Ignored 726 lines (20 shown)" (FR-056). -->
						<ul class="ignored-list">
							{#each notes.ignored as line, i (i)}
								<li>{line}</li>
							{/each}
						</ul>
						<p class="hint">
							{#if notes.method === 'columns'}
								Rows of the table that fit no section, or whose line type is not listed. The count is exact; only the
								first rows are listed.
							{:else if notes.method === 'columns_ai'}
								Rows of the table that fit no section, or whose line type is not listed, then lines the AI saw beside the
								table and left out on purpose. Only the first are listed.
							{:else}
								Lines the reading saw and left out on purpose, such as subtotals. A guide only: it may not list every
								line that was left out.
							{/if}
						</p>
					</Disclosure>
				</section>
			{/if}

			{#if notes?.balance}
				<!-- The running-balance check of a reading from columns: a note, never
				     a reason an item is held back. -->
				<section class="detail-card">
					<div class="detail-card-head"><span class="detail-card-title">Running balance</span></div>
					<p class="hint balance-note" class:balance-off={!notes.balance.matches}>{notes.balance.message}</p>
				</section>
			{/if}

			{#if canOfferReadAgain}
				<!-- Shown even when it cannot be used, so the page says why (US9 AS7). -->
				<section class="detail-card">
					<div class="detail-card-head"><span class="detail-card-title">Read again</span></div>
					<p class="hint discard-hint">
						{job.readAgainReason ??
							'Wrong reading? Read this file again another way. Every item still waiting, and every skipped one, is replaced.'}
					</p>
					<button
						type="button"
						class="sheet-btn read-again-btn"
						disabled={!job.canReadAgain}
						title={job.readAgainReason ?? undefined}
						onclick={() => (readAgainOpen = true)}
					>
						<RotateCcw size={14} /> Read again
					</button>
				</section>
			{/if}

			{#if data.perms.delete && waitingCount > 0}
				<section class="detail-card">
					<div class="detail-card-head"><span class="detail-card-title">Discard</span></div>
					<p class="hint discard-hint">
						Removes the items still waiting. Records already made from this document stay, and so does its file.
					</p>
					<button type="button" class="sheet-btn sheet-btn-delete" onclick={() => (discardDialogOpen = true)}>
						<Trash2 size={14} /> Delete
					</button>
				</section>
			{/if}
		{/snippet}
	</DetailPage>

	<BulkActionBar show={canChange && selectedItems.length > 0} count={selectedItems.length} onclear={() => selected.clear()}>
		{#snippet actions()}
			<button
				type="button"
				class="bulk-actions-ghost bulk-btn"
				disabled={run != null}
				onclick={() => confirmMany(selectedItems.map((item) => item.id))}
			>
				<Check size={14} /> Confirm
			</button>
			<button type="button" class="bulk-actions-ghost bulk-btn" onclick={() => askSkip(selectedItems.map((item) => item.id))}>
				Skip
			</button>
			<Select.Root
				type="single"
				value=""
				onValueChange={(v) => {
					const id = Number(v);
					if (Number.isInteger(id) && id > 0) void fillMany({ action: 'setCategory', categoryAccountId: id }, 'Category set');
				}}
			>
				<Select.Trigger class="bulk-select" aria-label="Set category">Category</Select.Trigger>
				<Select.Content>
					{#each categoryGroups as group (group.label)}
						<Select.Group>
							<Select.GroupHeading>{group.label}</Select.GroupHeading>
							{#each group.choices as choice (choice.id)}
								<Select.Item value={String(choice.id)} label={choice.name} />
							{/each}
						</Select.Group>
					{/each}
				</Select.Content>
			</Select.Root>
			<Select.Root
				type="single"
				value=""
				onValueChange={(v) => {
					const id = Number(v);
					if (Number.isInteger(id) && id > 0) void fillMany({ action: 'setAccount', accountId: id }, 'Account set');
				}}
			>
				<Select.Trigger class="bulk-select" aria-label={accountLabel}>Account</Select.Trigger>
				<Select.Content>
					{#each accountGroups as group (group.label)}
						<Select.Group>
							<Select.GroupHeading>{group.label}</Select.GroupHeading>
							{#each group.accounts as account (account.id)}
								<Select.Item value={String(account.id)} label={`${account.code} · ${account.name}`} />
							{/each}
						</Select.Group>
					{/each}
				</Select.Content>
			</Select.Root>
		{/snippet}
	</BulkActionBar>
</div>

{#if canOfferReadAgain}
	<ReadAgainDialog
		bind:open={readAgainOpen}
		jobId={job.id}
		filename={job.originalFilename}
		choices={data.readAsChoices}
		current={readAsOfJob(job)}
		replaces="Every item still waiting, and every skipped item, is replaced by the new reading."
	/>
{/if}

<ConfirmDialog
	bind:open={skipDialogOpen}
	title={skipAsk === 'all' ? 'Skip every waiting item?' : 'Skip the selected items?'}
	description={skipAsk === 'all'
		? `No record is made for the ${waitingCount} item${waitingCount === 1 ? '' : 's'} still waiting. Items already confirmed keep their records.`
		: 'No record is made for these items. The other items are not changed.'}
	confirmLabel="Skip"
	danger
	onConfirm={() => {
		const selection = skipAsk;
		skipDialogOpen = false;
		skipAsk = null;
		if (selection) void skipMany(selection);
	}}
/>

<ConfirmDialog
	bind:open={discardDialogOpen}
	title="Discard this document?"
	description="The items still waiting are removed. Records already made from it stay, and so does the file while a record uses it."
	confirmLabel="Delete"
	danger
	onConfirm={() => {
		discardDialogOpen = false;
		void discardDocument();
	}}
/>

<style>
	.group-screen {
		position: relative;
		flex: 1;
		min-width: 0;
		min-height: 0;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	.group-title {
		overflow-wrap: anywhere;
	}
	.hero-counts {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 14px;
		font-size: 13px;
		color: var(--muted-foreground);
	}
	.hero-counts b {
		color: var(--foreground);
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
	.hero-counts .attention,
	.hero-counts .attention b {
		color: var(--amber);
	}
	.control-chip {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		align-self: flex-start;
		font-size: 11.5px;
		font-weight: 500;
		color: var(--amber);
		background: var(--amber-soft);
		padding: 2px 9px;
		border-radius: 999px;
	}
	.control-chip.ok {
		color: var(--green);
		background: var(--green-soft);
	}

	/* The group's own actions, above the table. */
	.group-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 12px 16px;
	}
	.group-account {
		display: flex;
		flex-direction: column;
		gap: 5px;
		flex: 1 1 260px;
		min-width: 0;
	}
	.group-account-label {
		font-size: 11.5px;
		color: var(--muted-foreground);
		font-weight: 500;
	}
	.group-buttons {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	.group-note {
		flex-basis: 100%;
		margin: 0;
		font-size: 12px;
		color: var(--amber);
	}
	.run-progress {
		flex-basis: 100%;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		font-size: 12.5px;
		color: var(--muted-foreground);
	}
	.run-track {
		flex-basis: 100%;
		margin-top: 2px;
	}

	.group-report {
		font-size: 12.5px;
		background: var(--amber-soft);
		color: var(--foreground);
		border-radius: 8px;
		padding: 10px 12px;
	}
	/* The document is being read again, or was, and is back on the queue. */
	.group-report.reread {
		display: flex;
		align-items: center;
		gap: 8px;
		background: var(--accent);
	}
	.group-report.reread a {
		color: var(--primary);
		margin-left: 4px;
	}
	.read-again-btn {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
	.group-report.error {
		background: var(--red-soft);
		color: var(--red);
	}
	.group-report-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
	}
	.group-report-close {
		border: none;
		background: none;
		font-family: inherit;
		font-size: 12px;
		color: var(--muted-foreground);
		cursor: pointer;
		padding: 0;
		flex-shrink: 0;
	}
	.group-report-list {
		margin: 8px 0 0;
		padding-left: 18px;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.group-tabs {
		max-width: 100%;
		overflow-x: auto;
		align-self: flex-start;
	}

	/* The status tabs, and the section select beside them when the document
	   was read with a profile of several sections. */
	.group-filters {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
		min-width: 0;
	}
	.group-filters .group-tabs {
		align-self: auto;
	}
	.section-filter {
		width: 220px;
		max-width: 100%;
	}

	/* The table scrolls with the page, not in a box of its own: an item opened
	   in place has a contact search list that drops below it, and a scrolling
	   box would clip it. */
	.items-card {
		flex: none;
		overflow: visible;
	}
	.check-box {
		width: 17px;
		height: 17px;
		border-radius: 5px;
		border: 1.5px solid var(--border-strong);
		background: var(--card);
		display: grid;
		place-items: center;
		cursor: pointer;
		color: var(--primary-foreground);
		padding: 0;
		flex-shrink: 0;
	}
	.check-box.on {
		border-color: var(--primary);
		background: var(--primary);
	}
	.check-dash {
		width: 8px;
		height: 2px;
		border-radius: 2px;
		background: white;
		display: block;
	}
	.row-link {
		color: inherit;
		text-decoration: none;
		display: flex;
		flex-direction: column;
		gap: 1px;
		min-width: 0;
	}
	.item-toggle {
		border: none;
		background: none;
		padding: 0;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	.row-link:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
		border-radius: 4px;
	}
	.cell-itemname {
		font-weight: 500;
		overflow-wrap: anywhere;
	}
	.cell-itemnum {
		font-size: 11.5px;
		color: var(--muted-foreground);
	}
	.dup-flag {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		margin-left: 6px;
		font-size: 11px;
		font-weight: 500;
		color: var(--amber);
		white-space: nowrap;
	}
	.items-table :global(.chev-open) {
		transform: rotate(180deg);
	}
	.exp-row.is-open td {
		border-bottom-color: transparent;
	}
	.item-open-row td {
		padding: 0 14px 14px;
		border-bottom: 1px solid var(--border);
	}
	.items-empty {
		padding: 28px;
		text-align: center;
		font-size: 13px;
		color: var(--muted-foreground);
	}
	.items-foot {
		flex-wrap: wrap;
		align-items: center;
	}
	.pager {
		display: inline-flex;
		align-items: center;
		gap: 10px;
	}

	.rail-file-name {
		overflow-wrap: anywhere;
	}
	.control-result {
		display: flex;
		align-items: center;
		gap: 6px;
		margin: 12px 0 0;
		font-size: 13px;
		font-weight: 500;
		color: var(--amber);
	}
	.control-result.ok {
		color: var(--green);
	}
	.ignored-list {
		margin: 0;
		padding-left: 18px;
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-size: 12.5px;
		overflow-wrap: anywhere;
	}
	.discard-hint {
		margin: 0 0 10px;
	}

	.bulk-btn {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 5px 10px;
		border-radius: 6px;
		font-family: inherit;
		font-size: 13px;
		cursor: pointer;
	}
	.group-screen :global(.bulk-select) {
		height: 30px;
		font-size: 13px;
		min-width: 0;
	}

	/* A phone: the table becomes stacked cards (layout.css), and nothing on
	   this page may need a sideways scroll (FR-022). */
	@media (max-width: 767px) {
		/* On a phone `.main` is the one scroll container (layout.css), so this
		   wrapper must neither clip nor stretch, like `.screen` there. The bar
		   is fixed above the bottom nav on a phone, so it needs no positioned
		   parent. */
		.group-screen {
			flex: none;
			overflow: visible;
			min-height: 100%;
		}
		/* Selecting is how the bar's actions reach an item, so the checkbox
		   stays on a card here, unlike on the Records screen. */
		.items-table .exp-row td.td-check {
			display: block;
			order: 1;
			flex: 0 0 auto;
			align-self: center;
		}
		.items-table .exp-row td.td-chevron {
			display: none;
		}
		.item-open-row td {
			padding: 0 0 10px;
			border-bottom: none;
		}
		.group-tabs {
			max-width: 100%;
		}
		.items-foot {
			white-space: normal;
		}
		.group-screen :global(.bulkbar-inner) {
			flex-wrap: wrap;
			max-width: calc(100vw - 32px);
		}
		.group-screen :global(.bulk-actions) {
			flex-wrap: wrap;
		}
	}
	.balance-note {
		margin: 0;
	}
	.balance-off {
		color: var(--amber);
	}
</style>
