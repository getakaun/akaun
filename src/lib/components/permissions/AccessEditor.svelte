<script lang="ts">
	import {
		PERMISSION_CATALOG,
		PERMISSION_ROOTS,
		leafMeta,
		leavesOf,
		type LeafPermission,
		type PermissionRoot
	} from '$lib/permissions/catalog.js';
	import {
		LEVEL_LABELS,
		describeArea,
		explicitLeaves,
		levelLeaves,
		levelOf,
		levelledLeaves,
		levelsFor,
		type AccessLevel
	} from '$lib/permissions/describe.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import { AlertTriangle } from '@lucide/svelte';
	import { SvelteSet } from 'svelte/reactivity';

	/**
	 * The permission catalog as one row per area, each with an access level —
	 * None, View, Edit, Full — or Custom, which opens a switch per ability.
	 * Under each area a sentence says what the choice allows, in words.
	 *
	 * A level is only a way to pick leaves: `value` is still the leaves chosen,
	 * and anything that is not exactly a level shows as Custom. Explicit
	 * abilities (Adjustments) are never part of a level and always have their
	 * own switch.
	 *
	 * `available` limits what can be chosen (a token, only what its owner may
	 * hand on); a level that needs anything outside it is disabled.
	 * `inherited` is already granted elsewhere (a user's groups): shown on,
	 * locked, and never emitted.
	 */
	let {
		value,
		onchange,
		available = null,
		inherited = new Set<LeafPermission>(),
		disabled = false,
		showSuperuserOnly = false,
		unavailableNote = 'Not available.'
	}: {
		value: LeafPermission[];
		onchange: (next: LeafPermission[]) => void;
		available?: ReadonlySet<LeafPermission> | null;
		inherited?: ReadonlySet<LeafPermission>;
		disabled?: boolean;
		showSuperuserOnly?: boolean;
		/** Shown for an area where nothing can be chosen. */
		unavailableNote?: string;
	} = $props();

	const chosen = $derived(new Set(value));
	/** Areas whose Custom panel was opened by hand, while still on a level. */
	const opened = new SvelteSet<PermissionRoot>();

	const roots = $derived(
		PERMISSION_ROOTS.filter(
			(root) =>
				showSuperuserOnly ||
				!(PERMISSION_CATALOG[root] as { superuserOnly?: boolean }).superuserOnly
		)
	);

	const isAvailable = (leaf: LeafPermission) => available === null || available.has(leaf);
	const held = (leaf: LeafPermission) => chosen.has(leaf) || inherited.has(leaf);

	function canToggle(leaf: LeafPermission): boolean {
		// Something already chosen can always be turned off, even if it is no
		// longer available — that only ever narrows.
		return !disabled && !inherited.has(leaf) && (chosen.has(leaf) || isAvailable(leaf));
	}

	/** Why a level cannot be picked, or null when it can. */
	function levelBlocked(root: PermissionRoot, level: AccessLevel): string | null {
		const want = new Set(levelLeaves(root, level));
		if (levelledLeaves(root).some((leaf) => inherited.has(leaf) && !want.has(leaf)))
			return 'A group already grants more than this.';
		if ([...want].some((leaf) => !inherited.has(leaf) && !isAvailable(leaf)))
			return 'Includes something that cannot be chosen here.';
		return null;
	}

	/** Emits the chosen leaves in catalog order. */
	function emit(isOn: (leaf: LeafPermission) => boolean) {
		onchange(roots.flatMap(leavesOf).filter((leaf) => !inherited.has(leaf) && isOn(leaf)));
	}

	function pickLevel(root: PermissionRoot, level: AccessLevel) {
		if (disabled || levelBlocked(root, level)) return;
		const own = new Set(levelledLeaves(root));
		const want = new Set(levelLeaves(root, level));
		opened.delete(root);
		emit((leaf) => (own.has(leaf) ? want.has(leaf) : chosen.has(leaf)));
	}

	function toggle(leaf: LeafPermission, on: boolean) {
		if (!canToggle(leaf)) return;
		// Keep the panel open: a switch that happens to land on a level must not
		// fold the switches away under the pointer.
		const root = leaf.split('.')[0] as PermissionRoot;
		if (!leafMeta(leaf).explicit) opened.add(root);
		emit((l) => (l === leaf ? on : chosen.has(l)));
	}

	function area(root: PermissionRoot) {
		const leaves = leavesOf(root);
		const holding = leaves.filter(held);
		const level = levelOf(root, holding);
		const custom = level === 'custom' || opened.has(root);
		const anything = leaves.some((leaf) => held(leaf) || isAvailable(leaf));
		return {
			label: PERMISSION_CATALOG[root].label,
			levels: levelsFor(root),
			level,
			custom,
			anything,
			sentence: describeArea(root, holding),
			levelled: levelledLeaves(root),
			// An explicit ability that can be neither chosen nor is held is
			// left out rather than shown as a dead switch.
			explicit: explicitLeaves(root).filter((leaf) => held(leaf) || isAvailable(leaf))
		};
	}
</script>

