<script lang="ts">
	import type { Snippet } from 'svelte';
	import { beforeNavigate, goto } from '$app/navigation';
	import BackLink from './BackLink.svelte';
	import ConfirmDialog from './ConfirmDialog.svelte';

	/**
	 * The frame every detail page wears.
	 *
	 * This is what the drawer standard used to guarantee — "a user must not be
	 * able to tell the feature from the frame alone" — moved to the shape that
	 * can actually hold a record: a topbar with the way back, a hero, and two
	 * columns for the record and for everything it touches.
	 *
	 * The unsaved-changes guard is the Settings page's pattern (CLAUDE.md
	 * § Settings Page Patterns): edits stage in local `$state`, `dirty` compares
	 * them with what the server sent, and `beforeNavigate` stops an in-app
	 * navigation that would drop them.
	 */
	let {
		backHref,
		backLabel,
		dirty = false,
		editing = false,
		saving = false,
		saveLabel = 'Save changes',
		dirtyNote = 'Unsaved changes',
		onsave,
		onrevert,
		hero,
		main,
		rail,
		actions
	}: {
		backHref: string;
		backLabel: string;
		dirty?: boolean;
		/**
		 * The page is in an explicit edit mode (quotations, invoices). The bar then
		 * stays up even before anything changes, so there is always a way to leave
		 * edit mode — nothing saves until Save is clicked.
		 */
		editing?: boolean;
		saving?: boolean;
		saveLabel?: string;
		dirtyNote?: string;
		onsave?: () => void;
		onrevert?: () => void;
		hero: Snippet;
		main: Snippet;
		rail?: Snippet;
		actions?: Snippet;
	} = $props();

	let confirmLeaveOpen = $state(false);
	let pendingHref: string | null = null;
	// Set for exactly one navigation: the one the user just agreed to lose their
	// edits for. Without it, re-issuing the navigation would meet this same guard.
	let leaving = false;

	beforeNavigate((nav) => {
		if (leaving) {
			leaving = false;
			return;
		}
		// `willUnload` is a reload or a close: the browser shows its own prompt and
		// `cancel()` cannot help.
		if (!dirty || nav.willUnload || !nav.to) return;
		pendingHref = nav.to.url.href;
		nav.cancel();
		confirmLeaveOpen = true;
	});

	function discardAndLeave() {
		const href = pendingHref;
		pendingHref = null;
		onrevert?.();
		if (!href) return;
		leaving = true;
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- `href` is the URL SvelteKit itself handed us in `beforeNavigate`.
		void goto(href);
	}
</script>

<div class="screen">
	<header class="topbar">
		<div class="topbar-left">
			<BackLink href={backHref} label={backLabel} />
		</div>
		{#if actions}
			<div class="topbar-right">{@render actions()}</div>
		{/if}
	</header>

	<div class="page-scroll">
		<div class="page-inner">
			<div class="detail-hero">{@render hero()}</div>

			<div class="detail-grid">
				<div class="detail-main">{@render main()}</div>
				{#if rail}
					<div class="detail-rail">{@render rail()}</div>
				{/if}
			</div>

			{#if dirty || editing}
				<div class="detail-savebar">
					<span class="detail-savebar-note">{dirty ? dirtyNote : 'No changes yet'}</span>
					<button type="button" class="sheet-btn" onclick={() => onrevert?.()} disabled={saving}>
						{editing ? 'Cancel' : 'Discard'}
					</button>
					<button
						type="button"
						class="sheet-btn sheet-btn-primary"
						onclick={() => onsave?.()}
						disabled={saving || !dirty}
					>
						{saving ? 'Saving…' : saveLabel}
					</button>
				</div>
			{/if}
		</div>
	</div>
</div>

<ConfirmDialog
	bind:open={confirmLeaveOpen}
	title="Leave without saving?"
	description="The changes on this page have not been saved. Leaving now discards them."
	confirmLabel="Discard and leave"
	danger
	onConfirm={discardAndLeave}
/>
