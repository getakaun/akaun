<script lang="ts">
  import {
    beforeNavigate,
    goto,
    invalidateAll,
    replaceState,
  } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import { SvelteURLSearchParams } from "svelte/reactivity";
  import {
    ArrowDownLeft,
    ArrowLeftRight,
    ArrowUpRight,
    Banknote,
    Calendar,
    Check,
    ChevronRight,
    CircleDollarSign,
    ExternalLink,
    FileText,
    Search,
    SlidersHorizontal,
    Trash2,
    X,
  } from "@lucide/svelte";
  import { toast } from "svelte-sonner";
  import * as Sheet from "$lib/components/ui/sheet/index.js";
  import * as Select from "$lib/components/ui/select/index.js";
  import ConfirmDialog from "$lib/components/ui/ConfirmDialog.svelte";
  import DatePicker from "$lib/components/ui/date-picker/DatePicker.svelte";
  import EmptyState from "$lib/components/ui/EmptyState.svelte";
  import FilterDropdown from "$lib/components/ui/FilterDropdown.svelte";
  import StatusBadge from "$lib/components/ui/StatusBadge.svelte";
  import BackLink from "$lib/components/ui/BackLink.svelte";
  import {
    LedgerRecordKindDisplayLabels,
    StatementDirection,
    StatementExtractionState,
  } from "$lib/enums.js";
  import { mainCurrencySymbol } from "$lib/currency-state.svelte.js";
  import { formatDate, formatMoney } from "$lib/format.js";
  import { useIsMobile } from "$lib/hooks/useIsMobile.svelte.js";
  import { createResourceStream } from "$lib/sse.js";
  import type { loadStatementMatch } from "$lib/server/loaders/reconciliation.js";

  /**
   * Matching one statement's lines against the records that touched its account.
   *
   * A full-width working surface: the bank's lines, the candidate records and
   * the allocation being composed all have to be visible at once, which is why
   * this is a page rather than a drawer — the named task-workspace exception in
   * CLAUDE.md. Unlike the workspace it comes from, it has **its own shareable
   * address**, so somebody can send a colleague the statement they are part-way
   * through (FR-052).
   *
   * Only movements on the statement's own account are offered. Automatic
   * suggestions also require the same date and no competing record. Manual
   * matching remains available for different bank posting dates.
   *
   * What is gone is the "Akaun Records" tab and its "Needs Review" status
   * filter. That question — what still needs clearing, across every account —
   * is now a filter on the Records screen, where it covers accounts with no
   * statement uploaded too (D-06, FR-056).
   */
  type Data = ReturnType<typeof loadStatementMatch>;
  /** One side of a record, on the account this statement belongs to. */
  type MovementRow = Data["movements"][number];
  type StatementLine = Data["lines"][number];
  type Draft = { lineId: number; amount: number };
  /** Must not exceed the `movementIds` array cap in /api/reconciliation/auto-match. */
  const BULK_MATCH_CHUNK = 500;
  /** Half a cent — the point where a decimal remainder stops being a rounding artefact. */
  const CENT = 0.005;

  let { data }: { data: Data } = $props();

  const screen = useIsMobile();
  const isMobile = $derived(screen.current);
  const workspaceScreen = useIsMobile("(max-width: 1000px)");
  const compactWorkspace = $derived(workspaceScreen.current);
  const panelSide = $derived(isMobile ? "bottom" : "right");

  let query = $state(page.url.searchParams.get("q") ?? "");
  let from = $state(page.url.searchParams.get("from") ?? "");
  let to = $state(page.url.searchParams.get("to") ?? "");
  let mobileFilterOpen = $state(false);
  let selectedMovementId = $state(
    Number(page.url.searchParams.get("movement")) || null,
  );
  let selectedMovement = $state<MovementRow | null>(null);
  let drafts = $state<Draft[]>([]);
  let savedDrafts = $state<Draft[]>([]);
  let initialDrafts = $state<Draft[]>([]);
  let saving = $state(false);
  let bulkOpen = $state(false);
  let bulkSaving = $state(false);
  let deleteLineOpen = $state(false);
  let pendingLineId = $state<number | null>(null);
  let discardOpen = $state(false);
  let deferredAction = $state<(() => void) | null>(null);
  let editingLineId = $state<number | null>(null);
  // "Record this as a transfer from another account" (FR-023).
  let transferLineId = $state<number | null>(null);
  let transferAccountId = $state<number | null>(null);
  let transferDescription = $state("");
  let transferSaving = $state(false);
  let statementAction = $state<"move" | "delete" | "retry" | null>(null);
  let targetAccountId = $state("");
  let deleteStatementOpen = $state(false);
  let statementError = $state("");

  /** Records on this account that bank lines do not yet fully account for. */
  const reviewMovements = $derived(
    data.movements.filter(
      (movement) => Math.abs(movement.remainingAmount ?? 0) >= CENT,
    ),
  );
  const bankRemaining = $derived(
    data.lines.reduce(
      (sum, line) => sum + Math.max(0, line.remainingAmount),
      0,
    ),
  );
  const dateRangeActive = $derived(!!(from || to));
  const activeFilterCount = $derived(dateRangeActive ? 1 : 0);

  const visibleMovements = $derived.by(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return data.movements
      .filter(
        (movement) =>
          !normalized ||
          `${movement.label} ${movement.contactName ?? ""} ${movement.accountName ?? ""} ${kindLabel(movement.kind)}`
            .toLocaleLowerCase()
            .includes(normalized),
      )
      .toSorted((left, right) => matchRank(left) - matchRank(right));
  });
  const bulkMatchable = $derived(
    visibleMovements.filter(
      (movement) => matchStatus(movement) === "exact-match",
    ),
  );
  const savedAllocations = $derived.by(() => {
    const movement = selectedMovement;
    return movement
      ? data.allocations.filter(
          (allocation) => allocation.movementId === movement.movementId,
        )
      : [];
  });
  /**
   * The lines this movement could be. Only lines from a statement on the
   * movement's own account are ever offered — that is FR-021, and it is why a
   * wallet purchase can no longer appear against a bank statement.
   */
  const compatibleLines = $derived.by(() => {
    const movement = selectedMovement;
    if (!movement) return [];
    const direction =
      movement.amountMinor > 0 ? StatementDirection.In : StatementDirection.Out;
    const savedIds = new Set(
      savedAllocations.map((allocation) => allocation.lineId),
    );
    return data.lines.filter(
      (line) =>
        line.accountId === movement.accountId &&
        line.direction === direction &&
        (line.remainingAmount >= CENT || savedIds.has(line.id)),
    );
  });
  const availableLines = $derived(
    compatibleLines.toSorted((left, right) =>
      right.date.localeCompare(left.date),
    ),
  );
  const draftTotal = $derived(
    Math.round(
      drafts.reduce((sum, draft) => sum + Number(draft.amount || 0), 0) * 100,
    ) / 100,
  );
  const movementTotal = $derived(selectedMovement?.amount ?? 0);
  const draftRemaining = $derived(
    Math.round((movementTotal - draftTotal) * 100) / 100,
  );
  const dirty = $derived(
    JSON.stringify(normalizeDrafts(drafts)) !==
      JSON.stringify(normalizeDrafts(savedDrafts)),
  );
  const manuallyEdited = $derived(
    JSON.stringify(normalizeDrafts(drafts)) !==
      JSON.stringify(normalizeDrafts(initialDrafts)),
  );
  const hasSuggestion = $derived(
    !!selectedMovement?.suggestedLineIds.length &&
      savedAllocations.length === 0,
  );
  const suggestionApplied = $derived(
    !!selectedMovement &&
      drafts.length === selectedMovement.suggestedLineIds.length &&
      selectedMovement.suggestedLineIds.every((id) =>
        drafts.some((draft) => draft.lineId === id),
      ),
  );
  /** A line with nothing allocated to it yet is the only kind a transfer can explain. */
  const transferLine = $derived(
    data.lines.find((line) => line.id === transferLineId) ?? null,
  );
  // Decided on the server (`transferTargetIds`): two places money sits, unless
  // the user has Adjustments.
  const transferTargets = $derived(
    data.accounts.filter((account) =>
      data.transferTargetIds.includes(account.id),
    ),
  );

  // Which movement's allocations `drafts` currently holds. Deliberately a plain
  // `let`, not `$state`: the effect below writes it, and making it reactive
  // would feed that write straight back in as a dependency.
  let hydratedId: number | null = null;

  // Two jobs, and the difference matters:
  //   1. `?movement=…` in the URL (refresh, pasted link) opens a movement
  //      without going through `loadMovement`, so its saved allocations have to
  //      be staged here — otherwise Save would replace them with whatever the
  //      empty composer holds.
  //   2. After an invalidation, re-point `selectedMovement` at the fresh loader
  //      object so the composer shows current amounts. This must NOT re-stage
  //      drafts: an SSE event from another tab would wipe edits in progress.
  $effect(() => {
    const movements = data.movements;
    const id = selectedMovementId;
    if (!id) {
      hydratedId = null;
      return;
    }
    const refreshed = movements.find((movement) => movement.movementId === id);
    if (!refreshed) return;
    selectedMovement = refreshed;
    if (hydratedId === id) return;
    hydratedId = id;
    stageSavedAllocations(refreshed);
  });

  // The stream still sends a full snapshot on connect. This surface is scoped
  // to one statement, so it narrows what it receives rather than asking for a
  // narrower feed: any event that is not the snapshot re-runs this page's own
  // loader, which is already scoped (contracts/events.md).
  createResourceStream<{ type: string }>(
    "/api/reconciliation/stream",
    (event) => {
      if (event.type !== "snapshot" && !statementAction) void invalidateAll();
    },
  );

  function clearAllocationDrafts() {
    selectedMovementId = null;
    selectedMovement = null;
    drafts = [];
    savedDrafts = [];
    initialDrafts = [];
  }

  async function manageStatement(action: "move" | "delete" | "retry") {
    if (statementAction) return;
    const accountId = Number(targetAccountId);
    if (action === "move" && (!accountId || accountId === data.account.id))
      return;
    statementAction = action;
    statementError = "";
    try {
      const response = await fetch(
        `/api/reconciliation/statements/${data.statement.id}${action === "retry" ? "/retry" : ""}`,
        action === "move"
          ? {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ accountId }),
            }
          : { method: action === "delete" ? "DELETE" : "POST" },
      );
      if (!response.ok) {
        const result = await response.json().catch(() => null);
        throw new Error(
          result?.error ?? "Statement could not be updated. Try again.",
        );
      }
      if (action === "retry") {
        toast.success("Statement extraction restarted");
        await invalidateAll();
      } else {
        // The action was guarded before the write. Do not prompt a second time
        // after deletion or leave the old account's now-stale address on screen.
        clearAllocationDrafts();
        deleteStatementOpen = false;
        toast.success(
          action === "delete"
            ? "Statement deleted"
            : "Statement account updated",
        );
        if (action === "move") {
          await goto(
            resolve("/(app)/accounts/[id]/reconcile/[statementId]", {
              id: String(accountId),
              statementId: String(data.statement.id),
            }),
          );
          targetAccountId = "";
        } else {
          await goto(
            resolve("/(app)/accounts/[id]/reconcile", {
              id: String(data.account.id),
            }),
          );
        }
      }
    } catch (error) {
      statementError =
        error instanceof Error
          ? error.message
          : "Statement could not be updated. Try again.";
    } finally {
      statementAction = null;
    }
  }

  function kindLabel(kind: number | undefined) {
    return (kind && LedgerRecordKindDisplayLabels[kind]) || "Record";
  }
  function transactionStatus(line: StatementLine) {
    if (line.remainingAmount < -CENT) return "overallocated";
    if (line.allocatedAmount >= CENT && Math.abs(line.remainingAmount) < CENT)
      return "reconciled";
    return line.allocatedAmount >= CENT ? "partial" : "unreconciled";
  }
  function matchStatus(
    movement: MovementRow,
  ):
    | "matched"
    | "exact-match"
    | "partial-match"
    | "no-match"
    | "needs-manual-choice" {
    if (Math.abs(movement.remainingAmount ?? 0) < CENT) return "matched";
    if ((movement.allocatedAmount ?? 0) >= CENT) return "partial-match";
    if (movement.suggestionConflict) return "needs-manual-choice";
    return movement.suggestedLineIds.length ? "exact-match" : "no-match";
  }
  function matchRank(movement: MovementRow) {
    const status = matchStatus(movement);
    return status === "exact-match"
      ? 0
      : status === "partial-match"
        ? 1
        : status === "no-match"
          ? 2
          : 3;
  }
  function buildSuggestionDrafts(movement: MovementRow): Draft[] {
    if (!movement.suggestedLineIds.length) return [];
    let remaining = movement.amount;
    const result: Draft[] = [];
    for (const lineId of movement.suggestedLineIds) {
      const line = data.lines.find((candidate) => candidate.id === lineId);
      if (!line) continue;
      const amount = Math.min(line.remainingAmount, remaining);
      remaining = Math.round((remaining - amount) * 100) / 100;
      result.push({ lineId, amount });
    }
    return result;
  }
  function normalizeDrafts(value: Draft[]) {
    return value
      .map((draft) => ({ lineId: draft.lineId, amount: Number(draft.amount) }))
      .sort((a, b) => a.lineId - b.lineId);
  }
  function statusLabel() {
    if (data.statement.extractionState === StatementExtractionState.Extracting)
      return "extracting";
    if (data.statement.extractionState === StatementExtractionState.Failed)
      return "failed";
    return data.statement.completed ? "matched" : "active";
  }
  function updateUrl() {
    const params = new SvelteURLSearchParams({});
    if (query) params.set("q", query);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    if (selectedMovementId) params.set("movement", String(selectedMovementId));
    const path = resolve("/(app)/accounts/[id]/reconcile/[statementId]", {
      id: String(data.account.id),
      statementId: String(data.statement.id),
    });
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- route is resolved; only query state is appended.
    replaceState(`${path}?${params}`, page.state);
  }
  function clearFilters() {
    from = "";
    to = "";
    updateUrl();
  }
  function guard(action: () => void) {
    if (!manuallyEdited) return action();
    deferredAction = action;
    discardOpen = true;
  }
  function confirmDiscard() {
    drafts = [...initialDrafts];
    discardOpen = false;
    const action = deferredAction;
    deferredAction = null;
    action?.();
  }
  /**
   * Fill the composer for `movement`: its saved allocations if it has any, the
   * suggested set otherwise. Shared by the in-app row click and the
   * URL-restore effect so both open a movement in the same state.
   */
  function stageSavedAllocations(movement: MovementRow) {
    const saved = data.allocations
      .filter((allocation) => allocation.movementId === movement.movementId)
      .map((allocation) => ({
        lineId: allocation.lineId,
        amount: allocation.amount,
      }));
    drafts = saved.length ? saved : buildSuggestionDrafts(movement);
    savedDrafts = [...saved];
    initialDrafts = [...drafts];
  }
  function loadMovement(movement: MovementRow) {
    selectedMovementId = movement.movementId;
    // Staged here and now, so the effect above treats this movement as hydrated
    // and leaves the drafts alone on the next invalidation.
    hydratedId = movement.movementId;
    selectedMovement = movement;
    stageSavedAllocations(movement);
    updateUrl();
  }
  function chooseMovement(movement: MovementRow) {
    guard(() => loadMovement(movement));
  }
  function closeMovement() {
    guard(clearSelection);
  }
  function toggleLine(line: StatementLine) {
    const existing = drafts.find((draft) => draft.lineId === line.id);
    if (existing) {
      drafts = drafts.filter((draft) => draft.lineId !== line.id);
      return;
    }
    const savedHere =
      savedAllocations.find((allocation) => allocation.lineId === line.id)
        ?.amount ?? 0;
    const available = line.remainingAmount + savedHere;
    const remaining = Math.max(0, movementTotal - draftTotal);
    drafts = [
      ...drafts,
      { lineId: line.id, amount: Math.min(available, remaining || available) },
    ];
  }
  function updateDraft(lineId: number, value: string) {
    drafts = drafts.map((draft) =>
      draft.lineId === lineId ? { ...draft, amount: Number(value) } : draft,
    );
  }
  function applySuggestion() {
    if (!selectedMovement) return;
    drafts = buildSuggestionDrafts(selectedMovement);
  }
  async function saveAllocations(): Promise<boolean> {
    if (!selectedMovement || saving || draftRemaining < -CENT) return false;
    saving = true;
    const response = await fetch(
      `/api/reconciliation/records/${selectedMovement.movementId}/allocations`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ allocations: drafts }),
      },
    ).catch(() => null);
    saving = false;
    if (!response?.ok) {
      const result = await response?.json().catch(() => null);
      toast.error(
        result?.error ??
          "Allocations could not be saved. Check the available amounts and try again.",
      );
      return false;
    }
    savedDrafts = [...drafts];
    initialDrafts = [...drafts];
    toast.success("Allocations saved");
    await invalidateAll();
    return true;
  }
  async function saveAndAdvance() {
    if (!selectedMovement) return;
    const queue = visibleMovements;
    const index = queue.findIndex(
      (movement) => movement.movementId === selectedMovementId,
    );
    const nextId =
      index >= 0 && index + 1 < queue.length
        ? queue[index + 1].movementId
        : null;
    const ok = await saveAllocations();
    if (!ok) return;
    const nextMovement =
      (nextId &&
        data.movements.find(
          (movement) =>
            movement.movementId === nextId &&
            Math.abs(movement.remainingAmount ?? 0) >= CENT,
        )) ||
      visibleMovements.find(
        (movement) => Math.abs(movement.remainingAmount ?? 0) >= CENT,
      );
    if (nextMovement) {
      loadMovement(nextMovement);
      return;
    }
    clearSelection();
  }
  function clearSelection() {
    selectedMovementId = null;
    selectedMovement = null;
    drafts = [];
    savedDrafts = [];
    initialDrafts = [];
    updateUrl();
  }
  async function runAutoMatch() {
    bulkOpen = false;
    if (bulkSaving || saving) return;
    // Hand edits on the open movement outrank its suggestion, so persist them
    // first — that also takes the movement out of the batch, since the server
    // skips anything already allocated.
    if (selectedMovement && manuallyEdited && !(await saveAllocations()))
      return;
    const targets = bulkMatchable.map((movement) => movement.movementId);
    if (!targets.length) return;
    bulkSaving = true;
    let matched = 0;
    let skipped = 0;
    // The endpoint caps a batch at BULK_MATCH_CHUNK movements; each request
    // re-reads the live line balances, so chunking stays consistent.
    for (let start = 0; start < targets.length; start += BULK_MATCH_CHUNK) {
      const response = await fetch("/api/reconciliation/auto-match", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          statementId: data.statement.id,
          movementIds: targets.slice(start, start + BULK_MATCH_CHUNK),
        }),
      }).catch(() => null);
      const result = await response?.json().catch(() => null);
      if (!response?.ok) {
        bulkSaving = false;
        toast.error(
          result?.error ??
            "Exact matches could not be saved. Check the available amounts and try again.",
        );
        // Earlier chunks are already saved; reload so the list reflects them.
        await invalidateAll();
        return;
      }
      matched += Number(result?.matched ?? 0);
      skipped += Number(result?.skipped ?? 0);
    }
    bulkSaving = false;
    toast.success(
      `${matched} record${matched === 1 ? "" : "s"} matched${
        skipped ? ` · ${skipped} skipped` : ""
      }`,
    );
    await invalidateAll();
    const next = visibleMovements.find((movement) => {
      const status = matchStatus(movement);
      return (
        status === "partial-match" ||
        status === "no-match" ||
        status === "needs-manual-choice"
      );
    });
    if (next) {
      loadMovement(next);
      return;
    }
    clearSelection();
  }
  function openTransfer(line: StatementLine) {
    transferLineId = line.id;
    transferAccountId = transferTargets[0]?.id ?? null;
    transferDescription = line.description;
  }
  function closeTransfer() {
    transferLineId = null;
    transferAccountId = null;
    transferDescription = "";
  }
  /**
   * Record a line as money moved between two of the user's own accounts, and
   * match it in the same action (FR-023). Nothing was earned or spent, so there
   * was never a record to find — this creates the one that was missing.
   */
  async function saveTransfer() {
    if (!transferLineId || !transferAccountId || transferSaving) return;
    transferSaving = true;
    const response = await fetch(
      `/api/reconciliation/lines/${transferLineId}/transfer`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          otherAccountId: transferAccountId,
          description: transferDescription,
        }),
      },
    ).catch(() => null);
    transferSaving = false;
    if (!response?.ok) {
      const result = await response?.json().catch(() => null);
      toast.error(
        result?.error ??
          "This transaction could not be recorded as a transfer.",
      );
      return;
    }
    toast.success("Transfer recorded and matched");
    closeTransfer();
    await invalidateAll();
  }
  async function editLine(line: StatementLine, field: string, value: string) {
    const numeric = field === "amount" || field === "direction";
    const response = await fetch(`/api/reconciliation/lines/${line.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ [field]: numeric ? Number(value) : value }),
    });
    if (!response.ok) {
      const result = await response.json().catch(() => null);
      toast.error(result?.error ?? "Statement line could not be updated.");
      return;
    }
    toast.success("Statement line updated");
    await invalidateAll();
  }
  async function deleteLine() {
    if (!pendingLineId) return;
    const response = await fetch(`/api/reconciliation/lines/${pendingLineId}`, {
      method: "DELETE",
    });
    if (!response.ok)
      return toast.error("Statement line could not be deleted. Try again.");
    deleteLineOpen = false;
    pendingLineId = null;
    toast.success("Statement line deleted");
    await invalidateAll();
  }

  beforeNavigate((navigation) => {
    if (dirty) {
      navigation.cancel();
      if (navigation.to?.url) {
        const destination = navigation.to.url;
        // eslint-disable-next-line svelte/no-navigation-without-resolve -- destination already comes from SvelteKit's resolved navigation target.
        deferredAction = () => void goto(destination);
      }
      discardOpen = true;
    }
  });
</script>

<svelte:window
  onbeforeunload={(event) => {
    if (!dirty) return;
    event.preventDefault();
    return "";
  }}
/>
<svelte:head
  ><title>{data.statement.originalFilename} · Match</title></svelte:head
>

<div class="screen reconciliation-screen">
  <header class="topbar">
    <div class="topbar-left">
      <BackLink
        href={resolve("/(app)/accounts/[id]/reconcile", {
          id: String(data.account.id),
        })}
        label={data.account.name}
      />
    </div>
  </header>

  <div class="work">
    <div class="work-main recon-work">
      <section class="statement-overview" aria-label="Statement summary">
        <div class="statement-heading">
          <h1 class="page-title">{data.statement.originalFilename}</h1>
          <StatusBadge status={statusLabel()} />
        </div>
        <p class="statement-meta">
          <span>{data.account.name}</span>
          <span
            >{data.statement.dateFrom && data.statement.dateTo
              ? `${formatDate(data.statement.dateFrom)} – ${formatDate(data.statement.dateTo)}`
              : "No transaction dates"}</span
          >
        </p>
        <div class="statement-progress">
          <div>
            <span class="mini-label">Matched transactions</span>
            <strong class="num"
              >{data.statement.matchedCount} / {data.statement
                .totalLines}</strong
            >
          </div>
          <div>
            <span class="mini-label">Unallocated statement amount</span>
            <strong class="num">{formatMoney(bankRemaining)}</strong>
          </div>
        </div>
        {#if data.statement.extractionState === StatementExtractionState.Extracting}
          <p class="extraction-notice" role="status">
            Extracting transactions… This page will update automatically.
          </p>
        {:else if data.statement.extractionState === StatementExtractionState.Failed}
          <div class="extraction-error" role="alert">
            <p>
              {data.statement.extractionError ||
                "Transactions could not be extracted. Retry extraction or upload a clearer file."}
            </p>
            {#if data.permissions.add}
              <button
                type="button"
                class="sheet-btn sheet-btn-primary"
                disabled={statementAction !== null}
                onclick={() => guard(() => void manageStatement("retry"))}
              >
                {statementAction === "retry" ? "Retrying…" : "Retry extraction"}
              </button>
            {/if}
          </div>
        {/if}
        <details class="statement-details">
          <summary>Statement details</summary>
          <div class="statement-details-body">
            <dl class="statement-information">
              <div>
                <dt>Filename</dt>
                <dd>{data.statement.originalFilename}</dd>
              </div>
              <div>
                <dt>Uploaded</dt>
                <dd>{formatDate(data.statement.createdAt.slice(0, 10))}</dd>
              </div>
              <div>
                <dt>Source file</dt>
                <dd>
                  {#if data.statement.storedFilePath}
                    <a
                      class="source-link"
                      href={resolve(
                        "/api/reconciliation/statements/[statementId]/file",
                        {
                          statementId: String(data.statement.id),
                        },
                      )}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <ExternalLink size={14} aria-hidden="true" />View source
                      file<span class="sr-only"> (opens in a new tab)</span>
                    </a>
                  {:else}<span class="muted">Source file unavailable</span>{/if}
                </dd>
              </div>
            </dl>
            {#if data.permissions.change}
              <div class="statement-move">
                <span class="field-label" id="statement-account-label"
                  >Account this statement belongs to</span
                >
                <div class="statement-move-controls">
                  <Select.Root
                    type="single"
                    value={targetAccountId || String(data.account.id)}
                    onValueChange={(value) => {
                      targetAccountId = value;
                    }}
                    disabled={statementAction !== null}
                  >
                    <Select.Trigger
                      aria-labelledby="statement-account-label"
                      class="statement-account-select"
                    >
                      {data.accounts.find(
                        (account) =>
                          String(account.id) ===
                          (targetAccountId || String(data.account.id)),
                      )?.name ?? "Choose an account"}
                    </Select.Trigger>
                    <Select.Content>
                      {#each data.accounts as account (account.id)}
                        <Select.Item
                          value={String(account.id)}
                          label={account.name}
                        />
                      {/each}
                    </Select.Content>
                  </Select.Root>
                  <button
                    type="button"
                    class="sheet-btn"
                    disabled={statementAction !== null ||
                      !targetAccountId ||
                      Number(targetAccountId) === data.account.id}
                    onclick={() => guard(() => void manageStatement("move"))}
                  >
                    {statementAction === "move" ? "Moving…" : "Move statement"}
                  </button>
                </div>
              </div>
            {/if}
            {#if data.permissions.delete}
              <div class="statement-danger">
                <button
                  type="button"
                  class="sheet-btn sheet-btn-delete"
                  disabled={statementAction !== null}
                  onclick={() =>
                    guard(() => {
                      deleteStatementOpen = true;
                    })}
                >
                  <Trash2 size={14} aria-hidden="true" />Delete statement
                </button>
              </div>
            {/if}
          </div>
        </details>
        {#if statementError}<p class="extraction-error" role="alert">
            {statementError}
          </p>{/if}
      </section>
      <div class="toolbar matching-toolbar">
        <div class="matching-heading">
          <h2>Records to match</h2>
          <span class="num">{reviewMovements.length}</span>
        </div>
        <div class="search-box recon-search">
          <div style="position:relative; display:flex; align-items:center;">
            <span
              style="position:absolute; left:10px; top:50%; transform:translateY(-50%); color:var(--muted-foreground); display:flex; pointer-events:none;"
            >
              <Search size={15} aria-hidden="true" />
            </span>
            <input
              type="search"
              placeholder="Search records…"
              bind:value={query}
              oninput={updateUrl}
              aria-label="Search records"
            />
          </div>
        </div>

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
          {@render BulkMatchButton()}
        </div>
        <div class="toolbar-filters">
          {@render BulkMatchButton()}
          {#if activeFilterCount > 0}
            <button class="clear-filters" onclick={clearFilters}>
              <X size={13} /> Clear
            </button>
          {/if}
          <FilterDropdown label="Date" active={dateRangeActive} align="right">
            {#snippet icon()}<Calendar size={14} aria-hidden="true" />{/snippet}
            <div class="filter-daterange">
              <div class="filter-daterange-head">
                <span>Date range</span>
                {#if from || to}<button
                    type="button"
                    onclick={() => {
                      from = "";
                      to = "";
                      updateUrl();
                      void invalidateAll();
                    }}>Clear</button
                  >{/if}
              </div>
              <span class="mini-label">From</span>
              <DatePicker
                value={from}
                placeholder="From date"
                onchange={(value) => {
                  from = value;
                  updateUrl();
                  void invalidateAll();
                }}
              />
              <span class="mini-label">To</span>
              <DatePicker
                value={to}
                placeholder="To date"
                onchange={(value) => {
                  to = value;
                  updateUrl();
                  void invalidateAll();
                }}
              />
            </div>
          </FilterDropdown>
        </div>
      </div>

      <!-- Lines, candidates and the current selection, all visible at once —
           which is why this is a full-width page and not a drawer. -->
      <div class="split-workspace">
        <div class="record-pane">
          <div class="table-card">
            <table class="exp-table">
              <thead
                ><tr
                  ><th>Record</th><th>Account</th><th>Date</th><th
                    class="ta-right">Total</th
                  ><th>Match</th><th class="ta-right">Remaining</th><th
                    aria-label="Open"
                  ></th></tr
                ></thead
              ><tbody
                >{#each visibleMovements as movement (movement.movementId)}<tr
                    class="exp-row"
                    class:selected={movement.movementId === selectedMovementId}
                    tabindex="0"
                    onclick={() => chooseMovement(movement)}
                    onkeydown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        chooseMovement(movement);
                      }
                    }}
                    ><td class="td-primary"
                      ><div class="cell-item">
                        <span class="cell-itemname">{movement.label}</span><span
                          class="cell-itemnum"
                          >{kindLabel(movement.kind)} · {movement.contactName ||
                            "No contact"}</span
                        >
                      </div></td
                    ><td data-label="Account"
                      ><span class="type-chip"
                        >{movement.accountName ?? "No account"}</span
                      ></td
                    ><td class="td-date" data-label="Date"
                      >{formatDate(movement.date)}</td
                    ><td class="td-amount" data-label="Total"
                      ><span class="amount-num"
                        >{formatMoney(movement.amount)}</span
                      ></td
                    ><td data-label="Match"
                      ><StatusBadge status={matchStatus(movement)} /></td
                    ><td class="td-amount remaining" data-label="Remaining"
                      ><span class="amount-num"
                        >{formatMoney(movement.remainingAmount ?? 0)}</span
                      ></td
                    ><td class="td-chevron"
                      ><ChevronRight size={15} aria-hidden="true" /></td
                    ><td class="row-break"></td></tr
                  >{/each}{#if visibleMovements.length === 0}<tr
                    class="empty-row"
                    ><td colspan="7"
                      ><EmptyState
                        title="Nothing to match"
                        sub={query.trim() || dateRangeActive
                          ? "No record on this account matches the current search or date range."
                          : "Every record on this account is already accounted for by a bank line."}
                        >{#snippet icon()}{#if query.trim() || dateRangeActive}<Banknote
                              size={20}
                            />{:else}<Check
                              size={20}
                            />{/if}{/snippet}</EmptyState
                      ></td
                    ></tr
                  >{/if}</tbody
              >
            </table>
          </div>
          <div class="table-foot">
            <span
              >Showing <b>{visibleMovements.length}</b> of {data.movements
                .length}</span
            >
          </div>
        </div>
        <div class="desktop-composer">
          {#if selectedMovement}{@render AllocationComposer()}{:else if reviewMovements.length === 0}<EmptyState
              title="You're all caught up"
              sub="Every record on this account is accounted for by a bank line."
              >{#snippet icon()}<Check size={20} />{/snippet}</EmptyState
            >{:else}<EmptyState
              title="Select an Akaun record"
              sub="Choose a record to review compatible bank transactions and stage allocations."
              >{#snippet icon()}<CircleDollarSign
                  size={20}
                />{/snippet}</EmptyState
            >{/if}
        </div>
      </div>

      <!-- The bank's own lines, as extracted from the statement. -->
      <div class="statement-lines-panel">
        <div class="detail-section-label">
          Extracted Transactions ({data.lines.length})
        </div>
        <div class="statement-lines">
          {#each data.lines as line (line.id)}
            {@const status = transactionStatus(line)}
            <div class="statement-line">
              <button
                class="statement-line-summary related-link"
                type="button"
                onclick={() =>
                  (editingLineId = editingLineId === line.id ? null : line.id)}
                ><span
                  class="direction-icon"
                  class:money-in={line.direction === StatementDirection.In}
                  >{#if line.direction === StatementDirection.In}<ArrowDownLeft
                      size={14}
                    />{:else}<ArrowUpRight size={14} />{/if}</span
                ><span class="statement-line-copy"
                  ><strong title={line.description}
                    >{line.description || "Statement transaction"}</strong
                  ><small class="statement-line-meta">
                    <span>{formatDate(line.date)}</span>
                    <span
                      class="statement-line-status"
                      class:reconciled={status === "reconciled"}
                      class:partial={status === "partial"}
                      class:overallocated={status === "overallocated"}
                    >
                      {#if status === "reconciled"}
                        <Check size={12} aria-hidden="true" /> Reconciled
                      {:else if status === "partial"}
                        Partially reconciled
                      {:else if status === "overallocated"}
                        Overallocated
                      {:else}
                        Unreconciled
                      {/if}
                    </span>
                    {#if status !== "reconciled"}
                      <span>{formatMoney(line.remainingAmount)} remaining</span>
                    {/if}
                  </small></span
                ><span class="line-total">{formatMoney(line.amount)}</span><span
                  class:rotated={editingLineId === line.id}
                  class="line-chevron"><ChevronRight size={14} /></span
                ></button
              >{#if editingLineId === line.id}<div class="line-edit">
                  <label
                    ><span>Date</span><input
                      name={`line-date-${line.id}`}
                      type="date"
                      value={line.date}
                      disabled={!data.permissions.change}
                      onchange={(event) =>
                        editLine(line, "date", event.currentTarget.value)}
                    /></label
                  ><label class="wide"
                    ><span>Description</span><input
                      name={`line-description-${line.id}`}
                      autocomplete="off"
                      value={line.description}
                      disabled={!data.permissions.change}
                      onchange={(event) =>
                        editLine(
                          line,
                          "description",
                          event.currentTarget.value,
                        )}
                    /></label
                  ><label
                    ><span>Amount</span><input
                      name={`line-amount-${line.id}`}
                      type="number"
                      inputmode="decimal"
                      min="0.01"
                      step="0.01"
                      value={line.amount}
                      disabled={!data.permissions.change}
                      onchange={(event) =>
                        editLine(line, "amount", event.currentTarget.value)}
                    /></label
                  ><label
                    ><span>Direction</span><Select.Root
                      type="single"
                      value={String(line.direction)}
                      onValueChange={(next) =>
                        next && editLine(line, "direction", next)}
                      ><Select.Trigger
                        aria-label="Direction"
                        class="w-full justify-between"
                        size="sm"
                        disabled={!data.permissions.change}
                        >{line.direction === StatementDirection.In
                          ? "Credit"
                          : "Debit"}</Select.Trigger
                      ><Select.Content
                        ><Select.Item
                          value={String(StatementDirection.In)}
                          label="Credit"
                        ></Select.Item><Select.Item
                          value={String(StatementDirection.Out)}
                          label="Debit"
                        ></Select.Item></Select.Content
                      ></Select.Root
                    ></label
                  ><label class="wide"
                    ><span>Note</span><input
                      name={`line-note-${line.id}`}
                      autocomplete="off"
                      value={line.note}
                      disabled={!data.permissions.change}
                      onchange={(event) =>
                        editLine(line, "note", event.currentTarget.value)}
                    /></label
                  >{#if data.permissions.add && line.allocatedAmount < CENT}<button
                      class="line-transfer"
                      type="button"
                      onclick={() => openTransfer(line)}
                      ><ArrowLeftRight size={13} />Record as a transfer from
                      another account</button
                    >{/if}{#if data.permissions.delete}<button
                      class="line-delete"
                      type="button"
                      onclick={() => {
                        pendingLineId = line.id;
                        deleteLineOpen = true;
                      }}><Trash2 size={13} />Delete Transaction</button
                    >{/if}
                </div>{/if}
            </div>{/each}{#if data.lines.length === 0}<EmptyState
              title={data.statement.extractionState ===
              StatementExtractionState.Extracting
                ? "Extracting transactions…"
                : "No transactions found"}
              sub={data.statement.extractionState ===
              StatementExtractionState.Extracting
                ? "This view updates automatically when extraction completes."
                : data.statement.extractionState ===
                    StatementExtractionState.Failed
                  ? "Retry extraction, or delete this statement and upload a clearer file."
                  : "Delete this statement and upload a clearer file."}
              >{#snippet icon()}<FileText size={20} />{/snippet}</EmptyState
            >{/if}
        </div>
      </div>
    </div>
  </div>
</div>

<ConfirmDialog
  bind:open={deleteStatementOpen}
  title="Delete Bank Statement?"
  description="This removes the statement and every line extracted from it. Allocations against those lines are removed too. This cannot be undone."
  confirmLabel="Delete statement"
  danger
  onConfirm={() => manageStatement("delete")}
/>

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
      <button class="filter-mobile-clear" type="button" onclick={clearFilters}
        >Clear</button
      >
    </div>
    <div class="filter-daterange">
      <div class="filter-daterange-field">
        <span class="mini-label">From</span>
        <DatePicker
          value={from}
          placeholder="From date"
          onchange={(value) => {
            from = value;
            updateUrl();
            void invalidateAll();
          }}
        />
      </div>
      <div class="filter-daterange-field">
        <span class="mini-label">To</span>
        <DatePicker
          value={to}
          placeholder="To date"
          onchange={(value) => {
            to = value;
            updateUrl();
            void invalidateAll();
          }}
        />
      </div>
    </div>
  </Sheet.Content>
</Sheet.Root>

<!-- The composer, on a screen too narrow to show it beside the list. -->
{#if compactWorkspace && selectedMovement}
  <Sheet.Root
    open={true}
    onOpenChange={(open) => {
      if (!open) closeMovement();
    }}
  >
    <Sheet.Content
      side={panelSide}
      class="recon-sheet"
      style="gap:0; width:500px; max-width:95vw; height:100dvh; border-radius:0;"
    >
      {@render AllocationComposer()}
    </Sheet.Content>
  </Sheet.Root>
{/if}

{#snippet BulkMatchButton()}
  {#if data.permissions.match && bulkMatchable.length > 0}
    <button
      class="bulk-match-btn"
      type="button"
      disabled={bulkSaving || saving}
      onclick={() => (bulkOpen = true)}
      ><Check size={13} aria-hidden="true" />{bulkSaving
        ? "Saving…"
        : `Save ${bulkMatchable.length} exact match${
            bulkMatchable.length === 1 ? "" : "es"
          }`}</button
    >
  {/if}
{/snippet}

{#snippet AllocationComposer()}
  {#if selectedMovement}{@const movesIn = selectedMovement.amountMinor > 0}
    <section class="composer" aria-label={`Allocate ${selectedMovement.label}`}>
      <header class="composer-head">
        <div class="type-icon" class:income={movesIn}>
          {#if movesIn}<ArrowDownLeft size={17} />{:else}<ArrowUpRight
              size={17}
            />{/if}
        </div>
        <div class="composer-title">
          <span
            >{kindLabel(selectedMovement.kind)} · {selectedMovement.accountName ??
              "No account"}</span
          >
          <h2>{selectedMovement.label}</h2>
          <p>
            {selectedMovement.contactName || formatDate(selectedMovement.date)}
          </p>
        </div>
        {#if compactWorkspace}<button
            class="icon-btn"
            type="button"
            aria-label="Close allocation composer"
            onclick={closeMovement}><X size={16} /></button
          >{/if}
      </header>
      <div class="amount-strip">
        <div>
          <span>Total</span><strong>{formatMoney(movementTotal)}</strong>
        </div>
        <div><span>Staged</span><strong>{formatMoney(draftTotal)}</strong></div>
        <div
          class:balanced={Math.abs(draftRemaining) < CENT}
          class:error={draftRemaining < -CENT}
        >
          <span>Remaining</span><strong>{formatMoney(draftRemaining)}</strong>
        </div>
      </div>
      <div class="composer-body">
        {#if selectedMovement.suggestionConflict}
          <p>
            Other records fit the same statement lines. Choose the correct match
            manually.
          </p>
        {/if}
        {#if hasSuggestion}<div class="suggestion">
            <div>
              <strong
                >{suggestionApplied
                  ? "Suggested match"
                  : "Exact Match Found"}</strong
              ><span
                >{selectedMovement.suggestedLineIds.length} transaction{selectedMovement
                  .suggestedLineIds.length === 1
                  ? ""
                  : "s"} total exactly {formatMoney(movementTotal)}.</span
              >
            </div>
            {#if !suggestionApplied}<button
                type="button"
                onclick={applySuggestion}>Use Suggested Match</button
              >{/if}
          </div>{/if}
        <div class="section-heading">
          <div>
            <h3>Compatible Statement Lines</h3>
            <p>
              {movesIn ? "Credit" : "Debit"} transactions on
              {selectedMovement.accountName ?? "this account"}
            </p>
          </div>
          <span>{availableLines.length}</span>
        </div>
        <div class="line-list">
          {#each availableLines as line (line.id)}{@const draft = drafts.find(
              (item) => item.lineId === line.id,
            )}{@const savedHere =
              savedAllocations.find(
                (allocation) => allocation.lineId === line.id,
              )?.amount ?? 0}
            <div class="allocation-line" class:selected={!!draft}>
              <label class="line-select"
                ><input
                  type="checkbox"
                  checked={!!draft}
                  onchange={() => toggleLine(line)}
                /><span class="fake-check"
                  >{#if draft}<Check size={12} />{/if}</span
                ><span class="line-copy"
                  ><strong title={line.description}
                    >{line.description || "Statement transaction"}</strong
                  ><small
                    ><span title={line.statementFilename}
                      >{line.statementFilename}</span
                    >
                    · {formatDate(line.date)}</small
                  ></span
                ></label
              >
              <div class="line-money">
                <small
                  >{formatMoney(line.remainingAmount + savedHere)} available</small
                >{#if draft}<label
                    ><span>{mainCurrencySymbol()}</span><input
                      name={`allocation-${line.id}`}
                      aria-label={`Allocation amount for ${line.description || "statement transaction"}`}
                      type="number"
                      inputmode="decimal"
                      min="0.01"
                      step="0.01"
                      max={line.remainingAmount + savedHere}
                      value={draft.amount}
                      onchange={(event) =>
                        updateDraft(line.id, event.currentTarget.value)}
                    /></label
                  >{:else}<strong>{formatMoney(line.amount)}</strong>{/if}
              </div>
            </div>{/each}{#if availableLines.length === 0}<EmptyState
              title="No compatible transactions"
              sub={`Upload a statement for ${selectedMovement.accountName ?? "this account"} containing ${movesIn ? "credit" : "debit"} transactions with an available balance.`}
              >{#snippet icon()}<Banknote size={20} />{/snippet}</EmptyState
            >{/if}
        </div>
      </div>
      <footer class="composer-foot">
        <div>
          <span>Staged total</span><strong>{formatMoney(draftTotal)}</strong
          ><small class:error={draftRemaining < -CENT}
            >{draftRemaining < -CENT
              ? `${formatMoney(Math.abs(draftRemaining))} over record total`
              : `${formatMoney(draftRemaining)} remaining`}</small
          >
        </div>
        <div class="composer-actions">
          <button
            class="sheet-btn"
            type="button"
            disabled={!manuallyEdited || saving}
            onclick={() => (drafts = [...initialDrafts])}>Reset</button
          ><button
            class="sheet-btn-primary"
            type="button"
            disabled={!data.permissions.match ||
              saving ||
              !dirty ||
              draftRemaining < -CENT}
            onclick={saveAndAdvance}
            >{saving
              ? "Saving…"
              : visibleMovements.some(
                    (movement) =>
                      movement.movementId !== selectedMovementId &&
                      Math.abs(movement.remainingAmount ?? 0) >= CENT,
                  )
                ? "Save & Next"
                : "Save"}</button
          >
        </div>
      </footer>
    </section>{/if}
{/snippet}
<Sheet.Root
  open={!!transferLine}
  onOpenChange={(open) => {
    if (!open) closeTransfer();
  }}
  ><Sheet.Content
    side={panelSide}
    class="recon-sheet"
    style="gap:0; width:500px; max-width:95vw; height:100dvh; border-radius:0;"
    ><div class="sheet-head">
      <div>
        <span class="sheet-eyebrow"><ArrowLeftRight size={13} />Transfer</span>
        <h2 class="sheet-title-text">Record as a transfer</h2>
      </div>
      <Sheet.Close class="sheet-close" aria-label="Close transfer"
        ><X size={16} /></Sheet.Close
      >
    </div>
    {#if transferLine}<div class="upload-body">
        <div class="detail-amount">
          <span class="detail-amount-val"
            >{formatMoney(transferLine.amount)}</span
          >
        </div>
        <p class="transfer-explain">
          This line moves funds between two of your own accounts, so it is
          neither revenue nor an expense and no record exists for it yet. Saving
          this creates that record and matches this transaction to it.
        </p>
        <div class="field">
          <span class="field-label"
            >{transferLine.direction === StatementDirection.In
              ? "From account"
              : "To account"}</span
          >
          <Select.Root
            type="single"
            value={transferAccountId != null ? String(transferAccountId) : ""}
            onValueChange={(next) =>
              (transferAccountId = next ? Number(next) : null)}
            ><Select.Trigger
              aria-label="The other account in this transfer"
              class="w-full justify-between"
              disabled={transferTargets.length === 0}
              >{transferTargets.length === 0
                ? "No other account to choose from"
                : (transferTargets.find(
                    (account) => account.id === transferAccountId,
                  )?.name ?? "Choose an account")}</Select.Trigger
            ><Select.Content
              >{#each transferTargets as account (account.id)}<Select.Item
                  value={String(account.id)}
                  label={account.name}
                ></Select.Item>{/each}</Select.Content
            ></Select.Root
          >
        </div>
        <div class="field">
          <span class="field-label">Description</span>
          <input
            name="transfer-description"
            autocomplete="off"
            bind:value={transferDescription}
            placeholder="Transfer"
          />
        </div>
        <div class="field">
          <span class="field-label">Date</span>
          <span class="field-static">{formatDate(transferLine.date)}</span>
          <small class="field-hint"
            >Taken from the bank transaction, so the two always agree.</small
          >
        </div>
      </div>
      <div class="sheet-foot">
        <div class="sheet-foot-actions">
          <Sheet.Close class="sheet-btn">Cancel</Sheet.Close><button
            class="sheet-btn-primary"
            type="button"
            disabled={!transferAccountId || transferSaving}
            onclick={saveTransfer}
            >{transferSaving ? "Saving…" : "Save & Match"}</button
          >
        </div>
      </div>{/if}</Sheet.Content
  ></Sheet.Root
>

<ConfirmDialog
  bind:open={discardOpen}
  title="Discard Allocation Changes?"
  description="Your staged allocation changes have not been saved. Discard them and continue?"
  confirmLabel="Discard Changes"
  danger
  onConfirm={confirmDiscard}
/>
<ConfirmDialog
  bind:open={deleteLineOpen}
  title="Delete Statement Transaction?"
  description="This removes the transaction and its allocations. Affected Akaun records can become unreconciled again."
  confirmLabel="Delete Transaction"
  danger
  onConfirm={deleteLine}
/>
<ConfirmDialog
  bind:open={bulkOpen}
  title="Save Exact Matches?"
  description={`Allocate the suggested statement transactions for ${bulkMatchable.length} record${bulkMatchable.length === 1 ? "" : "s"}. Records that still need review are left untouched.`}
  confirmLabel="Save Matches"
  onConfirm={runAutoMatch}
/>

<style>
  .reconciliation-screen > .topbar {
    flex: none;
    padding-bottom: 12px;
  }
  .statement-overview {
    flex: none;
    min-width: 0;
    margin-bottom: 16px;
  }
  .statement-heading {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
  }
  .statement-heading h1 {
    min-width: 0;
    overflow-wrap: anywhere;
    font-size: 20px;
  }
  .statement-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 18px;
    margin: 6px 0 12px;
    color: var(--muted-foreground);
    font-size: 12.5px;
    overflow-wrap: anywhere;
  }
  .statement-progress {
    display: flex;
    flex-wrap: wrap;
    gap: 10px 32px;
  }
  .statement-progress > div {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .statement-progress strong {
    font-size: 16px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .statement-details {
    margin-top: 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--card);
  }
  .statement-details summary {
    cursor: pointer;
    padding: 9px 12px;
    font-size: 12.5px;
    font-weight: 500;
  }
  .statement-details-body {
    padding: 0 12px 12px;
    max-height: 240px;
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .statement-information {
    display: grid;
    gap: 8px;
    margin: 0 0 12px;
    font-size: 12.5px;
  }
  .statement-information > div {
    display: grid;
    grid-template-columns: 90px minmax(0, 1fr);
    gap: 12px;
    align-items: center;
  }
  .statement-information dt,
  .muted {
    color: var(--muted-foreground);
  }
  .statement-information dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .statement-move-controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .statement-move-controls :global(.statement-account-select) {
    min-width: 0;
    width: min(100%, 360px);
  }
  .statement-danger {
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid var(--border);
  }
  .statement-danger button {
    color: var(--red);
  }
  .extraction-notice,
  .extraction-error {
    margin: 12px 0 0;
    padding: 10px 12px;
    border-radius: 8px;
    font-size: 12.5px;
    line-height: 1.5;
  }
  .extraction-notice {
    color: var(--primary);
    background: var(--primary-soft);
  }
  .extraction-error {
    color: var(--red);
    background: var(--red-soft);
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
  }
  .extraction-error p {
    margin: 0;
    flex: 1 1 200px;
  }
  .matching-heading {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .matching-heading h2 {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
  }
  .matching-heading > span {
    color: var(--muted-foreground);
    font-size: 12px;
  }
  .matching-toolbar > .recon-search {
    margin-left: auto;
  }
  .statement-overview button,
  .statement-move-controls button {
    white-space: nowrap;
  }
  .statement-overview button:focus-visible,
  summary:focus-visible,
  .source-link:focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: 2px;
  }
  .source-link:hover {
    border-color: var(--primary);
    background: var(--accent);
  }
  @media (max-width: 767px) {
    .matching-toolbar > .recon-search {
      display: block;
      width: 100%;
      order: 3;
    }
    .statement-heading h1 {
      font-size: 18px;
    }
    .statement-progress {
      gap: 12px 20px;
    }
    .statement-information > div {
      grid-template-columns: 70px minmax(0, 1fr);
    }
  }

  /* The bank's own lines, now a panel on the page rather than a drawer. */
  .statement-lines-panel {
    margin-top: 14px;
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 14px;
    background: var(--card);
  }
  .statement-lines-panel > .detail-section-label {
    margin-top: 0;
  }
  .statement-line-copy .statement-line-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 3px 8px;
    white-space: normal;
    overflow: visible;
  }
  .statement-line-status {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-weight: 600;
  }
  .statement-line-status.reconciled {
    color: var(--green);
  }
  .statement-line-status.partial {
    color: var(--amber);
  }
  .statement-line-status.overallocated {
    color: var(--red);
  }
  .reconciliation-screen {
    min-width: 0;
  }
  .bulk-match-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 32px;
    padding: 0 10px;
    border: 1px solid var(--primary);
    border-radius: 8px;
    background: var(--accent);
    color: var(--primary);
    font: inherit;
    font-size: 13px;
    font-weight: 500;
    white-space: nowrap;
    cursor: pointer;
  }
  .bulk-match-btn:hover:not(:disabled) {
    background: var(--primary);
    color: var(--primary-foreground);
  }
  .bulk-match-btn:disabled {
    opacity: 0.55;
    cursor: default;
  }
  .recon-search {
    position: relative;
    display: flex;
    align-items: center;
  }
  .recon-search input {
    width: 100%;
    height: 34px;
    padding: 0 10px 0 32px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--card);
    color: var(--foreground);
    font: inherit;
    font-size: 13px;
  }
  .recon-search > div {
    width: 100%;
  }
  .recon-search input:focus-visible,
  input:focus-visible,
  button:focus-visible {
    outline: 2px solid var(--primary);
    outline-offset: 2px;
  }
  .sheet-btn-primary:hover {
    filter: brightness(0.96);
  }
  .recon-work {
    padding-top: 12px;
  }
  .filter-daterange {
    padding: 12px 14px;
    min-width: 200px;
  }
  .filter-daterange-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 10px;
  }
  .filter-daterange-head > span:first-child {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted-foreground);
  }
  .filter-daterange-head button,
  .filter-mobile-clear {
    border: 0;
    background: none;
    color: var(--primary);
    cursor: pointer;
    font: inherit;
    font-size: 11px;
    font-weight: 600;
    padding: 0;
  }
  .filter-daterange .mini-label {
    display: block;
    margin: 8px 0 4px;
  }
  .filter-daterange .mini-label:first-of-type {
    margin-top: 0;
  }
  .filter-mobile-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted-foreground);
    margin-bottom: 10px;
  }
  .split-workspace {
    min-height: 0;
    flex: 1;
    display: grid;
    grid-template-columns: minmax(480px, 1.15fr) minmax(390px, 0.85fr);
    gap: 14px;
  }
  .record-pane {
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .desktop-composer {
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--card);
    box-shadow: var(--shadow-sm);
  }
  .num,
  .amount-num,
  .line-total,
  .amount-strip strong,
  .composer-foot strong,
  .remaining {
    color: var(--amber);
    font-variant-numeric: tabular-nums;
  }
  .type-chip {
    display: inline-flex;
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--secondary);
    color: var(--secondary-foreground);
    font-size: 11.5px;
    font-weight: 500;
  }
  .td-chevron {
    color: var(--muted-foreground);
  }
  .exp-row:focus-visible {
    outline: 2px solid var(--primary);
    outline-offset: -2px;
  }
  .composer {
    height: 100%;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--card);
  }
  .composer-head,
  .sheet-head {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 18px 20px 15px;
    border-bottom: 1px solid var(--border);
  }
  .composer-title {
    min-width: 0;
    flex: 1;
  }
  .composer-title > span,
  .sheet-eyebrow {
    display: flex;
    align-items: center;
    gap: 5px;
    margin-bottom: 3px;
    color: var(--muted-foreground);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.07em;
    text-transform: uppercase;
  }
  .composer-title h2,
  .sheet-title-text {
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 16px;
    font-weight: 650;
  }
  .composer-title p {
    margin: 3px 0 0;
    color: var(--muted-foreground);
    font-size: 12px;
  }
  .type-icon,
  .direction-icon {
    display: grid;
    place-items: center;
    flex: 0 0 auto;
    color: var(--red);
    background: var(--red-soft);
  }
  .type-icon {
    width: 36px;
    height: 36px;
    border-radius: 9px;
  }
  .type-icon.income,
  .direction-icon.money-in {
    color: var(--green);
    background: var(--green-soft);
  }
  .icon-btn,
  :global(.sheet-close) {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    border: 1px solid var(--border);
    border-radius: 7px;
    background: var(--card);
    color: var(--muted-foreground);
    cursor: pointer;
  }
  .amount-strip {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    border-bottom: 1px solid var(--border);
    background: var(--muted);
  }
  .amount-strip div {
    padding: 12px 16px;
    border-right: 1px solid var(--border);
  }
  .amount-strip div:last-child {
    border: 0;
  }
  .amount-strip span,
  .composer-foot span {
    display: block;
    color: var(--muted-foreground);
    font-size: 10px;
    font-weight: 650;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .amount-strip strong {
    display: block;
    margin-top: 3px;
    font-size: 15px;
  }
  .amount-strip .balanced strong {
    color: var(--green);
  }
  .amount-strip .error strong,
  .error {
    color: var(--red) !important;
  }
  .composer-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 16px 20px;
  }
  .suggestion {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 16px;
    padding: 12px;
    border: 1px solid color-mix(in srgb, var(--green) 35%, var(--border));
    border-radius: 9px;
    background: var(--green-soft);
  }
  .suggestion div {
    min-width: 0;
  }
  .suggestion strong,
  .suggestion span {
    display: block;
  }
  .suggestion span {
    margin-top: 2px;
    color: var(--muted-foreground);
    font-size: 11.5px;
  }
  .suggestion button {
    flex: none;
    padding: 7px 9px;
    border: 1px solid var(--green);
    border-radius: 7px;
    background: var(--card);
    color: var(--green);
    font: inherit;
    font-size: 11px;
    font-weight: 650;
    cursor: pointer;
  }
  .section-heading {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 9px;
  }
  .section-heading h3 {
    margin: 0;
    font-size: 13px;
  }
  .section-heading p {
    margin: 2px 0 0;
    color: var(--muted-foreground);
    font-size: 11px;
  }
  .section-heading > span {
    display: grid;
    place-items: center;
    width: 23px;
    height: 23px;
    border-radius: 50%;
    background: var(--muted);
    color: var(--muted-foreground);
    font-size: 11px;
  }
  .line-list,
  .statement-lines {
    border: 1px solid var(--border);
    border-radius: 9px;
    overflow: hidden;
  }
  .allocation-line {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 11px 12px;
    border-bottom: 1px solid var(--border);
  }
  .allocation-line:last-child {
    border-bottom: 0;
  }
  .allocation-line:hover {
    background: var(--accent);
  }
  .allocation-line.selected {
    background: var(--primary-soft);
  }
  .line-select {
    min-width: 0;
    flex: 1;
    display: flex;
    align-items: center;
    gap: 9px;
    cursor: pointer;
  }
  /* Visually hidden but still focusable and label-activatable. Deliberately
     kept IN FLOW at zero size rather than `position: absolute`: an
     out-of-flow box resolves against its nearest positioned ancestor, and
     with none in this tree it escaped `.composer-body`'s scrollport
     entirely. Focusing a row near the bottom of a long list then made the
     browser scroll an outer shell by thousands of px to "reveal" it, taking
     the whole page out of view. In flow, the input sits inside the
     scrollport, so focus scrolls the list — which is what we want.
     The focus ring is drawn on `.fake-check` via `:focus-within`, so the
     input itself needs no size of its own. */
  .line-select > input {
    width: 0;
    height: 0;
    margin: 0;
    appearance: none;
    opacity: 0;
    pointer-events: none;
  }
  .fake-check {
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    flex: none;
    border: 1.5px solid var(--border-strong);
    border-radius: 5px;
    background: var(--card);
    color: var(--primary-foreground);
  }
  .selected .fake-check {
    border-color: var(--primary);
    background: var(--primary);
  }
  .line-select:focus-within .fake-check {
    outline: 2px solid var(--primary);
    outline-offset: 2px;
  }
  .line-copy,
  .statement-line-copy {
    min-width: 0;
    flex: 1;
  }
  .line-copy strong,
  .line-copy small,
  .statement-line-copy strong,
  .statement-line-copy small {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .line-copy strong,
  .statement-line-copy strong {
    font-size: 12px;
  }
  .line-copy small,
  .statement-line-copy small,
  .line-money small {
    color: var(--muted-foreground);
    font-size: 10.5px;
  }
  .line-money {
    flex: none;
    text-align: right;
  }
  .line-money > strong {
    display: block;
    margin-top: 2px;
    font-size: 12px;
  }
  .line-money label {
    display: flex;
    align-items: center;
    gap: 3px;
    margin-top: 3px;
    padding: 2px 5px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--card);
    font-size: 11px;
  }
  .line-money input {
    width: 72px;
    border: 0;
    outline: 0;
    background: transparent;
    color: var(--foreground);
    text-align: right;
    font: inherit;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  .composer-foot {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 13px 18px;
    border-top: 1px solid var(--border);
    background: var(--card);
  }
  .composer-foot strong {
    display: inline-block;
    margin: 2px 8px 0 0;
    font-size: 15px;
  }
  .composer-foot small {
    color: var(--muted-foreground);
    font-size: 10.5px;
  }
  .composer-actions {
    display: flex;
    gap: 7px;
  }
  .sheet-btn,
  .sheet-btn-primary {
    min-height: 34px;
    padding: 0 12px;
    border-radius: 8px;
    font: inherit;
    font-size: 12.5px;
    font-weight: 550;
    cursor: pointer;
  }
  .sheet-btn {
    border: 1px solid var(--border);
    background: var(--card);
    color: var(--foreground);
  }
  .sheet-btn-primary {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    border: 0;
    background: var(--primary);
    color: var(--primary-foreground);
  }
  .sheet-btn:disabled,
  .sheet-btn-primary:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  :global(.recon-sheet) {
    overflow: hidden;
  }
  .sheet-head {
    justify-content: space-between;
    padding: 22px 22px 16px;
  }
  .sheet-head > div {
    min-width: 0;
  }
  .detail-section-label {
    margin: 18px 0 8px;
    color: var(--muted-foreground);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .source-link {
    display: inline-flex;
    align-items: center;
    gap: 9px;
    padding: 10px 11px;
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--foreground);
    text-decoration: none;
  }
  .statement-line {
    border-bottom: 1px solid var(--border);
  }
  .statement-line:last-child {
    border: 0;
  }
  .statement-line-summary {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 10px;
    border: 0;
    background: var(--card);
    color: var(--foreground);
    text-align: left;
    cursor: pointer;
  }
  .direction-icon {
    width: 28px;
    height: 28px;
    border-radius: 7px;
  }
  .line-total {
    flex: none;
    font-size: 12px;
    font-weight: 650;
  }
  .line-chevron {
    display: flex;
    color: var(--muted-foreground);
    transition: transform 0.15s;
  }
  .line-chevron.rotated {
    transform: rotate(90deg);
  }
  .line-edit {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
    padding: 12px;
    border-top: 1px solid var(--border);
    background: var(--muted);
  }
  .line-edit label {
    display: grid;
    gap: 4px;
    color: var(--muted-foreground);
    font-size: 10.5px;
    font-weight: 600;
  }
  .line-edit label.wide {
    grid-column: 1/-1;
  }
  .line-edit input {
    width: 100%;
    min-width: 0;
    height: 32px;
    padding: 0 8px;
    border: 1px solid var(--border);
    border-radius: 7px;
    background: var(--card);
    color: var(--foreground);
    font: inherit;
    font-size: 12px;
  }
  .line-delete,
  .line-transfer {
    grid-column: 1/-1;
    justify-self: start;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--red);
    font: inherit;
    font-size: 11.5px;
    text-align: left;
    cursor: pointer;
  }
  .line-transfer {
    color: var(--primary);
  }
  /* Which account a statement belongs to decides what can match it, so it sits
     at the top of the sheet rather than among the counts. */
  .upload-body {
    flex: 1;
    overflow-y: auto;
    padding: 20px 22px;
  }
  .upload-body input {
    width: 100%;
    height: 34px;
    padding: 0 9px;
    border: 1px solid var(--input);
    border-radius: 8px;
    background: var(--card);
    color: var(--foreground);
    font: inherit;
    font-size: 13px;
  }
  .field-static {
    display: block;
    font-size: 13px;
    color: var(--muted-foreground);
  }
  .transfer-explain {
    margin: 0 0 18px;
    font-size: 12.5px;
    color: var(--muted-foreground);
    line-height: 1.6;
  }

  @media (max-width: 1000px) {
    .split-workspace {
      grid-template-columns: 1fr;
    }
    .desktop-composer {
      display: none;
    }
  }
  @media (min-width: 1001px) {
    .reconciliation-screen {
      height: 100%;
      min-height: 0;
      contain: size layout paint;
    }
    .reconciliation-screen > :global(.work),
    .recon-work,
    .split-workspace,
    .record-pane {
      min-height: 0;
      overflow: hidden;
    }
    .recon-work {
      padding-bottom: 20px;
      overflow-y: auto;
    }
    .split-workspace {
      flex-shrink: 0;
      min-height: 360px;
    }
    .statement-lines-panel {
      flex-shrink: 0;
    }
    .record-pane {
      display: flex;
      flex-direction: column;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--card);
      box-shadow: var(--shadow-sm);
    }
    .record-pane .table-card {
      flex: 1;
      min-height: 0;
      overflow: auto;
      overscroll-behavior: contain;
      border: 0;
      border-radius: 0;
      box-shadow: none;
      background: transparent;
    }
    .record-pane .table-foot {
      flex: none;
      margin: 0;
      padding: 12px 18px;
      border-top: 1px solid var(--border);
      background: var(--card);
    }
  }
  @media (max-width: 767px) {
    .recon-work {
      padding-top: 10px;
    }
    .recon-search {
      display: none;
    }
    .record-pane .table-card {
      overflow: visible;
    }
    :global(.recon-sheet) {
      width: 100vw !important;
      max-width: 100vw !important;
    }
    .composer-head {
      padding-top: calc(18px + env(safe-area-inset-top));
    }
    .composer-foot,
    :global(.recon-sheet .sheet-foot) {
      padding-bottom: calc(13px + env(safe-area-inset-bottom));
    }
    .amount-strip div {
      padding: 10px 12px;
    }
    .allocation-line {
      align-items: flex-start;
    }
    .line-money {
      padding-top: 2px;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .line-chevron {
      transition: none;
    }
  }
</style>
