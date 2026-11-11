<script lang="ts">
  import type { Snippet } from "svelte";
  import { beforeNavigate, goto } from "$app/navigation";
  import { X } from "@lucide/svelte";
  import * as Sheet from "$lib/components/ui/sheet/index.js";
  import ConfirmDialog from "$lib/components/ui/ConfirmDialog.svelte";
  import ReportNotes from "$lib/components/reports/ReportNotes.svelte";
  import { useIsMobile } from "$lib/hooks/useIsMobile.svelte.js";
  let {
    title,
    eyebrow = "Asset tax deductions",
    saving = false,
    dirty = false,
    error = "",
    readonly = false,
    submitLabel = "Save",
    disabled = false,
    onclose,
    onsubmit,
    children,
  }: {
    title: string;
    eyebrow?: string;
    saving?: boolean;
    dirty?: boolean;
    error?: string;
    readonly?: boolean;
    submitLabel?: string;
    disabled?: boolean;
    onclose: () => void;
    onsubmit: (event: SubmitEvent) => void;
    children: Snippet;
  } = $props();
  const screen = useIsMobile();
  let form: HTMLFormElement;
  let discardOpen = $state(false);
  let pendingHref: string | null = null;
  let leaving = false;
  function close() {
    if (saving) return;
    if (dirty && !readonly) discardOpen = true;
    else onclose();
  }
  beforeNavigate((nav) => {
    if (leaving || !dirty || readonly || !nav.to || nav.willUnload) return;
    nav.cancel();
    pendingHref = nav.to.url.href;
    discardOpen = true;
  });
  function discard() {
    leaving = true;
    if (pendingHref) {
      /* eslint-disable-next-line svelte/no-navigation-without-resolve -- SvelteKit supplied the destination. */ void goto(
        pendingHref,
      );
    } else onclose();
  }
</script>

<svelte:window
  onbeforeunload={(event) => {
    if (dirty && !readonly) {
      event.preventDefault();
      event.returnValue = "";
    }
  }}
/>
<Sheet.Root
  open={true}
  onOpenChange={(open) => {
    if (!open) close();
  }}
  ><Sheet.Content
    side={screen.current ? "bottom" : "right"}
    style={screen.current
      ? "height:100dvh;border-radius:0;display:flex;flex-direction:column;overflow:hidden;gap:0;"
      : "width:520px;max-width:95vw;display:flex;flex-direction:column;overflow:hidden;gap:0;"}
  >
    <div class="tax-drawer-head">
      <div>
        <div class="sheet-eyebrow">{eyebrow}</div>
        <Sheet.Title class="sheet-title-text">{title}</Sheet.Title
        ><Sheet.Description class="sr-only"
          >Prepare asset tax deductions independently of accounting
          depreciation.</Sheet.Description
        >
      </div>
      <button
        type="button"
        class="sheet-close"
        aria-label="Close"
        onclick={close}
        disabled={saving}><X size={16} /></button
      >
    </div>
    <div class="tax-drawer-body">
      <form bind:this={form} {onsubmit} class="tax-stack">
        {@render children()}{#if error}<div role="alert">
            <ReportNotes notes={[error]} firstIsWarning />
          </div>{/if}
      </form>
    </div>
    <footer class="sheet-footer">
      <div class="sheet-foot-actions tax-actions">
        <button
          type="button"
          class="sheet-btn"
          onclick={close}
          disabled={saving}>{readonly ? "Close" : "Cancel"}</button
        >{#if !readonly}<button
            type="button"
            class="sheet-btn sheet-btn-primary"
            disabled={saving || disabled}
            onclick={() => form.requestSubmit()}
            >{saving ? "Saving…" : submitLabel}</button
          >{/if}
      </div>
    </footer>
  </Sheet.Content></Sheet.Root
>
<ConfirmDialog
  bind:open={discardOpen}
  title="Discard unsaved changes?"
  description="The information in this drawer has not been saved."
  confirmLabel="Discard changes"
  onConfirm={discard}
/>

<style>
  .tax-drawer-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    padding: 22px 22px 16px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    gap: 12px;
  }
  .tax-drawer-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 20px 22px;
  }
  .tax-drawer-body :global(.field) {
    margin: 0;
  }
</style>
