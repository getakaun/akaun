<script lang="ts">
	import { enhance } from '$app/forms';
	import { beforeNavigate, goto, replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import { untrack, onMount, onDestroy } from 'svelte';
	import { ChevronRight, FileText, GripVertical, Plus, X, Lock, Pencil, Trash2, Zap, RefreshCw, Upload, ShieldCheck, AlertTriangle } from '@lucide/svelte';
	import { resolve } from '$app/paths';
	import { formatDate, formatMinor } from '$lib/format.js';
	import { Slider } from '$lib/components/ui/slider/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import * as Sheet from '$lib/components/ui/sheet/index.js';
	import { toast } from 'svelte-sonner';
	import { CURRENCIES } from '$lib/currency.js';
	import { useIsMobile } from '$lib/hooks/useIsMobile.svelte.js';
	import { flip } from 'svelte/animate';
	import { draggable, droppable } from '@thisux/sveltednd';
	import type { DragDropState } from '@thisux/sveltednd';
	import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte';
	import ColorPicker from '$lib/components/ui/ColorPicker.svelte';
	import { LAYOUT_CATALOG, DEFAULT_LAYOUT_KEY } from '$lib/pdf/layout-catalog.js';
	import { PDF_THEME_PRESETS } from '$lib/pdf/theme-presets.js';
	import { renderTemplate, validateTemplate, TOKEN_REGEX, type SequenceDocType } from '$lib/sequence-template.js';
	import type { PageData, ActionData } from './$types.js';
	import AccountDefaults from '$lib/components/settings/AccountDefaults.svelte';
	import CompanyImageField from '$lib/components/settings/CompanyImageField.svelte';
	import type { PdfHeaderStyle } from '$lib/pdf/header-style.js';
	import { parseProfileFile, stashImportedFile } from '$lib/import-profile-portable.js';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	type Tab = 'general' | 'company' | 'books' | 'intelligence' | 'templates' | 'advanced';
	const TAB_IDS: readonly Tab[] = ['general', 'company', 'books', 'intelligence', 'templates', 'advanced'];

	// The open tab is kept in the address (`?tab=intelligence`), so a page
	// opened from a tab — an import profile, say — comes back to that tab, by
	// the back button or by its own way back.
	function tabFromUrl(): Tab {
		const asked = page.url.searchParams.get('tab') as Tab | null;
		if (!asked || !TAB_IDS.includes(asked)) return 'general';
		if (asked === 'books' && !data.canSeeBooks) return 'general';
		return asked;
	}
	let activeTab = $state<Tab>(tabFromUrl());

	function showTab(id: Tab) {
		activeTab = id;
		const path = resolve('/(app)/settings');
		// A shallow replace: the tab is page state, not a new page to go back to.
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- route is resolved above; only the tab is appended.
		replaceState(id === 'general' ? path : `${path}?tab=${id}`, page.state);
	}

	// Mobile detection for Sheet side
	const screenState = useIsMobile();
	const isMobile = $derived(screenState.current);
	const panelSide = $derived(isMobile ? 'bottom' : 'right');

	// Company settings state
	// svelte-ignore state_referenced_locally
	let companyName = $state(data.companyName);
	// svelte-ignore state_referenced_locally
	let companyAddress = $state(data.companyAddress);
	// svelte-ignore state_referenced_locally
	let companyRegistrationNo = $state(data.companyRegistrationNo);
	// What each company image has staged; `CompanyImageField` holds the file
	// and its preview, and drops them when this goes back to 'none'.
	let logoChange = $state<'none' | 'replace' | 'remove'>('none');
	let letterheadChange = $state<'none' | 'replace' | 'remove'>('none');

	// Currency settings state
	// svelte-ignore state_referenced_locally
	let mainCur = $state(data.currency);

	const curLabel = $derived(
		(() => {
			const c = CURRENCIES.find((x) => x.code === mainCur);
			return c ? `${c.code} — ${c.name}` : mainCur;
		})()
	);

	// Which account a new expense or income starts with (FR-011). Only asked
	// about when there is more than one account to choose between.
	// svelte-ignore state_referenced_locally
	let defaultAccount = $state(String(data.ledgerDefaultAccountId ?? ''));
	const defaultAccountName = $derived(
		data.moneyAccounts.find((a) => String(a.id) === defaultAccount)?.name ?? 'Choose an account'
	);

	// Categories are accounts, created, renamed and archived on the Accounts
	// screen — the one place accounts are managed. This tab used to offer a
	// second, differently-behaved way to do the same job: it staged rows and
	// reconciled them on Save, while Accounts wrote each change immediately, so
	// the same action had two shapes depending on where it was started from
	// (FR-019, FR-020).

	// Document numbering state — one shared template, applied to every type
	const SEQ_TYPES: SequenceDocType[] = ['expense', 'income', 'payment', 'quotation', 'invoice'];
	const SEQ_LABELS: Record<SequenceDocType, string> = {
		expense: 'Expense',
		income: 'Income',
		payment: 'Payment',
		quotation: 'Quotation',
		invoice: 'Invoice'
	};
	const SEQ_CHIPS: { token: string; label: string }[] = [
		{ token: '{PREFIX}', label: 'PREFIX' },
		{ token: '{YYYY}', label: 'YYYY' },
		{ token: '{YY}', label: 'YY' },
		{ token: '{MM}', label: 'MM' },
		{ token: '{DD}', label: 'DD' },
		{ token: '{SEQ:3}', label: 'SEQ' }
	];

	function seqTokenLabel(token: string): string {
		return token.replace(/^\{|\}$/g, '').replace(/:\d+$/, '');
	}

	// svelte-ignore state_referenced_locally
	let seqTemplate = $state(data.sequenceTemplate);
	let seqFieldRef = $state<HTMLDivElement | null>(null);
	let seqDragOver = $state(false);
	let seqFlash = $state(false);
	let seqDraggingChip = $state<string | null>(null);
	let seqPoppingChip = $state<string | null>(null);
	// Tracks an in-field badge being repositioned via drag — not reactive
	// state, just bookkeeping read/written across native drag event handlers.
	let seqDraggingInternalNode: HTMLElement | null = null;
	// The animated "gap" shown at the exact spot a dragged chip/badge would
	// land — also plain bookkeeping, not reactive state.
	let seqDropPlaceholder: HTMLElement | null = null;

	const seqToday = new Date().toISOString().slice(0, 10);
	const seqReducedMotion =
		typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

	const seqValidationError = $derived(validateTemplate(seqTemplate));
	const seqPreviewLine = $derived(
		seqValidationError ??
			SEQ_TYPES.map((t) => `${SEQ_LABELS[t]} ${renderTemplate(seqTemplate, t, seqToday, 1)}`).join('   ·   ')
	);

	// Badges are plain DOM nodes (not Svelte-templated), so drag handlers for
	// repositioning are wired up directly here rather than as component props.
	function seqMakeBadgeEl(token: string): HTMLSpanElement {
		const span = document.createElement('span');
		span.contentEditable = 'false';
		span.className = 'seq-inline-badge';
		span.dataset.token = token;
		span.textContent = seqTokenLabel(token);
		span.draggable = !data.sequenceTemplateLocked;
		span.addEventListener('dragstart', (event) => {
			event.dataTransfer?.setData('text/plain', token);
			if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
			seqDraggingInternalNode = span;
			span.classList.add('seq-inline-badge-dragging');
		});
		span.addEventListener('dragend', () => {
			span.classList.remove('seq-inline-badge-dragging');
			seqDraggingInternalNode = null;
			seqRemovePlaceholder();
		});
		return span;
	}

	// Rebuilds the field's DOM (text nodes + inline token badges) from a plain
	// `{TOKEN}` template string. Only runs when the field itself (re)mounts —
	// never reactively on every edit, since that would blow away the DOM
	// selection/cursor mid-edit. See the $effect below.
	function seqHydrate(el: HTMLElement, template: string) {
		el.innerHTML = '';
		let lastIndex = 0;
		for (const match of template.matchAll(TOKEN_REGEX)) {
			const index = match.index ?? 0;
			if (index > lastIndex) el.appendChild(document.createTextNode(template.slice(lastIndex, index)));
			el.appendChild(seqMakeBadgeEl(match[0]));
			lastIndex = index + match[0].length;
		}
		if (lastIndex < template.length) el.appendChild(document.createTextNode(template.slice(lastIndex)));
	}

	// Walks the field's DOM back into the plain `{TOKEN}` string that
	// validateTemplate/renderTemplate/deriveBucketKey operate on.
	function seqSerialize(el: HTMLElement): string {
		let out = '';
		for (const node of el.childNodes) {
			if (node.nodeType === Node.TEXT_NODE) {
				out += node.textContent ?? '';
			} else if (node instanceof HTMLElement && node.dataset.token) {
				out += node.dataset.token;
			}
		}
		return out;
	}

	function seqSyncFromDom() {
		if (seqFieldRef) seqTemplate = seqSerialize(seqFieldRef);
	}

	$effect(() => {
		const el = seqFieldRef;
		if (el) seqHydrate(el, untrack(() => seqTemplate));
	});

	function seqFlashInsert() {
		if (seqReducedMotion) return;
		seqFlash = true;
		setTimeout(() => (seqFlash = false), 400);
	}

	// The current selection if it's inside the field, otherwise the end of
	// the field's content — used as the insertion point for click-inserts
	// and as a drag-drop fallback if a precise point can't be resolved.
	function seqCurrentRange(): Range | null {
		const el = seqFieldRef;
		if (!el) return null;
		const sel = document.getSelection();
		if (sel && sel.rangeCount > 0) {
			const range = sel.getRangeAt(0);
			if (el.contains(range.commonAncestorContainer)) return range.cloneRange();
		}
		const range = document.createRange();
		range.selectNodeContents(el);
		range.collapse(false);
		return range;
	}

	// Point-based ranges (drag-drop) can resolve to a position *inside* an
	// existing badge's label text, since caretRangeFromPoint measures pixel
	// layout and ignores contenteditable="false". Snap such a range to just
	// before/after the badge instead, so insertion never nests one badge
	// inside another's DOM subtree.
	function seqNormalizeRange(range: Range): Range {
		const el = seqFieldRef;
		if (!el) return range;
		const container = range.startContainer;
		const containerEl = container.nodeType === Node.TEXT_NODE ? container.parentElement : (container as Element);
		const badge = containerEl?.closest?.('.seq-inline-badge') as HTMLElement | null;
		if (!badge || !el.contains(badge)) return range;
		const label = badge.textContent ?? '';
		const before = container.nodeType === Node.TEXT_NODE && range.startOffset <= label.length / 2;
		const normalized = document.createRange();
		if (before) normalized.setStartBefore(badge);
		else normalized.setStartAfter(badge);
		normalized.collapse(true);
		return normalized;
	}

	function seqInsertTokenAtRange(token: string, range: Range) {
		const el = seqFieldRef;
		if (!el) return;
		range = seqNormalizeRange(range);
		const badge = seqMakeBadgeEl(token);
		if (!seqReducedMotion) badge.classList.add('seq-inline-badge-enter');
		range.deleteContents();
		range.insertNode(badge);
		if (!seqReducedMotion) requestAnimationFrame(() => badge.classList.remove('seq-inline-badge-enter'));
		range.setStartAfter(badge);
		range.collapse(true);
		const sel = document.getSelection();
		sel?.removeAllRanges();
		sel?.addRange(range);
		el.focus();
		seqSyncFromDom();
		seqFlashInsert();
	}

	function seqChipClick(token: string) {
		const range = seqCurrentRange();
		if (range) seqInsertTokenAtRange(token, range);
		if (!seqReducedMotion) {
			seqPoppingChip = token;
			setTimeout(() => {
				if (seqPoppingChip === token) seqPoppingChip = null;
			}, 180);
		}
	}

	function seqChipDragStart(event: DragEvent, token: string) {
		event.dataTransfer?.setData('text/plain', token);
		if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
		seqDraggingChip = token;
	}

	function seqChipDragEnd() {
		seqDraggingChip = null;
		seqRemovePlaceholder();
	}

	function seqTemplateDragOver(event: DragEvent) {
		event.preventDefault();
		seqDragOver = true;
		seqUpdateDropIndicator(event);
	}

	function seqTemplateDragLeave(event: DragEvent) {
		const el = seqFieldRef;
		const related = event.relatedTarget as Node | null;
		// Moving onto a child (e.g. a badge) fires leave-then-enter on some
		// browsers — only treat it as a real leave once we're outside the field.
		if (el && related && el.contains(related)) return;
		seqDragOver = false;
		seqRemovePlaceholder();
	}

	// Resolves a drop point to a precise DOM Range. Unlike a plain <input>,
	// contenteditable content is real DOM text layout, so the browser's own
	// caret-from-point APIs give pixel-accurate placement here.
	function seqRangeFromPoint(x: number, y: number): Range | null {
		const doc = document as Document & {
			caretRangeFromPoint?: (x: number, y: number) => Range | null;
			caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
		};
		if (doc.caretRangeFromPoint) return doc.caretRangeFromPoint(x, y);
		if (doc.caretPositionFromPoint) {
			const pos = doc.caretPositionFromPoint(x, y);
			if (!pos) return null;
			const range = document.createRange();
			range.setStart(pos.offsetNode, pos.offset);
			range.collapse(true);
			return range;
		}
		return null;
	}

	// FLIP-slides existing badges into their new position whenever the drop
	// gap moves, instead of letting them snap there instantly. Snapshot
	// rects before the DOM change, then after, and animate away the delta.
	function seqCaptureBadgeRects(el: HTMLElement): Map<HTMLElement, DOMRect> {
		const rects = new Map<HTMLElement, DOMRect>();
		for (const node of el.children) {
			if (node instanceof HTMLElement && node !== seqDropPlaceholder) rects.set(node, node.getBoundingClientRect());
		}
		return rects;
	}

	function seqPlayFlip(el: HTMLElement, prevRects: Map<HTMLElement, DOMRect>) {
		if (seqReducedMotion) return;
		for (const node of el.children) {
			if (!(node instanceof HTMLElement) || node === seqDropPlaceholder) continue;
			const prev = prevRects.get(node);
			if (!prev) continue;
			const next = node.getBoundingClientRect();
			const dx = prev.left - next.left;
			const dy = prev.top - next.top;
			if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
			node.style.transition = 'none';
			node.style.transform = `translate(${dx}px, ${dy}px)`;
			requestAnimationFrame(() => {
				node.style.transition = 'transform 180ms cubic-bezier(0.16, 1, 0.3, 1)';
				node.style.transform = '';
				node.addEventListener(
					'transitionend',
					() => {
						node.style.transition = '';
					},
					{ once: true }
				);
			});
		}
	}

	// Shows an animated gap at the exact spot a dropped chip/badge would
	// land — the field visibly makes room before the drop actually happens,
	// so repositioning reads as "pushing badges apart" instead of a blind swap.
	function seqEnsurePlaceholder(): HTMLElement {
		if (seqDropPlaceholder && !seqDropPlaceholder.isConnected) seqDropPlaceholder = null;
		if (!seqDropPlaceholder) {
			const span = document.createElement('span');
			span.contentEditable = 'false';
			span.className = 'seq-drop-placeholder';
			seqDropPlaceholder = span;
		}
		return seqDropPlaceholder;
	}

	function seqRemovePlaceholder() {
		const placeholder = seqDropPlaceholder;
		seqDropPlaceholder = null;
		if (!placeholder?.isConnected) return;
		if (seqReducedMotion) {
			placeholder.remove();
			return;
		}
		placeholder.classList.remove('seq-drop-placeholder-grown');
		placeholder.addEventListener('transitionend', () => placeholder.remove(), { once: true });
		// Safety net in case width was already 0 and no transition fires.
		setTimeout(() => placeholder.remove(), 200);
	}

	function seqUpdateDropIndicator(event: DragEvent) {
		const el = seqFieldRef;
		if (!el) return;
		const pointRange = seqRangeFromPoint(event.clientX, event.clientY);
		if (!pointRange || !el.contains(pointRange.startContainer)) return;
		const target = seqNormalizeRange(pointRange);
		const placeholder = seqEnsurePlaceholder();
		const prevRects = seqCaptureBadgeRects(el);
		target.insertNode(placeholder);
		seqPlayFlip(el, prevRects);
		if (seqReducedMotion) {
			placeholder.classList.add('seq-drop-placeholder-grown');
		} else if (!placeholder.classList.contains('seq-drop-placeholder-grown')) {
			requestAnimationFrame(() => placeholder.classList.add('seq-drop-placeholder-grown'));
		}
	}

	function seqTemplateDrop(event: DragEvent) {
		event.preventDefault();
		seqDragOver = false;
		const token = event.dataTransfer?.getData('text/plain');
		const el = seqFieldRef;
		const draggedNode = seqDraggingInternalNode;
		seqDraggingInternalNode = null;
		const placeholder = seqDropPlaceholder;
		seqDropPlaceholder = null;
		if (!token || !el) {
			placeholder?.remove();
			return;
		}
		// Reuse the placeholder's exact position as the drop target — it's
		// already sitting where the animation showed the badge would land.
		let target: Range | null = null;
		if (placeholder?.isConnected) {
			target = document.createRange();
			target.selectNode(placeholder);
		} else {
			const pointRange = seqRangeFromPoint(event.clientX, event.clientY);
			target = pointRange && el.contains(pointRange.startContainer) ? seqNormalizeRange(pointRange) : seqCurrentRange();
		}
		if (!target) {
			placeholder?.remove();
			return;
		}
		seqInsertTokenAtRange(token, target); // deleteContents() removes the placeholder itself
		// Repositioning an existing badge — drop the copy in at the new spot
		// (above), then remove the original so it reads as a move, not a copy.
		if (draggedNode?.isConnected) {
			draggedNode.remove();
			seqSyncFromDom();
		}
	}

	// Force plain-text paste — pasted HTML/styling has no place in a
	// single-line token template.
	function seqHandlePaste(event: ClipboardEvent) {
		event.preventDefault();
		const text = event.clipboardData?.getData('text/plain') ?? '';
		if (!text) return;
		const range = seqCurrentRange();
		if (!range) return;
		range.deleteContents();
		const textNode = document.createTextNode(text);
		range.insertNode(textNode);
		range.setStartAfter(textNode);
		range.collapse(true);
		const sel = document.getSelection();
		sel?.removeAllRanges();
		sel?.addRange(range);
		seqSyncFromDom();
	}

	// Removes an adjacent token badge as one atomic unit on Backspace/Delete,
	// instead of relying on inconsistent browser default handling of
	// `contenteditable="false"` islands (some browsers select-then-delete
	// over two keystrokes).
	function seqHandleKeydown(event: KeyboardEvent) {
		if (event.key !== 'Backspace' && event.key !== 'Delete') return;
		const el = seqFieldRef;
		const sel = document.getSelection();
		if (!el || !sel || !sel.isCollapsed || sel.rangeCount === 0) return;
		const { startContainer, startOffset } = sel.getRangeAt(0);

		let target: ChildNode | null = null;
		if (event.key === 'Backspace') {
			if (startContainer.nodeType === Node.TEXT_NODE && startOffset === 0) {
				target = startContainer.previousSibling;
			} else if (startContainer === el && startOffset > 0) {
				target = el.childNodes[startOffset - 1] ?? null;
			}
		} else {
			if (startContainer.nodeType === Node.TEXT_NODE && startOffset === startContainer.textContent?.length) {
				target = startContainer.nextSibling;
			} else if (startContainer === el) {
				target = el.childNodes[startOffset] ?? null;
			}
		}

		if (target instanceof HTMLElement && target.dataset.token) {
			event.preventDefault();
			target.remove();
			seqSyncFromDom();
		}
	}

	// Global intelligence settings
	// svelte-ignore state_referenced_locally
	let aiParallelTasks = $state(data.autoImportParallelTasks);
	// svelte-ignore state_referenced_locally
	let aiCategoryHints = $state(data.autoImportCategoryHints);
	// svelte-ignore state_referenced_locally
	let aiRateLimitSec = $state(Math.round(data.autoImportRateLimitMs / 1000));
	// svelte-ignore state_referenced_locally
	let aiCustomInstructions = $state(data.autoImportCustomInstructions);

	// --- PDF template tab state ---
	// Layout is fixed to the standard layout for now (see DEFAULT_LAYOUT_KEY) —
	// only the accent color is user-editable.
	// svelte-ignore state_referenced_locally
	let pdfThemeColor = $state(data.pdfThemeColor);
	// svelte-ignore state_referenced_locally
	let pdfHeader = $state<PdfHeaderStyle>(data.pdfHeader);
	// Days to the due date / expiry date a new document starts with, as typed:
	// strings, so blank ("none") stays blank. The server checks the range.
	// svelte-ignore state_referenced_locally
	let invoiceDueDays = $state(data.invoiceDueDays);
	// svelte-ignore state_referenced_locally
	let quotationValidDays = $state(data.quotationValidDays);
	const standardLayoutDescription =
		LAYOUT_CATALOG.find((l) => l.key === DEFAULT_LAYOUT_KEY)?.description ?? '';

	// --- Books tab: check the books, and what the one-off update decided ---

	/**
	 * The whole-books check (SC-002). Every record has two sides that have to
	 * cancel out; this adds all of them up and says whether any don't.
	 */
	type IntegrityResult = {
		ok: boolean;
		recordsChecked: number;
		unbalancedRecords: { recordId: number; differenceMinor: number }[];
		totalDifferenceMinor: number;
		booksBalance: boolean;
		wholeBooksDifferenceMinor: number;
		elapsedMs: number;
	};
	let integrity = $state<IntegrityResult | null>(null);
	let integrityChecking = $state(false);

	async function checkTheBooks() {
		integrityChecking = true;
		try {
			const res = await fetch('/api/ledger/integrity');
			if (!res.ok) {
				toast.error('The books could not be checked just now.');
				return;
			}
			integrity = await res.json();
		} catch {
			toast.error('The books could not be checked just now.');
		} finally {
			integrityChecking = false;
		}
	}

	/**
	 * How each old reimbursement's payer was worked out, said in words.
	 *
	 * The stored values are slugs for the code's benefit; nobody reading this
	 * screen should have to decode one (Principle VII). The step names are taken
	 * from `PageData` rather than imported, because the type they come from lives
	 * under `$lib/server` and cannot be reached from a component.
	 */
	type PayerStep = NonNullable<PageData['upgrade']>['report']['payerAttributions'][number]['step'];
	const PAYER_STEP_TEXT: Record<PayerStep, string> = {
		'email-match': 'matched by email address',
		'name-match': 'matched by name',
		'sole-user-email-match': 'matched by email address, through the only other user account',
		'sole-user-name-match': 'matched by name, through the only other user account',
		'created-contact': 'nobody matched, so a new contact was created from the login',
		'named-contact': 'the record already said who it was',
		'bank-fallback': 'nobody was named, so it was treated as paid from the bank account'
	};

	const upgradeReport = $derived(data.upgrade?.report ?? null);
	const upgradeVerify = $derived(data.upgrade?.verify ?? null);
	// Nothing to say means nothing on screen — an installation whose update went
	// cleanly, or one that never had anything to update, sees no section at all.
	const hasUpgradeNotes = $derived(
		!!upgradeReport &&
			(upgradeReport.uncategorisedRecordIds.length > 0 ||
				upgradeReport.missingAttachments.length > 0 ||
				upgradeReport.roundingDifferences.length > 0 ||
				upgradeReport.payerAttributions.length > 0 ||
				upgradeReport.bankFallbackRecordIds.length > 0 ||
				upgradeReport.unrepointedAllocationIds.length > 0 ||
				(!!upgradeVerify && !upgradeVerify.ok))
	);

	const recordList = (ids: number[]) => ids.map((id) => `#${id}`).join(', ');

	// Search index rebuild state
	type RebuildStatus = {
		running: boolean;
		total: number;
		processed: number;
		startedAt: string | null;
		finishedAt: string | null;
		error: string | null;
	};
	let rebuildStatus = $state<RebuildStatus | null>(null);
	let rebuildEventSource: EventSource | null = null;
	const rebuildPercent = $derived(
		rebuildStatus && rebuildStatus.total > 0
			? Math.round((rebuildStatus.processed / rebuildStatus.total) * 100)
			: 0
	);

	onMount(() => {
		rebuildEventSource = new EventSource('/api/search-rebuild/stream');
		rebuildEventSource.onmessage = (e) => {
			const data = JSON.parse(e.data);
			if (data.type === 'snapshot' || data.type === 'progress') rebuildStatus = data.status;
		};
	});

	onDestroy(() => {
		rebuildEventSource?.close();
		cancelChatgptSignIn();
	});

	async function triggerRebuild() {
		const res = await fetch('/api/search-rebuild', { method: 'POST' });
		if (res.ok) {
			rebuildStatus = await res.json();
		} else {
			toast.error('Failed to start search index rebuild');
		}
	}

	function handleSliderChange(v: number[]) {
		aiParallelTasks = v[0];
	}

	function handleRateLimitSliderChange(v: number[]) {
		aiRateLimitSec = v[0];
	}

	// --- Provider list state ---
	// isNew marks a locally-staged row that hasn't been persisted yet — it holds
	// the real apiKey (server-persisted rows always have it stripped to '') and
	// has no real DB id until the page-level "Save changes" click creates it.
	// A staged `chatgpt` row holds `connectionId` instead: its finished sign-in,
	// which waits on the server until that Save.
	type ProviderRow = (typeof data.providers)[0] & { isNew?: boolean; connectionId?: string };
	// svelte-ignore state_referenced_locally
	let providers = $state<ProviderRow[]>([...data.providers]);

	function reorderItems<T extends { id: string | number }>(
		arr: T[],
		draggedItem: T,
		targetElement: HTMLElement | null,
		dropPosition: 'before' | 'after' | null
	): T[] {
		if (!targetElement || !dropPosition) return arr;
		const targetId = targetElement.closest<HTMLElement>('[data-id]')?.dataset.id;
		if (!targetId || String(draggedItem.id) === targetId) return arr;
		const result = [...arr];
		const fromIndex = result.findIndex((i) => String(i.id) === String(draggedItem.id));
		if (fromIndex === -1) return arr;
		const [item] = result.splice(fromIndex, 1);
		const newTargetIdx = result.findIndex((i) => String(i.id) === targetId);
		if (newTargetIdx === -1) return arr;
		result.splice(dropPosition === 'after' ? newTargetIdx + 1 : newTargetIdx, 0, item);
		return result;
	}

	const reducedMotion =
		typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	const flipDurationMs = reducedMotion ? 0 : 200;

	function handleDrop(state: DragDropState<ProviderRow>) {
		if (!state.draggedItem) return;
		providers = reorderItems(providers, state.draggedItem, state.targetElement, state.dropPosition);
	}

	// --- Import profiles (006 US6 AS1) ---
	// Listed here, beside the providers that read the documents. Each one opens
	// on its own page to edit. Turning one on or off is staged like a provider
	// switch and saved with this tab's Save; the server checks import.change
	// for it, since this page checks no permission of its own.
	type ProfileRow = (typeof data.importProfiles.profiles)[0];
	/** What each kind of import profile imports, as the list says it. */
	const KIND_LABEL: Record<ProfileRow['kind'], string> = {
		table: 'Table rows',
		summary: 'Summary lines',
		transactions: 'Transaction lines',
		mixed: 'Table rows and summary lines'
	};
	// svelte-ignore state_referenced_locally
	let importProfiles = $state<ProfileRow[]>([...data.importProfiles.profiles]);
	const canChangeProfiles = $derived(data.importProfiles.canChange);

	function profileHref(id: number) {
		return resolve('/(app)/settings/import-profiles/[id]', { id: String(id) });
	}

	// A profile file exported from another installation opens in the editor,
	// filled in and not yet saved: a new profile, or the saved one with the
	// same name, which Save then replaces. The file is read here and only its
	// text is passed on; the File itself is never kept.
	let profileFileInput = $state<HTMLInputElement | null>(null);

	async function importProfileFile(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const chosen = input.files?.[0];
		input.value = '';
		if (!chosen) return;
		if (isDirty) {
			toast.error('Save or discard the changes in Settings, then import the profile.');
			return;
		}
		let text: string;
		try {
			text = await chosen.text();
		} catch {
			toast.error('The app cannot read this file. Choose it again.');
			return;
		}
		const parsed = parseProfileFile(text);
		if (!parsed.ok) {
			toast.error('Cannot import the profile', { description: parsed.error });
			return;
		}
		const name = typeof parsed.file.profile.name === 'string' ? parsed.file.profile.name.trim().toLowerCase() : '';
		const same = name ? importProfiles.find((p) => p.name.trim().toLowerCase() === name) : undefined;
		stashImportedFile(parsed.file, chosen.name);
		void goto(same ? profileHref(same.id) : resolve('/(app)/settings/import-profiles/new'));
	}

	// --- Provider Sheet state ---
	let sheetOpen = $state(false);
	let editingProvider = $state<ProviderRow | null>(null);

	let sfType = $state('openrouter');
	let sfName = $state('');
	let sfApiKey = $state('');
	let sfModel = $state('');
	let sfShowFreeOnly = $state(false);

	type ModelInfo = { id: string; name: string; isFree: boolean };
	let sfModels = $state<ModelInfo[]>([]);
	let sfFetching = $state(false);
	let sfError = $state('');

	// --- ChatGPT plan sign-in ---
	// A `chatgpt` provider signs in with ChatGPT instead of holding a key. The
	// finished sign-in waits on the server as `sfConnectionId` until Save
	// stores it on the row. The stream that reports it is opened by the click
	// and closed when its result arrives, never by an effect.
	let sfConnectionId = $state<string | null>(null);
	let sfAccountEmail = $state<string | null>(null);
	let sfSignInState = $state<string | null>(null);
	let sfSignInUrl = $state('');
	let sfDeviceCode = $state('');
	let sfDeviceExpiresAt = $state(0);
	let signInGeneration = 0;
	let sfSigningIn = $state(false);
	let sfSignInError = $state('');
	let signInStream: EventSource | null = null;

	function closeSignInStream() {
		signInStream?.close();
		signInStream = null;
	}

	function resetChatgptSignIn() {
		cancelChatgptSignIn();
		sfConnectionId = null;
		sfAccountEmail = null;
		sfSignInState = null;
		sfSignInUrl = '';
		sfDeviceCode = '';
		sfFetching = false;
		sfSigningIn = false;
		sfSignInError = '';
	}

	function changeSheetProviderType() {
		resetChatgptSignIn();
		sfModels = [];
		sfModel = '';
		sfError = '';
	}

	function signInFinished(connectionId: string, email: string | null) {
		closeSignInStream();
		sfConnectionId = connectionId;
		sfModel = '';
		sfAccountEmail = email;
		sfSigningIn = false;
		sfSignInState = null;
		sfSignInUrl = '';
		sfDeviceCode = '';
		void fetchChatgptModels(connectionId);
	}

	function signInFailed(message: string) {
		closeSignInStream();
		sfSignInError = message;
		sfSigningIn = false;
		sfSignInState = null;
	}

	// Keep the saved connection until a replacement is saved.
	async function startChatgptSignIn() {
		cancelChatgptSignIn();
		const generation = ++signInGeneration;
		sfSignInError = '';
		sfSigningIn = true;
		// Reserve the tab during the click so browsers allow it before the request completes.
		const signInTab = window.open('about:blank', '_blank');
		if (signInTab) signInTab.opener = null;
		try {
			const res = await fetch('/api/providers/chatgpt/sign-in', { method: 'POST' });
			const body = await res.json().catch(() => ({}));
			if (generation !== signInGeneration) {
				signInTab?.close();
				if (body.state) void cancelServerSignIn(body.state);
				return;
			}
			if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
			sfSignInState = body.state;
			sfSignInUrl = body.verificationUrl;
			sfDeviceCode = body.userCode;
			sfDeviceExpiresAt = body.expiresAt;
			if (signInTab && !signInTab.closed) signInTab.location.replace(sfSignInUrl);
			// The stream sends a snapshot, so approval before connect is not lost.
			signInStream = new EventSource(`/api/providers/chatgpt/sign-in/stream?state=${encodeURIComponent(body.state)}`);
			signInStream.onmessage = (e) => {
				const msg = JSON.parse(e.data);
				if (generation !== signInGeneration || msg.state !== sfSignInState) return;
				if (msg.type === 'sign-in-complete') signInFinished(msg.connectionId, msg.email ?? null);
				else if (msg.type === 'sign-in-failed') signInFailed(msg.message);
			};
			signInStream.onerror = () => {
				if (generation === signInGeneration && signInStream?.readyState === EventSource.CLOSED)
					signInFailed('The sign-in is no longer available. Start again.');
			};
		} catch (err) {
			signInTab?.close();
			if (generation === signInGeneration) signInFailed(err instanceof Error ? err.message : 'Sign-in could not start');
		}
	}

	async function cancelServerSignIn(state: string) {
		await fetch('/api/providers/chatgpt/sign-in/cancel', {
			method: 'POST', headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ state }), keepalive: true
		}).catch(() => undefined);
	}
	function cancelChatgptSignIn() {
		++signInGeneration;
		if (sfSignInState) void cancelServerSignIn(sfSignInState);
		closeSignInStream();
		sfSigningIn = false;
		sfSignInState = null;
		sfSignInUrl = '';
		sfDeviceCode = '';
	}
	async function copyDeviceCode() {
		try { await navigator.clipboard.writeText(sfDeviceCode); toast.success('Code copied'); }
		catch { toast.error('Select and copy the code manually.'); }
	}

	async function fetchChatgptModels(connectionId: string) {
		const generation = signInGeneration;
		sfFetching = true;
		sfError = '';
		try {
			const res = await fetch(`/api/providers/chatgpt/models?connection=${encodeURIComponent(connectionId)}`);
			const body = await res.json().catch(() => ({}));
			if (generation !== signInGeneration || sfConnectionId !== connectionId || sfType !== 'chatgpt') return;
			if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
			sfModels = body.models ?? [];
		} catch (err) {
			if (generation === signInGeneration) sfError = err instanceof Error ? err.message : 'Failed to fetch models';
		} finally {
			if (generation === signInGeneration) sfFetching = false;
		}
	}

	// The free filter is OpenRouter's; left on, it would empty any other list.
	const sfFilteredModels = $derived(
		sfShowFreeOnly && sfType === 'openrouter' ? sfModels.filter((m) => m.isFree) : sfModels
	);

	$effect(() => {
		if (sfFilteredModels.length > 0 && !sfFilteredModels.find((m) => m.id === sfModel)) {
			sfModel = sfFilteredModels[0].id;
		}
	});

	$effect(() => {
		const key = sfApiKey;
		const type = sfType;
		// Signed in, not keyed: its models come from the sign-in.
		if (type === 'chatgpt') return;
		if (!key) {
			// When editing, keep the server-fetched model list; only clear for add mode.
			if (!editingProvider) {
				sfModels = [];
				sfError = '';
			}
			return;
		}
		const t = setTimeout(() => fetchSheetModels(key, type), 600);
		return () => clearTimeout(t);
	});

	async function fetchSheetModels(key: string, type: string) {
		sfFetching = true;
		sfError = '';
		try {
			if (type === 'google_ai_studio') {
				const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
					headers: { 'x-goog-api-key': key }
				});
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const json = await res.json();
				const raw: { name: string; displayName: string; supportedGenerationMethods: string[] }[] =
					json.models ?? [];
				sfModels = raw
					.filter((m) => m.supportedGenerationMethods.includes('generateContent'))
					.map((m) => ({
						id: m.name.replace('models/', ''),
						name: m.displayName,
						isFree: false
					}))
					.sort((a, b) => a.name.localeCompare(b.name));
			} else if (type === 'groq') {
				const res = await fetch('https://api.groq.com/openai/v1/models', {
					headers: { Authorization: `Bearer ${key}` }
				});
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const json = await res.json();
				const raw: { id: string }[] = json.data ?? [];
				sfModels = raw
					.map((m) => ({ id: m.id, name: m.id, isFree: false }))
					.sort((a, b) => a.name.localeCompare(b.name));
			} else {
				const res = await fetch('https://openrouter.ai/api/v1/models', {
					headers: { Authorization: `Bearer ${key}` }
				});
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const json = await res.json();
				const raw: { id: string; name: string; pricing?: { prompt?: string } }[] = json.data ?? [];
				sfModels = raw
					.map((m) => ({
						id: m.id,
						name: m.name,
						isFree: parseFloat(m.pricing?.prompt ?? '1') === 0
					}))
					.sort((a, b) => a.name.localeCompare(b.name));
			}
		} catch (err) {
			sfError = err instanceof Error ? err.message : 'Failed to fetch models';
		} finally {
			sfFetching = false;
		}
	}

	const PROVIDER_LABELS: Record<string, string> = {
		openrouter: 'OpenRouter',
		google_ai_studio: 'Google AI Studio',
		groq: 'Groq',
		chatgpt: 'ChatGPT plan'
	};

	const PROVIDER_DEFAULT_NAMES: Record<string, string> = {
		openrouter: 'OpenRouter',
		google_ai_studio: 'Google AI Studio',
		groq: 'Groq',
		chatgpt: 'ChatGPT'
	};

	function openAddSheet() {
		editingProvider = null;
		sfType = 'openrouter';
		sfName = PROVIDER_DEFAULT_NAMES['openrouter'];
		sfApiKey = '';
		sfModel = '';
		sfModels = [];
		sfError = '';
		sfShowFreeOnly = false;
		resetChatgptSignIn();
		sheetOpen = true;
	}

	$effect(() => {
		if (!editingProvider) {
			sfName = PROVIDER_DEFAULT_NAMES[sfType] ?? sfType;
			sfModels = [];
		}
	});

	function openEditSheet(prov: ProviderRow) {
		editingProvider = prov;
		sfType = prov.type;
		sfName = prov.name;
		// A staged (not-yet-saved) row still holds its real key locally — prefill
		// it so re-editing doesn't look like the key was lost, and let the
		// existing debounced $effect below re-fetch its model list from that key.
		sfApiKey = prov.isNew ? prov.apiKey : '';
		sfModel = prov.model;
		sfModels = [];
		sfError = '';
		sfShowFreeOnly = false;
		resetChatgptSignIn();
		sfAccountEmail = prov.chatgptAccount?.email ?? null;
		sheetOpen = true;
		if (prov.isNew && prov.connectionId) {
			sfConnectionId = prov.connectionId;
			fetchChatgptModels(prov.connectionId);
		} else if (!prov.isNew && (prov.hasApiKey || prov.chatgptAccount)) fetchServerModels(prov.id);
	}

	async function fetchServerModels(providerId: string) {
		sfFetching = true;
		sfError = '';
		try {
			const res = await fetch(`/api/providers/${providerId}/models`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			sfModels = data.models ?? [];
		} catch (err) {
			sfError = err instanceof Error ? err.message : 'Failed to fetch models';
		} finally {
			sfFetching = false;
		}
	}

	// Add, and editing a not-yet-saved row, both stage into the local `providers`
	// list instead of hitting the DB — actual persistence happens once, when the
	// Intelligence tab's "Save" button submits ?/saveIntelligence. Editing an
	// already-persisted provider still saves immediately via ?/updateProvider.
	function handleSheetSubmit(e: SubmitEvent) {
		// A `chatgpt` row carries its sign-in, never a key.
		const signedIn = sfType === 'chatgpt';
		const staged = {
			type: sfType,
			name: sfName,
			apiKey: signedIn ? '' : sfApiKey,
			model: sfModel,
			hasApiKey: !signedIn && sfApiKey.length > 0,
			connectionId: signedIn ? (sfConnectionId ?? undefined) : undefined,
			chatgptAccount: signedIn && sfConnectionId ? { email: sfAccountEmail } : null
		};
		if (!editingProvider) {
			e.preventDefault();
			providers = [
				...providers,
				{
					id: crypto.randomUUID(),
					...staged,
					baseUrl: null,
					enabled: true,
					sortKey: '',
					createdAt: '',
					isNew: true
				}
			];
			closeSheet();
			return;
		}
		if (editingProvider.isNew) {
			e.preventDefault();
			const id = editingProvider.id;
			providers = providers.map((p) => (p.id === id ? { ...p, ...staged } : p));
			closeSheet();
		}
	}

	function closeSheet() {
		sheetOpen = false;
		cancelChatgptSignIn();
	}

	let deleteConfirmOpen = $state(false);
	let deleteTarget = $state<ProviderRow | null>(null);
	let deleteFormEl = $state<HTMLFormElement | null>(null);

	function requestDeleteProvider(prov: ProviderRow) {
		deleteTarget = prov;
		deleteConfirmOpen = true;
	}

	function confirmDeleteProvider() {
		if (deleteTarget?.isNew) {
			const id = deleteTarget.id;
			providers = providers.filter((p) => p.id !== id);
			closeSheet();
		} else {
			deleteFormEl?.requestSubmit();
		}
		deleteConfirmOpen = false;
	}

	function truncateModel(model: string, max = 32): string {
		if (model.length <= max) return model;
		return model.slice(0, max - 1) + '…';
	}

	// Tracked dependency is `form` alone — this effect must only re-run in response to a
	// new form submission. Everything inside is untracked because it's one-time sync/toast
	// logic, not a condition that should itself retrigger the effect: e.g. reading
	// `logoFileInput`/`seqFieldRef` (DOM refs that get set to null whenever their tab's
	// {#if} block unmounts) would otherwise make tab switches replay this whole block —
	// including toast.success() — since `form?.success` stays true until the next submit.
	$effect(() => {
		const f = form;
		if (!f?.success) return;
		untrack(() => {
			const action = (f as { action?: string }).action;
			if (action === 'updateProvider' || action === 'deleteProvider' || action === 'saveIntelligence') {
				providers = [...data.providers];
				if (action !== 'saveIntelligence') closeSheet();
			}
			if (action === 'saveIntelligence') {
				importProfiles = [...data.importProfiles.profiles];
				aiParallelTasks = data.autoImportParallelTasks;
				aiCategoryHints = data.autoImportCategoryHints;
				aiRateLimitSec = Math.round(data.autoImportRateLimitMs / 1000);
				aiCustomInstructions = data.autoImportCustomInstructions;
			}
			if (action === 'saveGeneral') {
				mainCur = data.currency;
				defaultAccount = String(data.ledgerDefaultAccountId ?? '');
			}
			if (action === 'saveCompany') {
				companyName = data.companyName;
				companyAddress = data.companyAddress;
				companyRegistrationNo = data.companyRegistrationNo;
				logoChange = 'none';
				letterheadChange = 'none';
			}
			if (action === 'savePdfTemplate') {
				pdfThemeColor = data.pdfThemeColor;
				pdfHeader = data.pdfHeader;
				// The server stores "007" as "7"; take its spelling back.
				invoiceDueDays = data.invoiceDueDays;
				quotationValidDays = data.quotationValidDays;
			}
			if (action === 'saveSequenceTemplate') {
				seqTemplate = data.sequenceTemplate;
				if (seqFieldRef) seqHydrate(seqFieldRef, data.sequenceTemplate);
			}
			toast.success('Settings saved');
		});
	});

	// --- Unsaved-changes guard ---
	// Every section below is local $state seeded once from `data.*` and only
	// persisted on that section's own Save click. `data.*` itself updates
	// reactively after a successful save (SvelteKit re-runs `load`), and the
	// effect above keeps local state in sync with it — so comparing against
	// live `data.*` (rather than a frozen snapshot) is self-correcting.
	const providersDirty = $derived(
		providers.length !== data.providers.length ||
		providers.some(
			(p, i) => p.isNew || p.id !== data.providers[i]?.id || p.enabled !== data.providers[i]?.enabled
		)
	);

	const profilesDirty = $derived(
		importProfiles.some(
			(p) => p.enabled !== data.importProfiles.profiles.find((saved) => saved.id === p.id)?.enabled
		)
	);

	const isDirty = $derived(
		mainCur !== data.currency ||
		defaultAccount !== String(data.ledgerDefaultAccountId ?? '') ||
		seqTemplate !== data.sequenceTemplate ||
		companyName !== data.companyName ||
		companyAddress !== data.companyAddress ||
		companyRegistrationNo !== data.companyRegistrationNo ||
		logoChange !== 'none' ||
		letterheadChange !== 'none' ||
		providersDirty ||
		profilesDirty ||
		aiParallelTasks !== data.autoImportParallelTasks ||
		aiCategoryHints !== data.autoImportCategoryHints ||
		aiRateLimitSec !== Math.round(data.autoImportRateLimitMs / 1000) ||
		aiCustomInstructions !== data.autoImportCustomInstructions ||
		pdfThemeColor !== data.pdfThemeColor ||
		pdfHeader !== data.pdfHeader ||
		invoiceDueDays !== data.invoiceDueDays ||
		quotationValidDays !== data.quotationValidDays
	);

	function resetAllUnsaved() {
		mainCur = data.currency;
		defaultAccount = String(data.ledgerDefaultAccountId ?? '');
		seqTemplate = data.sequenceTemplate;
		if (seqFieldRef) seqHydrate(seqFieldRef, data.sequenceTemplate);
		companyName = data.companyName;
		companyAddress = data.companyAddress;
		companyRegistrationNo = data.companyRegistrationNo;
		logoChange = 'none';
		letterheadChange = 'none';
		providers = [...data.providers];
		importProfiles = [...data.importProfiles.profiles];
		aiParallelTasks = data.autoImportParallelTasks;
		aiCategoryHints = data.autoImportCategoryHints;
		aiRateLimitSec = Math.round(data.autoImportRateLimitMs / 1000);
		aiCustomInstructions = data.autoImportCustomInstructions;
		pdfThemeColor = data.pdfThemeColor;
		pdfHeader = data.pdfHeader;
		invoiceDueDays = data.invoiceDueDays;
		quotationValidDays = data.quotationValidDays;
		closeSheet();
	}

	let pendingTab = $state<Tab | null>(null);
	let pendingUrl: URL | null = null;
	let unsavedConfirmOpen = $state(false);
	let allowNavigation = false;

	function requestTabChange(id: Tab) {
		if (id === activeTab) return;
		if (isDirty) {
			pendingTab = id;
			unsavedConfirmOpen = true;
		} else {
			showTab(id);
		}
	}

	function discardAndProceed() {
		resetAllUnsaved();
		if (pendingTab) {
			showTab(pendingTab);
			pendingTab = null;
		} else if (pendingUrl) {
			const url = pendingUrl;
			pendingUrl = null;
			allowNavigation = true;
			// `url` is the already-resolved internal destination SvelteKit itself
			// handed us via beforeNavigate's `nav.to.url` — it isn't a route id we
			// can pass through resolve().
			// eslint-disable-next-line svelte/no-navigation-without-resolve
			goto(url);
		}
		unsavedConfirmOpen = false;
	}

	beforeNavigate((nav) => {
		if (isDirty && !allowNavigation) {
			nav.cancel();
			pendingUrl = nav.to?.url ?? null;
			unsavedConfirmOpen = true;
		}
		allowNavigation = false;
	});

	// Derived rather than fixed only because the Books tab is there or not
	// depending on whether this user may see the reports side of things.
	const TABS: { id: Tab; label: string }[] = $derived([
		{ id: 'general', label: 'General' },
		{ id: 'company', label: 'Company' },
		...(data.canSeeBooks ? [{ id: 'books' as Tab, label: 'Books' }] : []),
		{ id: 'intelligence', label: 'Intelligence' },
		{ id: 'templates', label: 'Templates' },
		{ id: 'advanced', label: 'Advanced' }
	]);
</script>

<svelte:head>
	<title>Settings - Akaun</title>
</svelte:head>

<div class="screen">
	<header class="topbar">
		<div class="topbar-left">
			<h1 class="page-title">Settings</h1>
			<p class="page-sub">Configure your workspace</p>
		</div>
	</header>

	<div class="set-layout">
		<!-- Left nav -->
		<nav class="set-nav">
			{#each TABS as tab (tab.id)}
				<button
					class="set-nav-item"
					class:active={activeTab === tab.id}
					onclick={() => requestTabChange(tab.id)}
				>
					{tab.label}
				</button>
			{/each}
		</nav>

		<!-- Content -->
		<div class="set-content">
			{#if activeTab === 'general'}
				<div class="set-section">
					<div class="set-section-head">
						<h2 class="set-section-title">General</h2>
						<p class="set-section-sub">Currency, accounts and document numbering</p>
					</div>
					<form method="POST" action="?/saveGeneral" use:enhance={() => ({ update }) => update({ reset: false })}>
						{#if !data.currencyLocked}
							<input type="hidden" name="currencyCode" value={mainCur} />
						{/if}
						{#if data.moneyAccounts.length > 1}
							<input type="hidden" name="defaultAccountId" value={defaultAccount} />
						{/if}
						<p class="set-subsection-label">Display</p>
						<div class="set-rows">
							<div class="set-row">
								<div>
									<div class="set-row-label">Currency</div>
									<div class="set-row-value" style="font-size:12px; margin-top:2px;">All amounts display in this currency; foreign records are converted to it</div>
								</div>
								{#if data.currencyLocked}
									<div class="set-input-right" style="display:flex; align-items:center; gap:6px; color:var(--muted-foreground);">
										{curLabel} <Lock size={12} />
									</div>
								{:else}
									<Select.Root type="single" name="mainCurrencyDisplay" bind:value={mainCur}>
										<Select.Trigger class="set-input-right set-input-wide">{curLabel}</Select.Trigger>
										<Select.Content>
											{#each CURRENCIES as c (c.code)}
												<Select.Item value={c.code} label={`${c.code} — ${c.name}`} />
											{/each}
										</Select.Content>
									</Select.Root>
								{/if}
							</div>
							<!--
								Which account a new expense or income starts with (FR-011). With
								only one account there is nothing to ask, so the row is absent
								rather than shown with a single option.
							-->
							{#if data.moneyAccounts.length > 1}
								<div class="set-row">
									<div>
										<div class="set-row-label">Money usually comes from</div>
										<div class="set-row-value" style="font-size:12px; margin-top:2px;">New expenses and income start with this account already filled in. You can still change it on any record.</div>
									</div>
									{#if data.canManageAccounts}
										<Select.Root type="single" name="defaultAccountDisplay" bind:value={defaultAccount}>
											<Select.Trigger class="set-input-right set-input-wide">{defaultAccountName}</Select.Trigger>
											<Select.Content>
												{#each data.moneyAccounts as account (account.id)}
													<Select.Item value={String(account.id)} label={account.name} />
												{/each}
											</Select.Content>
										</Select.Root>
									{:else}
										<div class="set-input-right" style="color:var(--muted-foreground);">{defaultAccountName}</div>
									{/if}
								</div>
							{/if}

							<div class="set-row">
								<div>
									<div class="set-row-label">Chart of Accounts</div>
									<div class="set-row-value" style="font-size:12px; margin-top:2px;">Manage every Asset, Liability, Equity, Revenue and Expense account together.</div>
								</div>
								<a
										class="set-input-right"
										href={resolve('/(app)/accounts')}
										style="color:var(--primary); text-decoration:none;">Open accounts →</a
									>
							</div>
						</div>
						{#if data.currencyLocked}
							<p class="set-row-value" style="font-size:12px; display:flex; align-items:center; gap:4px; margin-top:6px; margin-bottom:0;">
								Currency is locked once transactions exist — changing it would silently corrupt historical amounts.
							</p>
						{/if}
						<Button type="submit" class="mt-4">Save</Button>
					</form>

					<p class="set-subsection-label" style="margin-top:32px;">Numbering</p>
					<form
						method="POST"
						action="?/saveSequenceTemplate"
						use:enhance={() => ({ update }) => update({ reset: false })}
					>
						<input type="hidden" name="template" value={seqTemplate} />
						<p class="set-row-value" style="font-size:12px; margin-top:0; margin-bottom:10px;">One format, applied to every document type</p>
						{#if data.sequenceTemplateLocked}
							<p class="set-row-value" style="font-size:12px; margin-top:0; margin-bottom:14px;">
								This format generated at least one document number, so it's now fixed.
							</p>
						{:else}
							<p class="set-row-value" style="font-size:12px; margin-top:0; margin-bottom:14px;">
								Drag or click a token to insert it — literal characters (dashes, custom text) are typed
								by hand. <code>{'{PREFIX}'}</code> resolves to each type's fixed code (EX/IN/CL/QT/IV) —
								include it or leave it out, but its value can't be changed. Exactly one
								<code>{'{SEQ}'}</code> token is required; the sequence resets whenever the resolved date
								portion of the template changes — a template with <code>{'{DD}'}</code> resets daily,
								<code>{'{YYYY}'}</code> only resets yearly, no date token never resets.
							</p>

							<div class="seq-chip-row">
								{#each SEQ_CHIPS as chip (chip.token)}
									<Badge
										variant="outline"
										class="seq-chip {seqDraggingChip === chip.token ? 'seq-chip-dragging' : ''} {seqPoppingChip === chip.token ? 'seq-chip-pop' : ''}"
										draggable={true}
										role="button"
										tabindex={0}
										ondragstart={(e: DragEvent) => seqChipDragStart(e, chip.token)}
										ondragend={seqChipDragEnd}
										onclick={() => seqChipClick(chip.token)}
										onkeydown={(e: KeyboardEvent) => {
											if (e.key === 'Enter' || e.key === ' ') {
												e.preventDefault();
												seqChipClick(chip.token);
											}
										}}
									>
										{chip.label}
									</Badge>
								{/each}
							</div>
						{/if}

						<div
							bind:this={seqFieldRef}
							class="set-input-full seq-template-field {seqDragOver ? 'seq-drag-over' : ''} {seqFlash ? 'seq-flash' : ''} {data.sequenceTemplateLocked ? 'seq-template-field-locked' : ''}"
							contenteditable={data.sequenceTemplateLocked ? 'false' : 'true'}
							role="textbox"
							aria-multiline="false"
							aria-readonly={data.sequenceTemplateLocked}
							aria-label="Document number template"
							tabindex={0}
							oninput={data.sequenceTemplateLocked ? undefined : seqSyncFromDom}
							onkeydown={data.sequenceTemplateLocked ? undefined : seqHandleKeydown}
							onpaste={data.sequenceTemplateLocked ? undefined : seqHandlePaste}
							ondragover={data.sequenceTemplateLocked ? undefined : seqTemplateDragOver}
							ondragleave={data.sequenceTemplateLocked ? undefined : seqTemplateDragLeave}
							ondrop={data.sequenceTemplateLocked ? undefined : seqTemplateDrop}
						></div>

						<p class="set-row-value" style="font-size:12px; margin-top:12px; word-break: break-word;">
							Preview: <code>{seqPreviewLine}</code>
						</p>
						{#if data.sequenceTemplateLocked}
							<p class="set-row-value" style="font-size:12px; display:flex; align-items:center; gap:4px; margin-top:6px; margin-bottom:0;">
								<Lock size={12} /> Number format is locked once any document exists — changing it would break historical document numbering.
							</p>
						{:else}
							<Button type="submit" class="mt-4">Save</Button>
						{/if}
					</form>
				</div>

			{:else if activeTab === 'company'}
				<div class="set-section">
					<div class="set-section-head">
						<h2 class="set-section-title">Company</h2>
						<p class="set-section-sub">Shown on printed quotations and invoices</p>
					</div>
					<form
						method="POST"
						action="?/saveCompany"
						enctype="multipart/form-data"
						use:enhance={() => ({ update }) => update({ reset: false })}
					>
						{#if form?.error}
							<div style="background:var(--red-soft); color:var(--red); border-radius:8px; padding:10px 14px; font-size:13px; margin-bottom:16px;">{form.error}</div>
						{/if}
						<div class="set-rows">
							<div class="set-row">
								<div>
									<div class="set-row-label">Logo</div>
								</div>
								<CompanyImageField
									fileName="companyLogo"
									removeName="removeLogo"
									savedUrl={data.companyLogoUrl}
									alt="Company logo"
									bind:change={logoChange}
								/>
							</div>
							<div class="set-row">
								<div>
									<div class="set-row-label">Letterhead</div>
									<div class="set-row-value" style="font-size:12px; margin-top:2px;">A JPEG or PNG banner. Printed at the top of quotations and invoices in place of the company name when Templates › Header is set to Letterhead.</div>
								</div>
								<CompanyImageField
									fileName="companyLetterhead"
									removeName="removeLetterhead"
									savedUrl={data.companyLetterheadUrl}
									alt="Company letterhead"
									wide
									bind:change={letterheadChange}
								/>
							</div>
							<div class="set-row set-row-col">
								<div class="set-row-label">Company Name</div>
								<Input
									name="companyName"
									bind:value={companyName}
									placeholder="e.g. Acme Sdn Bhd"
									class="set-input-full"
								/>
							</div>
							<div class="set-row set-row-col">
								<div class="set-row-label">Address</div>
								<textarea
									name="companyAddress"
									bind:value={companyAddress}
									placeholder="Street, City, State, Postcode"
									rows="3"
									class="set-textarea"
								></textarea>
							</div>
							<div class="set-row set-row-col">
								<div class="set-row-label">Registration No.</div>
								<Input
									name="companyRegistrationNo"
									bind:value={companyRegistrationNo}
									placeholder="e.g. 202301012345"
									class="set-input-full"
								/>
							</div>
						</div>
						<Button type="submit" class="mt-4">Save</Button>
					</form>
				</div>

			{:else if activeTab === 'books'}
				<AccountDefaults
					defaults={data.accountDefaults}
					accounts={data.defaultAccountOptions}
					disabled={!data.canManageAccounts}
				/>
				<div class="set-section">
					<div class="set-section-head">
						<h2 class="set-section-title">Ledger integrity check</h2>
						<p class="set-section-sub">
							Every record's debits and credits have to cancel each other out. This adds up
							every side of every record and tells you straight away if any of them don't.
						</p>
					</div>
					<div class="set-rows">
						<div class="set-row">
							<div>
								<div class="set-row-label">Run the check</div>
								<div class="set-row-value" style="font-size:12px; margin-top:2px;">
									{#if integrity}
										{integrity.recordsChecked} records checked in {integrity.elapsedMs}ms.
									{:else}
										Safe to run any time — it only reads.
									{/if}
								</div>
							</div>
							<Button type="button" variant="ghost" disabled={integrityChecking} onclick={checkTheBooks}>
								<ShieldCheck size={14} />
								{integrityChecking ? 'Checking…' : 'Check now'}
							</Button>
						</div>
					</div>

					{#if integrity}
						{#if integrity.ok}
							<p class="books-note books-note-good">
								<ShieldCheck size={14} />
								<span>All good. Every record balances, and so does everything added up together.</span>
							</p>
						{:else}
							<p class="books-note books-note-bad">
								<AlertTriangle size={14} />
								<span>
									{integrity.unbalancedRecords.length === 1
										? 'One record does not add up.'
										: `${integrity.unbalancedRecords.length} records do not add up.`}
									Nothing has been changed — this is only a report.
								</span>
							</p>
							<ul class="books-list">
								{#each integrity.unbalancedRecords as row (row.recordId)}
									<li>Record #{row.recordId} is out by {formatMinor(Math.abs(row.differenceMinor))}</li>
								{/each}
							</ul>
							{#if !integrity.booksBalance}
								<p class="set-hint">
									Added up across everything, the books are out by
									{formatMinor(Math.abs(integrity.wholeBooksDifferenceMinor))}.
								</p>
							{/if}
						{/if}
					{/if}
				</div>

				<!--
					What the one-off move to the new way of recording money had to decide
					for itself (FR-036b, FR-036c). Shown only when there is something to
					say; an installation that came up clean sees nothing here.
				-->
				{#if hasUpgradeNotes && upgradeReport}
					<div class="set-section" style="margin-top:32px;">
						<div class="set-section-head">
							<h2 class="set-section-title">Migration results</h2>
							<p class="set-section-sub">
								Moving your records to the new way of keeping them{#if data.upgrade?.finishedAt}, on
									{formatDate(data.upgrade.finishedAt.slice(0, 10))}{/if}, meant making a few
								calls without asking you. Here is every one of them, so you can check.
							</p>
						</div>

						{#if upgradeVerify && !upgradeVerify.ok}
							<p class="books-note books-note-bad">
								<AlertTriangle size={14} />
								<span>
									The update could not prove it left everything as it found it, so nothing old
									was thrown away. A copy of your data from before it ran is kept in the
									<code>pre-chart-</code> folder next to the database.
								</span>
							</p>
							<ul class="books-list">
								{#each upgradeVerify.findings as finding, i (i)}
									<li>{finding.what} — was {finding.before}, now {finding.after}</li>
								{/each}
							</ul>
						{/if}

						{#if upgradeReport.payerAttributions.length > 0}
							<p class="set-subsection-label" style="margin-top:0;">Reimbursement counterparties</p>
							<p class="set-hint" style="margin-top:0;">
								Old reimbursements only recorded the login that created them, not the person.
								This is who each one was matched to, and how.
							</p>
							<ul class="books-list">
								{#each upgradeReport.payerAttributions as row (`${row.legacyKind}-${row.legacyId}`)}
									<li>
										<strong>{row.contactName ?? 'A new contact'}</strong>
										— {PAYER_STEP_TEXT[row.step]}
										<span class="books-dim">(was {row.legacyKind} #{row.legacyId})</span>
									</li>
								{/each}
							</ul>
							<p class="set-hint">
								Got one wrong? Merge that contact into the right one on the
								<a href={resolve('/(app)/contacts')}>Contacts</a> screen — every record they are on
								moves across at once.
							</p>
						{/if}

						{#if upgradeReport.bankFallbackRecordIds.length > 0}
							<p class="set-subsection-label">Expenses with no contact</p>
							<p class="set-hint" style="margin-top:0;">
								These were never marked paid and named nobody, so there was no one to owe them
								to. They are recorded as paid from your bank account — if any of them were
								really paid by a person, open the record and say so.
							</p>
							<ul class="books-list">
								<li>{recordList(upgradeReport.bankFallbackRecordIds)}</li>
							</ul>
						{/if}

						{#if upgradeReport.uncategorisedRecordIds.length > 0}
							<p class="set-subsection-label">Uncategorised records</p>
							<p class="set-hint" style="margin-top:0;">
								No category could be read for these, so they sit under Uncategorised until you
								give them one.
							</p>
							<ul class="books-list">
								<li>{recordList(upgradeReport.uncategorisedRecordIds)}</li>
							</ul>
						{/if}

						{#if upgradeReport.missingAttachments.length > 0}
							<p class="set-subsection-label">Files that could not be found</p>
							<p class="set-hint" style="margin-top:0;">
								These attachments were not where the record said they were. Each record still
								points at the old place, so nothing has been lost that was there.
							</p>
							<ul class="books-list">
								{#each upgradeReport.missingAttachments as file (file)}
									<li>{file}</li>
								{/each}
							</ul>
						{/if}

						{#if upgradeReport.roundingDifferences.length > 0}
							<p class="set-subsection-label">Amounts that did not divide evenly</p>
							<p class="set-hint" style="margin-top:0;">
								Money is now kept in whole cents. These amounts had a fraction of a cent that
								had to go somewhere.
							</p>
							<ul class="books-list">
								{#each upgradeReport.roundingDifferences as row (row.recordId)}
									<li>Record #{row.recordId} — {formatMinor(Math.abs(row.differenceMinor))}</li>
								{/each}
							</ul>
						{/if}

						{#if upgradeReport.unrepointedAllocationIds.length > 0}
							<p class="set-subsection-label">Bank matches that did not carry over</p>
							<p class="set-hint" style="margin-top:0;">
								These bank lines were matched to a record before, and the match could not be
								moved across. Match them again on the Reconciliation screen.
							</p>
							<ul class="books-list">
								<li>{recordList(upgradeReport.unrepointedAllocationIds)}</li>
							</ul>
						{/if}
					</div>
				{/if}

			{:else if activeTab === 'intelligence'}
				<div class="set-section">
					<div class="set-section-head">
						<h2 class="set-section-title">Intelligence</h2>
						<p class="set-section-sub">Providers used for receipt extraction, import profiles, and how auto-import processes files.</p>
					</div>

					<form
						method="POST"
						action="?/saveIntelligence"
						use:enhance={() => ({ update }) => update({ reset: false })}
					>
						{#if form?.error}
							<div style="background:var(--red-soft); color:var(--red); border-radius:8px; padding:10px 14px; font-size:13px; margin-bottom:16px;">{form.error}</div>
						{/if}
						<p class="set-subsection-label" style="margin-top:0;">Providers</p>
						<input
							type="hidden"
							name="providers"
							value={JSON.stringify(
								providers.map((p) =>
									p.isNew
										? {
												isNew: true,
												tempId: p.id,
												type: p.type,
												name: p.name,
												apiKey: p.apiKey,
												model: p.model,
												baseUrl: p.baseUrl,
												enabled: p.enabled,
												connectionId: p.connectionId
											}
										: { id: p.id, enabled: p.enabled }
								)
							)}
						/>

						<div class="prov-header">
							<span class="set-row-label" style="margin:0;">Configured providers</span>
							<button type="button" class="sheet-btn sheet-btn-primary" style="padding:6px 12px; font-size:13px;" onclick={openAddSheet}>
								<Plus size={14} /> Add provider
							</button>
						</div>

						{#if providers.length === 0}
							<div class="prov-empty">
								<Zap size={20} style="opacity:0.3;" />
								<span>No providers configured — add one to enable auto-import.</span>
							</div>
						{:else}
							<div class="prov-list">
								{#each providers as prov (prov.id)}
									<div
										class="prov-row"
										class:prov-row-disabled={!prov.enabled}
										data-id={String(prov.id)}
										animate:flip={{ duration: flipDurationMs }}
										use:draggable={{
											container: 'prov-list',
											dragData: prov,
											handle: '.prov-handle',
											disabled: providers.length <= 1
										}}
										use:droppable={{
											container: 'prov-list',
											callbacks: { onDrop: handleDrop },
											disabled: providers.length <= 1
										}}
									>
										<span class="prov-handle" aria-hidden="true" class:prov-handle-hidden={providers.length <= 1}><GripVertical size={15} /></span>
										<span class="prov-type-badge">{PROVIDER_LABELS[prov.type] ?? prov.type}</span>
										<div class="prov-info">
											<span class="prov-name">{prov.name}</span>
											<span class="prov-model">{truncateModel(prov.model)}{#if prov.chatgptAccount?.email} · {prov.chatgptAccount.email}{/if}{#if prov.type === 'chatgpt' && !prov.chatgptAccount} · Reconnect required{/if}</span>
										</div>
										<button
											type="button"
											class="toggle-btn"
											class:on={prov.enabled}
											aria-pressed={prov.enabled}
											aria-label={prov.enabled ? 'Disable provider' : 'Enable provider'}
											onclick={() => {
												providers = providers.map((p) =>
													p.id === prov.id ? { ...p, enabled: !p.enabled } : p
												);
											}}
										>
											<span class="toggle-thumb"></span>
										</button>
										<button type="button" class="prov-edit-btn" title="Edit provider" onclick={() => openEditSheet(prov)}>
											<Pencil size={13} />
										</button>
									</div>
								{/each}
							</div>
						{/if}

						{#if data.importProfiles.canView}
							<p class="set-subsection-label" style="margin-top:28px;">Import profiles</p>
							<input
								type="hidden"
								name="importProfiles"
								value={JSON.stringify(importProfiles.map((p) => ({ id: p.id, enabled: p.enabled })))}
							/>
							<p class="set-row-value" style="font-size:12px; margin-top:0; margin-bottom:10px;">
								A saved way to read one kind of document, such as a marketplace statement. Enabled profiles are offered under
								“Read as” when uploading.
							</p>
							<div class="prov-header">
								<span class="set-row-label" style="margin:0;">Saved profiles</span>
								{#if canChangeProfiles}
									<div class="prof-header-actions">
										<input
											bind:this={profileFileInput}
											type="file"
											accept="application/json,.json"
											style="display:none"
											onchange={importProfileFile}
										/>
										<button
											type="button"
											class="sheet-btn"
											style="padding:6px 12px; font-size:13px;"
											title="Open a profile file exported from another installation"
											onclick={() => profileFileInput?.click()}
										>
											<Upload size={14} /> Import
										</button>
										<a
											class="sheet-btn sheet-btn-primary"
											style="padding:6px 12px; font-size:13px; text-decoration:none;"
											href={resolve('/(app)/settings/import-profiles/new')}
										>
											<Plus size={14} /> New profile
										</a>
									</div>
								{/if}
							</div>
							{#if importProfiles.length === 0}
								<div class="prov-empty">
									<FileText size={20} style="opacity:0.3;" />
									<span>
										No import profiles yet.{canChangeProfiles
											? ' Select New profile to start from an example, or from blank.'
											: ''}
									</span>
								</div>
							{:else}
								<div class="prov-list">
									{#each importProfiles as profile (profile.id)}
										<div class="prov-row related-link" class:prov-row-disabled={!profile.enabled}>
											<a class="row-link prof-link" href={profileHref(profile.id)}>
												<span class="prov-info">
													<span class="prov-name">{profile.name}</span>
													<span class="prov-model">
														{KIND_LABEL[profile.kind]}, {profile.sectionCount} section{profile.sectionCount === 1 ? '' : 's'}
													</span>
												</span>
												<ChevronRight size={14} color="var(--muted-foreground)" />
											</a>
											<button
												type="button"
												class="toggle-btn"
												class:on={profile.enabled}
												aria-pressed={profile.enabled}
												aria-label={profile.enabled ? `Disable ${profile.name}` : `Enable ${profile.name}`}
												title={canChangeProfiles ? undefined : 'Turning a profile on or off needs permission to change imports.'}
												disabled={!canChangeProfiles}
												onclick={() => {
													importProfiles = importProfiles.map((p) =>
														p.id === profile.id ? { ...p, enabled: !p.enabled } : p
													);
												}}
											>
												<span class="toggle-thumb"></span>
											</button>
										</div>
									{/each}
								</div>
							{/if}
						{/if}

						<p class="set-subsection-label" style="margin-top:28px;">Processing</p>
						<input type="hidden" name="categoryHints" value={String(aiCategoryHints)} />
						<input type="hidden" name="parallelTasks" value={aiParallelTasks} />
						<input type="hidden" name="rateLimitMs" value={aiRateLimitSec * 1000} />
						<p class="set-row-value" style="font-size:12px; margin-top:0; margin-bottom:10px;">Global settings for auto-import processing</p>
						<div class="set-rows">
							<div class="set-row">
								<div>
									<div class="set-row-label">Parallel tasks</div>
									<div class="set-row-value" style="font-size:12px; margin-top:2px;">Process up to {aiParallelTasks} file{aiParallelTasks !== 1 ? 's' : ''} at once</div>
								</div>
								<div class="slider-row">
									<Slider
										type="multiple"
										min={1}
										max={10}
										step={1}
										value={[aiParallelTasks]}
										onValueChange={handleSliderChange}
										style="width:140px;"
									/>
									<span class="slider-val num">{aiParallelTasks}</span>
								</div>
							</div>
							<div class="set-row">
								<div>
									<div class="set-row-label">Rate limit</div>
									<div class="set-row-value" style="font-size:12px; margin-top:2px;">{aiRateLimitSec === 0 ? 'No delay between AI calls' : `Wait ${aiRateLimitSec}s between AI calls`}</div>
								</div>
								<div class="slider-row">
									<Slider
										type="multiple"
										min={0}
										max={30}
										step={1}
										value={[aiRateLimitSec]}
										onValueChange={handleRateLimitSliderChange}
										style="width:140px;"
									/>
									<span class="slider-val num">{aiRateLimitSec}s</span>
								</div>
							</div>
							<div class="set-row">
								<div>
									<div class="set-row-label">Category hints</div>
									<div class="set-row-value" style="font-size:12px; margin-top:2px;">Learn from your last 100 categorised items</div>
								</div>
								<button
									type="button"
									class="toggle-btn"
									aria-label="Category hints"
									class:on={aiCategoryHints}
									onclick={() => { aiCategoryHints = !aiCategoryHints; }}
									aria-pressed={aiCategoryHints}
								>
									<span class="toggle-thumb"></span>
								</button>
							</div>
							<div class="set-row set-row-col">
								<div class="set-row-label">Custom instructions</div>
								<div class="set-row-value" style="font-size:12px; margin-top:2px; margin-bottom:6px;">
									Extra guidance for the AI when reading your documents — e.g. recurring suppliers, unusual formats, or category rules specific to your business.
									A document read with an import profile uses that profile's own instructions in place of these.
								</div>
								<textarea
									name="customInstructions"
									bind:value={aiCustomInstructions}
									placeholder={'e.g. "Grab receipts are always a food expense" or "Invoices from Acme Corp use category Software"'}
									rows="4"
									maxlength="2000"
									class="set-textarea"
								></textarea>
							</div>
						</div>
						<Button type="submit" class="mt-4">Save</Button>
					</form>
				</div>

			{:else if activeTab === 'templates'}
				<div class="set-section">
					<div class="set-section-head">
						<h2 class="set-section-title">Templates</h2>
						<p class="set-section-sub">Set the accent color and header for printed quotations and invoices, and the terms new ones start with</p>
					</div>
					<form method="POST" action="?/savePdfTemplate" use:enhance={() => ({ update }) => update({ reset: false })}>
						{#if form?.error}
							<div style="background:var(--red-soft); color:var(--red); border-radius:8px; padding:10px 14px; font-size:13px; margin-bottom:16px;">{form.error}</div>
						{/if}
						<p class="set-subsection-label">Printed documents</p>
						<div class="set-rows">
							<div class="set-row set-row-col">
								<div class="set-row-label">Layout</div>
								<div class="layout-static">
									<span class="layout-static-name">Standard</span>
									<span class="layout-static-desc">{standardLayoutDescription}</span>
								</div>
							</div>
							<div class="set-row set-row-col">
								<div class="set-row-label">Accent color</div>
								<ColorPicker
									value={pdfThemeColor}
									onValueChange={(c) => (pdfThemeColor = c)}
									presets={PDF_THEME_PRESETS}
								/>
								<input type="hidden" name="themeColor" value={pdfThemeColor} />
							</div>
							<div class="set-row">
								<div>
									<div class="set-row-label">Header</div>
									<div class="set-row-value" style="font-size:12px; margin-top:2px;">
										{#if data.companyLetterheadUrl}
											What prints at the top of the page. The layout decides where it goes.
										{:else}
											Upload a letterhead on the Company tab to print it instead of the company name.
										{/if}
									</div>
								</div>
								<div class="seg sm" role="group" aria-label="Header">
									<button
										type="button"
										class="seg-btn"
										class:active={pdfHeader === 'name'}
										aria-pressed={pdfHeader === 'name'}
										onclick={() => (pdfHeader = 'name')}
									>
										Company name
									</button>
									<button
										type="button"
										class="seg-btn"
										class:active={pdfHeader === 'letterhead'}
										aria-pressed={pdfHeader === 'letterhead'}
										disabled={!data.companyLetterheadUrl && pdfHeader !== 'letterhead'}
										onclick={() => (pdfHeader = 'letterhead')}
									>
										Letterhead
									</button>
								</div>
								<input type="hidden" name="pdfHeader" value={pdfHeader} />
							</div>
						</div>
						<p class="set-subsection-label">Default terms</p>
						<div class="set-rows">
							<div class="set-row">
								<div>
									<div class="set-row-label">Invoice due in (days)</div>
									<div class="set-row-value" style="font-size:12px; margin-top:2px;">A new invoice is due this many days after its issue date. 0 is due on receipt; leave blank for no due date.</div>
								</div>
								<Input
									name="invoiceDueDays"
									type="text"
									inputmode="numeric"
									placeholder="None"
									bind:value={invoiceDueDays}
									class="set-input-right"
									style="width:120px;"
								/>
							</div>
							<div class="set-row">
								<div>
									<div class="set-row-label">Quotation valid for (days)</div>
									<div class="set-row-value" style="font-size:12px; margin-top:2px;">A new quotation expires this many days after its issue date. Leave blank for no expiry date.</div>
								</div>
								<Input
									name="quotationValidDays"
									type="text"
									inputmode="numeric"
									placeholder="None"
									bind:value={quotationValidDays}
									class="set-input-right"
									style="width:120px;"
								/>
							</div>
						</div>
						<input type="hidden" name="invoiceLayoutKey" value={DEFAULT_LAYOUT_KEY} />
						<input type="hidden" name="quotationLayoutKey" value={DEFAULT_LAYOUT_KEY} />
						<Button type="submit" class="mt-4">Save</Button>
					</form>
				</div>

			{:else if activeTab === 'advanced'}
				<div class="set-section">
					<div class="set-section-head">
						<h2 class="set-section-title">Search index</h2>
						<p class="set-section-sub">Rebuild searchable text for every expense, income, quotation, invoice and contact — including re-reading scanned documents.</p>
					</div>
					<div class="set-rows">
						<div class="set-row">
							<div>
								<div class="set-row-label">Rebuild search index</div>
								<div class="set-row-value" style="font-size:12px; margin-top:2px;">
									{#if rebuildStatus?.running}
										Rebuilding… {rebuildStatus.processed} / {rebuildStatus.total} ({rebuildPercent}%)
									{:else if rebuildStatus?.finishedAt}
										{#if rebuildStatus.error}
											Last run failed: {rebuildStatus.error}
										{:else}
											Last rebuilt {rebuildStatus.processed} records.
										{/if}
									{:else}
										Re-extracts text from stored files and recomputes search text for all records.
									{/if}
								</div>
							</div>
							<Button
								type="button"
								variant="ghost"
								disabled={rebuildStatus?.running}
								onclick={triggerRebuild}
							>
								<RefreshCw size={14} class={rebuildStatus?.running ? 'animate-spin' : ''} />
								{rebuildStatus?.running ? 'Rebuilding…' : 'Rebuild'}
							</Button>
						</div>
						{#if rebuildStatus?.running}
							<div class="rebuild-progress-track">
								<div class="rebuild-progress-fill" style="width:{rebuildPercent}%"></div>
							</div>
						{/if}
					</div>
				</div>
			{/if}
		</div>
	</div>
</div>

<!-- Add / Edit Provider Sheet -->
<Sheet.Root
	open={sheetOpen}
	onOpenChange={(o) => { if (!o) closeSheet(); }}
>
		<Sheet.Content
			side={panelSide}
			style={isMobile
				? 'height:100dvh; border-radius:0; border-top:none; display:flex; flex-direction:column; overflow:hidden; gap:0;'
				: 'width:500px; max-width:95vw; display:flex; flex-direction:column; overflow:hidden; gap:0;'}
		>
			<div style="display:flex; align-items:flex-start; justify-content:space-between; padding:22px 22px 16px; border-bottom:1px solid var(--border);">
				<div>
					<div class="sheet-eyebrow">LLM Provider</div>
					<div class="sheet-title-text">{editingProvider ? editingProvider.name : 'Add provider'}</div>
				</div>
				<Sheet.Close class="sheet-close"><X size={16} /></Sheet.Close>
			</div>

			<form
				method="POST"
				action="?/updateProvider"
				use:enhance={({ cancel }) => {
					// Adding, or editing a staged row, only stages locally
					// (handleSheetSubmit). `enhance` ignores that handler's
					// preventDefault, so it is cancelled here, or it would post
					// ?/updateProvider with no id: "Provider ID is required".
					if (!editingProvider || editingProvider.isNew) {
						cancel();
						return;
					}
					return ({ update }) => update({ reset: false });
				}}
				onsubmit={handleSheetSubmit}
				style="flex:1; display:flex; flex-direction:column; overflow:hidden;"
			>
				{#if editingProvider && !editingProvider.isNew}
					<input type="hidden" name="id" value={editingProvider.id} />
					{#if sfType === 'chatgpt' && sfConnectionId}
						<input type="hidden" name="connectionId" value={sfConnectionId} />
					{/if}
				{/if}

				<div style="flex:1; overflow-y:auto; padding:20px 22px;">
					{#if form?.error}
						<div style="background:var(--red-soft); color:var(--red); border-radius:8px; padding:10px 14px; font-size:13px; margin-bottom:16px;">{form.error}</div>
					{/if}

					<div class="field">
						<label class="field-label" for="sf-type">Provider type</label>
						<!-- A saved provider keeps its type: ?/updateProvider does not change it. -->
						<Select.Root
							type="single"
							name="type"
							bind:value={sfType}
							onValueChange={changeSheetProviderType}
							disabled={editingProvider !== null && !editingProvider.isNew}
						>
							<Select.Trigger id="sf-type" class="w-full">
								{PROVIDER_LABELS[sfType] ?? sfType}
							</Select.Trigger>
							<Select.Content>
								<Select.Item value="openrouter" label="OpenRouter" />
								<Select.Item value="google_ai_studio" label="Google AI Studio" />
								<Select.Item value="groq" label="Groq" />
								<Select.Item value="chatgpt" label="ChatGPT plan" />
							</Select.Content>
						</Select.Root>
						<span style="font-size:11px; color:var(--muted-foreground); margin-top:4px; display:block;">
							{#if sfType === 'openrouter'}
								Unified API gateway — access hundreds of models with one key. <a href="https://openrouter.ai/keys" target="_blank" rel="noopener noreferrer" style="color:var(--primary);">Get a key ↗</a>
							{:else if sfType === 'google_ai_studio'}
								Direct access to Gemini models. <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer" style="color:var(--primary);">Get a key ↗</a>
							{:else if sfType === 'groq'}
								Fast open-source model inference (Llama, Mixtral and more). <a href="https://console.groq.com/keys" target="_blank" rel="noopener noreferrer" style="color:var(--primary);">Get a key ↗</a>
							{:else if sfType === 'chatgpt'}
								Uses your ChatGPT subscription's Codex access instead of an API key. Enable device code login in ChatGPT Security settings, or ask your workspace administrator.
							{/if}
						</span>
					</div>

					<div class="field">
						<label class="field-label" for="sf-name">Name</label>
						<Input
							id="sf-name"
							name="name"
							class="w-full"
							placeholder="e.g. OpenRouter"
							value={sfName}
							oninput={(e) => (sfName = (e.target as HTMLInputElement).value)}
							required
						/>
					</div>

					{#if sfType === 'chatgpt'}
						{@const accountEmail = sfAccountEmail ?? editingProvider?.chatgptAccount?.email ?? null}
						<div class="field">
							<span class="field-label">ChatGPT account</span>
							{#if !sfSigningIn && (sfConnectionId || editingProvider?.chatgptAccount)}
								<div style="display:flex; align-items:center; justify-content:space-between; gap:12px; font-size:13px; padding:8px 12px; border:1px solid var(--border); border-radius:6px;">
									<span>Signed in{#if accountEmail} as <strong>{accountEmail}</strong>{/if}</span>
									<button type="button" class="sheet-btn" style="padding:4px 10px; font-size:12px;" onclick={startChatgptSignIn}>Sign in again</button>
								</div>
							{:else}
								<div style="display:flex; gap:8px; align-items:center;">
									<button type="button" class="sheet-btn sheet-btn-primary" onclick={startChatgptSignIn} disabled={sfSigningIn}>
										{#if sfSigningIn}<span class="spinner sm"></span> Waiting for ChatGPT…{:else}Sign in with ChatGPT{/if}
									</button>
									{#if sfSigningIn}
										<button type="button" class="sheet-btn" onclick={cancelChatgptSignIn}>Cancel</button>
									{/if}
								</div>
							{/if}
							{#if sfSigningIn && sfSignInUrl}
								<div class="field" style="margin-top:12px;">
									<span class="field-label">Your one-time sign-in code</span>
									<div style="display:flex; gap:8px; align-items:center;">
										<strong style="font-family:monospace; font-size:20px; user-select:all;">{sfDeviceCode}</strong>
										<button type="button" class="sheet-btn" onclick={copyDeviceCode}>Copy code</button>
									</div>
									<span style="font-size:12px; color:var(--muted-foreground);">Open ChatGPT, enter this code and approve. Akaun will connect automatically. Expires at {new Date(sfDeviceExpiresAt).toLocaleTimeString()}.</span>
									<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external OpenAI verification page. -->
									<a href={sfSignInUrl} target="_blank" rel="noopener noreferrer" class="sheet-btn">Open ChatGPT ↗</a>
								</div>
							{/if}
							{#if editingProvider && !editingProvider.isNew && !editingProvider.chatgptAccount && !sfConnectionId && !sfSigningIn}
								<span style="font-size:12px; color:var(--muted-foreground);">This provider needs device sign-in. Reconnect and select an available model before saving.</span>
							{/if}
							{#if sfSignInError}
								<div style="font-size:12px; color:var(--red); margin-top:6px;">{sfSignInError}</div>
							{/if}
						</div>
					{:else}
						<div class="field">
							<label class="field-label" for="sf-apikey">API key</label>
							<Input
								id="sf-apikey"
								name="apiKey"
								type="password"
								class="w-full"
								placeholder={editingProvider?.hasApiKey
									? 'Leave blank to keep current key'
									: sfType === 'google_ai_studio' ? 'AQ…' : sfType === 'groq' ? 'gsk_…' : 'sk-or-v1-…'}
								value={sfApiKey}
								oninput={(e) => (sfApiKey = (e.target as HTMLInputElement).value)}
							/>
						</div>
					{/if}

					{#if sfType === 'openrouter'}
						<div class="field" style="flex-direction:row; align-items:center; justify-content:space-between; gap:12px;">
							<div>
								<span class="field-label" style="margin-bottom:0;">Free models only</span>
								<span style="font-size:11px; color:var(--muted-foreground); display:block;">Only show models with no usage cost</span>
							</div>
							<button
								type="button"
								class="toggle-btn"
								aria-label="Free models only"
								class:on={sfShowFreeOnly}
								onclick={() => { sfShowFreeOnly = !sfShowFreeOnly; }}
								aria-pressed={sfShowFreeOnly}
							>
								<span class="toggle-thumb"></span>
							</button>
						</div>
					{/if}

					<div class="field">
						<label class="field-label" for="sf-model">Model</label>
						{#if sfFetching}
							<div style="font-size:12px; color:var(--muted-foreground); display:flex; align-items:center; gap:6px; margin-bottom:6px;">
								<span class="spinner sm"></span> Fetching models…
							</div>
						{:else if sfError}
							<div style="font-size:12px; color:var(--red); margin-bottom:6px;">{sfError}</div>
							{#if sfType === 'chatgpt' && sfConnectionId}
								<button type="button" class="sheet-btn" onclick={() => sfConnectionId && fetchChatgptModels(sfConnectionId)}>Retry loading models</button>
							{/if}
						{/if}

						{#if sfFilteredModels.length > 0}
							<input type="hidden" name="model" value={sfModel} />
							<Select.Root type="single" bind:value={sfModel}>
								<Select.Trigger id="sf-model" class="w-full">
									{(sfFilteredModels.find((m) => m.id === sfModel)?.name ?? sfModel) || 'Select model'}
								</Select.Trigger>
								<Select.Content>
									{#each sfFilteredModels as m (m.id)}
										<Select.Item value={m.id} label={m.name} />
									{/each}
								</Select.Content>
							</Select.Root>
						{:else}
							{@const fallbackModel = editingProvider !== null && !(sfType === 'chatgpt' && sfConnectionId) ? (editingProvider?.model ?? '') : ''}
							<input type="hidden" name="model" value={sfModel || fallbackModel} />
							<div style="font-size:12px; color:var(--muted-foreground); padding:8px 12px; border:1px solid var(--border); border-radius:6px; background:var(--muted);">
								{fallbackModel || (sfType === 'chatgpt' ? 'Sign in to load available models' : 'Enter API key to load available models')}
							</div>
						{/if}
					</div>
				</div>

				<div class="sheet-foot">
					<div class="sheet-foot-actions">
						{#if editingProvider}
							<button
								type="button"
								class="sheet-btn sheet-btn-delete"
								style="margin-right:auto;"
								onclick={() => editingProvider && requestDeleteProvider(editingProvider)}
							>
								<Trash2 size={14} /> Delete
							</button>
						{/if}
						<button type="button" class="sheet-btn" onclick={closeSheet}>Cancel</button>
						<button
							type="submit"
							class="sheet-btn sheet-btn-primary"
							disabled={!sfName ||
								(!sfModel && !editingProvider) ||
								(sfType === 'chatgpt' &&
									(sfSigningIn || (sfConnectionId && (sfFetching || !sfModels.some((m) => m.id === sfModel))) ||
									(!sfConnectionId && !(editingProvider && !editingProvider.isNew && editingProvider.chatgptAccount))))}
						>
							{editingProvider ? 'Save changes' : 'Add provider'}
						</button>
					</div>
				</div>
			</form>
		</Sheet.Content>
</Sheet.Root>

{#if deleteTarget}
	<ConfirmDialog
		bind:open={deleteConfirmOpen}
		title="Delete provider"
		description="Remove {deleteTarget.name}? This cannot be undone."
		confirmLabel="Delete"
		danger
		onConfirm={confirmDeleteProvider}
	/>
	<form
		bind:this={deleteFormEl}
		method="POST"
		action="?/deleteProvider"
		use:enhance={() => ({ update }) => update({ reset: false })}
		style="display:none;"
	>
		<input type="hidden" name="id" value={deleteTarget.id} />
	</form>
{/if}

<ConfirmDialog
	bind:open={unsavedConfirmOpen}
	title="Unsaved changes"
	description="You have unsaved changes on this page. Leave and discard them?"
	confirmLabel="Discard changes"
	cancelLabel="Keep editing"
	onConfirm={discardAndProceed}
/>

<style>
	.seg-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}


	.set-hint {
		font-size: 12px;
		color: var(--muted-foreground);
		margin-top: 12px;
		max-width: 62ch;
		line-height: 1.5;
	}

	.set-hint a {
		color: var(--primary);
	}

	.books-note {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		font-size: 13px;
		line-height: 1.5;
		border-radius: 8px;
		padding: 10px 14px;
		margin-top: 14px;
		max-width: 68ch;
	}

	.books-note-good {
		background: var(--green-soft);
		color: var(--green);
	}

	.books-note-bad {
		background: var(--red-soft);
		color: var(--red);
	}

	.books-list {
		margin: 10px 0 0;
		padding-left: 18px;
		font-size: 12.5px;
		line-height: 1.7;
		color: var(--muted-foreground);
		max-width: 68ch;
		overflow-wrap: anywhere;
	}

	.books-dim {
		color: var(--muted-foreground);
		opacity: 0.75;
	}




	.seq-chip-row {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-bottom: 10px;
	}

	:global(.seq-chip) {
		cursor: grab;
		user-select: none;
		background: var(--accent) !important;
		color: var(--accent-foreground) !important;
		border-color: transparent !important;
		transition:
			transform 120ms ease,
			box-shadow 120ms ease,
			opacity 150ms ease;
	}

	:global(.seq-chip:hover) {
		transform: translateY(-1px);
		box-shadow: 0 2px 6px oklch(0 0 0 / 0.12);
	}

	:global(.seq-chip:active) {
		cursor: grabbing;
	}

	:global(.seq-chip-dragging) {
		opacity: 0.4;
		transform: scale(0.95);
	}

	:global(.seq-chip-pop) {
		animation: seq-chip-pop 180ms ease;
	}

	@keyframes seq-chip-pop {
		0% {
			transform: scale(1);
		}
		50% {
			transform: scale(1.15);
		}
		100% {
			transform: scale(1);
		}
	}

	.seq-template-field {
		width: 100%;
		min-height: 36px;
		padding: 7px 10px;
		font-size: 13.5px;
		font-family: var(--font-mono, monospace);
		line-height: 20px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--card);
		color: var(--foreground);
		outline: none;
		white-space: pre-wrap;
		word-break: break-word;
		cursor: text;
		transition:
			border-color 150ms ease,
			background-color 150ms ease;
	}

	.seq-template-field:focus {
		border-color: var(--primary);
	}

	.seq-template-field-locked {
		cursor: default;
		color: var(--muted-foreground);
	}

	.seq-template-field-locked :global(.seq-inline-badge) {
		cursor: default;
		background: oklch(0.97 0.04 85 / 0.6);
		border: 1px solid oklch(0.85 0.1 85);
		color: oklch(0.45 0.15 70);
	}

	:global(.dark) .seq-template-field-locked :global(.seq-inline-badge) {
		background: oklch(0.25 0.05 85 / 0.4);
		border-color: oklch(0.4 0.1 85);
		color: oklch(0.75 0.1 85);
	}

	:global(.seq-inline-badge) {
		display: inline-flex;
		align-items: center;
		vertical-align: middle;
		padding: 1px 6px;
		margin: 0 1px;
		border-radius: 9999px;
		background: var(--accent);
		color: var(--accent-foreground);
		font-size: 11.5px;
		font-weight: 500;
		font-family: inherit;
		white-space: nowrap;
		user-select: none;
		cursor: grab;
		transition:
			opacity 150ms ease,
			transform 180ms cubic-bezier(0.16, 1, 0.3, 1);
	}

	:global(.seq-inline-badge-dragging) {
		opacity: 0.4;
	}

	/* Starting state for a freshly-dropped badge — the class is removed one
	   frame after insertion so the badge transitions from this into place. */
	:global(.seq-inline-badge-enter) {
		opacity: 0;
		transform: scale(0.75);
	}

	:global(.seq-drop-placeholder) {
		display: inline-block;
		width: 0;
		height: 15px;
		vertical-align: middle;
		margin: 0 1px;
		border-radius: 9999px;
		border: 1.5px dashed var(--primary);
		background: var(--primary-soft);
		opacity: 0;
		transition:
			width 200ms cubic-bezier(0.16, 1, 0.3, 1),
			opacity 200ms cubic-bezier(0.16, 1, 0.3, 1);
	}

	:global(.seq-drop-placeholder-grown) {
		width: 26px;
		opacity: 1;
	}

	.seq-drag-over {
		border-color: var(--primary) !important;
		box-shadow: 0 0 0 3px var(--primary-soft);
	}

	.seq-flash {
		border-color: var(--primary) !important;
		box-shadow: 0 0 0 3px var(--primary-soft);
		transition:
			border-color 400ms ease,
			box-shadow 400ms ease;
	}

	@media (prefers-reduced-motion: reduce) {
		:global(.seq-chip),
		:global(.seq-chip:hover),
		:global(.seq-chip-dragging),
		:global(.seq-chip-pop),
		:global(.seq-inline-badge),
		:global(.seq-drop-placeholder),
		.seq-template-field {
			transition: none;
			animation: none;
			transform: none;
		}
	}

	.rebuild-progress-track {
		height: 6px;
		border-radius: 999px;
		background: var(--accent);
		overflow: hidden;
		margin: 0 0 16px;
	}

	.rebuild-progress-fill {
		height: 100%;
		border-radius: 999px;
		background: var(--primary);
		transition: width 200ms ease;
	}

	/* Provider list */
	.prov-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 12px;
	}
	.prof-header-actions {
		display: flex;
		gap: 8px;
	}

	.prov-empty {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 20px 16px;
		border: 1px dashed var(--border);
		border-radius: 10px;
		font-size: 13px;
		color: var(--muted-foreground);
		margin-bottom: 4px;
	}

	.prov-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.prov-row {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px 12px;
		border: 1px solid var(--border);
		border-radius: 10px;
		background: var(--card);
		transition: border-color 0.15s, box-shadow 0.15s, transform 0.15s, opacity 0.15s;
	}

	.prov-row:hover {
		border-color: var(--primary);
	}

	.prov-row:global(.dragging) {
		opacity: 0.55;
		box-shadow: 0 6px 20px rgba(0, 0, 0, 0.1);
		transform: scale(1.01);
	}

	.prov-row-disabled {
		opacity: 0.55;
	}

	.prov-handle {
		cursor: grab;
		color: var(--muted-foreground);
		flex-shrink: 0;
		display: flex;
		align-items: center;
	}

	.prov-handle:active {
		cursor: grabbing;
	}

	.prov-handle-hidden {
		visibility: hidden;
		cursor: default;
	}

	.prov-type-badge {
		flex-shrink: 0;
		font-size: 11px;
		font-weight: 600;
		padding: 2px 8px;
		border-radius: 20px;
		background: color-mix(in srgb, var(--primary) 12%, transparent);
		color: var(--primary);
		letter-spacing: 0.01em;
	}

	.prov-info {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.prov-name {
		font-size: 13px;
		font-weight: 500;
		color: var(--foreground);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.prov-model {
		font-size: 11px;
		color: var(--muted-foreground);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		font-family: var(--font-mono, monospace);
	}

	.prov-edit-btn {
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border-radius: 6px;
		border: 1px solid var(--border);
		background: transparent;
		color: var(--muted-foreground);
		cursor: pointer;
		transition: background 0.12s, color 0.12s;
	}

	/* An import profile row: the name opens the profile, the switch beside it
	   turns it on or off. */
	.prof-link {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 10px;
		color: inherit;
		text-decoration: none;
		border-radius: 6px;
	}

	.prof-link:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
	}

	.toggle-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.prov-edit-btn:hover {
		background: var(--accent);
		color: var(--foreground);
	}

	/* Sheet field spacing */
	.field {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin-bottom: 16px;
	}

	/* Templates tab */
	.layout-static {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 10px 12px;
		border-radius: 8px;
		border: 1px solid var(--border);
		background: var(--muted);
	}
	.layout-static-name { font-size: 13px; font-weight: 600; color: var(--foreground); }
	.layout-static-desc { font-size: 12px; color: var(--muted-foreground); }
</style>
