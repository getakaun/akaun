<script lang="ts">
  import { goto, invalidateAll, replaceState } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import { SvelteURLSearchParams } from "svelte/reactivity";
  import {
    ChevronRight,
    FileText,
    Plus,
    Search,
    Upload,
    X,
  } from "@lucide/svelte";
  import { toast } from "svelte-sonner";
  import * as Sheet from "$lib/components/ui/sheet/index.js";
  import EmptyState from "$lib/components/ui/EmptyState.svelte";
  import StatusBadge from "$lib/components/ui/StatusBadge.svelte";
  import BackLink from "$lib/components/ui/BackLink.svelte";
  import { StatementExtractionState } from "$lib/enums.js";
  import { formatDate, formatMoney } from "$lib/format.js";
  import { useIsMobile } from "$lib/hooks/useIsMobile.svelte.js";
  import { createResourceStream } from "$lib/sse.js";
  import type { loadAccountStatements } from "$lib/server/loaders/reconciliation.js";

  /**
   * The statements on one account, and what each one still needs.
   *
   * Reconciling is reached from the account it belongs to, so this surface is
   * scoped to that one account (FR-048). **There is no account picker on the
   * upload** — the route already says which account this is, and asking again
   * was asking the same question twice; the endpoint takes the account from its
   * path (FR-050).
   *
   * A full page rather than a drawer: it is a work surface with many steps, the
   * named task-workspace exception in CLAUDE.md. It keeps its own real address.
   *
   * Upload remains here; statement management lives on the statement detail
   * page alongside the matching workspace. Existing endpoints are preserved.
   */
  type Data = ReturnType<typeof loadAccountStatements>;
  type Statement = Data["statements"][number];
  type StatementStatus = "active" | "completed" | "all";

  let { data }: { data: Data } = $props();
  const canAddStatement = $derived(
    data.permissions.add && data.account.active && data.account.postingEligible,
  );

  const screen = useIsMobile();
  const isMobile = $derived(screen.current);
  const panelSide = $derived(isMobile ? "bottom" : "right");

  const initialStatus = page.url.searchParams.get("status");
  let statementStatus = $state<StatementStatus>(
    initialStatus === null || initialStatus === "active"
      ? "active"
      : initialStatus === "completed"
        ? "completed"
        : "all",
  );
  let query = $state(page.url.searchParams.get("q") ?? "");

  // The file itself stays out of `$state` — a `File` is not a plain object.
  let uploadOpen = $state(false);
  let uploadFileName = $state("");
  let uploading = $state(false);
  let uploadInput = $state<HTMLInputElement | null>(null);
  let pendingUpload: File | null = null;

  const activeStatements = $derived(
    data.statements.filter((s) => !s.completed),
  );
  const completedStatements = $derived(
    data.statements.filter((s) => s.completed),
  );
  const visibleStatements = $derived.by(() => {
    const source =
      statementStatus === "active"
        ? activeStatements
        : statementStatus === "completed"
          ? completedStatements
          : data.statements;
    const normalized = query.trim().toLocaleLowerCase();
    return source.filter(
      (statement) =>
        !normalized ||
        `${statement.originalFilename} ${statement.accountName ?? ""}`
          .toLocaleLowerCase()
          .includes(normalized),
    );
  });

  /** Still to clear on this account, across its statements. */
  const bankRemaining = $derived(
    data.statements.reduce(
      (sum, statement) => sum + Math.max(0, statement.remainingAmount),
      0,
    ),
  );

  // The stream still sends a full snapshot on connect. This surface is scoped
  // to one account, so it narrows what it receives rather than asking for a
  // narrower feed: any event that is not the snapshot re-runs this page's own
  // loader, which is already account-scoped (contracts/events.md).
  createResourceStream<{ type: string }>(
    "/api/reconciliation/stream",
    (event) => {
      if (event.type !== "snapshot") void invalidateAll();
    },
  );

  function statusLabel(statement: Statement) {
    if (statement.extractionState === StatementExtractionState.Extracting)
      return "extracting";
    if (statement.extractionState === StatementExtractionState.Failed)
      return "failed";
    return statement.completed ? "matched" : "active";
  }

  function updateUrl() {
    const params = new SvelteURLSearchParams({
      status: statementStatus,
    });
    if (query) params.set("q", query);
    const path = resolve("/(app)/accounts/[id]/reconcile", {
      id: String(data.account.id),
    });
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- route is resolved above; only query state is appended.
    replaceState(`${path}?${params}`, page.state);
  }

  /** Matching this statement's lines — its own page, its own address (FR-052). */
  function matchHref(statement: Statement) {
    return resolve("/(app)/accounts/[id]/reconcile/[statementId]", {
      id: String(data.account.id),
      statementId: String(statement.id),
    });
  }
  function openMatch(statement: Statement) {
    void goto(matchHref(statement));
  }

  function openUpload() {
    pendingUpload = null;
    uploadFileName = "";
    uploadOpen = true;
  }

  function chooseUploadFile(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    pendingUpload = input.files?.[0] ?? null;
    uploadFileName = pendingUpload?.name ?? "";
  }

  async function upload() {
    if (!pendingUpload || uploading) return;
    uploading = true;
    const form = new FormData();
    form.set("file", pendingUpload);
    // No `accountId` field: the address says which account this is.
    const response = await fetch(
      `/api/accounts/${data.account.id}/reconciliation/statements`,
      { method: "POST", body: form },
    ).catch(() => null);
    uploading = false;
    if (!response?.ok) {
      const result = await response?.json().catch(() => null);
      toast.error(
        result?.error ??
          "Statement upload failed. Choose a PDF, JPEG, or PNG under 15 MB.",
      );
      return;
    }
    toast.success("Statement extraction started");
    uploadOpen = false;
    pendingUpload = null;
    uploadFileName = "";
    statementStatus = "active";
    updateUrl();
    await invalidateAll();
  }
