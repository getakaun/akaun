<script lang="ts">
  import { goto, invalidateAll, replaceState } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import { SvelteURLSearchParams } from "svelte/reactivity";
  import {
    ChevronRight,
    FileText,
    MoreHorizontal,
    Plus,
    Search,
    SlidersHorizontal,
    Trash2,
    Upload,
    X,
  } from "@lucide/svelte";
  import { toast } from "svelte-sonner";
  import * as Sheet from "$lib/components/ui/sheet/index.js";
  import * as Select from "$lib/components/ui/select/index.js";
  import ConfirmDialog from "$lib/components/ui/ConfirmDialog.svelte";
  import EmptyState from "$lib/components/ui/EmptyState.svelte";
  import FilterDropdown from "$lib/components/ui/FilterDropdown.svelte";
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
   * Nothing about reconciling's behaviour changes (FR-057). Every action here —
   * upload, retry, move to another account, delete — calls the same endpoint it
   * always did.
   */
  type Data = ReturnType<typeof loadAccountStatements>;
  type Statement = Data["statements"][number];
  type StatementStatus = "active" | "completed";

  let { data }: { data: Data } = $props();
  const canAddStatement = $derived(
    data.permissions.add && data.account.active && data.account.postingEligible,
  );

  const screen = useIsMobile();
  const isMobile = $derived(screen.current);
  const panelSide = $derived(isMobile ? "bottom" : "right");

  let statementStatuses = $state<StatementStatus[]>(
    page.url.searchParams.has("status")
      ? (page.url.searchParams
          .get("status")!
          .split(",")
          .filter(Boolean) as StatementStatus[])
      : ["active"],
  );
  let query = $state(page.url.searchParams.get("q") ?? "");
  let mobileFilterOpen = $state(false);

  // Which statement's own actions are open — moving it, retrying it, deleting
  // it. Matching happens on its own page, at its own address (FR-052).
  let selectedStatementId = $state(
    Number(page.url.searchParams.get("statement")) || null,
  );
  let retrying = $state(false);
  let deleteStatementOpen = $state(false);

  // The file itself stays out of `$state` — a `File` is not a plain object.
  let uploadOpen = $state(false);
  let uploadFileName = $state("");
  let uploading = $state(false);
  let uploadInput = $state<HTMLInputElement | null>(null);
  let pendingUpload: File | null = null;

  const selectedStatement = $derived(
    data.statements.find((statement) => statement.id === selectedStatementId) ??
      null,
  );

  const activeStatements = $derived(
    data.statements.filter((statement) => !statement.completed),
  );
  const completedStatements = $derived(
    data.statements.filter((statement) => statement.completed),
  );
  const includeActiveStatements = $derived(
    statementStatuses.length === 0 || statementStatuses.includes("active"),
  );
  const includeCompletedStatements = $derived(
    statementStatuses.length === 0 || statementStatuses.includes("completed"),
  );
  const singleStatementStatus = $derived(
    statementStatuses.length === 1 ? statementStatuses[0] : null,
  );
  const statementStatusActive = $derived(
    !(statementStatuses.length === 1 && statementStatuses[0] === "active"),
  );
  const activeFilterCount = $derived(statementStatusActive ? 1 : 0);

  const visibleStatements = $derived.by(() => {
    let source: Statement[] = [];
    if (includeActiveStatements) source = source.concat(activeStatements);
    if (includeCompletedStatements) source = source.concat(completedStatements);
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
      status: statementStatuses.join(","),
    });
    if (query) params.set("q", query);
    if (selectedStatementId)
      params.set("statement", String(selectedStatementId));
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

  function openStatementActions(statement: Statement) {
    selectedStatementId = statement.id;
    updateUrl();
  }

  function closeStatement() {
    selectedStatementId = null;
    updateUrl();
  }

  function toggleStatementStatus(status: StatementStatus) {
    statementStatuses = statementStatuses.includes(status)
      ? statementStatuses.filter((value) => value !== status)
      : [...statementStatuses, status];
    updateUrl();
  }

  function clearFilters() {
    statementStatuses = ["active"];
    updateUrl();
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
    statementStatuses = ["active"];
    updateUrl();
    await invalidateAll();
  }

  /** Move a statement to the account it really belongs to (FR-054). */
  async function reassignStatement(accountId: number) {
    if (!selectedStatementId) return;
    const response = await fetch(
      `/api/reconciliation/statements/${selectedStatementId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId }),
      },
    ).catch(() => null);
    if (!response?.ok) {
      const result = await response?.json().catch(() => null);
      toast.error(
        result?.error ?? "This statement could not be moved to that account.",
      );
      await invalidateAll();
      return;
    }
    toast.success("Statement account updated");
    // It belongs to another account now, so it is no longer on this page.
    closeStatement();
    await invalidateAll();
  }

  async function retryExtraction() {
    if (!selectedStatementId || retrying) return;
    retrying = true;
    const response = await fetch(
      `/api/reconciliation/statements/${selectedStatementId}/retry`,
      { method: "POST" },
    ).catch(() => null);
    retrying = false;
    if (!response?.ok) {
      const result = await response?.json().catch(() => null);
      toast.error(
        result?.error ?? "Extraction could not be restarted. Try again.",
      );
      return;
    }
    toast.success("Statement extraction restarted");
    await invalidateAll();
  }

  async function deleteStatement() {
    if (!selectedStatementId) return;
    const response = await fetch(
      `/api/reconciliation/statements/${selectedStatementId}`,
      { method: "DELETE" },
    );
    if (!response.ok)
      return toast.error("Statement could not be deleted. Try again.");
    deleteStatementOpen = false;
    closeStatement();
    toast.success("Statement deleted");
    await invalidateAll();
  }
</script>

<svelte:head><title>{data.account.name} · Bank reconciliation</title></svelte:head>

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
            style="position:absolute; left:10px; color:var(--muted-foreground); display:flex; pointer-events:none;"
          >
            <Search size={15} />
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
        <button class="primary-action" type="button" onclick={openUpload}>
          <Plus size={15} /><span class="btn-text">Upload Statement</span>
        </button>
      {/if}
    </div>
  </header>

  <div class="work">
    <div class="work-main recon-work">
      <div class="toolbar">
        <div class="mobile-filter-row">
          <button
            class="btn-outline btn-sm"
            style="display:inline-flex; align-items:center; gap:6px;"
            onclick={() => (mobileFilterOpen = true)}
          >
            <SlidersHorizontal size={13} /> Filters
            {#if activeFilterCount > 0}
              <span class="filter-count">{activeFilterCount}</span>
            {/if}
          </button>
          {#if activeFilterCount > 0}
            <button class="clear-filters" onclick={clearFilters}>
              <X size={13} /> Clear
            </button>
          {/if}
        </div>
        <div class="toolbar-filters">
          {#if activeFilterCount > 0}
            <button class="clear-filters" onclick={clearFilters}>
              <X size={13} /> Clear
            </button>
          {/if}
          <FilterDropdown label="Status" active={statementStatusActive}>
            <div class="filter-checklist">
              <label class="filter-check">
                <input
                  type="checkbox"
                  class="filter-checkbox"
                  checked={statementStatuses.includes("active")}
                  onchange={() => toggleStatementStatus("active")}
                />
                <span>Active ({activeStatements.length})</span>
              </label>
              <label class="filter-check">
                <input
                  type="checkbox"
                  class="filter-checkbox"
                  checked={statementStatuses.includes("completed")}
                  onchange={() => toggleStatementStatus("completed")}
                />
                <span>Completed ({completedStatements.length})</span>
              </label>
            </div>
          </FilterDropdown>
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
                        >Uploaded {formatDate(statement.createdAt.slice(0, 10))}</span
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
                    <button
                      type="button"
                      class="statement-more"
                      aria-label="Statement options"
                      onclick={(event) => {
                        event.stopPropagation();
                        openStatementActions(statement);
                      }}><MoreHorizontal size={15} /></button
                    >
                    <ChevronRight size={15} aria-hidden="true" />
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
                      title={singleStatementStatus === "completed"
                        ? "No completed statements"
                        : "No statements yet"}
                      sub={singleStatementStatus === "completed"
                        ? "Statements move here automatically when every line is fully allocated."
                        : "Upload a statement from your bank to check this account against it."}
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

<!-- Mobile filters -->
<Sheet.Root
  open={mobileFilterOpen}
  onOpenChange={(open) => {
    if (!open) mobileFilterOpen = false;
  }}
>
  <Sheet.Content
    side="bottom"
    class="recon-sheet"
    style="gap:0; border-radius:16px 16px 0 0;"
  >
    <div class="filter-mobile-head">
      <span>Filters</span>
      <Sheet.Close class="sheet-close" aria-label="Close filters">
        <X size={16} />
      </Sheet.Close>
    </div>
    <div class="filter-checklist">
      <div class="filter-checklist-head">
        <span>Status</span>
        <button
          class="filter-mobile-clear"
          type="button"
          onclick={clearFilters}>Clear</button
        >
      </div>
      <label class="filter-check">
        <input
          type="checkbox"
          class="filter-checkbox"
          checked={statementStatuses.includes("active")}
          onchange={() => toggleStatementStatus("active")}
        />
        <span>Active ({activeStatements.length})</span>
      </label>
      <label class="filter-check">
        <input
          type="checkbox"
          class="filter-checkbox"
          checked={statementStatuses.includes("completed")}
          onchange={() => toggleStatementStatus("completed")}
        />
        <span>Completed ({completedStatements.length})</span>
      </label>
    </div>
  </Sheet.Content>
</Sheet.Root>

<!-- One statement's own actions -->
<Sheet.Root
  open={selectedStatement !== null}
  onOpenChange={(open) => {
    if (!open) closeStatement();
  }}
>
  <Sheet.Content
    side={panelSide}
    class="recon-sheet"
    style={isMobile
      ? "gap:0; height:100dvh; border-radius:0;"
      : "gap:0; width:500px; max-width:95vw;"}
  >
    {#if selectedStatement}
      <div class="sheet-head">
        <div>
          <span class="sheet-eyebrow"><FileText size={13} />Bank Statement</span>
          <h2 class="sheet-title-text filename">
            {selectedStatement.originalFilename}
          </h2>
        </div>
        <Sheet.Close class="sheet-close" aria-label="Close statement">
          <X size={16} />
        </Sheet.Close>
      </div>
      <div class="statement-body">
        <div class="statement-status">
          <StatusBadge status={statusLabel(selectedStatement)} />
          <span class="num">
            {selectedStatement.dateFrom && selectedStatement.dateTo
              ? `${formatDate(selectedStatement.dateFrom)} – ${formatDate(selectedStatement.dateTo)}`
              : "No transactions"}
          </span>
        </div>

        {#if data.permissions.change}
          <div class="statement-account">
            <span class="field-label">Account this statement belongs to</span>
            <!-- Moving a statement uploaded against the wrong account
                 (FR-054). -->
            <Select.Root
              type="single"
              value={selectedStatement.accountId != null ? String(selectedStatement.accountId) : ""}
              onValueChange={(next) => {
                const accountId = next ? Number(next) : null;
                if (accountId) void reassignStatement(accountId);
              }}
            >
              <Select.Trigger
                aria-label="Account this statement belongs to"
                class="w-full justify-between"
              >
                {data.accounts.find((account) => account.id === selectedStatement.accountId)
                  ?.name ?? "Choose an account"}
              </Select.Trigger>
              <Select.Content>
                {#each data.accounts as account (account.id)}
                  <Select.Item value={String(account.id)} label={account.name} />
                {/each}
              </Select.Content>
            </Select.Root>
          </div>
        {/if}

        <div class="statement-stats">
          <div>
            <span class="mini-label">Lines</span>
            <strong>{selectedStatement.totalLines}</strong>
          </div>
          <div>
            <span class="mini-label">Matched</span>
            <strong>{selectedStatement.matchedCount}</strong>
          </div>
          <div>
            <span class="mini-label">Remaining</span>
            <strong>{formatMoney(selectedStatement.remainingAmount)}</strong>
          </div>
        </div>

        {#if selectedStatement.extractionError}
          <p class="error-banner">{selectedStatement.extractionError}</p>
        {/if}

        <button
          type="button"
          class="sheet-btn-primary"
          disabled={selectedStatement.totalLines === 0}
          title={selectedStatement.totalLines === 0
            ? selectedStatement.extractionState ===
                StatementExtractionState.Extracting
              ? "Still extracting transactions from this statement."
              : "No transactions were extracted from this statement."
            : undefined}
          onclick={() => openMatch(selectedStatement)}
        >
          Match this statement
        </button>
      </div>
      <div class="sheet-foot">
        <div class="sheet-foot-actions">
          {#if data.permissions.delete}
            <button
              class="sheet-btn sheet-btn-delete"
              style="margin-right:auto;"
              type="button"
              onclick={() => (deleteStatementOpen = true)}
            >
              <Trash2 size={14} /> Delete
            </button>
          {/if}
          <Sheet.Close class="sheet-btn">Close</Sheet.Close>
          {#if selectedStatement.extractionState === StatementExtractionState.Failed && data.permissions.add}
            <button
              class="sheet-btn-primary"
              type="button"
              disabled={retrying}
              onclick={retryExtraction}
            >
              {retrying ? "Retrying…" : "Retry Extraction"}
            </button>
          {/if}
        </div>
      </div>
    {/if}
  </Sheet.Content>
</Sheet.Root>

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
        This statement will be checked against <strong>{data.account.name}</strong
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
          <FileText size={14} />{uploadFileName || "Choose a PDF, JPEG or PNG"}
        </button>
        <small class="field-hint">Up to 15 MB.</small>
      </div>
    </div>
    <div class="sheet-foot">
      <div class="sheet-foot-actions">
        <Sheet.Close class="sheet-btn">Cancel</Sheet.Close>
        <button
          class="sheet-btn-primary"
          type="button"
          disabled={!uploadFileName || uploading}
          onclick={upload}>{uploading ? "Uploading…" : "Upload"}</button
        >
      </div>
    </div>
  </Sheet.Content>
</Sheet.Root>

<ConfirmDialog
  bind:open={deleteStatementOpen}
  title="Delete Bank Statement?"
  description="This removes the statement and every line extracted from it. Allocations against those lines are removed too. This cannot be undone."
  confirmLabel="Delete statement"
  danger
  onConfirm={deleteStatement}
/>

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
  .filter-checklist {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px;
  }
  .filter-check {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 8px;
    border-radius: 6px;
    font-size: 13px;
    cursor: pointer;
  }
  .filter-check:hover {
    background: var(--accent);
  }
  .filter-checkbox {
    width: 15px;
    height: 15px;
    accent-color: var(--primary);
  }
  .filter-mobile-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 18px 8px;
    font-size: 13px;
    font-weight: 600;
  }
  .filter-mobile-clear {
    border: none;
    background: none;
    color: var(--primary);
    font-family: inherit;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }
  .filter-checklist-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
    color: var(--muted-foreground);
    font-size: 11px;
    font-weight: 650;
    letter-spacing: 0.04em;
    text-transform: uppercase;
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
  .amount-num,
  .statement-stats strong {
    font-variant-numeric: tabular-nums;
  }
  .td-chevron {
    display: flex;
    align-items: center;
    gap: 4px;
    justify-content: flex-end;
    color: var(--muted-foreground);
  }
  .statement-more {
    border: none;
    background: none;
    color: var(--muted-foreground);
    font-size: 16px;
    line-height: 1;
    padding: 2px 6px;
    border-radius: 6px;
    cursor: pointer;
  }
  .statement-more:hover {
    background: var(--accent);
    color: var(--foreground);
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
  .statement-body {
    flex: 1;
    overflow-y: auto;
    padding: 20px 22px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .statement-status {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    font-size: 12.5px;
    color: var(--muted-foreground);
  }
  .statement-account {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .statement-stats {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 10px;
  }
  .statement-stats div {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px;
  }
  .statement-stats strong {
    display: block;
    margin-top: 3px;
    font-size: 14px;
  }
  .error-banner {
    margin: 0;
    padding: 10px 12px;
    border-radius: 8px;
    background: var(--red-soft);
    color: var(--red);
    font-size: 12.5px;
    line-height: 1.5;
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
  .sheet-btn-delete {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
</style>
