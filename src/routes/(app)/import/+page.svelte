<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { resolve } from '$app/paths';
	import { Upload, Clock, Receipt, Check, X, AlertTriangle, RotateCcw, Camera, ChevronRight } from '@lucide/svelte';
	import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte';
	import ImportReviewCard from '$lib/components/import/ImportReviewCard.svelte';
	import ImportGroupCard from '$lib/components/import/ImportGroupCard.svelte';
	import ReadAgainDialog from '$lib/components/import/ReadAgainDialog.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import { useIsMobile } from '$lib/hooks/useIsMobile.svelte.js';
	import ScannerOverlay from '$lib/components/scanner/ScannerOverlay.svelte';
	import { loadOpenCv } from '$lib/scanner/cv';
	import { importStateEnum } from '$lib/enums.js';
	import { syncImportAccountSelection } from '$lib/import-account-groups.js';
	import { mainCurrency } from '$lib/currency-state.svelte.js';
	import { currencySymbol } from '$lib/currency.js';
	import {
		describeReading,
		editedValue,
		formatMoney,
		hasProfileChoice,
		isTransferRow,
		keepsReadAccount,
		readAsOfJob,
		readingLabel,
		readingProgressLabel,
		receiptSides,
		reviewCurrency,
		reviewRateMissing,
		reviewRowFrom,
		sideIsIncome,
		targetAfterSourceChange,
		type ReviewEdits,
		type ReviewOptions,
		type ReviewRow
	} from '$lib/components/import/review-card.js';
	import { ImportReadAs } from '$lib/import-reading.js';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	type JobState =
		| 'queued'
		| 'extracting'
		| 'processing'
		| 'pending_review'
		| 'confirmed'
		| 'imported'
		| 'skipped'
		| 'failed'
		// A document read as several items. It shows as one card that opens the
		// group's own page, where its items are reviewed.
		| 'grouped';

	type ItemCounts = {
		ready: number;
		needsAttention: number;
		confirmed: number;
		// How many of the confirmed items are income, and how many are transfers;
		// the rest are expenses. A group from before transfers has no count of them.
		confirmedIncome: number;
		confirmedTransfer?: number;
		skipped: number;
	};

	/**
	 * The chip tone of a finished group, from the records it made: income when
	 * every one is income, expense when every one is an expense, and plain when
	 * they are mixed, are transfers, or there are none.
	 */
	function groupTone(counts: ItemCounts): 'income' | 'expense' | 'mixed' {
		if (counts.confirmed === 0) return 'mixed';
		if (counts.confirmedIncome === counts.confirmed) return 'income';
		if (counts.confirmedIncome === 0 && !counts.confirmedTransfer) return 'expense';
		return 'mixed';
	}

	type Job = ReviewRow & {
		state: JobState;
		originalFilename: string;
		error: string | null;
		// The record this document became, once it is imported. The history row links to it.
		resultId: number | null;
		resultType: number | null;
		// How the document was to be read, and how it was read (006 FR-001).
		readAs: string | null;
		readHow: string | null;
		// The saved profile's id when it was read with one; else a built-in schema id or null.
		profileId: string | null;
		// What the uploader chose under "Import" (FR-002), for a profile or Auto-detect; else null.
		importMode: string | null;
		// The import profile it was read with, by name, when it was (FR-041).
		profile: { name: string; mode: string } | null;
		// The stated total, the items' sum and the lines left out, as JSON.
		extractionNotes: string | null;
		// Where a group's items stand. Absent for a receipt.
		itemCounts: ItemCounts | null;
		// Whether "Read again" would be accepted now, and if not, why (FR-023).
		// The server works it out; nothing here copies the rule.
		canReadAgain: boolean;
		readAgainReason: string | null;
		// When its last reading finished; a different value is a new reading.
		processedAt: string | null;
		// How many parts of a long document are read, and how many it has (FR-043).
		// Null unless it is being read in parts.
		progressDone: number | null;
		progressTotal: number | null;
		// client-side tracking
		_edits?: ReviewEdits;
		// Set from the confirm reply when no category could be read off the document.
		_uncategorised?: boolean;
	};

	// Convert a raw DB queue row (INT enum codes) into a display Job (string labels).
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	function normalizeJob(j: any): Job {
		return {
			...reviewRowFrom(j),
			state: (importStateEnum.toLabel(j.state) ?? 'queued') as JobState,
			originalFilename: j.originalFilename,
			error: j.error,
			resultId: j.resultId ?? null,
			resultType: j.resultType ?? null,
			readAs: j.readAs ?? null,
			readHow: j.readHow ?? null,
			profileId: j.profileId ?? null,
			importMode: j.importMode ?? null,
			profile: j.profile ?? null,
			extractionNotes: j.extractionNotes ?? null,
			itemCounts: j.itemCounts ?? null,
			canReadAgain: j.canReadAgain === true,
			readAgainReason: j.readAgainReason ?? null,
			processedAt: j.processedAt ?? null,
			progressDone: j.progressDone ?? null,
			progressTotal: j.progressTotal ?? null,
			_edits: {},
		};
	}

	const reviewOptions = $derived<ReviewOptions>({
		allAccounts: data.allAccounts,
		categoryAccounts: data.categoryAccounts,
		transferAccounts: data.transferAccounts,
		payableAccountId: data.payableAccountId,
		receivableAccountId: data.receivableAccountId,
		uncategorisedAccountId: data.uncategorisedAccountId,
		uncategorisedIncomeAccountId: data.uncategorisedIncomeAccountId
	});

	// Initialize from SSR data, converting DB rows to typed Job objects
	// svelte-ignore state_referenced_locally
	let jobs = $state<Job[]>(data.jobs.map(normalizeJob));

	// Source determines direction. Target is always the narrowed other side.
	// svelte-ignore state_referenced_locally
	let sourceAccountByJob = $state<Record<string, number | null>>(
		Object.fromEntries(jobs.map((j) => [j.id, receiptSides(j, reviewOptions, keepsReadAccount(j)).source]))
	);
	// svelte-ignore state_referenced_locally
	let targetAccountByJob = $state<Record<string, number | null>>(
		Object.fromEntries(jobs.map((j) => [j.id, receiptSides(j, reviewOptions, keepsReadAccount(j)).target]))
	);
	let sourceAccountTouched = $state<Record<string, boolean>>({});
	let targetAccountTouched = $state<Record<string, boolean>>({});

	// Store original file references for retry
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- File objects must stay outside $state.
	const fileStore = new Map<string, File>();

	// Why a job's import was refused, keyed by job id. Cleared when it goes through.
	let confirmErrors = $state<Record<string, string>>({});

	let drag = $state(false);
	let fileInput: HTMLInputElement | null = $state(null);
	let clearHistoryDialogOpen = $state(false);

	// ── How the next upload is read (006 FR-001) ──────────────────────────────
	// The choices come from the server, first one the default, so saved profiles
	// can join the list later. The last choice is remembered on this device only.
	const READ_AS_KEY = 'akaun.import.readAs';
	// svelte-ignore state_referenced_locally
	let readAs = $state<string>(data.readAsChoices[0]?.value ?? 'auto');
	const readAsLabel = $derived(data.readAsChoices.find((c) => c.value === readAs)?.label ?? 'Auto-detect');
	// Why the last upload was refused, shown under the drop zone.
	let uploadError = $state<string | null>(null);

	function setReadAs(value: string) {
		if (!data.readAsChoices.some((c) => c.value === value)) return;
		readAs = value;
		try {
			localStorage.setItem(READ_AS_KEY, value);
		} catch {
			// Storage can be blocked; the choice then lasts for this visit only.
		}
	}

	const screen = useIsMobile();
	const isMobile = $derived(screen.current);
	let showScanner = $state(false);
	let scanInitialDataUrl = $state('');
	let scanInputEl: HTMLInputElement | null = $state(null);

	// Trigger the OS camera directly from the FAB's own tap — a hidden input's
	// .click() only reliably opens the picker when called synchronously inside
	// a real user gesture, so this can't wait on opencv.js loading first.
	// Kick that load off now instead; it runs in the background while the user
	// is in the camera app, ready by the time EditView needs it.
	function openScanCamera() {
		loadOpenCv();
		scanInputEl?.click();
	}

	function handleScanFileSelected(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
		const reader = new FileReader();
		reader.onload = () => {
			scanInitialDataUrl = reader.result as string;
			showScanner = true;
		};
		reader.readAsDataURL(file);
	}

	function handleScanFinish(file: File) {
		showScanner = false;
		uploadFiles([file]);
	}

	const PIPE_STATES = ['queued', 'extracting', 'processing'];
	const PIPE_FILL: Record<string, number> = {
		queued: 10,
		extracting: 45,
		processing: 78,
	};

	// How full a queued document's bar is. A long document read in parts fills
	// the rest of the bar part by part from where reading starts, so it never
	// moves back (FR-043).
	function pipeFill(job: Job): number {
		const total = job.progressTotal ?? 0;
		if (job.state === 'processing' && total > 1) {
			const done = Math.min(Math.max(job.progressDone ?? 0, 0), total);
			const start = PIPE_FILL.processing;
			return Math.round(start + ((96 - start) * done) / total);
		}
		return PIPE_FILL[job.state] ?? 10;
	}

	// What kind of file a queued document is, by its name: a spreadsheet is read
	// cell by cell, with no OCR (006 FR-051).
	function fileKindLabel(filename: string): string {
		const lower = filename.toLowerCase();
		if (lower.endsWith('.pdf')) return 'PDF';
		if (lower.endsWith('.xlsx') || lower.endsWith('.csv')) return 'Spreadsheet';
		return 'Image · OCR';
	}

	const pipeline = $derived(jobs.filter((j) => PIPE_STATES.includes(j.state)));
	const failed = $derived(jobs.filter((j) => j.state === 'failed'));
	const review = $derived(jobs.filter((j) => j.state === 'pending_review'));
	// Documents read as several items, still with items to review.
	const groups = $derived(jobs.filter((j) => j.state === 'grouped'));
	const history = $derived(jobs.filter((j) => ['confirmed', 'imported', 'skipped'].includes(j.state)));
	const confirmable = $derived(review.filter((j) => !j.duplicateOf && !jobAccountMissing(j)).length);
	let _es: EventSource | null = null;

	// onMount/onDestroy guarantee exactly one connection per page visit — no reactive re-runs
	onMount(() => {
		try {
			const stored = localStorage.getItem(READ_AS_KEY);
			if (stored && data.readAsChoices.some((c) => c.value === stored)) readAs = stored;
		} catch {
			// No storage: keep the default.
		}

		_es = new EventSource('/api/import/stream');

		_es.onmessage = (e) => {
			const msg = JSON.parse(e.data);
			if (msg.type === 'snapshot') {
				mergeServerJobs(msg.jobs);
			} else if (msg.type === 'job-update') {
				mergeServerJobs([msg.job]);
			} else if (msg.type === 'job-deleted') {
				jobs = jobs.filter((j) => j.id !== msg.jobId);
			}
			// `item-update` and `item-deleted` are about one item of a group, not a
			// queue row: they belong to the group's own page. The group's card here
			// changes through the `job-update` that follows each of them, which
			// carries its new counts. An item is never merged in as a job.
		};
	});

	onDestroy(() => {
		_es?.close();
	});

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	function mergeServerJobs(incomingRaw: any[]) {
		const incoming = incomingRaw.map(normalizeJob);
		const byId = new Map(incoming.map((j) => [j.id, j]));
		const existingIds = new Set(jobs.map((j) => j.id));

		// Update existing jobs, preserve client-side _edits
		jobs = jobs.map((local) => {
			const server = byId.get(local.id);
			if (!server) return local;
			// Back in the queue: it is being read again (FR-023). Or a reading
			// that finished at another time than the one on screen, when this tab
			// missed it going back (a reconnect whose snapshot already shows the
			// new card, say).
			const readAgain =
				(PIPE_STATES.includes(server.state) && !PIPE_STATES.includes(local.state)) ||
				(server.processedAt !== null && local.processedAt !== null && server.processedAt !== local.processedAt);
			if (readAgain) {
				// What the reviewer typed into the last reading's card belongs to
				// that reading, so it goes, and the new reading's accounts are taken
				// as they come.
				delete sourceAccountTouched[local.id];
				delete targetAccountTouched[local.id];
				delete confirmErrors[local.id];
				return server;
			}
			return {
				...server,
				_edits: local._edits ?? {},
				_uncategorised: local._uncategorised,
			};
		});

		// Prepend jobs added in another tab that we don't know about yet
		const brandNew = incoming.filter((j) => !existingIds.has(j.id));
		if (brandNew.length > 0) {
			jobs = [...brandNew, ...jobs];
		}

		// Live extraction may replace an automatic fallback. Only an actual reviewer
		// choice is protected from subsequent server updates.
		for (const j of incoming) {
			const sides = receiptSides(j, reviewOptions, keepsReadAccount(j));
			sourceAccountByJob[j.id] = syncImportAccountSelection(
				sourceAccountByJob[j.id],
				sides.source,
				sourceAccountTouched[j.id] === true,
			);
			targetAccountByJob[j.id] = syncImportAccountSelection(
				targetAccountByJob[j.id],
				sides.target,
				targetAccountTouched[j.id] === true,
			);
		}
	}

	// Set the contact intent (existing id, typed new name, or cleared) for a review row.
	function setContact(jobId: string, v: { value: number | null; newName: string | null }) {
		jobs = jobs.map((j) => {
			if (j.id !== jobId) return j;
			const edits = { ...(j._edits ?? {}) };
			delete edits.contactId;
			delete edits.newContactName;
			// An explicit empty supplier suppresses the extracted name and stale match.
			edits.supplier = v.newName ?? '';
			if (v.value != null) edits.contactId = v.value;
			else if (v.newName) edits.newContactName = v.newName;
			return { ...j, _edits: edits };
		});
	}

	/**
	 * Uploads one file. Returns the new job's id, or null when it was refused or did not arrive.
	 * A profile is read in its own import mode (FR-002), so "Read as" is the only choice sent.
	 */
	async function uploadFile(file: File, readAsOverride?: string): Promise<string | null> {
		const form = new FormData();
		form.append('file', file);
		form.append('readAs', readAsOverride ?? readAs);
		try {
			const res = await fetch('/api/import', {
				method: 'POST',
				body: form,
				credentials: 'include',
			});
			if (!res.ok) {
				const err = await res.json().catch(() => ({ error: 'Upload failed' }));
				console.error('Upload error:', err.error);
				uploadError = `${file.name}: ${err.error ?? 'Upload failed'}`;
				return null;
			}
			uploadError = null;
			const { jobId } = await res.json();
			fileStore.set(jobId, file); // kept for Retry button on failed jobs
			return jobId;
		} catch (err) {
			console.error('Upload failed:', err);
			uploadError = `${file.name}: the upload did not reach the server. Check the connection and try again.`;
			return null;
		}
	}

	async function uploadFiles(files: FileList | File[], readAsOverride?: string) {
		for (const file of Array.from(files)) await uploadFile(file, readAsOverride);
	}

	function handleDrop(e: DragEvent) {
		e.preventDefault();
		drag = false;
		if (e.dataTransfer?.files) uploadFiles(e.dataTransfer.files);
	}

	function handleFileInput(e: Event) {
		const input = e.target as HTMLInputElement;
		if (input.files) uploadFiles(input.files);
		input.value = '';
	}

	async function confirmJob(jobId: string) {
		const job = jobs.find((j) => j.id === jobId);
		if (!job) return;
		// A foreign-currency job can't be imported without a rate to convert it.
		if (reviewRateMissing(job, job._edits ?? {}, mainCurrency())) return;
		// A record has to say which account paid for it or received it.
		if (jobAccountMissing(job)) return;

		const isIncome = jobIsIncome(job);
		const fromAccountId = sourceAccountByJob[jobId];
		const toAccountId = targetAccountByJob[jobId];
		if (fromAccountId == null || toAccountId == null) return;
		const body = {
			...(job._edits ?? {}),
			fromAccountId,
			toAccountId,
			// The reading this card shows. If the document was read again meanwhile,
			// the server refuses rather than import the new reading with these edits.
			readAt: job.processedAt,
		};
		const res = await fetch(`/api/import/${jobId}/confirm`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			credentials: 'include',
		});
		if (!res.ok) {
			// A rule refused it and nothing was written — say why, on the card.
			const err = await res.json().catch(() => ({}));
			confirmErrors[jobId] = err.error ?? "That couldn't be imported. Try again.";
			return;
		}
		delete confirmErrors[jobId];

		const result = await res.json().catch(() => ({ uncategorised: false }));
		jobs = jobs.map((j) =>
			j.id === jobId
				? {
						...j,
						state: 'confirmed' as JobState,
						// A transfer stays a transfer; the accounts chose the kind of anything else.
						documentType: isTransferRow(j) ? j.documentType : isIncome ? 'income' : 'expense',
						// The reply names the new record, so the history row can link to it
						// before the live update arrives.
						resultId: typeof result.id === 'number' ? result.id : j.resultId,
						_uncategorised: !!result.uncategorised,
					}
				: j,
		);
		// Transition to imported after a moment (the server does it async)
		setTimeout(() => {
			jobs = jobs.map((j) => (j.id === jobId ? { ...j, state: 'imported' as JobState } : j));
		}, 800);
	}

	async function confirmAll() {
		const toConfirm = review.filter((j) => !j.duplicateOf && !jobAccountMissing(j));
		await Promise.all(toConfirm.map((j) => confirmJob(j.id)));
	}

	async function skipJob(jobId: string) {
		const res = await fetch(`/api/import/${jobId}/skip`, {
			method: 'POST',
			credentials: 'include',
		});
		if (res.ok) {
			jobs = jobs.map((j) => (j.id === jobId ? { ...j, state: 'skipped' as JobState } : j));
		}
	}

	// "Skip" on a group card: every item still waiting is skipped, as "Skip all"
	// does on the group's page. The state is not set here: the group ends
	// skipped, imported (some items were already confirmed) or still grouped (an
	// item is mid-confirm), and the job-update event says which.
	let skipGroupAsk = $state<{ id: string; filename: string; waiting: number } | null>(null);
	let skipGroupDialogOpen = $state(false);
	let skippingGroups = $state<Record<string, boolean>>({});

	function askSkipGroup(job: Job) {
		const counts = job.itemCounts;
		skipGroupAsk = {
			id: job.id,
			filename: job.originalFilename,
			waiting: (counts?.ready ?? 0) + (counts?.needsAttention ?? 0),
		};
		skipGroupDialogOpen = true;
	}

	async function skipGroup(jobId: string) {
		skippingGroups[jobId] = true;
		try {
			const res = await fetch(`/api/import/${jobId}/skip`, {
				method: 'POST',
				credentials: 'include',
			});
			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				confirmErrors[jobId] = err.error ?? "That couldn't be skipped. Try again.";
				return;
			}
			delete confirmErrors[jobId];
		} finally {
			delete skippingGroups[jobId];
		}
	}

	async function retryJob(jobId: string) {
		const file = fileStore.get(jobId);
		if (!file) return;
		// Read it again the way it was asked to be read the first time. If that
		// was a profile turned off since, the upload refuses it by name. A
		// profile brings its own import mode, so nothing else is sent.
		const job = jobs.find((j) => j.id === jobId);
		const previousReadAs = job ? readAsOfJob(job) : undefined;

		// Upload again first. A refused retry (the profile was turned off or
		// deleted since, say) keeps the failed row and its reason, and the upload
		// area says why it was refused.
		const newJobId = await uploadFile(file, previousReadAs);
		if (!newJobId) return;

		// Only now that the new upload is queued does the failed one go.
		await fetch(`/api/import/${jobId}`, {
			method: 'DELETE',
			credentials: 'include',
		});
		jobs = jobs.filter((j) => j.id !== jobId);
		fileStore.delete(jobId);
	}

	async function discardJob(jobId: string) {
		await fetch(`/api/import/${jobId}`, {
			method: 'DELETE',
			credentials: 'include',
		});
		jobs = jobs.filter((j) => j.id !== jobId);
	}

	async function clearHistory() {
		await fetch('/api/import/history', {
			method: 'DELETE',
			credentials: 'include',
		});
		jobs = jobs.filter((j) => !['confirmed', 'imported', 'skipped'].includes(j.state));
		clearHistoryDialogOpen = false;
	}

	function updateEdit(jobId: string, key: string, value: string | number) {
		jobs = jobs.map((j) => {
			if (j.id !== jobId) return j;
			return { ...j, _edits: { ...(j._edits ?? {}), [key]: value } };
		});
	}

	// Whether any import profile is turned on. With none, the standard reading
	// is the only one Auto-detect gives, so it is not labelled (FR-003).
	const profilesEnabled = $derived(hasProfileChoice(data.readAsChoices));

	/**
	 * How a document is read, as its card or row says it (FR-041): a saved
	 * profile, chosen or detected, several items, or the standard reading. A
	 * document still waiting to be read, or whose reading failed, says how it
	 * was asked to be read. See `readingLabel`.
	 */
	function jobReading(job: Job): string | null {
		return readingLabel(job, {
			profilesEnabled,
			waiting: PIPE_STATES.includes(job.state) || job.state === 'failed'
		});
	}

	// ── Read again (006 FR-023) ───────────────────────────────────────────────
	let readAgainJob = $state<Job | null>(null);
	let readAgainOpen = $state(false);

	function openReadAgain(job: Job) {
		readAgainJob = job;
		readAgainOpen = true;
	}

	/** What reading this document again throws away, for the dialog to say. */
	function readAgainReplaces(job: Job): string {
		// A group is read again from its own page, which says this itself.
		if (job.state === 'failed') return 'Nothing was read from it last time, so nothing is lost.';
		return 'This card, and any change you made on it, is replaced by the new reading.';
	}

	function jobIsIncome(job: Job): boolean {
		return sideIsIncome(job, reviewOptions, sourceAccountByJob[job.id]);
	}

	function setSourceAccount(jobId: string, value: number): void {
		const job = jobs.find((candidate) => candidate.id === jobId);
		if (job && isTransferRow(job)) {
			// A transfer (FR-058): the other side stays, unless it is now the same account.
			sourceAccountByJob[jobId] = value;
			sourceAccountTouched[jobId] = true;
			if (targetAccountByJob[jobId] === value) {
				targetAccountByJob[jobId] = null;
				targetAccountTouched[jobId] = true;
			}
			return;
		}
		const wasIncome = job ? jobIsIncome(job) : false;
		sourceAccountByJob[jobId] = value;
		sourceAccountTouched[jobId] = true;
		targetAccountTouched[jobId] = true;
		const isIncome = sideIsIncome({ documentType: null }, reviewOptions, value);
		targetAccountByJob[jobId] = targetAfterSourceChange(reviewOptions, value, targetAccountByJob[jobId] ?? null);
		if (job && isIncome !== wasIncome) {
			// Matches and suggestions were resolved using the LLM's original role.
			// Do not silently carry one across an Expense/Income correction.
			jobs = jobs.map((candidate) =>
				candidate.id === jobId ? { ...candidate, matchedContactId: null, matchCandidates: [] } : candidate,
			);
		}
	}

	function setTargetAccount(jobId: string, raw: string): void {
		const value = Number(raw);
		targetAccountByJob[jobId] = Number.isInteger(value) && value > 0 ? value : null;
		targetAccountTouched[jobId] = true;
	}

	function jobAccountMissing(job: Job): boolean {
		return sourceAccountByJob[job.id] == null || targetAccountByJob[job.id] == null;
	}

	// Fetch a rate for a job's foreign currency + date, storing it as an edit override.
	async function fetchJobRate(jobId: string) {
		const job = jobs.find((j) => j.id === jobId);
		if (!job) return;
		const edits = job._edits ?? {};
		const cur = reviewCurrency(job, edits, mainCurrency());
		const date = String(editedValue(job, edits, 'date', mainCurrency()));
		if (cur === mainCurrency() || !date) return;
		try {
			const res = await fetch(`/api/exchange-rate?from=${cur}&to=${mainCurrency()}&date=${date}`);
			const json = await res.json();
			if (json.rate != null) updateEdit(jobId, 'exchangeRate', String(json.rate));
		} catch {
			// leave blank for manual entry
		}
	}

	function setJobCurrency(jobId: string, code: string) {
		updateEdit(jobId, 'currency', code);
		if (code === mainCurrency()) updateEdit(jobId, 'exchangeRate', '1');
		else fetchJobRate(jobId);
	}

	/** What a finished receipt became, for its chip. */
	function historyKind(job: Job): { label: string; tone: 'income' | 'expense' | 'mixed' } {
		if (isTransferRow(job)) return { label: 'Transfer', tone: 'mixed' };
		return job.documentType === 'income' ? { label: 'Income', tone: 'income' } : { label: 'Expense', tone: 'expense' };
	}

	function bucketPath(job: Job): string {
		if (!job.date) return '—';
		const [y, m] = job.date.split('-');
		const base = isTransferRow(job) ? 'transfers' : job.documentType === 'income' ? 'income' : 'expenses';
		return `${base}/${y}/${m}`;
	}

	function displayTitle(job: Job): string {
		return job.itemName || job.originalFilename;
	}