</script>

<svelte:head
  ><title>{data.account.name} · Bank reconciliation</title></svelte:head
>

<div class="screen reconciliation-screen">
  <header class="topbar">
    <div class="topbar-left">
      <!-- The account is a real page now, so this workspace can say where it
           came from the way every other detail surface does. -->
      <BackLink
        href={resolve("/(app)/accounts/[id]", { id: String(data.account.id) })}
        label={data.account.name}
      />
      <h1 class="page-title">Bank reconciliation</h1>
      <p class="page-sub">
        {data.account.name} ·
        {#if bankRemaining > 0}
          <span class="num">{formatMoney(bankRemaining)}</span> unreconciled
        {:else}
          Fully reconciled
        {/if}
      </p>
    </div>
    <div class="topbar-right">
      <div class="search-box recon-search">
        <div style="position:relative; display:flex; align-items:center;">
          <span
            style="position:absolute; left:10px; top:50%; transform:translateY(-50%); color:var(--muted-foreground); display:flex; pointer-events:none;"
          >
            <Search size={15} aria-hidden="true" />
          </span>
          <input
            type="search"
            placeholder="Search statements…"
            bind:value={query}
            oninput={updateUrl}
            aria-label="Search statements"
          />
        </div>
      </div>
      {#if canAddStatement}
        <button
          class="primary-action"
          type="button"
          aria-label="Upload statement"
          onclick={openUpload}
        >
          <Plus size={15} /><span class="btn-text">Upload Statement</span>
        </button>
      {/if}
    </div>
  </header>

  <div class="work">
    <div class="work-main recon-work">
      <div class="toolbar">
        <div class="status-tabs" role="group" aria-label="Statement status">
          {#each [{ value: "active", label: "Active", count: activeStatements.length }, { value: "completed", label: "Completed", count: completedStatements.length }, { value: "all", label: "All", count: data.statements.length }] as tab (tab.value)}
            <button
              type="button"
              class="status-tab"
              class:active={statementStatus === tab.value}
              aria-pressed={statementStatus === tab.value}
              onclick={() => {
                statementStatus = tab.value as StatementStatus;
                updateUrl();
              }}
            >
              {tab.label}<span class="tab-count">{tab.count}</span>
            </button>
          {/each}
        </div>
      </div>

      <div class="statement-pane">
        <div class="table-card">
          <table class="exp-table">
            <thead>
              <tr>
                <th>Statement</th>
                <th>Date Range</th>
                <th>Status</th>
                <th>Matched</th>
                <th class="ta-right">Remaining</th>
                <th aria-label="Open"></th>
              </tr>
            </thead>
            <tbody>
              {#each visibleStatements as statement (statement.id)}
                <tr
                  class="exp-row"
                  onclick={(event) => {
                    if ((event.target as HTMLElement).closest("a")) return;
                    openMatch(statement);
                  }}
                >
                  <td class="td-primary">
                    <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the href comes from resolve() via matchHref(). -->
                    <a class="cell-item row-link" href={matchHref(statement)}>
                      <span
                        class="cell-itemname filename"
                        title={statement.originalFilename}
                        >{statement.originalFilename}</span
                      >
                      <span class="cell-itemnum"
                        >Uploaded {formatDate(
                          statement.createdAt.slice(0, 10),
                        )}</span
                      >
                    </a>
                  </td>
                  <td class="td-date" data-label="Date Range">
                    {statement.dateFrom && statement.dateTo
                      ? `${formatDate(statement.dateFrom)} – ${formatDate(statement.dateTo)}`
                      : "No transactions"}
                  </td>
                  <td data-label="Status">
                    <StatusBadge status={statusLabel(statement)} />
                  </td>
                  <td data-label="Matched">
                    <span class="num"
                      >{statement.matchedCount} / {statement.totalLines}</span
                    >
                  </td>
                  <td class="td-amount" data-label="Remaining">
                    <span class="amount-num"
                      >{formatMoney(statement.remainingAmount)}</span
                    >
                  </td>
                  <td class="td-chevron">
                    <span class="row-chevron"
                      ><ChevronRight size={15} aria-hidden="true" /></span
                    >
                  </td>
                  <td class="row-break"></td>
                </tr>
              {/each}
              {#if visibleStatements.length === 0}
                <tr class="empty-row">
                  <td colspan="6">
                    <!-- An account with no statement yet, and one never
                         reconciled, both read as a normal starting state
                         rather than as something missing (FR-050). -->
                    <EmptyState
                      title={query.trim()
                        ? "No matching statements"
                        : data.statements.length === 0
                          ? "No statements yet"
                          : statementStatus === "completed"
                            ? "No completed statements"
                            : "No active statements"}
                      sub={query.trim()
                        ? "Try another filename or clear your search."
                        : data.statements.length === 0
                          ? "Upload a statement from your bank to check this account against it."
                          : statementStatus === "completed"
                            ? "Statements move here automatically when every line is fully allocated."
                            : "All statements are completed. Upload another statement or view the Completed tab."}
                    >
                      {#snippet icon()}<FileText size={20} />{/snippet}
                    </EmptyState>
                  </td>
                </tr>
              {/if}
            </tbody>
          </table>
        </div>
        <div class="table-foot">
          <span
            >{visibleStatements.length} statement{visibleStatements.length === 1
              ? ""
              : "s"}</span
          >
        </div>
      </div>
    </div>
  </div>
</div>

<!-- Upload. No account picker: the address says which account this is. -->
<Sheet.Root
  open={uploadOpen}
  onOpenChange={(open) => {
    if (!open) uploadOpen = false;
  }}
>
  <Sheet.Content
    side={panelSide}
    class="recon-sheet"
    style={isMobile
      ? "gap:0; height:100dvh; border-radius:0;"
      : "gap:0; width:500px; max-width:95vw;"}
  >
    <div class="sheet-head">
      <div>
        <span class="sheet-eyebrow"><Upload size={13} />Bank Statement</span>
        <h2 class="sheet-title-text">Upload a statement</h2>
      </div>
      <Sheet.Close class="sheet-close" aria-label="Close upload">
        <X size={16} />
      </Sheet.Close>
    </div>
    <div class="upload-body">
      <p class="upload-account">
        This statement will be checked against <strong
          >{data.account.name}</strong
        >. Its transactions can only be matched to records that touched this
        account.
      </p>
      <div class="field">
        <span class="field-label">File</span>
        <input
          bind:this={uploadInput}
          class="sr-only"
          type="file"
          accept="application/pdf,image/png,image/jpeg"
          onchange={chooseUploadFile}
          aria-label="Choose bank statement"
        />
        <button
          class="sheet-btn"
          type="button"
          onclick={() => uploadInput?.click()}
        >
          <FileText size={14} aria-hidden="true" />Choose file
        </button>
        {#if uploadFileName}
          <p class="upload-filename" aria-live="polite">{uploadFileName}</p>
        {/if}
        <small class="field-hint">PDF, JPEG or PNG · Up to 15 MB.</small>
      </div>
    </div>
    <div class="sheet-foot">
      <div class="sheet-foot-actions">
        <Sheet.Close class="sheet-btn">Cancel</Sheet.Close>
        <button
          class="sheet-btn sheet-btn-primary"
          type="button"
          disabled={!uploadFileName || uploading}
          onclick={upload}>{uploading ? "Uploading…" : "Upload"}</button
        >
      </div>
    </div>
  </Sheet.Content>
</Sheet.Root>

<style>
  .reconciliation-screen {
    min-height: 0;
  }
  .row-link {
    color: inherit;
    text-decoration: none;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .row-link:focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: 2px;
    border-radius: 4px;
  }
  .recon-search input {
    width: 100%;
    height: 34px;
    padding: 0 10px 0 32px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--card);
    color: var(--foreground);
    font-family: inherit;
    font-size: 13px;
  }
  .primary-action {
    flex-shrink: 0;
    white-space: nowrap;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 32px;
    padding: 0 12px;
    background: var(--primary);
    color: var(--primary-foreground);
    border: none;
    border-radius: 8px;
    font-family: inherit;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
  }
  .recon-work {
    padding-top: 12px;
  }
  .statement-pane {
    min-width: 0;
  }
  .filename {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 320px;
  }
  .num,
  .amount-num {
    font-variant-numeric: tabular-nums;
  }
  .td-chevron {
    vertical-align: middle;
  }
  .row-chevron {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    color: var(--muted-foreground);
  }
  .sheet-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 10px;
    padding: 22px 22px 16px;
    border-bottom: 1px solid var(--border);
  }
  .sheet-eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 11.5px;
    color: var(--muted-foreground);
  }
  .sheet-title-text {
    margin: 3px 0 0;
    font-size: 15.5px;
    font-weight: 600;
  }
  .upload-body {
    flex: 1;
    overflow-y: auto;
    padding: 20px 22px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .upload-account {
    margin: 0;
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--muted-foreground);
  }
  .field-hint {
    font-size: 11.5px;
    color: var(--muted-foreground);
  }
  .upload-filename {
    margin: 8px 0;
    overflow-wrap: anywhere;
    font-size: 13px;
  }
  .field-hint {
    display: block;
    margin-top: 8px;
  }
  .topbar-left {
    min-width: 0;
  }
  .topbar {
    flex-wrap: wrap;
  }
  .topbar-right {
    flex-shrink: 0;
    max-width: 100%;
    margin-left: auto;
  }
  .page-sub {
    white-space: normal;
  }
  .primary-action:hover {
    filter: brightness(0.96);
  }
  button:focus-visible,
  input:focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: 2px;
  }
  @media (max-width: 767px) {
    .status-tabs {
      max-width: 100%;
    }
    .filename {
      max-width: 100%;
    }
  }
</style>
