<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { toast } from 'svelte-sonner';
	import { ArrowDown, ArrowUp, Check, ChevronRight, Download, Plus, Trash2, X } from '@lucide/svelte';
	import DetailPage from '$lib/components/ui/DetailPage.svelte';
	import Disclosure from '$lib/components/ui/Disclosure.svelte';
	import * as Collapsible from '$lib/components/ui/collapsible/index.js';
	import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte';
	import AuditTrail from '$lib/components/ui/AuditTrail.svelte';
	import StatusBadge from '$lib/components/ui/StatusBadge.svelte';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import ProfileCategorySelect from './ProfileCategorySelect.svelte';
	import ProfileColumnSelect from './ProfileColumnSelect.svelte';
	import ProfileRowSorting from './ProfileRowSorting.svelte';
	import ProfileSampleTable from './ProfileSampleTable.svelte';
	import {
		PROFILE_FEE_TYPES_MAX,
		PROFILE_FILE_TYPES,
		PROFILE_FILE_TYPE_LABELS,
		PROFILE_PHRASES_MAX,
		PROFILE_SAME_MONEY_MAX,
		PROFILE_SECTIONS_MAX,
		ROW_CONDITIONS_MAX,
		TABLE_DATE_FORMATS,
		checkProfile,
		kindReadsTable,
		kindUsesAi,
		type ProfileError,
		type ProfileKind,
		type ProfileSectionKind,
		type RowConditionOp
	} from '$lib/import-profile-schema.js';
	import { ImportMode, importModeLabel, type ImportModeValue } from '$lib/import-reading.js';
	import {
		blankForm,
		errorsAt,
		errorsUnder,
		formFingerprint,
		formFromDraft,
		layoutHeadings,
		linesOf,
		newCondition,
		newFeeType,
		newSectionFor,
		payloadFromForm,
		problemPlace,
		readsFromTable,
		readsSpreadsheets,
		sectionKeys,
		setKind as setProfileKind,
		toggleFileType,
		type ConditionForm,
		type FeeTypeForm,
		type LayoutForm,
		type ProblemPlace,
		type ProfileForm,
		type RowsForm,
		type SectionForm
	} from '$lib/import-profile-form.js';
	import { layoutFromSample, sortingOf, type SampleInspection } from '$lib/import-profile-sample.js';
	import {
		downloadJson,
		draftFromFile,
		profileFile,
		profileFileName,
		takeImportedFile
	} from '$lib/import-profile-portable.js';
	import type { ImportProfileView } from '$lib/server/services/import-profiles.js';

	/**
	 * One import profile, on its own page: a new one (`profile` null) or a
	 * saved one (006 US6, FR-030, FR-031, FR-035).
	 *
	 * The whole profile is staged here and saved once, as on the Settings page:
	 * nothing reaches the server until Save, and the frame's guard stops a
	 * navigation that would drop the edits. The form writes the schema; the
	 * user never sees it. The one place raw JSON is typed is each section's
	 * "Advanced: extra fields", checked as it is typed by the same check the
	 * server runs (the sequence-template pattern), so the two never disagree.
	 *
	 * The profile says what it imports, once: Summary lines or Every
	 * transaction (FR-002, FR-032). Every section is read that way, and there
	 * is one stated total. To read one kind of document both ways, make two
	 * profiles. A profile saved when each section had its own mode, with
	 * sections in both, shows a problem on the sections in the other mode
	 * until they are moved or kept on purpose.
	 *
	 * A section can be a Transfer between the profile's account and another
	 * account that holds money (FR-058), and can name other profiles whose
	 * records describe the same money (FR-066).
	 *
	 * The page follows how a profile is built: what it is, how it reads, the
	 * spreadsheet's table, the sections, then how Auto-detect recognises it and
	 * what the AI is told. How it reads is one of three (FR-055, FR-057): by the
	 * AI; its table by code; or its table by code and the rest by the AI. A
	 * table is built from a sample spreadsheet: the sample's columns are shown
	 * with what each holds chosen above it, and the rows are sorted into
	 * sections by one column's values (`ProfileSampleTable`,
	 * `ProfileRowSorting`). The same sample is what "Try it" reads with the
	 * profile as it is on the page. Nothing about the sample is stored.
	 *
	 * Whether the profile is on or off is set from the list in Settings ›
	 * Intelligence, beside the AI providers, and not here.
	 */
	type Choice = { id: number; code: string; name: string };

	let {
		profile,
		expenseCategories,
		incomeCategories,
		moneyAccounts,
		otherProfiles,
		canChange
	}: {
		profile: ImportProfileView | null;
		expenseCategories: Choice[];
		incomeCategories: Choice[];
		/** Accounts that hold money: the profile's account and each transfer's other one (FR-058). */
		moneyAccounts: Choice[];
		/** The other saved profiles, which a section can name as the same money (FR-066). */
		otherProfiles: { id: number; name: string }[];
		canChange: boolean;
	} = $props();

	const HOME = '/settings?tab=intelligence';

	// ── The staged form ────────────────────────────────────────────────────────
	// The saved profile this page last knew: what Discard goes back to. A new
	// profile has none.
	// svelte-ignore state_referenced_locally
	let saved = $state<ImportProfileView | null>(profile);
	// svelte-ignore state_referenced_locally
	let form = $state<ProfileForm>(profile ? formFromDraft(profile) : blankForm());

	/**
	 * What "no unsaved changes" looks like. A saved profile: the form as saved.
	 * A new profile: the blank form, so an untouched page asks nothing on the
	 * way out.
	 */
	function baselineFor(view: ImportProfileView | null): string {
		return formFingerprint(view ? formFromDraft(view) : blankForm());
	}
	// svelte-ignore state_referenced_locally
	let baseline = $state(baselineFor(profile));

	// Another profile opened from here reuses this component: start again from
	// what the server sent for it.
	// svelte-ignore state_referenced_locally
	let seededFor = $state(profile?.id ?? null);
	$effect(() => {
		const id = profile?.id ?? null;
		if (id === seededFor) return;
		seededFor = id;
		saved = profile;
		form = profile ? formFromDraft(profile) : blankForm();
		baseline = baselineFor(profile);
		attempted = false;
		saveError = null;
		serverProblems = null;
	});

	const fingerprint = $derived(formFingerprint(form));
	const dirty = $derived(canChange && fingerprint !== baseline);
	let saving = $state(false);

	// ── Problems ───────────────────────────────────────────────────────────────
	// The shared check, run on every change. The server runs it again on save,
	// and adds what only it can see: a category archived since, or a name
	// another profile has. Those are kept for the form they were about.
	const checked = $derived(checkProfile(payloadFromForm(form)));
	const localProblems = $derived<ProfileError[]>(checked.ok ? [] : checked.errors);
	let serverProblems = $state<{ fingerprint: string; errors: ProfileError[] } | null>(null);
	const problems = $derived<ProfileError[]>([
		...localProblems,
		...(serverProblems && serverProblems.fingerprint === fingerprint ? serverProblems.errors : [])
	]);
	// A blank form is all problems; they are shown once Save is tried. The extra
	// fields are the exception: JSON is checked as it is typed.
	let attempted = $state(false);
	let saveError = $state<string | null>(null);

	function shown(path: string): string[] {
		return attempted ? errorsAt(problems, path) : [];
	}

	function extrasProblems(index: number): string[] {
		return errorsUnder(attempted ? problems : localProblems, `sections[${index}].extras`);
	}

	const keys = $derived(sectionKeys(form.sections));

	// ── Editing ────────────────────────────────────────────────────────────────
	// What the profile imports (FR-055, FR-057): the one choice that sets the
	// mode, the table and how each section is read.
	const KIND_CHOICES: { value: ProfileKind; label: string; hint: string }[] = [
		{
			value: 'table',
			label: 'Table rows',
			hint: 'Each row of a spreadsheet table becomes a record. The app reads it. No AI.'
		},
		{
			value: 'summary',
			label: 'Summary lines',
			hint: 'Totals and fees from the summary of a statement. The AI reads it.'
		},
		{
			value: 'transactions',
			label: 'Transaction lines',
			hint: 'Each transaction line of a document. The AI reads it.'
		},
		{
			value: 'mixed',
			label: 'Table rows and summary lines',
			hint: 'The table rows, and lines outside the table, for example a fee. Spreadsheets only.'
		}
	];

	const KINDS: { value: ProfileSectionKind; label: string }[] = [
		{ value: 'income', label: 'Income' },
		{ value: 'expense', label: 'Expense' },
		{ value: 'by_sign', label: 'By sign' },
		{ value: 'transfer', label: 'Transfer' }
	];

	/** The categories a section of this kind can name, as the server checks them. A transfer has none. */
	function categoryGroups(kind: ProfileSectionKind) {
		const groups: { label: string; choices: Choice[] }[] = [];
		if (kind === 'transfer') return groups;
		if (kind !== 'income') groups.push({ label: 'Expense or revenue deduction', choices: expenseCategories });
		if (kind !== 'expense') groups.push({ label: 'Income', choices: incomeCategories });
		return groups;
	}

	const accountGroups = $derived([{ label: 'Accounts', choices: moneyAccounts }]);

	/** The money accounts a transfer's other side can be: any but the profile's own. */
	const counterGroups = $derived([
		{ label: 'Accounts', choices: moneyAccounts.filter((account) => account.id !== form.accountId) }
	]);

	const profileNames = $derived(new Map(otherProfiles.map((other) => [other.id, other.name])));

	function toggleSameMoney(section: SectionForm, id: number) {
		section.sameMoneyAs = section.sameMoneyAs.includes(id)
			? section.sameMoneyAs.filter((other) => other !== id)
			: [...section.sameMoneyAs, id];
	}

	// ── The table layout and row rules (FR-053, FR-054) ────────────────────────
	// The headings as typed, once each, are what every column choice offers.
	const headings = $derived([...new Set(layoutHeadings(form.layout))]);
	const headingOptions = $derived(headings.map((heading) => ({ value: heading, label: heading })));

	const DATE_FORMATS = TABLE_DATE_FORMATS.map((format) => ({ value: format, label: format }));
	const DECIMALS = [
		{ value: '.', label: 'Point (1,234.50)' },
		{ value: ',', label: 'Comma (1.234,50)' }
	];
	const CSV_SEPARATORS = [
		{ value: ',', label: 'Comma' },
		{ value: ';', label: 'Semicolon' },
		{ value: '\t', label: 'Tab' },
		{ value: '|', label: 'Vertical bar' }
	];
	const OPS: { value: RowConditionOp; label: string }[] = [
		{ value: 'is', label: 'is' },
		{ value: 'is_not', label: 'is not' },
		{ value: 'is_one_of', label: 'is one of' },
		{ value: 'contains', label: 'contains' },
		{ value: 'empty', label: 'is empty' },
		{ value: 'not_empty', label: 'is not empty' }
	];

	// What only the AI uses is shown only when it reads some part.
	const usesAi = $derived(kindUsesAi(form.kind));
	const sorting = $derived(kindReadsTable(form.kind) ? sortingOf(form) : null);
	// What the profile reads (FR-070): a kind that reads a table reads only
	// spreadsheets, and only a profile that reads them has a sheet.
	const tableKind = $derived(kindReadsTable(form.kind));
	const readsSheets = $derived(readsSpreadsheets(form));

	// "Rows become": one section for every row, until the user splits the rows
	// by a column's values. A profile already split shows the split.
	let splitting = $state(false);
	const tableSections = $derived(form.sections.filter((section) => readsFromTable(form, section)));
	const oneSection = $derived(
		!splitting && tableSections.length === 1 && sorting !== null && sorting.assignments.size === 0
	);

	// The table set aside while the profile is switched to the AI, so that
	// switching back finds it as it was. It is not saved: an AI profile has none.
	let setAside: LayoutForm | null = null;

	function chooseKind(kind: ProfileKind) {
		if (!kindReadsTable(kind)) setAside = form.layout ?? setAside;
		else if (!form.layout && setAside) form.layout = setAside;
		setProfileKind(form, kind);
	}

	function addCondition(rows: RowsForm, which: 'where' | 'flagWhen') {
		rows[which] = [...rows[which], newCondition(headings[0] ?? '')];
	}

	function removeCondition(rows: RowsForm, which: 'where' | 'flagWhen', uid: string) {
		rows[which] = rows[which].filter((condition) => condition.uid !== uid);
	}

	/** Whether a condition compares with one value, a list, or nothing. */
	function opTakes(op: RowConditionOp): 'value' | 'values' | 'none' {
		if (op === 'is_one_of') return 'values';
		if (op === 'empty' || op === 'not_empty') return 'none';
		return 'value';
	}

	// ── The sample, and trying the profile on it (FR-053 to FR-055) ──────────
	// The sample is kept out of reactive state, as a File must be; only its
	// name and what the server found in it are. One sample serves both.
	let sampleFile: File | null = null;
	let sampleName = $state('');
	let sample = $state<SampleInspection | null>(null);
	let sampleLoading = $state(false);
	// "More options" under the table, open while the user keeps it open.
	let moreOpen = $state(false);
	let sampleError = $state<string | null>(null);

	/**
	 * Sends the sample to be looked at. A new file's table is taken as the
	 * layout when the layout has no headings yet, and offered otherwise
	 * (`ProfileSampleTable`); a table the user located is always taken.
	 */
	async function loadSample(file: File, where: { sheet: string; headerRow: number } | null = null) {
		if (sampleLoading) return;
		sampleLoading = true;
		sampleError = null;
		const body = new FormData();
		body.set('file', file);
		if (where) {
			body.set('sheet', where.sheet);
			body.set('headerRow', String(where.headerRow));
		} else if (form.sheet.trim()) {
			// The sheet the profile reads, so the columns shown are that sheet's (FR-069).
			body.set('sheet', form.sheet.trim());
		}
		try {
			const res = await fetch('/api/import/profiles/sample', { method: 'POST', body, credentials: 'include' });
			const reply = await res.json().catch(() => ({}));
			if (!res.ok) {
				sampleError =
					res.status === 403
						? 'You do not have permission to change import profiles.'
						: (reply.error ?? 'The app cannot read the sample. Try again.');
				return;
			}
			sampleFile = file;
			sampleName = file.name;
			sample = reply as SampleInspection;
			preview = null;
			previewError = null;
			if (where || !form.layout || linesOf(form.layout.headersText).length === 0) adoptSample(where !== null);
		} catch {
			sampleError = 'The server did not get the request. Make sure that you are connected, then try again.';
		} finally {
			sampleLoading = false;
		}
	}

	/**
	 * Takes the sample's table as the layout. The sample's sheet becomes the
	 * profile's when the file has several and the user typed none, or picked
	 * another table in the sample (`located`); a sheet the user typed is
	 * otherwise kept.
	 */
	function adoptSample(located = false) {
		if (!sample) return;
		form.layout = layoutFromSample(sample, form.layout);
		if (sample.sheets.length > 1 && (located || !form.sheet.trim())) form.sheet = sample.sheet;
	}
	// The form as it was previewed, to say when the preview no longer shows it.
	let previewedFingerprint = $state('');
	let previewing = $state(false);
	let previewError = $state<{ message: string; errors: ProfileError[] } | null>(null);
	type PreviewItem = {
		row: number | null;
		section: string;
		kind: string;
		date: string;
		description: string;
		amountMinor: number;
		reference: string;
		feeType: string | null;
		note: string | null;
	};
	type Preview = {
		mode: ImportModeValue;
		sheet: string;
		headerRow: number;
		rows: number;
		sections: { key: string; name: string; kind: string; count: number }[];
		aiSections: string[];
		items: PreviewItem[];
		itemCount: number;
		ignoredCount: number;
		ignored: string[];
		statedTotalMinor: number | null;
		itemsTotalMinor: number;
		balance: { matches: boolean; message: string } | null;
	};
	let preview = $state<Preview | null>(null);

	async function runPreview() {
		if (!sampleFile || previewing) return;
		previewing = true;
		previewError = null;
		const body = new FormData();
		body.set('file', sampleFile);
		body.set('profile', JSON.stringify(payloadFromForm(form)));
		const sent = fingerprint;
		try {
			const res = await fetch('/api/import/profiles/preview', { method: 'POST', body, credentials: 'include' });
			const reply = await res.json().catch(() => ({}));
			if (!res.ok) {
				preview = null;
				previewError = {
					message:
						res.status === 403
							? 'You do not have permission to change import profiles.'
							: (reply.error ?? 'The app cannot read the sample. Try again.'),
					errors: Array.isArray(reply.errors) ? reply.errors : []
				};
				return;
			}
			preview = reply as Preview;
			previewedFingerprint = sent;
		} catch {
			previewError = { message: 'The server did not get the request. Make sure that you are connected, then try again.', errors: [] };
		} finally {
			previewing = false;
		}
	}

	/** Whole cents as a figure with its sign. */
	function money(minor: number): string {
		const abs = Math.abs(minor);
		return `${minor < 0 ? '-' : ''}${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
	}

	const KIND_LABELS: Record<string, string> = {
		income: 'Income',
		expense: 'Expense',
		transfer_out: 'Transfer out',
		transfer_in: 'Transfer in',
		by_sign: 'By sign',
		transfer: 'Transfer'
	};

	/**
	 * Changes a section's kind. A category the new kind cannot take is cleared,
	 * rather than kept and refused on save: an income section cannot file a
	 * line under an expense category.
	 */
	function setKind(section: SectionForm, kind: ProfileSectionKind) {
		section.kind = kind;
		const allowed = new Set(categoryGroups(kind).flatMap((group) => group.choices.map((choice) => choice.id)));
		if (section.fixedCategoryAccountId != null && !allowed.has(section.fixedCategoryAccountId)) {
			section.fixedCategoryAccountId = null;
		}
		for (const fee of section.feeTypes) {
			if (fee.categoryAccountId != null && !allowed.has(fee.categoryAccountId)) fee.categoryAccountId = null;
		}
	}

	let phraseDraft = $state('');

	function addPhrase() {
		const phrase = phraseDraft.trim();
		if (!phrase) return;
		if (!form.phrases.some((existing) => existing.toLowerCase() === phrase.toLowerCase())) {
			form.phrases = [...form.phrases, phrase];
		}
		phraseDraft = '';
	}

	function removePhrase(index: number) {
		form.phrases = form.phrases.filter((_, at) => at !== index);
	}

	function addSection() {
		form.sections = [...form.sections, newSectionFor(form)];
	}

	// Which sections are folded to their summary line. A saved profile with
	// many sections opens folded; a section with a problem opens after a save
	// is tried, whatever was chosen.
	// svelte-ignore state_referenced_locally
	let folded = $state<Record<string, boolean>>(
		profile && profile.sections.length >= 3 ? Object.fromEntries(form.sections.map((s) => [s.uid, true])) : {}
	);
	function sectionOpen(section: SectionForm, index: number): boolean {
		if (attempted && errorsUnder(problems, `sections[${index}]`).length > 0) return true;
		return !folded[section.uid];
	}

	// ── Before you save ────────────────────────────────────────────────────────
	// Every problem, named by where it is on the page rather than by its path,
	// and a way to go to it. Shown as a to-do list from the start, so a new
	// profile says what it still needs; red once Save has been tried.
	const placedProblems = $derived(
		problems.map((problem) => ({ message: problem.message, place: problemPlace(problem.path, form) }))
	);

	// The expanders a jump to a problem opened: a section's "More" by its uid,
	// and the table's "More options". Kept open until the page is left, like
	// one the user opened.
	let revealed = $state<Record<string, boolean>>({});

	/** Whether a section's "More" must stay open: a problem inside it after Save, or a jump to one. */
	function sectionMoreForced(section: SectionForm, index: number): boolean {
		if (revealed[section.uid]) return true;
		if (!attempted) return false;
		const at = `sections[${index}]`;
		return ['rows.where', 'rows.flagWhen', 'rows.flagNote', 'sameMoneyAs', 'extras'].some(
			(part) => errorsUnder(problems, `${at}.${part}`).length > 0
		);
	}

	const FOCUSABLE = 'input:not([type="hidden"]), textarea, select, button, [tabindex]:not([tabindex="-1"])';

	/** Opens whatever folds the problem's field, then scrolls to it and puts the cursor in it. */
	async function goToProblem(place: ProblemPlace) {
		if (place.sectionUid) folded[place.sectionUid] = false;
		if (place.inMore === 'section' && place.sectionUid) revealed[place.sectionUid] = true;
		if (place.inMore === 'table') revealed.table = true;
		await tick();
		const target = place.targets.map((id) => document.getElementById(id)).find((el) => el !== null);
		if (!target) return;
		const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		target.scrollIntoView({ block: 'center', behavior: still ? 'auto' : 'smooth' });
		const field = target.matches(FOCUSABLE) ? target : target.querySelector<HTMLElement>(FOCUSABLE);
		field?.focus({ preventScroll: true });
	}

	/** The rows of the sample a table section takes, when the sample says. */
	function sampleCount(section: SectionForm): number | null {
		if (!sample || !sorting || !sorting.column) return null;
		const values = sample.columns.find((c) => c.heading === sorting!.column)?.distinct;
		if (!values) return null;
		return values
			.filter((v) => sorting!.assignments.get(v.value) === section.uid)
			.reduce((sum, v) => sum + v.count, 0);
	}

	/** Every table section's rules, cleared, to sort by one column instead. */
	function clearCustomRules() {
		for (const section of form.sections) {
			if (readsFromTable(form, section) && section.rows) section.rows.where = [];
		}
	}

	/** A line type column's values in the sample, to pick from. */
	function feeColumnValues(section: SectionForm): string[] | null {
		const column = section.rows?.feeTypeColumn;
		if (!sample || !column) return null;
		return sample.columns.find((c) => c.heading === column)?.distinct?.map((v) => v.value) ?? null;
	}

	function toggleFeeValue(fee: FeeTypeForm, value: string) {
		const values = linesOf(fee.valuesText);
		fee.valuesText = (values.includes(value) ? values.filter((v) => v !== value) : [...values, value]).join('\n');
	}

	function removeSection(uid: string) {
		form.sections = form.sections.filter((section) => section.uid !== uid);
	}

	function moveSection(index: number, by: -1 | 1) {
		const next = form.sections.slice();
		const target = index + by;
		if (target < 0 || target >= next.length) return;
		[next[index], next[target]] = [next[target], next[index]];
		form.sections = next;
	}

	function addFeeType(section: SectionForm) {
		section.feeTypes = [...section.feeTypes, newFeeType()];
	}

	function removeFeeType(section: SectionForm, uid: string) {
		section.feeTypes = section.feeTypes.filter((fee) => fee.uid !== uid);
	}

	// ── Saving ─────────────────────────────────────────────────────────────────
	let auditRef = $state<{ refresh: () => Promise<void> } | null>(null);

	function profileHref(id: number) {
		return resolve('/(app)/settings/import-profiles/[id]', { id: String(id) });
	}

	async function save() {
		if (saving || !canChange) return;
		attempted = true;
		saveError = null;
		if (localProblems.length > 0) {
			saveError = `Correct ${localProblems.length} problem${localProblems.length === 1 ? '' : 's'} before you save. They are listed under Before you save.`;
			return;
		}
		saving = true;
		const sentFingerprint = fingerprint;
		try {
			const res = await fetch(saved ? `/api/import/profiles/${saved.id}` : '/api/import/profiles', {
				method: saved ? 'PATCH' : 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payloadFromForm(form)),
				credentials: 'include'
			});
			const reply = await res.json().catch(() => ({}));
			if (!res.ok) {
				if (res.status === 403) saveError = 'You do not have permission to change import profiles.';
				else if (res.status === 404) saveError = 'This profile is deleted. You cannot save it. Go to Settings to make a new profile.';
				else {
					saveError = reply.error ?? 'The app cannot save the profile. Try again.';
					if (Array.isArray(reply.errors)) serverProblems = { fingerprint: sentFingerprint, errors: reply.errors };
				}
				return;
			}
			const view = reply as ImportProfileView;
			if (!saved) {
				// Saved: nothing is unsaved any more, so the guard lets the page go
				// to the new profile's own address. It takes the place of the "new"
				// page in the history, so Back goes to where the user came from and
				// not to an empty form for another profile.
				baseline = fingerprint;
				await tick();
				void goto(profileHref(view.id), { replaceState: true });
				toast.success('Import profile added');
				return;
			}
			saved = view;
			form = formFromDraft(view);
			baseline = formFingerprint(form);
			attempted = false;
			serverProblems = null;
			imported = null;
			void auditRef?.refresh();
			toast.success('Import profile saved');
		} catch {
			saveError = 'The server did not get the request. Make sure that you are connected, then try again.';
		} finally {
			saving = false;
		}
	}

	function revert() {
		setAside = null;
		imported = null;
		form = saved ? formFromDraft(saved) : blankForm();
		attempted = false;
		saveError = null;
		serverProblems = null;
	}

	// ── Deleting ───────────────────────────────────────────────────────────────
	let deleteOpen = $state(false);

	async function deleteProfile() {
		if (!saved) return;
		const res = await fetch(`/api/import/profiles/${saved.id}`, { method: 'DELETE', credentials: 'include' });
		if (!res.ok && res.status !== 404) {
			saveError =
				res.status === 403
					? 'You do not have permission to delete import profiles.'
					: 'The app cannot delete the profile. Try again.';
			return;
		}
		// Gone: what was staged here has nowhere to be saved, so leave without
		// asking about it.
		baseline = fingerprint;
		await tick();
		toast.success('Import profile deleted');
		// Replace the deleted profile's entry, so Back does not land on an
		// address that now only redirects.
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- a fixed in-app path with the tab to open.
		void goto(HOME, { replaceState: true });
	}

	// ── Moving a profile between installations ────────────────────────────────
	// One profile per file, with its accounts and categories named by code and
	// name rather than by id (`import-profile-portable.ts`).
	const portableChoices = $derived({ moneyAccounts, expenseCategories, incomeCategories, otherProfiles });

	/** Saves the profile as it was last saved, not the edits on the page. */
	function exportProfile() {
		if (!saved) return;
		// The file copies only a draft's own fields, so the id and dates stay behind.
		const { file, lost } = profileFile(saved, portableChoices);
		downloadJson(profileFileName(saved.name), file);
		if (lost.length > 0) {
			toast.warning('Exported without some references', {
				description: `These are no longer available here, so the file leaves them empty: ${lost.join('; ')}.`
			});
		}
	}

	/** The file the Settings list opened this page with: what it was, and what it named that is not here. */
	let imported = $state<{ fileName: string; unmatched: string[] } | null>(null);

	// A file chosen on the Settings list fills the form, and saves nothing. The
	// page is then unsaved like any other edit: Save adds the profile, or, on a
	// saved profile with the file's name, replaces it.
	onMount(() => {
		const waiting = takeImportedFile();
		if (!waiting || !canChange) return;
		const read = draftFromFile(waiting.file, portableChoices, saved?.id ?? null);
		if (!read.ok) {
			toast.error('Cannot import the profile', { description: read.error });
			return;
		}
		form = formFromDraft(read.draft);
		attempted = false;
		saveError = null;
		serverProblems = null;
		imported = { fileName: waiting.fileName, unmatched: read.unmatched };
		if (saved && formFingerprint(form) === baseline && read.unmatched.length === 0) {
			imported = null;
			toast.info('The file is the same as the saved profile');
		}
	});

	const title = $derived(saved ? saved.name : 'New import profile');
</script>

<svelte:head><title>{title} - Akaun</title></svelte:head>

<DetailPage
	backHref={HOME}
	backLabel="Settings"
	{dirty}
	{saving}
	saveLabel={saved ? 'Save profile' : 'Add profile'}
	dirtyNote={saved ? 'Unsaved changes' : 'Not saved yet'}
	onsave={save}
	onrevert={revert}
>
	{#snippet actions()}
		{#if saved}
			<button
				type="button"
				class="sheet-btn"
				disabled={dirty}
				title={dirty ? 'Save your changes to export them' : 'Save this profile as a file, to import it into another installation'}
				onclick={exportProfile}
			>
				<Download size={14} /> Export
			</button>
		{/if}
		{#if saved && canChange}
			<button type="button" class="sheet-btn sheet-btn-delete" onclick={() => (deleteOpen = true)}>
				<Trash2 size={14} /> Delete
			</button>
		{/if}
	{/snippet}

	{#snippet hero()}
		<div class="detail-hero-eyebrow">
			<span>Import profile</span>
			{#if saved}
				<span>·</span>
				<span>{saved.sections.length} section{saved.sections.length === 1 ? '' : 's'}</span>
			{/if}
		</div>
		<h1 class="detail-hero-title pf-title">{title}</h1>
		{#if saved}
			<div class="pf-hero-status">
				<StatusBadge status={saved.enabled ? 'profile-enabled' : 'profile-disabled'} />
				<span class="detail-hero-note">
					{saved.enabled ? 'Shown in “Read as” on the upload page.' : 'Not shown in “Read as”.'} To turn it on or off, go to Settings › Intelligence.
				</span>
			</div>
		{/if}
		{#if !canChange}
			<p class="detail-hero-note">You can only view this profile. To change it, you must have the permission to change imports.</p>
		{/if}
		{#if saveError}<p class="hero-error" role="alert">{saveError}</p>{/if}
	{/snippet}

	{#snippet main()}
		{#if imported}
			<section class="detail-card pf-imported" role="status">
				<div class="detail-card-head">
					<span class="detail-card-title">Imported from {imported.fileName}</span>
					<button type="button" class="sheet-close" aria-label="Dismiss" onclick={() => (imported = null)}>
						<X size={14} />
					</button>
				</div>
				<p class="pf-imported-text">
					{saved
						? 'Nothing is saved yet. When you save, this replaces the saved profile. Its history keeps what changed.'
						: 'Nothing is saved yet. Check the profile, then add it.'}
				</p>
				{#if imported.unmatched.length > 0}
					<p class="pf-imported-text">These are not in this installation, so they are empty. Choose them below before you save.</p>
					<ul class="pf-imported-missing">
						{#each imported.unmatched as missing, missingIndex (missingIndex)}
							<li>{missing}</li>
						{/each}
					</ul>
				{/if}
			</section>
		{/if}

		<section class="detail-card">
			<div class="detail-card-head"><span class="detail-card-title">Basics</span></div>

			<div class="field" id="pf-kind">
				<span class="field-label">What to import *</span>
				<div class="pf-modes pf-kinds" role="radiogroup" aria-label="What to import">
					{#each KIND_CHOICES as choice (choice.value)}
						<label class="pf-mode pf-kind" class:on={form.kind === choice.value}>
							<input
								type="radio"
								name="pf-kind"
								value={choice.value}
								checked={form.kind === choice.value}
								disabled={!canChange}
								onchange={() => chooseKind(choice.value)}
							/>
							<span class="pf-kind-glyph" aria-hidden="true">{@render kindGlyph(choice.value)}</span>
							<span class="pf-mode-main">
								<span class="pf-mode-label">{choice.label}</span>
								<span class="pf-mode-hint">{choice.hint}</span>
							</span>
						</label>
					{/each}
				</div>
				{@render problemList([...shown('kind'), ...shown('mode')])}
			</div>

			<div class="field" id="pf-file-types">
				<span class="field-label">Reads *</span>
				<div class="pf-modes" role="group" aria-label="Reads">
					{#each PROFILE_FILE_TYPES as type (type)}
						{@const on = tableKind ? type === 'spreadsheet' : form.fileTypes.includes(type)}
						<label class="pf-mode" class:on>
							<input
								type="checkbox"
								checked={on}
								disabled={!canChange || tableKind}
								onchange={() => toggleFileType(form, type)}
							/>
							<span class="pf-mode-main">
								<span class="pf-mode-label">{PROFILE_FILE_TYPE_LABELS[type].label}</span>
								<span class="pf-mode-hint">{PROFILE_FILE_TYPE_LABELS[type].hint}</span>
							</span>
						</label>
					{/each}
				</div>
				{#if tableKind}
					<p class="field-hint">Table rows are read from a spreadsheet's cells, so this profile reads Excel and CSV files only.</p>
				{/if}
				{@render problemList(shown('fileTypes'))}
			</div>

			<div class="field">
				<label class="field-label" for="pf-name">Name *</label>
				<Input id="pf-name" bind:value={form.name} disabled={!canChange} class="w-full" placeholder="Example: Marketplace monthly statement" />
				{@render problemList(shown('name'))}
			</div>

			<!-- The card's last field when there is no Sheet field below it. -->
			<div class="field" id="pf-account" style={readsSheets ? undefined : 'margin-bottom:0;'}>
				<span class="field-label">Account</span>
				<ProfileCategorySelect
					groups={accountGroups}
					value={form.accountId}
					noneLabel="None"
					ariaLabel="The account this document lists"
					missingLabel="Account no longer available"
					disabled={!canChange}
					onchange={(value) => (form.accountId = value)}
				/>
				<p class="field-hint">
					Optional. The account of the document, for example a marketplace wallet. Items use this account, not Accounts receivable or Accounts payable. Transfers move money into or out of this account. A Transfer section must have an account.
				</p>
				{@render problemList(shown('accountId'))}
			</div>

			{#if readsSheets}
				<div class="field" id="pf-l-sheet" style="margin-bottom:0;">
					<label class="field-label" for="pf-sheet">Sheet</label>
					<Input
						id="pf-sheet"
						bind:value={form.sheet}
						disabled={!canChange}
						class="w-full"
						list={sample && sample.sheets.length > 1 ? 'pf-sheet-names' : undefined}
						placeholder={kindReadsTable(form.kind) ? 'The sheet with the table headings' : 'The first sheet'}
					/>
					{#if sample && sample.sheets.length > 1}
						<datalist id="pf-sheet-names">
							{#each sample.sheets as option (option.name)}
								<option value={option.name}></option>
							{/each}
						</datalist>
					{/if}
					<p class="field-hint">
						For an Excel file with more than one sheet. A CSV file has one sheet, so this does not apply to it. The profile reads this one sheet only, and the AI never sees the other sheets. Leave it empty to read {kindReadsTable(form.kind) ? 'the sheet with the table headings' : 'the first sheet'}.
					</p>
					{@render problemList(shown('sheet'))}
				</div>
			{/if}
		</section>

		{#if form.layout}
			{@render spreadsheetCard(form.layout)}
		{/if}

		{#if kindReadsTable(form.kind) && form.layout}
			<div class="pf-sections-head" id="pf-sections">
				<h2 class="pf-group-title">Rows become</h2>
			</div>
			<div id="pf-sorting">
				<ProfileRowSorting bind:form bind:splitting {sample} {headings} {canChange} oncustomclear={clearCustomRules} />
			</div>
			{#each form.sections as section, index (section.uid)}
				{#if readsFromTable(form, section)}
					{@render sectionCard(section, index, oneSection)}
				{/if}
			{/each}
		{/if}

		{#if kindUsesAi(form.kind)}
			<div class="pf-sections-head" id={kindReadsTable(form.kind) && form.layout ? undefined : 'pf-sections'}>
				<h2 class="pf-group-title">{form.kind === 'mixed' ? 'Lines outside the table' : 'Lines to import'}</h2>
				{#if canChange && form.sections.length < PROFILE_SECTIONS_MAX}
					<button type="button" class="sheet-btn" onclick={addSection}><Plus size={14} /> Add section</button>
				{/if}
			</div>
			<p class="field-hint pf-sections-hint">
				Each section is one type of line, for example fees or sales. The AI finds the lines by the description.
			</p>
			{#each form.sections as section, index (section.uid)}
				{#if !readsFromTable(form, section)}
					{@render sectionCard(section, index, false)}
				{/if}
			{/each}
		{/if}
		{@render problemList(shown('sections'))}

		{#if form.layout && canChange}
			{@render previewCard()}
		{/if}

		<section class="detail-card">
			<div class="detail-card-head"><span class="detail-card-title">Auto-detect</span></div>
			<p class="field-hint" style="margin-top:0;">
				{kindReadsTable(form.kind)
					? 'Optional. Auto-detect finds this profile by the table headings. Add a description or phrases only if two profiles read the same table.'
					: 'Auto-detect uses these fields to select this profile for an upload.'}
			</p>
			{@render detectFields()}
		</section>

		{#if usesAi}
			<section class="detail-card">
				<div class="detail-card-head"><span class="detail-card-title">AI instructions</span></div>
				<div class="field">
					<label class="field-label" for="pf-instructions">Instructions</label>
					<Textarea id="pf-instructions" rows={5} bind:value={form.instructions} disabled={!canChange} class="leading-relaxed" />
					<p class="field-hint">
						Optional. These instructions replace the custom instructions in Settings › Intelligence for this profile. The app always sends its rules and your category list.
					</p>
					{@render problemList(shown('instructions'))}
				</div>
				<div class="field" style="margin-bottom:0;">
					<label class="field-label" for="pf-stated-total">Stated total</label>
					<Input
						id="pf-stated-total"
						bind:value={form.statedTotal}
						disabled={!canChange}
						class="w-full"
						placeholder={form.mode === ImportMode.EveryTransaction ? 'Example: Total money in' : 'Example: Total payout released'}
					/>
					<p class="field-hint">
						Optional. The label of the printed total. The import shows if the items agree with this total.{#if form.layout} The AI reads this total only if the table has no stated total labels.{/if}
					</p>
					{@render problemList(attempted ? errorsUnder(problems, 'statedTotalLabels') : [])}
				</div>
			</section>
		{/if}

	{/snippet}

	{#snippet rail()}
		{#if canChange && (!saved || dirty || problems.length > 0)}
			<section class="detail-card pf-check" class:attempted aria-labelledby="pf-check-title">
				<div class="detail-card-head">
					<span class="detail-card-title" id="pf-check-title">Before you save</span>
					{#if problems.length > 0}
						<span class="pf-check-count">{problems.length} to do</span>
					{/if}
				</div>
				{#if problems.length === 0}
					<p class="pf-check-ready"><Check size={14} aria-hidden="true" /> Ready to save</p>
				{:else}
					<ul class="pf-check-list">
						{#each placedProblems as item, itemIndex (itemIndex)}
							<li>
								<button type="button" class="pf-check-item" onclick={() => goToProblem(item.place)}>
									<span class="pf-check-place">{item.place.label}</span>
									<span class="pf-check-message">{item.message}</span>
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</section>
		{/if}
		{#if saved}
			<section class="detail-card">
				<div class="detail-card-head"><span class="detail-card-title">History</span></div>
				<AuditTrail bind:this={auditRef} recordType="import_profile" recordId={saved.id} />
			</section>
		{/if}
	{/snippet}
</DetailPage>

{#snippet problemList(messages: string[])}
	{#each messages as message, messageIndex (messageIndex)}
		<p class="pf-problem">{message}</p>
	{/each}
{/snippet}

{#snippet detectFields()}
		<div class="field">
			<label class="field-label" for="pf-description">Document description{kindReadsTable(form.kind) ? '' : ' *'}</label>
			<Textarea id="pf-description" rows={3} bind:value={form.description} disabled={!canChange} class="leading-relaxed" />
			<p class="field-hint">Write who sends the document and what it shows.</p>
			{@render problemList(shown('description'))}
		</div>

		<div class="field" id="pf-phrases" style="margin-bottom:0;">
			<label class="field-label" for="pf-phrase">Fixed phrases</label>
			{#if form.phrases.length > 0}
				<div class="pf-phrases">
					{#each form.phrases as phrase, index (phrase)}
						<span class="pf-phrase">
							<span class="pf-phrase-text">{phrase}</span>
							{#if canChange}
								<button type="button" class="pf-phrase-remove" aria-label="Remove {phrase}" onclick={() => removePhrase(index)}>
									<X size={12} />
								</button>
							{/if}
						</span>
					{/each}
				</div>
			{/if}
			{#if canChange && form.phrases.length < PROFILE_PHRASES_MAX}
				<div class="pf-inline">
					<Input
						id="pf-phrase"
						bind:value={phraseDraft}
						class="w-full"
						placeholder="Example: the document title"
						onkeydown={(event: KeyboardEvent) => {
							if (event.key === 'Enter') {
								event.preventDefault();
								addPhrase();
							}
						}}
					/>
					<button type="button" class="sheet-btn" disabled={!phraseDraft.trim()} onclick={addPhrase}>Add</button>
				</div>
			{/if}
			<p class="field-hint">Optional. Text that is always on the document. If a document has all these phrases, Auto-detect selects this profile without the AI.</p>
			{@render problemList(attempted ? errorsUnder(problems, 'phrases') : [])}
		</div>
{/snippet}

{#snippet kindGlyph(kind: ProfileKind)}
	<!-- What part of a document the kind takes: tinted, the part it imports. -->
	<svg viewBox="0 0 44 32" width="44" height="32" fill="none" stroke="currentColor" stroke-width="1.2">
		{#if kind === 'table' || kind === 'mixed'}
			{#if kind === 'mixed'}
				<rect x="4" y="2.5" width="22" height="3" rx="1" class="pf-glyph-on" />
			{/if}
			<rect x="4" y={kind === 'mixed' ? 9 : 4} width="36" height={kind === 'mixed' ? 20 : 24} rx="2" />
			{#each [0, 1, 2, 3] as row (row)}
				<rect
					x="4.6"
					y={(kind === 'mixed' ? 9 : 4) + 4.6 + row * (kind === 'mixed' ? 3.8 : 4.6)}
					width="34.8"
					height={kind === 'mixed' ? 2.6 : 3.2}
					class="pf-glyph-on"
					stroke="none"
				/>
			{/each}
			<line x1="16" y1={kind === 'mixed' ? 9 : 4} x2="16" y2="28" />
			<line x1="28" y1={kind === 'mixed' ? 9 : 4} x2="28" y2="28" />
		{:else if kind === 'summary'}
			<rect x="8" y="2" width="28" height="28" rx="2" />
			<line x1="12" y1="8" x2="32" y2="8" opacity="0.5" />
			<line x1="12" y1="12" x2="28" y2="12" opacity="0.5" />
			<rect x="12" y="17" width="20" height="3" rx="1" class="pf-glyph-on" />
			<rect x="12" y="23" width="20" height="3" rx="1" class="pf-glyph-on" />
		{:else}
			<rect x="8" y="2" width="28" height="28" rx="2" />
			{#each [0, 1, 2, 3, 4] as row (row)}
				<rect x="12" y={6 + row * 4.6} width="20" height="2.4" rx="1" class="pf-glyph-on" stroke="none" />
			{/each}
		{/if}
	</svg>
{/snippet}

{#snippet sectionCard(section: SectionForm, index: number, compact: boolean)}
	{@const at = `sections[${index}]`}
	{@const fromTable = readsFromTable(form, section)}
	{@const open = compact || sectionOpen(section, index)}
	{@const count = fromTable ? sampleCount(section) : null}
	<Collapsible.Root
		open={open}
		onOpenChange={(next) => {
			if (!compact) folded[section.uid] = !next;
		}}
	>
	<section class="detail-card pf-section" id="pf-s-{section.uid}" class:pf-folded={!open}>
		{#if compact}
			<div class="detail-card-head"><h3 class="pf-section-title">Every row</h3></div>
		{:else}
		<div class="detail-card-head">
			<Collapsible.Trigger class="pf-fold">
				<ChevronRight size={14} class={open ? 'pf-fold-open' : ''} aria-hidden="true" />
				<h3 class="pf-section-title">{section.name.trim() || `Section ${index + 1}`}</h3>
				<span class="pf-fold-meta">
					{KIND_LABELS[section.kind] ?? section.kind}{count !== null
						? `, ${count.toLocaleString('en-US')} row${count === 1 ? '' : 's'} in the sample`
						: ''}
				</span>
			</Collapsible.Trigger>
			{#if canChange}
				<span class="pf-section-tools">
					<button type="button" class="pf-icon-btn" aria-label="Move section up" disabled={index === 0} onclick={() => moveSection(index, -1)}><ArrowUp size={13} /></button>
					<button
						type="button"
						class="pf-icon-btn"
						aria-label="Move section down"
						disabled={index === form.sections.length - 1}
						onclick={() => moveSection(index, 1)}><ArrowDown size={13} /></button
					>
					<button
						type="button"
						class="pf-icon-btn pf-icon-danger"
						aria-label="Remove section"
						title={form.sections.length === 1 ? 'A profile must have one section or more.' : 'Remove section'}
						disabled={form.sections.length === 1}
						onclick={() => removeSection(section.uid)}
					>
						<Trash2 size={13} />
					</button>
				</span>
			{/if}
		</div>
		{/if}

		<Collapsible.Content>
			{@render problemList(shown(at))}

			{#if !compact}
			<div class="field">
				<label class="field-label" for="pf-s-{section.uid}-name">Name *</label>
				<Input id="pf-s-{section.uid}-name" bind:value={section.name} disabled={!canChange} class="w-full" placeholder="Example: Fees" />
				{@render problemList(shown(`${at}.name`))}
				{@render problemList(shown(`${at}.key`))}
			</div>
			{/if}


			{#if section.legacyMode && section.legacyMode !== form.mode}
				<!-- Saved when each section had its own mode (FR-032): shown at once, not only after Save. -->
				<div class="pf-legacy-mode" role="alert">
					{@render problemList(errorsAt(problems, `${at}.mode`))}
					{#if canChange}
						<button type="button" class="sheet-btn" onclick={() => (section.legacyMode = null)}>
							Keep it and import it as {importModeLabel(form.mode)}
						</button>
					{/if}
				</div>
			{/if}

			<div class="field" id="pf-s-{section.uid}-kind">
				<span class="field-label">Kind *</span>
				<div class="chip-row" role="radiogroup" aria-label="Kind">
					{#each KINDS as kind (kind.value)}
						<label class="chip" class:on={section.kind === kind.value}>
							<input
								type="radio"
								name="pf-kind-{section.uid}"
								value={kind.value}
								checked={section.kind === kind.value}
								disabled={!canChange}
								onchange={() => setKind(section, kind.value)}
							/>
							{kind.label}
						</label>
					{/each}
				</div>
				<p class="field-hint">
					{#if section.kind === 'by_sign'}
						A positive amount is income. A negative amount is an expense.
					{:else if section.kind === 'transfer'}
						Money that moves between two of your accounts, for example a withdrawal to the bank. A transfer has no category and no contact.
					{:else}
						A line with the opposite sign is ignored. It does not become {section.kind === 'income'
							? 'income'
							: 'an expense'}.
					{/if}
				</p>
				{@render problemList(shown(`${at}.kind`))}
			</div>

			{#if section.kind === 'transfer'}
				<div class="field" id="pf-s-{section.uid}-counter">
					<span class="field-label">Contra account *</span>
					<ProfileCategorySelect
						groups={counterGroups}
						value={section.counterAccountId}
						noneLabel="Select account"
						ariaLabel="Contra account of {section.name || `section ${index + 1}`}"
						missingLabel="Account no longer available"
						disabled={!canChange}
						onchange={(value) => (section.counterAccountId = value)}
					/>
					<p class="field-hint">The contra account of the transfer. Example: the bank account for withdrawals.</p>
					{@render problemList(shown(`${at}.counterAccountId`))}
				</div>
			{:else if section.feeTypes.length === 0}
				<div class="field" id="pf-s-{section.uid}-category">
					<span class="field-label">Category</span>
					<ProfileCategorySelect
						groups={categoryGroups(section.kind)}
						value={section.fixedCategoryAccountId}
						noneLabel={fromTable ? 'Reviewer selects' : 'AI suggests'}
						ariaLabel="Category for {section.name || `section ${index + 1}`}"
						disabled={!canChange}
						onchange={(value) => (section.fixedCategoryAccountId = value)}
					/>
					{@render problemList(shown(`${at}.fixedCategoryAccountId`))}
				</div>
			{/if}

			{#if !fromTable}
				<div class="field">
					<label class="field-label" for="pf-s-{section.uid}-description">Description *</label>
					<Textarea id="pf-s-{section.uid}-description" rows={2} bind:value={section.description} disabled={!canChange} class="leading-relaxed" />
					<p class="field-hint">Tell the AI what the lines are and where they are.</p>
					{@render problemList(shown(`${at}.description`))}
				</div>
			{/if}

			{#if section.kind !== 'transfer' || section.feeTypes.length > 0}
				{@render feeTypesField(section, at, fromTable)}
			{/if}

			<Disclosure label="More" forceOpen={sectionMoreForced(section, index)}>
				{#if section.kind !== 'transfer' && (otherProfiles.length > 0 || section.sameMoneyAs.length > 0)}
					<div class="field" id="pf-s-{section.uid}-same">
						<span class="field-label">Overlaps with</span>
						<div class="chip-row" role="group" aria-label="Overlaps with">
							{#each otherProfiles as other (other.id)}
								<label class="chip" class:on={section.sameMoneyAs.includes(other.id)}>
									<input
										type="checkbox"
										checked={section.sameMoneyAs.includes(other.id)}
										disabled={!canChange ||
											(!section.sameMoneyAs.includes(other.id) && section.sameMoneyAs.length >= PROFILE_SAME_MONEY_MAX)}
										onchange={() => toggleSameMoney(section, other.id)}
									/>
									{other.name}
								</label>
							{/each}
							{#each section.sameMoneyAs.filter((id) => !profileNames.has(id)) as gone (gone)}
								<label class="chip on">
									<input type="checkbox" checked disabled={!canChange} onchange={() => toggleSameMoney(section, gone)} />
									Deleted profile
								</label>
							{/each}
						</div>
						<p class="field-hint">
							Select the profiles that record the same transactions. Example: an income statement that shows the same sales. If their records include the month, the item is marked for review. This prevents a double count.
						</p>
						{@render problemList(attempted ? errorsUnder(problems, `${at}.sameMoneyAs`) : [])}
					</div>
				{/if}
				{#if fromTable && section.rows}
					{@render flagRule(section.rows, at, section.uid)}
					{#if !sorting}
						{@render customRules(section.rows, at, section.uid)}
					{/if}
				{:else if !fromTable}
					<div class="field" id="pf-s-{section.uid}-extras" style="margin-bottom:0;">
						<span class="field-label">Extra fields</span>
						<Textarea
							bind:value={section.extrasText}
							rows={6}
							disabled={!canChange}
							spellcheck={false}
							aria-label="Extra fields for {section.name || `section ${index + 1}`}, as JSON Schema"
							class="pf-mono leading-relaxed"
							placeholder={'{\n  "type": "object",\n  "properties": {\n    "order_no": { "type": ["string", "null"], "description": "The order number" }\n  }\n}'}
						/>
						<p class="field-hint">
							Values to read from each line, for example an order number. Write them as a JSON Schema object. Each field can use only <code>type</code> (string, number, integer, boolean, or one of these with "null"), <code>description</code> and <code>enum</code> (text only). The app shows each value on the item as "name: value".
						</p>
						{#each extrasProblems(index) as message, messageIndex (messageIndex)}
							<p class="pf-problem">{message}</p>
						{/each}
						{#if section.extrasText.trim() && extrasProblems(index).length === 0}
							<p class="pf-ok">The extra fields are correct.</p>
						{/if}
					</div>
				{/if}
				{#if keys[index]}<p class="field-hint">Key: <code>{keys[index]}</code></p>{/if}
			</Disclosure>
		</Collapsible.Content>
	</section>
	</Collapsible.Root>
{/snippet}

{#snippet spreadsheetCard(layout: LayoutForm)}
	{@const layoutProblems = attempted ? errorsUnder(problems, 'layout') : []}
	<section class="detail-card" id="pf-table">
		<div class="detail-card-head"><span class="detail-card-title">Table</span></div>
		<ProfileSampleTable
			bind:layout={form.layout!}
			{sample}
			{sampleName}
			loading={sampleLoading}
			error={sampleError}
			{canChange}
			roleProblems={[
				...shown('layout.headers'),
				...shown('layout.columns'),
				...shown('layout.columns.date'),
				...shown('layout.columns.description'),
				...shown('layout.columns.amount'),
				...shown('layout.columns.reference'),
				...shown('layout.direction'),
				...shown('layout.direction.column'),
				...(attempted ? errorsUnder(problems, 'layout.direction.in') : []),
				...(attempted ? errorsUnder(problems, 'layout.direction.out') : []),
				...shown('layout.balanceColumn')
			]}
			onfile={(file) => loadSample(file)}
			onlocate={(where) => sampleFile && loadSample(sampleFile, where)}
			onadopt={() => adoptSample()}
		/>

		<Disclosure label="More options" bind:open={moreOpen} forceOpen={layoutProblems.length > 0 || revealed.table === true} class="mt-4">
			<div class="pf-more">
				<div class="pf-grid">
					<div class="field" id="pf-l-counterparty">
						<label class="field-label" for="pf-counterparty">Contact</label>
						<Input id="pf-counterparty" bind:value={layout.counterparty} disabled={!canChange} class="w-full" placeholder="None" />
						<p class="field-hint">The supplier or customer for all items. Example: the marketplace.</p>
						{@render problemList(shown('layout.counterparty'))}
					</div>
					<div class="field" id="pf-l-currency">
						<label class="field-label" for="pf-currency">Currency</label>
						<Input id="pf-currency" bind:value={layout.currency} disabled={!canChange} class="w-full" placeholder="Main currency" />
						<p class="field-hint">A three-letter code. Example: MYR.</p>
						{@render problemList(shown('layout.currency'))}
					</div>
				</div>

				<div class="field" id="pf-l-documentDateLabel">
					<label class="field-label" for="pf-doc-date">Label of the document date</label>
					<Input id="pf-doc-date" bind:value={layout.documentDateLabel} disabled={!canChange} class="w-full" placeholder="Example: To" />
					{@render labelChips(
						(sample?.labels ?? []).filter((label) => /\d{4}|\d{1,2}[/.-]\d{1,2}/.test(label.value)),
						(label) => (layout.documentDateLabel = label)
					)}
					{@render problemList(shown('layout.documentDateLabel'))}
				</div>

				<div class="field" id="pf-l-statedTotalLabels">
					<label class="field-label" for="pf-totals">Labels of the stated totals</label>
					<Textarea id="pf-totals" rows={2} bind:value={layout.totalsText} disabled={!canChange} placeholder="One label on each line. Example: Total Money In" />
					{@render labelChips(sample?.labels ?? [], (label) => {
						const labels = linesOf(layout.totalsText);
						if (!labels.includes(label)) layout.totalsText = [...labels, label].join('\n');
					})}
					<p class="field-hint">The app adds the values next to these labels. It compares the sum with the items. If this is empty, there is no control total.</p>
					{@render problemList(attempted ? errorsUnder(problems, 'layout.statedTotalLabels') : [])}
				</div>

				<div class="pf-grid">
					<div class="field" id="pf-l-dateFormat">
						<span class="field-label">Date format</span>
						<ProfileColumnSelect
							options={DATE_FORMATS}
							value={layout.dateFormat}
							ariaLabel="Date format"
							disabled={!canChange}
							onchange={(value) => (layout.dateFormat = value as typeof layout.dateFormat)}
						/>
						{@render problemList(shown('layout.dateFormat'))}
					</div>
					<div class="field" id="pf-l-decimalSeparator">
						<span class="field-label">Decimal separator</span>
						<ProfileColumnSelect
							options={DECIMALS}
							value={layout.decimalSeparator}
							ariaLabel="Decimal separator"
							disabled={!canChange}
							onchange={(value) => (layout.decimalSeparator = value === ',' ? ',' : '.')}
						/>
						{@render problemList(shown('layout.decimalSeparator'))}
					</div>
					<div class="field" id="pf-l-csvDelimiter">
						<span class="field-label">CSV separator</span>
						<ProfileColumnSelect
							options={CSV_SEPARATORS}
							value={layout.csvDelimiter}
							noneLabel="Automatic"
							ariaLabel="CSV separator"
							disabled={!canChange}
							onchange={(value) => (layout.csvDelimiter = value as typeof layout.csvDelimiter)}
						/>
						{@render problemList(shown('layout.csvDelimiter'))}
					</div>
				</div>

				<div class="field" id="pf-l-headers">
					<label class="field-label" for="pf-headers">Headings</label>
					<Textarea id="pf-headers" rows={3} bind:value={layout.headersText} disabled={!canChange} class="leading-relaxed" placeholder="One heading on each line" />
					<p class="field-hint">The app finds the table at the first row with all these headings. A sample adds them automatically.</p>
				</div>

				{#if layout.directionColumn}
					<div class="pf-grid" id="pf-l-direction">
						<div class="field">
							<label class="field-label" for="pf-dir-in">Inflow values</label>
							<Textarea id="pf-dir-in" rows={2} bind:value={layout.directionInText} disabled={!canChange} placeholder="One per line" />
						</div>
						<div class="field">
							<label class="field-label" for="pf-dir-out">Outflow values</label>
							<Textarea id="pf-dir-out" rows={2} bind:value={layout.directionOutText} disabled={!canChange} placeholder="One per line" />
						</div>
					</div>
				{/if}
			</div>
		</Disclosure>
	</section>
{/snippet}

{#snippet labelChips(labels: { label: string; value: string }[], use: (label: string) => void)}
	{#if labels.length && canChange}
		<div class="pf-suggest">
			<span class="pf-suggest-lead">In the sample:</span>
			{#each labels as entry, index (index)}
				<button type="button" class="pf-suggest-chip" onclick={() => use(entry.label)}>
					{entry.label} <span class="pf-suggest-value">{entry.value}</span>
				</button>
			{/each}
		</div>
	{/if}
{/snippet}

{#snippet feeTypesField(section: SectionForm, at: string, fromTable: boolean)}
	{@const columnValues = fromTable ? feeColumnValues(section) : null}
	<div class="field" id="pf-s-{section.uid}-fees">
		<span class="field-label">Line types</span>
		{#if fromTable && section.rows && (section.feeTypes.length > 0 || section.rows.feeTypeColumn)}
			<div class="pf-fee-column">
				<span class="field-hint" style="margin:0;">Line type column</span>
				<ProfileColumnSelect
					options={headingOptions}
					value={section.rows.feeTypeColumn}
					noneLabel="Select a column"
					ariaLabel="Line type column"
					disabled={!canChange}
					onchange={(value) => (section.rows!.feeTypeColumn = value)}
				/>
			</div>
			{@render problemList(shown(`${at}.rows.feeTypeColumn`))}
		{/if}
		{#if section.feeTypes.length > 0}
			<div class="pf-fees">
				<div class="pf-fee pf-fee-head" aria-hidden="true">
					<span>Name</span><span>{fromTable ? 'Values' : 'How to identify'}</span><span>Category</span><span></span>
				</div>
				{#each section.feeTypes as fee, feeIndex (fee.uid)}
					{@const feeAt = `${at}.feeTypes[${feeIndex}]`}
					<div class="pf-fee" id="pf-s-{section.uid}-fee-{fee.uid}">
						<div>
							<Input
								bind:value={fee.name}
								aria-label="Line type name"
								placeholder="Commission fee"
								disabled={!canChange}
								class="w-full"
							/>
						</div>
						<div>
							{#if !fromTable}
								<Input
									bind:value={fee.description}
									aria-label="How to identify this line type"
									placeholder="Example: The commission on each sale"
									disabled={!canChange}
									class="w-full"
								/>
							{:else if columnValues}
								<div class="pf-value-chips" role="group" aria-label="Values that mean {fee.name.trim() || 'this line type'}">
									{#each columnValues as value (value)}
										<button
											type="button"
											class="pf-value-chip"
											class:on={linesOf(fee.valuesText).includes(value)}
											aria-pressed={linesOf(fee.valuesText).includes(value)}
											disabled={!canChange}
											onclick={() => toggleFeeValue(fee, value)}>{value}</button
										>
									{/each}
								</div>
							{:else if section.rows?.feeTypeColumn}
								<Textarea
									bind:value={fee.valuesText}
									rows={2}
									disabled={!canChange}
									aria-label="Values of {section.rows.feeTypeColumn} that mean {fee.name.trim() || 'this line type'}"
									placeholder="One per line"
									class="leading-relaxed"
								/>
							{:else}
								<p class="field-hint" style="margin:0;">Select the line type column first.</p>
							{/if}
						</div>
						<div>
							<ProfileCategorySelect
								groups={categoryGroups(section.kind)}
								value={fee.categoryAccountId}
								noneLabel="Auto"
								ariaLabel="Category for {fee.name.trim() || 'this line type'}"
								disabled={!canChange}
								onchange={(value) => (fee.categoryAccountId = value)}
							/>
						</div>
						<div class="pf-fee-remove">
							{#if canChange}
								<button type="button" class="pf-icon-btn pf-icon-danger" aria-label="Remove line type" onclick={() => removeFeeType(section, fee.uid)}>
									<Trash2 size={13} />
								</button>
							{/if}
						</div>
					</div>
					{@render problemList([
						...shown(feeAt),
						...shown(`${feeAt}.key`),
						...shown(`${feeAt}.name`),
						...shown(`${feeAt}.description`),
						...shown(`${feeAt}.categoryAccountId`),
						...(attempted ? errorsUnder(problems, `${feeAt}.values`) : [])
					])}
				{/each}
			</div>
		{/if}
		{#if canChange && section.feeTypes.length < PROFILE_FEE_TYPES_MAX}
			<button type="button" class="detail-card-action pf-add-fee" onclick={() => addFeeType(section)}>
				<Plus size={13} /> Add line type
			</button>
		{/if}
		<p class="field-hint">
			{#if section.feeTypes.length === 0}
				Optional. Divide the section into types, for example commission and shipping. Each type can have its own category.
			{:else if fromTable}
				The app reads only the rows with a listed type. It ignores all other rows. With "Auto", the reviewer selects the category.
			{:else}
				The app reads only the lines with a listed type. It ignores all other lines. With "Auto", the AI suggests the category.
			{/if}
		</p>
		{#if section.kind === 'by_sign' && section.feeTypes.length > 0}
			<p class="field-hint">
				By sign: an income category is for positive amounts only. An expense category is for negative amounts only.
			</p>
		{/if}
		{@render problemList(shown(`${at}.feeTypes`))}
	</div>
{/snippet}

{#snippet flagRule(rows: RowsForm, at: string, uid: string)}
	<div class="field" id="pf-s-{uid}-review" style="margin-top:10px;">
		<span class="field-label">Rows for review</span>
		<div class="pf-rules">
			{#if rows.flagWhen.length === 0}
				<p class="field-hint" style="margin:0;">Optional. If a row agrees with all the conditions, the app marks it for review with the note.</p>
			{/if}
			{@render conditionList(rows, 'flagWhen', `${at}.rows`, 'Add condition')}
			{#if rows.flagWhen.length > 0 || rows.flagNote}
				<Input
					bind:value={rows.flagNote}
					aria-label="Note for a marked row"
					placeholder="Note. Example: Make sure that the withdrawal is complete."
					disabled={!canChange}
					class="w-full"
				/>
				{@render problemList(shown(`${at}.rows.flagNote`))}
			{/if}
		</div>
	</div>
{/snippet}

{#snippet customRules(rows: RowsForm, at: string, uid: string)}
	<div class="field" id="pf-s-{uid}-where">
		<span class="field-label">Rows for this section</span>
		<div class="pf-rules">
			{#if rows.where.length === 0}<p class="field-hint" style="margin:0;">No condition. The section gets all rows of the table.</p>{/if}
			{@render conditionList(rows, 'where', `${at}.rows`, 'Add condition')}
		</div>
		{@render problemList(shown(`${at}.rows`))}
	</div>
{/snippet}

{#snippet previewCard()}
	<section class="detail-card">
		<div class="detail-card-head">
			<span class="detail-card-title">Test on the sample</span>
			<button type="button" class="sheet-btn" disabled={!sampleName || previewing} onclick={runPreview}>
				{previewing ? 'Wait…' : preview ? 'Test again' : 'Test'}
			</button>
		</div>
		<p class="field-hint" style="margin-top:0;">
			{sampleName
				? `Tests the profile on ${sampleName}. You do not have to save the profile first. The app keeps no data and makes no records.`
				: 'Load a sample in Table. Then you can test the profile before you save.'}
		</p>

		{#if previewError}
			<div class="pf-preview-error" role="alert">
				<p>{previewError.message}</p>
				{#if previewError.errors.length}
					<ul>
						{#each previewError.errors as problem, problemIndex (problemIndex)}
							<li>{problem.path ? `${problemPlace(problem.path, form).label}: ` : ''}{problem.message}</li>
						{/each}
					</ul>
				{/if}
			</div>
		{:else if preview}
			<div class="pf-preview">
				{#if previewedFingerprint !== fingerprint}
					<p class="field-hint" style="margin:0;">The profile changed after this test. Test again to see the result.</p>
				{/if}
				<p class="pf-preview-line">
					{importModeLabel(preview.mode)}. Headings on row {preview.headerRow} of “{preview.sheet}”. {preview.rows.toLocaleString('en-US')} row{preview.rows === 1 ? '' : 's'} in the table.
				</p>
				{#if preview.aiSections.length}
					<p class="field-hint" style="margin:0;">
						This test reads only the table. The AI reads {preview.aiSections.map((name) => `“${name}”`).join(', ')} when you upload a document. The items and totals below do not include {preview.aiSections.length === 1 ? 'this section' : 'these sections'}.
					</p>
				{/if}
				<ul class="pf-preview-counts">
					{#each preview.sections as counted (counted.key)}
						<li>{counted.name} ({KIND_LABELS[counted.kind] ?? counted.kind}): {counted.count.toLocaleString('en-US')}</li>
					{/each}
					<li>Ignored: {preview.ignoredCount.toLocaleString('en-US')}</li>
				</ul>
				{#if preview.statedTotalMinor !== null}
					<p class="pf-preview-line" class:pf-ok={preview.statedTotalMinor === preview.itemsTotalMinor} class:pf-problem={preview.statedTotalMinor !== preview.itemsTotalMinor}>
						Items: {money(preview.itemsTotalMinor)}. Stated total: {money(preview.statedTotalMinor)}. {preview.statedTotalMinor === preview.itemsTotalMinor ? 'They agree.' : `Difference: ${money(preview.itemsTotalMinor - preview.statedTotalMinor)}.`}
					</p>
				{/if}
				{#if preview.balance}
					<p class="pf-preview-line" class:pf-ok={preview.balance.matches} class:pf-problem={!preview.balance.matches}>
						{preview.balance.message}
					</p>
				{/if}
				{#if preview.items.length}
					<div class="pf-preview-table">
						<table>
							<thead>
								<tr><th>Row</th><th>Section</th><th>Kind</th><th>Date</th><th>Description</th><th class="num">Amount</th><th>Reference</th></tr>
							</thead>
							<tbody>
								{#each preview.items as item, itemIndex (itemIndex)}
									<tr>
										<td>{item.row ?? '—'}</td>
										<td>{item.section}{item.feeType ? ` · ${item.feeType}` : ''}</td>
										<td>{KIND_LABELS[item.kind] ?? item.kind}</td>
										<td>{item.date}</td>
										<td>
											{item.description}
											{#if item.note}<span class="pf-preview-note">{item.note}</span>{/if}
										</td>
										<td class="num">{money(item.amountMinor)}</td>
										<td>{item.reference || '—'}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
					{#if preview.itemCount > preview.items.length}
						<p class="field-hint">This shows {preview.items.length} of {preview.itemCount.toLocaleString('en-US')} items.</p>
					{/if}
				{:else}
					<p class="pf-problem">No row agrees with a section. The app imports nothing.</p>
				{/if}
				{#if preview.ignored.length}
					<Disclosure label="Ignored rows">
						<ul class="pf-notes">
							{#each preview.ignored as line, lineIndex (lineIndex)}<li>{line}</li>{/each}
						</ul>
					</Disclosure>
				{/if}
			</div>
		{/if}
	</section>
{/snippet}

{#snippet conditionList(rows: RowsForm, which: 'where' | 'flagWhen', path: string, label: string)}
	{#each rows[which] as condition, conditionIndex (condition.uid)}
		{@const conditionAt = `${path}.${which}[${conditionIndex}]`}
		{@render conditionRow(rows, which, condition, conditionAt)}
	{/each}
	{#if canChange && rows[which].length < ROW_CONDITIONS_MAX}
		<button type="button" class="detail-card-action pf-add-fee" onclick={() => addCondition(rows, which)}>
			<Plus size={13} /> {label}
		</button>
	{/if}
	{@render problemList(shown(`${path}.${which}`))}
{/snippet}

{#snippet conditionRow(rows: RowsForm, which: 'where' | 'flagWhen', condition: ConditionForm, conditionAt: string)}
	<div class="pf-condition">
		<ProfileColumnSelect
			options={headingOptions}
			value={condition.column}
			placeholder="Column"
			ariaLabel="Column"
			disabled={!canChange}
			onchange={(value) => (condition.column = value)}
		/>
		<ProfileColumnSelect
			options={OPS}
			value={condition.op}
			ariaLabel="How the cell is compared"
			disabled={!canChange}
			onchange={(value) => (condition.op = value as RowConditionOp)}
		/>
		{#if opTakes(condition.op) === 'value'}
			<Input bind:value={condition.value} aria-label="Value" placeholder="Value" disabled={!canChange} class="w-full" />
		{:else if opTakes(condition.op) === 'values'}
			<Textarea bind:value={condition.valuesText} rows={2} aria-label="Values" placeholder="One per line" disabled={!canChange} />
		{:else}
			<span></span>
		{/if}
		{#if canChange}
			<button type="button" class="pf-icon-btn pf-icon-danger" aria-label="Remove condition" onclick={() => removeCondition(rows, which, condition.uid)}>
				<Trash2 size={13} />
			</button>
		{:else}
			<span></span>
		{/if}
	</div>
	{@render problemList(attempted ? errorsUnder(problems, conditionAt) : [])}
{/snippet}

<ConfirmDialog
	bind:open={deleteOpen}
	title="Delete this import profile?"
	description={`“${saved?.name ?? ''}” will not show in “Read as”. Documents that you imported with it do not change. Their records do not change.`}
	confirmLabel="Delete"
	danger
	onConfirm={deleteProfile}
/>

<style>
	.pf-title {
		overflow-wrap: anywhere;
	}
	.pf-hero-status {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
	}
	.hero-error {
		background: var(--red-soft);
		color: var(--red);
		border-radius: 8px;
		padding: 8px 12px;
		font-size: 13px;
		margin: 8px 0 0;
	}
	.pf-problem {
		font-size: 12px;
		color: var(--red);
		margin: 5px 0 0;
		overflow-wrap: anywhere;
	}
	.pf-ok {
		font-size: 12px;
		color: var(--green);
		margin: 5px 0 0;
	}
	code {
		font-family: 'Geist Mono', monospace;
		font-size: 11.5px;
	}
	:global(.pf-mono) {
		font-family: 'Geist Mono', monospace;
		font-size: 12.5px;
	}

	/* Phrases */
	.pf-phrases {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin-bottom: 8px;
	}
	.pf-phrase {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		max-width: 100%;
		padding: 3px 6px 3px 10px;
		border: 1px solid var(--border);
		border-radius: 999px;
		background: var(--accent);
		font-size: 12.5px;
	}
	.pf-phrase-text {
		overflow-wrap: anywhere;
	}
	.pf-phrase-remove {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 18px;
		height: 18px;
		border: none;
		border-radius: 999px;
		background: none;
		color: var(--muted-foreground);
		cursor: pointer;
	}
	.pf-phrase-remove:hover {
		color: var(--foreground);
		background: var(--card);
	}
	.pf-inline {
		display: flex;
		gap: 8px;
		align-items: center;
	}

	/* Sections */
	.pf-sections-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		margin-top: 4px;
	}
	/* What to import: a glyph of the part of a document each kind takes. */
	.pf-kinds {
		grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
	}
	.pf-kind {
		align-items: center;
	}
	.pf-kind-glyph {
		display: inline-flex;
		flex-shrink: 0;
		color: var(--muted-foreground);
	}
	.pf-kind.on .pf-kind-glyph {
		color: var(--primary);
	}
	.pf-kind-glyph :global(.pf-glyph-on) {
		fill: var(--primary-soft);
	}
	.pf-kind.on .pf-kind-glyph :global(.pf-glyph-on) {
		fill: color-mix(in oklch, var(--primary) 35%, transparent);
	}
	.pf-sections-hint {
		margin: -4px 0 0;
	}
	/* The page's own headings: the groups of sections, then each section by
	   the name the user gave it. Not the small card labels. */
	.pf-group-title {
		margin: 0;
		font-size: 15px;
		font-weight: 600;
		letter-spacing: -0.01em;
		color: var(--foreground);
	}
	.pf-section-title {
		margin: 0;
		font-size: 14px;
		font-weight: 600;
		color: var(--foreground);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}
	.pf-section-tools {
		display: inline-flex;
		gap: 4px;
	}
	/* A section's head folds it to one line: its name, kind and rows. */
	.pf-section :global(.pf-fold) {
		display: flex;
		align-items: baseline;
		gap: 8px;
		min-width: 0;
		flex: 1;
		padding: 0;
		border: 0;
		background: none;
		color: var(--foreground);
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	.pf-section :global(.pf-fold svg) {
		align-self: center;
		flex-shrink: 0;
		color: var(--muted-foreground);
		transition: transform 150ms;
	}
	.pf-section :global(.pf-fold svg.pf-fold-open) {
		transform: rotate(90deg);
	}
	@media (prefers-reduced-motion: reduce) {
		.pf-section :global(.pf-fold svg) {
			transition: none;
		}
	}
	.pf-section :global(.pf-fold:focus-visible) {
		outline: 2px solid var(--primary);
		outline-offset: 2px;
		border-radius: 4px;
	}
	.pf-fold-meta {
		font-size: 12px;
		color: var(--muted-foreground);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.pf-folded .detail-card-head {
		margin-bottom: 0;
	}
	.pf-icon-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		flex-shrink: 0;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--card);
		color: var(--muted-foreground);
		font-family: inherit;
		font-size: 13px;
		cursor: pointer;
	}
	.pf-icon-btn:hover:not(:disabled) {
		color: var(--foreground);
		background: var(--accent);
	}
	.pf-icon-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
	.pf-icon-danger:hover:not(:disabled) {
		color: var(--red);
		border-color: var(--red);
		background: var(--red-soft);
	}

	/* What the profile imports: two choices, each with a one-line hint. */
	.pf-modes {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
		gap: 8px;
	}
	.pf-mode {
		display: flex;
		align-items: flex-start;
		gap: 9px;
		padding: 8px 10px;
		border: 1px solid var(--border);
		border-radius: 8px;
		cursor: pointer;
		background: var(--card);
	}
	.pf-mode.on {
		border-color: var(--primary);
		background: var(--primary-soft);
	}
	.pf-mode input {
		margin-top: 3px;
		accent-color: var(--primary);
		flex-shrink: 0;
	}
	.pf-mode:has(input:disabled) {
		cursor: not-allowed;
		opacity: 0.7;
	}
	.pf-mode-main {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}
	.pf-mode-label {
		font-size: 13px;
		font-weight: 500;
	}
	.pf-mode-hint {
		font-size: 11.5px;
		color: var(--muted-foreground);
	}
	.pf-legacy-mode {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 8px;
		margin-bottom: 14px;
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

	/* Line types: four columns on a wide screen, stacked on a phone. */
	.pf-fees {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin-bottom: 8px;
	}
	.pf-fee {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr) minmax(0, 1fr) 28px;
		gap: 8px;
		align-items: center;
	}
	.pf-fee-head {
		font-size: 11.5px;
		color: var(--muted-foreground);
	}
	.pf-add-fee {
		margin-bottom: 2px;
	}
	@media (max-width: 720px) {
		.pf-fee {
			grid-template-columns: minmax(0, 1fr);
			padding-bottom: 8px;
			border-bottom: 1px dashed var(--border);
		}
		.pf-fee-remove {
			justify-self: end;
		}
		.pf-fee-head {
			display: none;
		}
	}

	.pf-imported-text {
		font-size: 12.5px;
		color: var(--muted-foreground);
		margin: 0 0 8px;
	}
	.pf-imported-missing {
		margin: 0;
		padding-left: 18px;
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-size: 12.5px;
		color: var(--amber);
		overflow-wrap: anywhere;
	}

	/* Before you save */
	.pf-check-count {
		font-size: 12px;
		color: var(--muted-foreground);
	}
	.pf-check.attempted .pf-check-count {
		color: var(--red);
	}
	.pf-check-ready {
		display: flex;
		align-items: center;
		gap: 6px;
		margin: 0;
		font-size: 13px;
		color: var(--green);
	}
	.pf-check-list {
		list-style: none;
		margin: 0 -8px;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
		max-height: 60vh;
		overflow-y: auto;
	}
	.pf-check-item {
		display: flex;
		flex-direction: column;
		gap: 2px;
		width: 100%;
		padding: 6px 8px;
		border: 0;
		border-radius: 6px;
		background: none;
		text-align: left;
		font: inherit;
		cursor: pointer;
	}
	.pf-check-item:hover {
		background: var(--accent);
	}
	.pf-check-item:focus-visible {
		outline: 2px solid var(--primary);
		outline-offset: -2px;
	}
	.pf-check-place {
		font-size: 12.5px;
		font-weight: 500;
		color: var(--foreground);
		overflow-wrap: anywhere;
	}
	.pf-check-message {
		font-size: 12px;
		color: var(--muted-foreground);
		overflow-wrap: anywhere;
	}
	.pf-check.attempted .pf-check-message {
		color: var(--red);
	}

	.pf-notes {
		margin: 0;
		padding-left: 18px;
		display: flex;
		flex-direction: column;
		gap: 6px;
		font-size: 12.5px;
	}
	.pf-notes {
		color: var(--muted-foreground);
	}

	/* Table layout, row rules and preview */
	.pf-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
		gap: 0 12px;
	}
	.pf-more {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	/* Labels the sample prints outside its table, offered as answers. */
	.pf-suggest {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		margin-top: 6px;
	}
	.pf-suggest-lead {
		font-size: 11.5px;
		color: var(--muted-foreground);
	}
	.pf-suggest-chip {
		display: inline-flex;
		align-items: baseline;
		gap: 6px;
		padding: 2px 8px;
		border: 1px solid var(--border);
		border-radius: 999px;
		background: var(--card);
		font-size: 12px;
		color: var(--foreground);
		cursor: pointer;
	}
	.pf-suggest-chip:hover,
	.pf-suggest-chip:focus-visible {
		border-color: var(--primary);
	}
	.pf-suggest-value {
		color: var(--muted-foreground);
		font-variant-numeric: tabular-nums;
	}
	.pf-fee-column {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		margin-bottom: 8px;
		max-width: 420px;
	}
	.pf-fee-column > :last-child {
		flex: 1;
		min-width: 180px;
	}
	.pf-value-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}
	.pf-value-chip {
		padding: 2px 8px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--card);
		font-size: 12px;
		color: var(--muted-foreground);
		cursor: pointer;
	}
	.pf-value-chip.on {
		border-color: var(--primary);
		background: var(--primary-soft);
		color: var(--foreground);
	}
	.pf-value-chip:disabled {
		cursor: not-allowed;
	}
	.pf-rules {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 10px 12px;
		border: 1px dashed var(--border);
		border-radius: 8px;
	}
	.pf-condition {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 0.8fr) minmax(0, 1.2fr) 28px;
		gap: 8px;
		align-items: start;
	}
	@media (max-width: 720px) {
		.pf-condition {
			grid-template-columns: minmax(0, 1fr);
			padding-bottom: 8px;
			border-bottom: 1px dashed var(--border);
		}
		.pf-condition > :last-child {
			justify-self: end;
		}
	}
	.pf-preview {
		margin-top: 12px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.pf-preview-line {
		margin: 0;
		font-size: 12.5px;
		overflow-wrap: anywhere;
	}
	.pf-preview-counts {
		margin: 0;
		padding-left: 18px;
		font-size: 12.5px;
	}
	.pf-preview-table {
		overflow-x: auto;
		border: 1px solid var(--border);
		border-radius: 8px;
	}
	.pf-preview-table table {
		width: 100%;
		border-collapse: collapse;
		font-size: 12px;
	}
	.pf-preview-table th,
	.pf-preview-table td {
		padding: 6px 8px;
		text-align: left;
		border-bottom: 1px solid var(--border);
		vertical-align: top;
		white-space: nowrap;
	}
	.pf-preview-table td:nth-child(5) {
		white-space: normal;
		min-width: 160px;
	}
	.pf-preview-table .num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	.pf-preview-note {
		display: block;
		color: var(--amber, var(--muted-foreground));
		font-size: 11.5px;
	}
	.pf-preview-error {
		background: var(--red-soft);
		color: var(--red);
		border-radius: 8px;
		padding: 8px 12px;
		margin-top: 10px;
		font-size: 12.5px;
	}
	.pf-preview-error p {
		margin: 0;
	}
	.pf-preview-error ul {
		margin: 6px 0 0;
		padding-left: 18px;
	}
</style>