</script>


<svelte:head>
	<title>Auto Import - Akaun</title>
</svelte:head>

<div class="screen">
	<header class="topbar">
		<div class="topbar-left">
			<h1 class="page-title">Auto Import</h1>
			<p class="page-sub">
				Drop receipts &amp; invoices — text is extracted, then AI classifies each as income or expense and fills the
				fields
			</p>
		</div>
		<div class="topbar-right">
			{#if pipeline.length > 0}
				<span class="proc-pill">
					<span class="dot-pulse"></span>
					{pipeline.length} in pipeline · live
				</span>
			{/if}
		</div>
	</header>

	<div class="dash-scroll">
		<!-- Drop zone -->
		<div
			class="dropzone"
			class:drag
			role="button"
			tabindex="0"
			ondragover={(e) => {
				e.preventDefault();
				drag = true;
			}}
			ondragleave={() => (drag = false)}
			ondrop={handleDrop}
			onclick={() => fileInput?.click()}
			onkeydown={(e) => e.key === 'Enter' && fileInput?.click()}
		>
			<div class="dropzone-icon"><Upload size={26} /></div>
			<div class="dropzone-title">Drop files here, or <u>browse</u></div>
			<div class="dropzone-sub">
				PDF, JPG, PNG, Excel (.xlsx) or CSV · scanned files run through OCR · income &amp; expenses detected
				automatically
			</div>
		</div>
		<input
			bind:this={fileInput}
			type="file"
			accept=".pdf,.jpg,.jpeg,.png,.xlsx,.csv"
			multiple
			style="display:none"
			onchange={handleFileInput}
		/>
		<div class="upload-options">
			<span class="upload-option-label">Read as</span>
			<Select.Root type="single" value={readAs} onValueChange={setReadAs}>
				<Select.Trigger class="upload-readas" aria-label="Read as">{readAsLabel}</Select.Trigger>
				<Select.Content>
					{#each data.readAsChoices as choice (choice.value)}
						<Select.Item value={choice.value} label={choice.label} />
					{/each}
				</Select.Content>
			</Select.Root>
			{#if profilesEnabled && readAs === ImportReadAs.Auto}
				<span class="upload-option-hint">Uses a saved profile that fits the document, or else reads it the standard way.</span>
			{/if}
		</div>
		{#if uploadError}
			<div class="upload-error" role="alert">{uploadError}</div>
		{/if}

		<!-- Pipeline -->
		{#if pipeline.length > 0}
			<div class="import-section">
				<div class="import-section-head between">
					<span class="ish-left">
						<span class="dot-pulse"></span>
						Processing queue
						<span class="hbadge">{pipeline.length}</span>
					</span>
					<span class="cap-note">{pipeline.filter((j) => j.state !== 'queued').length}/3 workers active</span>
				</div>
				<div class="pipe-list">
					{#each pipeline as job (job.id)}
						<div class="pipe-row" class:queued={job.state === 'queued'}>
							<div class="pipe-icon">
								{#if job.state === 'queued'}
									<Clock size={15} />
								{:else}
									<Receipt size={15} />
								{/if}
							</div>
							<div class="pipe-main">
								<div class="pipe-toprow">
									<span class="pipe-name">{job.originalFilename}</span>
									<span class="pipe-type">
										{fileKindLabel(job.originalFilename)}
									</span>
								</div>
								{#if jobReading(job)}<div class="job-reading">{jobReading(job)}</div>{/if}
								<div class="pipe-track">
									<div class="pipe-fill" style="width:{pipeFill(job)}%"></div>
								</div>
							</div>
							<div class="pipe-state" class:is-queued={job.state === 'queued'}>
								{#if job.state === 'queued'}
									<Clock size={13} /> Queued
								{:else if job.state === 'extracting'}
									<span class="spinner sm"></span> Extracting text…
								{:else}
									<span class="spinner sm"></span> {readingProgressLabel(job) ?? 'Reading with AI'}…
								{/if}
							</div>
						</div>
					{/each}
				</div>
			</div>
		{/if}

		<!-- Failed -->
		{#if failed.length > 0}
			<div class="import-section">
				<div class="import-section-head">
					Failed <span class="hbadge">{failed.length}</span>
				</div>
				<div class="pipe-list">
					{#each failed as job (job.id)}
						<div class="fail-card">
							<div class="fail-icon"><AlertTriangle size={16} /></div>
							<div class="fail-main">
								<div class="fail-name">{job.originalFilename}</div>
								{#if jobReading(job)}<div class="job-reading">{jobReading(job)}</div>{/if}
								<div class="fail-msg">{job.error ?? 'Unknown error'}</div>
							</div>
							<div class="fail-actions">
								{#if fileStore.has(job.id)}
									<Button variant="outline" size="sm" onclick={() => retryJob(job.id)}>
										<RotateCcw size={14} /> Retry
									</Button>
								{/if}
								{#if data.perms.readAgain}
									<!-- From the file already uploaded, so it works after a reload too,
									     and it can be read another way (FR-023). -->
									<Button
										variant="outline"
										size="sm"
										disabled={!job.canReadAgain}
										title={job.readAgainReason ?? 'Read this document again from its file, another way'}
										onclick={() => openReadAgain(job)}
									>
										Read again
									</Button>
								{/if}
								<Button variant="ghost" size="sm" onclick={() => discardJob(job.id)}>Discard</Button>
							</div>
						</div>
					{/each}
				</div>
			</div>
		{/if}

		<!-- Review -->
		<div class="import-section">
			<div class="import-section-head between">
				<span>Ready to review <span class="hbadge">{review.length + groups.length}</span></span>
				{#if confirmable > 0}
					<Button size="sm" onclick={confirmAll}>
						<Check size={15} /> Confirm all ({confirmable})
					</Button>
				{/if}
			</div>
			{#if review.length === 0 && groups.length === 0}
				<div class="import-empty">No items awaiting review. Drop a file above to start.</div>
			{:else}
				<div class="review-list">
					<!-- A document read as several items: one card that opens its page.
					     "Confirm all" above is for receipts only; a group has its own. -->
					{#each groups as job (job.id)}
						<ImportGroupCard
							{job}
							busy={skippingGroups[job.id] ?? false}
							error={confirmErrors[job.id] ?? null}
							onskip={data.perms.confirm ? () => askSkipGroup(job) : undefined}
						/>
					{/each}
					{#each review as job (job.id)}
						<ImportReviewCard
							row={job}
							edits={job._edits ?? {}}
							sourceAccountId={sourceAccountByJob[job.id] ?? null}
							targetAccountId={targetAccountByJob[job.id] ?? null}
							options={reviewOptions}
							heading={job.originalFilename}
							headingHref={resolve('/api/import/[jobId]/file', { jobId: job.id })}
							reading={jobReading(job)}
							error={confirmErrors[job.id] ?? null}
							onedit={(key, value) => updateEdit(job.id, key, value)}
							oncontact={(v) => setContact(job.id, v)}
							oncurrency={(code) => setJobCurrency(job.id, code)}
							onsource={(value) => setSourceAccount(job.id, value)}
							ontarget={(raw) => setTargetAccount(job.id, raw)}
							onconfirm={() => confirmJob(job.id)}
							onskip={() => skipJob(job.id)}
							onreadagain={data.perms.readAgain ? () => openReadAgain(job) : undefined}
							readAgainBlocked={job.readAgainReason}
						/>
					{/each}
				</div>
			{/if}
		</div>

		<!-- History (this session) -->
		{#if history.length > 0}
			<div class="import-section">
				<div class="import-section-head between">
					<span>This session <span class="hbadge">{history.length}</span></span>
					<Button variant="ghost" size="sm" onclick={() => (clearHistoryDialogOpen = true)}>Clear history</Button>
				</div>
				<div class="proc-list">
					{#each history as job (job.id)}
						{#if job.itemCounts}
							{@const made = job.itemCounts.confirmed}
							{@const tone = groupTone(job.itemCounts)}
							<!-- A finished group: its page lists each item and links each
							     confirmed one to its record (FR-021). -->
							<a
								href={resolve('/(app)/import/[id]', { id: job.id })}
								class="proc-row done related-link history-link"
								class:skip={made === 0}
							>
								<div class="proc-file">
									{#if made === 0}
										<span class="skip-check"><X size={11} /></span>
									{:else}
										<span class="ok-check"><Check size={11} strokeWidth={3} /></span>
									{/if}
									<span>{job.originalFilename}</span>
									<span
										class="type-chip"
										class:income={tone === 'income'}
										class:expense={tone === 'expense'}
										class:mixed={tone === 'mixed'}>{made} record{made === 1 ? '' : 's'}</span
									>
								</div>
								<span class="history-reading">{describeReading(job)}</span>
								<span class="proc-type">
									{job.itemCounts.confirmed} confirmed · {job.itemCounts.skipped} skipped
								</span>
								<ChevronRight size={14} color="var(--muted-foreground)" />
							</a>
						{:else if job.state === 'skipped'}
							<div class="proc-row skip">
								<div class="proc-file">
									<span class="skip-check"><X size={11} /></span>
									<span>{displayTitle(job)}</span>
								</div>
								{#if jobReading(job)}<span class="history-reading">{jobReading(job)}</span>{/if}
								<span class="proc-type">Skipped{job.duplicateOf ? ' · duplicate' : ''}</span>
								<span class="skip-amt"
									>{currencySymbol(job.currency)}
									{formatMoney(job.amount)}</span
								>
							</div>
						{:else}
							{@const importing = job.state === 'confirmed'}
							<!-- Once the record exists the whole row opens it. It has no other action. -->
							<svelte:element
								this={job.resultId != null ? 'a' : 'div'}
								href={job.resultId != null
									? resolve('/(app)/records/[id]', { id: String(job.resultId) })
									: undefined}
								class="proc-row done"
								class:importing
								class:related-link={job.resultId != null}
								class:history-link={job.resultId != null}
							>
								<div class="proc-file">
									{#if importing}
										<span class="spinner sm"></span>
									{:else}
										<span class="ok-check"><Check size={11} strokeWidth={3} /></span>
									{/if}
									<span>{displayTitle(job)}</span>
									<span
										class="type-chip"
										class:income={historyKind(job).tone === 'income'}
										class:expense={historyKind(job).tone === 'expense'}
										class:mixed={historyKind(job).tone === 'mixed'}
									>
										{historyKind(job).label}
									</span>
								</div>
								{#if jobReading(job)}<span class="history-reading">{jobReading(job)}</span>{/if}
								<span class="bucket-path"
									>{importing
										? 'Importing…'
										: job._uncategorised
											? `→ ${bucketPath(job)} · filed as Uncategorised`
											: '→ ' + bucketPath(job)}</span
								>
								<span class="imported-amt"
									>{currencySymbol(job.currency)}
									{formatMoney(job.amount)}</span
								>
								{#if job.resultId != null}
									<ChevronRight size={14} color="var(--muted-foreground)" />
								{/if}
							</svelte:element>
						{/if}
					{/each}
				</div>
			</div>
		{/if}
	</div>
</div>

{#if readAgainJob}
	<ReadAgainDialog
		bind:open={readAgainOpen}
		jobId={readAgainJob.id}
		filename={readAgainJob.originalFilename}
		choices={data.readAsChoices}
		current={readAsOfJob(readAgainJob)}
		replaces={readAgainReplaces(readAgainJob)}
	/>
{/if}

<ConfirmDialog
	bind:open={skipGroupDialogOpen}
	title="Skip every waiting item?"
	description={skipGroupAsk
		? `No record is made for the ${skipGroupAsk.waiting} item${skipGroupAsk.waiting === 1 ? '' : 's'} still waiting in ${skipGroupAsk.filename}. Items already confirmed keep their records.`
		: ''}
	confirmLabel="Skip"
	danger
	onConfirm={() => {
		const ask = skipGroupAsk;
		skipGroupDialogOpen = false;
		skipGroupAsk = null;
		if (ask) void skipGroup(ask.id);
	}}
/>

<ConfirmDialog
	bind:open={clearHistoryDialogOpen}
	title="Clear import history?"
	description="Removes every skipped, confirmed and imported entry from this list. Records already brought into the ledger are not affected — this only clears the log."
	confirmLabel="Clear history"
	danger
	onConfirm={clearHistory}
/>

{#if isMobile}
	<button type="button" class="scan-fab" onclick={openScanCamera} aria-label="Scan a document">
		<Camera size={20} />
		<span>Scan</span>
	</button>
	<input
		bind:this={scanInputEl}
		type="file"
		accept="image/*"
		capture="environment"
		style="display:none"
		onchange={handleScanFileSelected}
	/>
{/if}

{#if showScanner}
	<ScannerOverlay
		initialDataUrl={scanInitialDataUrl}
		onclose={() => (showScanner = false)}
		onfinish={handleScanFinish}
	/>
{/if}

<style>
	/* How a waiting or failed document is read, under its name. */
	.job-reading {
		font-size: 11.5px;
		color: var(--muted-foreground);
		margin-top: 2px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	/* "Read as": how the next upload is read. Beside the drop zone, not in it,
	   so choosing does not open the file picker. */
	.upload-options {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
		margin-top: -6px;
	}
	.upload-option-label {
		font-size: 12.5px;
		color: var(--muted-foreground);
		font-weight: 500;
	}
	.upload-options :global(.upload-readas) {
		min-width: 0;
		max-width: 100%;
		height: 34px;
	}
	.upload-option-hint {
		font-size: 12px;
		color: var(--muted-foreground);
	}
	/* How a finished document was read, in its history row. */
	.history-reading {
		font-size: 11.5px;
		color: var(--muted-foreground);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		min-width: 0;
		max-width: 40%;
	}
	.upload-error {
		font-size: 12px;
		color: var(--red);
		margin-top: -6px;
	}

	/* A history row that opens its record: a link that still looks like the other rows. */
	.history-link {
		color: inherit;
		text-decoration: none;
	}
	.history-link:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
	}

	.scan-fab {
		position: fixed;
		right: 16px;
		bottom: calc(56px + var(--safe-bottom) + 16px);
		z-index: 60;
		display: flex;
		height: 48px;
		gap: 8px;
		padding: 0 18px 0 16px;
		align-items: center;
		justify-content: center;
		border-radius: 999px;
		background: var(--primary);
		color: var(--primary-foreground);
		font-size: 14px;
		font-weight: 600;
		letter-spacing: -0.01em;
		box-shadow: var(--shadow-lg);
		transition:
			transform 0.15s,
			background-color 0.15s;
	}

	@media (hover: hover) {
		.scan-fab:hover {
			background: color-mix(in oklch, var(--primary) 94%, white);
		}
	}

	.scan-fab:active {
		transform: scale(0.96);
	}
</style>
