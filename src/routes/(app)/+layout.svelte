<script lang="ts">
	import { page } from '$app/stores';
	import { onNavigate } from '$app/navigation';
	import { Menu } from '@lucide/svelte';
	import Sidebar from '$lib/components/ui/Sidebar.svelte';
	import BottomNav from '$lib/components/ui/BottomNav.svelte';
	import MobileDrawer from '$lib/components/ui/MobileDrawer.svelte';
	import { setMainCurrency } from '$lib/currency-state.svelte.js';
	import type { LayoutData } from './$types.js';

	let { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props();
	let drawerOpen = $state(false);

	// Make the global main currency available to formatMoney/AmountInput everywhere.
	// Set synchronously (so SSR + first render are correct, top-down) and reactively
	// (so changing it in Settings updates the UI without a reload).
	// svelte-ignore state_referenced_locally
	setMainCurrency(data.mainCurrency);
	$effect(() => setMainCurrency(data.mainCurrency));

	onNavigate((navigation) => {
		if (!document.startViewTransition) return;
		return new Promise((resolve) => {
			document.startViewTransition(async () => {
				resolve();
				await navigation.complete;
			});
		});
	});
</script>

<div class="app">
	<Sidebar
		user={data.user}
		activePage={$page.url.pathname}
		unpaidCount={data.unpaidCount}
		canManageUsers={data.canManageUsers}
		canSeeSettings={data.canSeeSettings}
		canReadAudit={data.canReadAudit}
		navItems={data.navItems}
	/>
	<main class="main">
		{@render children()}
	</main>
</div>

<BottomNav
	activePage={$page.url.pathname}
	unpaidCount={data.unpaidCount}
	navItems={data.navItems}
/>

<button class="mobile-menu-btn" onclick={() => (drawerOpen = true)} aria-label="Open navigation">
	<Menu size={20} />
</button>

<MobileDrawer
	bind:open={drawerOpen}
	user={data.user}
	canManageUsers={data.canManageUsers}
		canSeeSettings={data.canSeeSettings}
		canReadAudit={data.canReadAudit}
	navItems={data.navItems}
/>

<style>
	.mobile-menu-btn {
		display: none;
	}

	@media (max-width: 767px) {
		.mobile-menu-btn {
			display: flex;
			position: fixed;
			top: calc(11px + var(--safe-top));
			left: calc(12px + var(--safe-left));
			z-index: 35;
			width: 32px;
			height: 32px;
			align-items: center;
			justify-content: center;
			background: none;
			border: none;
			color: var(--foreground);
			cursor: pointer;
			-webkit-tap-highlight-color: transparent;
		}
	}
</style>
