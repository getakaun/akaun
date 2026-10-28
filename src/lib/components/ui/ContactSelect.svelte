<script lang="ts">
	import { onMount } from 'svelte';
	import { SvelteSet, SvelteURLSearchParams } from 'svelte/reactivity';
	import { cn, focusRingClass, focusRingOpenClass } from '$lib/utils.js';
	import XIcon from '@lucide/svelte/icons/x';

	type Candidate = { id: number; legalName: string; score?: number };

	let {
		value = $bindable(null),
		newName = $bindable(null),
		role,
		id,
		searchUrl = '/api/contacts',
		allowCreate = true,
		disabled = false,
		placeholder = 'Search contact…',
		initialLabel = null,
		suggestions = [],
		onChange = undefined,
		onSelect = undefined
	}: {
		value?: number | null;
		newName?: string | null;
		role?: number;
		id?: string;
		searchUrl?: string;
		allowCreate?: boolean;
		disabled?: boolean;
		placeholder?: string;
		// Label to show when `value` is pre-set but we haven't fetched its name yet.
		initialLabel?: string | null;
		// Optional fuzzy candidates to show first (import match_candidates).
		suggestions?: Candidate[];
		// Fired whenever the selection changes (existing pick / new name / cleared).
		onChange?: (v: { value: number | null; newName: string | null }) => void;
		// Optional full selected contact, including names fetched beyond the initial page.
		onSelect?: (contact: Candidate) => void;
	} = $props();

	const controlClass = cn(
		'border-input h-9 w-full rounded-md border bg-card px-3 text-[13.5px] transition-[color,box-shadow] outline-none disabled:cursor-not-allowed disabled:opacity-50 flex items-center',
		focusRingClass
	);

	let open = $state(false);
	let query = $state('');
	let debounced = $state('');
	let results = $state<Candidate[]>([]);
	// svelte-ignore state_referenced_locally
	let selectedLabel = $state<string | null>(initialLabel);
	let rootEl: HTMLDivElement;

	// Debounce the search term (mirrors the SearchInput 300ms pattern).
	// `query` must be read synchronously here, not inside the setTimeout callback —
	// Svelte only tracks dependencies from reads made during the effect's own
	// (synchronous) execution, so a read inside the async callback never re-triggers it.
	$effect(() => {
		const v = query;
		const t = setTimeout(() => (debounced = v), 300);
		return () => clearTimeout(t);
	});

	$effect(() => {
		const term = debounced.trim();
		if (!open) return;
		// Abort a still-in-flight request from a stale search term so its response can't
		// land after (and overwrite results with) a more recent, narrower search.
		const controller = new AbortController();
		const params = new SvelteURLSearchParams();
		if (role !== undefined) params.set('role', String(role));
		if (term) params.set('search', term);
		const url = `${searchUrl}?${params}`;
		fetch(url, { signal: controller.signal })
			.then((r) => (r.ok ? r.json() : []))
			.then((rows: Candidate[]) => {
				results = rows.map((r) => ({ id: r.id, legalName: r.legalName }));
			})
			.catch((err) => {
				if (err instanceof DOMException && err.name === 'AbortError') return;
				results = [];
			});
		return () => controller.abort();
	});

	// Merge fuzzy suggestions ahead of live results (dedup by id). Suggestions keep their
	// score order (relevant "did you mean" hints); the rest is sorted alphabetically.
	const shown = $derived.by(() => {
		const seen = new SvelteSet<number>();
		const suggested: Candidate[] = [];
		for (const c of suggestions) {
			if (seen.has(c.id)) continue;
			seen.add(c.id);
			suggested.push(c);
		}
		const rest: Candidate[] = [];
		for (const c of results) {
			if (seen.has(c.id)) continue;
			seen.add(c.id);
			rest.push(c);
		}
		rest.sort((a, b) => a.legalName.localeCompare(b.legalName, undefined, { sensitivity: 'base' }));
		return [...suggested, ...rest];
	});

	const typed = $derived(query.trim());
	const showCreate = $derived(
		allowCreate && typed.length > 0 &&
			!shown.some((c) => c.legalName.toLowerCase() === typed.toLowerCase())
	);

	function pick(c: Candidate) {
		value = c.id;
		newName = null;
		selectedLabel = c.legalName;
		open = false;
		query = '';
		onChange?.({ value, newName });
		onSelect?.(c);
	}

	function createNew() {
		value = null;
		newName = typed;
		selectedLabel = typed;
		open = false;
		query = '';
		onChange?.({ value, newName });
	}

	function clear() {
		value = null;
		newName = null;
		selectedLabel = null;
		query = '';
		onChange?.({ value, newName });
	}

	onMount(() => {
		const onDocClick = (e: MouseEvent) => {
			if (rootEl && !rootEl.contains(e.target as Node)) {
				open = false;
				if (!selectedLabel) query = '';
			}
		};
		document.addEventListener('click', onDocClick);
		return () => document.removeEventListener('click', onDocClick);
	});
</script>

<div class="relative w-full" bind:this={rootEl}>
	{#if selectedLabel && !open}
		<button
			type="button"
			{id}
			class={cn(controlClass, 'justify-between gap-2 text-left cursor-pointer')}
			data-state={open ? 'open' : 'closed'}
			{disabled}
			onclick={() => (open = true)}
		>
			<span class="overflow-hidden text-ellipsis whitespace-nowrap">{selectedLabel}</span>
			{#if !disabled}
				<span
					role="button"
					tabindex="0"
					aria-label="Clear contact"
					class="text-muted-foreground flex shrink-0 items-center hover:text-foreground"
					onclick={(e) => {
						e.stopPropagation();
						clear();
					}}
					onkeydown={(e) => {
						if (e.key === 'Enter' || e.key === ' ') {
							e.preventDefault();
							clear();
						}
					}}
				><XIcon size={13} /></span>
			{/if}
		</button>
	{:else}
		<input
			class={cn(controlClass, 'placeholder:text-muted-foreground', open && focusRingOpenClass)}
			data-state={open ? 'open' : 'closed'}
			type="text"
			{id}
			{placeholder}
			{disabled}
			bind:value={query}
			onfocus={() => (open = true)}
		/>
	{/if}

	{#if open && !disabled}
		<div
			class="bg-popover text-popover-foreground ring-foreground/10 absolute top-[calc(100%+4px)] left-0 right-0 z-50 max-h-64 overflow-y-auto rounded-lg p-1.5 shadow-md ring-1"
		>
			{#if showCreate}
				<button
					type="button"
					class="hover:bg-accent text-primary block w-full rounded-md px-2 py-1.5 text-left text-sm"
					onclick={createNew}
				>
					Create "{typed}"
				</button>
			{/if}
			{#each shown as c (c.id)}
				<button
					type="button"
					class="hover:bg-accent hover:text-accent-foreground block w-full rounded-md px-2 py-1.5 text-left text-sm"
					onclick={() => pick(c)}
				>
					{c.legalName}
				</button>
			{:else}
				{#if !showCreate}
					<div class="text-muted-foreground px-2 py-1.5 text-sm">No matching contacts</div>
				{/if}
			{/each}
		</div>
	{/if}
</div>