{#snippet ability(leaf: LeafPermission)}
	{@const meta = leafMeta(leaf)}
	{@const fromGroup = inherited.has(leaf)}
	<label
		class="ae-ability"
		class:on={held(leaf)}
		class:locked={!canToggle(leaf)}
		class:dim={!held(leaf) && !isAvailable(leaf)}
	>
		<span class="ae-ability-text">
			<span class="ae-ability-name">
				{meta.label}
				{#if meta.sensitive}
					<span class="ae-warn" title="Handle with care: read the description.">
						<AlertTriangle size={12} />
					</span>
				{/if}
				{#if fromGroup}<span class="ae-from">From a group</span>{/if}
			</span>
			<span class="ae-ability-desc">{meta.description}</span>
		</span>
		<Switch
			size="sm"
			checked={held(leaf)}
			disabled={!canToggle(leaf)}
			onCheckedChange={(on) => toggle(leaf, on)}
			aria-label={`${meta.rootLabel}: ${meta.label}`}
		/>
	</label>
{/snippet}

<div class="ae">
	{#each roots as root (root)}
		{@const a = area(root)}
		<div class="ae-area" class:is-none={a.level === 'none' && !a.custom}>
			<div class="ae-head">
				<div class="ae-text">
					<div class="ae-name">{a.label}</div>
					<div class="ae-sentence" aria-live="polite">
						{a.anything ? a.sentence : unavailableNote}
					</div>
				</div>
				{#if a.anything}
					<div class="seg sm ae-seg" role="radiogroup" aria-label={`${a.label} access`}>
						{#each a.levels as level (level)}
							{@const blocked = levelBlocked(root, level)}
							<button
								type="button"
								role="radio"
								aria-checked={!a.custom && a.level === level}
								class="seg-btn"
								class:active={!a.custom && a.level === level}
								disabled={disabled || blocked !== null}
								title={blocked ?? undefined}
								onclick={() => pickLevel(root, level)}
							>
								{LEVEL_LABELS[level]}
							</button>
						{/each}
						{#if a.levelled.length > 1}
							<button
								type="button"
								role="radio"
								aria-checked={a.custom}
								class="seg-btn"
								class:active={a.custom}
								disabled={disabled}
								onclick={() => {
									if (a.level !== 'custom') {
										if (opened.has(root)) opened.delete(root);
										else opened.add(root);
									}
								}}
							>
								{LEVEL_LABELS.custom}
							</button>
						{/if}
					</div>
				{/if}
			</div>

			{#if a.anything && a.custom}
				<div class="ae-grid">
					{#each a.levelled as leaf (leaf)}{@render ability(leaf)}{/each}
				</div>
			{/if}
			{#if a.explicit.length}
				<div class="ae-explicit">
					{#each a.explicit as leaf (leaf)}{@render ability(leaf)}{/each}
				</div>
			{/if}
		</div>
	{/each}
</div>

<style>
	.ae {
		/* Sized by where it sits, not by the screen: the same editor fills a
		   page column and a 500px drawer. */
		container-type: inline-size;
		border: 1px solid var(--border);
		border-radius: 10px;
		background: var(--card);
	}
	.ae-area {
		padding: 12px 14px;
		border-top: 1px solid var(--border);
	}
	.ae-area:first-child {
		border-top: none;
	}
	.ae-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
	}
	.ae-text {
		min-width: 0;
	}
	.ae-name {
		font-size: 13.5px;
		font-weight: 600;
	}
	.ae-sentence {
		margin-top: 2px;
		font-size: 12.5px;
		line-height: 1.45;
		color: var(--muted-foreground);
	}
	.ae-area.is-none .ae-name {
		color: var(--muted-foreground);
		font-weight: 500;
	}
	.ae-seg {
		flex-shrink: 0;
	}
	.ae-seg .seg-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
	.ae-seg .seg-btn:disabled:hover {
		color: var(--muted-foreground);
	}
	.ae-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 2px 20px;
		margin-top: 10px;
		padding: 8px 12px;
		border-radius: 8px;
		background: var(--muted);
	}
	.ae-explicit {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin-top: 10px;
	}
	/* A switch of its own, so it reads as something to turn on — not a note. */
	.ae-explicit .ae-ability {
		padding: 9px 12px;
		border: 1px solid var(--border);
		border-radius: 8px;
		transition:
			background 0.12s,
			border-color 0.12s;
	}
	.ae-explicit .ae-ability:not(.locked):hover {
		border-color: var(--primary);
		background: var(--accent);
	}
	.ae-explicit .ae-ability.on {
		border-color: var(--amber);
		background: var(--amber-soft);
	}
	.ae-ability {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 7px 0;
		cursor: pointer;
	}
	.ae-ability.locked {
		cursor: default;
	}
	.ae-ability.dim {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.ae-ability-text {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.ae-ability-name {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 13px;
		font-weight: 500;
	}
	.ae-ability-desc {
		font-size: 12px;
		line-height: 1.4;
		color: var(--muted-foreground);
	}
	.ae-warn {
		display: inline-flex;
		color: var(--amber);
	}
	.ae-from {
		font-size: 11px;
		font-weight: 500;
		color: var(--muted-foreground);
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: 999px;
		padding: 0 7px;
	}
	@container (max-width: 600px) {
		.ae-head {
			flex-direction: column;
			align-items: stretch;
			gap: 8px;
		}
		.ae-seg {
			align-self: flex-start;
			flex-wrap: wrap;
		}
		.ae-grid {
			grid-template-columns: 1fr;
		}
	}
</style>
