<script lang="ts">
  import { beforeNavigate, goto } from "$app/navigation";
  import { X } from "@lucide/svelte";
  import * as Sheet from "$lib/components/ui/sheet/index.js";
  import ConfirmDialog from "$lib/components/ui/ConfirmDialog.svelte";
  import { useIsMobile } from "$lib/hooks/useIsMobile.svelte.js";
  import AssetForm from "./AssetForm.svelte";
  import type {
    AssetRegister,
    AssetLedgerLine,
  } from "$lib/server/queries/fixed-assets.js";

  let {
    source = null,
    accounts,
    canChange = false,
    onclose,
    onsaved,
  }: {
    source?: AssetLedgerLine | null;
    accounts: AssetRegister["accounts"];
    canChange?: boolean;
    onclose: () => void;
    onsaved: () => Promise<void>;
  } = $props();
  const screen = useIsMobile();
  let formRef = $state<{ submit: () => Promise<void> } | null>(null);
  let dirty = $state(false);
  let saving = $state(false);
  let discardOpen = $state(false);
  let pendingHref: string | null = null;
  let leaving = false;
  function close() {
    if (saving) return;
    if (dirty) discardOpen = true;
    else onclose();
  }
  beforeNavigate((nav) => {
    if (leaving) {
      leaving = false;
      return;
    }
    if (!dirty || nav.willUnload || !nav.to) return;
    pendingHref = nav.to.url.href;
    nav.cancel();
    discardOpen = true;
  });
  function discard() {
    const href = pendingHref;
    pendingHref = null;
    if (href) {
      leaving = true;
      // eslint-disable-next-line svelte/no-navigation-without-resolve -- URL supplied by SvelteKit's navigation guard.
      void goto(href);
    } else onclose();
  }
</script>

<Sheet.Root
  open={true}
  onOpenChange={(open) => {
    if (!open) close();
  }}
>
  <Sheet.Content
    side={screen.current ? "bottom" : "right"}
    style={screen.current
      ? "height:100dvh; border-radius:0; border-top:none; display:flex; flex-direction:column; overflow:hidden; gap:0;"
      : "width:500px; max-width:95vw; display:flex; flex-direction:column; overflow:hidden; gap:0;"}
  >
    <div class="sheet-head">
      <div>
        <div class="sheet-eyebrow">New</div>
        <Sheet.Title class="sheet-title-text"
          >{source ? "Register asset" : "Add existing asset"}</Sheet.Title
        ><Sheet.Description class="sr-only"
          >Add an asset to the fixed asset register.</Sheet.Description
        >
      </div>
      <button
        type="button"
        class="sheet-close"
        aria-label="Close asset"
        onclick={close}><X size={16} /></button
      >
    </div>
    <div class="sheet-body">
      <AssetForm
        bind:this={formRef}
        {source}
        {accounts}
        {canChange}
        bind:dirty
        bind:saving
        onsaved={async () => {
          await onsaved();
          onclose();
        }}
      />
    </div>
    <footer class="sheet-foot">
      <p class="sheet-foot-note">Registration creates no accounting entry.</p>
      <div class="sheet-foot-actions">
        <button
          type="button"
          class="sheet-btn"
          onclick={close}
          disabled={saving}>Cancel</button
        >{#if canChange}<button
            type="button"
            class="sheet-btn sheet-btn-primary"
            onclick={() => formRef?.submit()}
            disabled={saving}>{saving ? "Saving…" : "Register asset"}</button
          >{/if}
      </div>
    </footer>
  </Sheet.Content>
</Sheet.Root>
<ConfirmDialog
  bind:open={discardOpen}
  title="Discard asset changes?"
  description="Your unsaved asset details will be lost."
  confirmLabel="Discard changes"
  onConfirm={discard}
/>

<style>
  .sheet-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    padding: 22px 22px 16px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .sheet-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 20px 22px;
  }
</style>
