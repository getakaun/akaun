<script lang="ts">
  import { page } from "$app/stores";
  import { createResourceStream } from "$lib/sse.js";
  import type { ClosingStatus } from "$lib/closing.js";
  import { provideClosingBoundary } from "$lib/closing-context.js";
  import { onNavigate } from "$app/navigation";
  import { Menu } from "@lucide/svelte";
  import Sidebar from "$lib/components/ui/Sidebar.svelte";
  import BottomNav from "$lib/components/ui/BottomNav.svelte";
  import MobileDrawer from "$lib/components/ui/MobileDrawer.svelte";
  import { setMainCurrency } from "$lib/currency-state.svelte.js";
  import type { LayoutData } from "./$types.js";

  let {
    data,
    children,
  }: { data: LayoutData; children: import("svelte").Snippet } = $props();
  let drawerOpen = $state(false);
  // SSR supplies the first boundary. Once the stream connects, its snapshot and
  // changes remain authoritative across navigations, including an explicit null
  // after reopening; inherited page data must not restore an older boundary.
  let streamedClosingStatus = $state<ClosingStatus | null>(null);
  const closingBoundary = $derived(
    streamedClosingStatus === null
      ? data.closedThrough
      : streamedClosingStatus.closedThrough,
  );
  provideClosingBoundary({
    get closedThrough() {
      return closingBoundary;
    },
  });
  createResourceStream<ClosingStatus>("/api/closing/stream", (status) => {
    streamedClosingStatus = status;
  });

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

<button
  class="mobile-menu-btn"
  onclick={() => (drawerOpen = true)}
  aria-label="Open navigation"
>
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
