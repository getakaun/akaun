<script lang="ts">
  import { goto, invalidateAll } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { Download, Printer, ChevronRight } from "@lucide/svelte";
  import DetailPage from "$lib/components/ui/DetailPage.svelte";
  import AuditTrail from "$lib/components/ui/AuditTrail.svelte";
  import ConfirmDialog from "$lib/components/ui/ConfirmDialog.svelte";
  import StatusBadge from "$lib/components/ui/StatusBadge.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { formatDate } from "$lib/format.js";
  import { createResourceStream } from "$lib/sse.js";
  import {
    TAX_PREPARATION_NOTE,
    formatTaxMinor,
    taxManualLabels,
  } from "$lib/tax-worksheet.js";
  import TaxWorksheetSheet from "./TaxWorksheetSheet.svelte";
  import type { loadTaxWorksheet } from "$lib/server/loaders/tax-worksheets.js";
  import type { TaxWorksheetDetail as Detail } from "$lib/server/queries/tax-worksheets.js";
  import { toast } from "svelte-sonner";
  import ReportNotes from "$lib/components/reports/ReportNotes.svelte";
  import ListExpand, {
    visibleItems,
  } from "$lib/components/ui/ListExpand.svelte";
  import { formatAuditTime } from "$lib/components/audit/audit-format.js";
  import CapitalAllowances from "./CapitalAllowances.svelte";
  import TaxExpenses from "./TaxExpenses.svelte";
  import TaxAdjustments from "./TaxAdjustments.svelte";
  import "./tax-worksheets.css";
  let { data }: { data: ReturnType<typeof loadTaxWorksheet> } = $props();
  const d = $derived(data.detail);
  const r = $derived(d.revision);
  const t = $derived(d.totals);
  const money = (minor: number) => formatTaxMinor(minor, r.snapshot.currency);
  const editable = $derived(
    d.isLatest && r.status !== "finalised" && data.canUpdate,
  );
  let mode = $state<
    "source" | "manual" | "refresh" | "amend" | "withdraw" | null
  >(null);
  let line = $state<Detail["totals"]["lines"][number] | null>(null);
  let adjustmentId = $state<number | null>(null);
  let saving = $state(false);
  let error = $state("");
  let revisionsExpanded = $state(false);
  let confirm = $state<"review" | "finalise" | "resume" | null>(null);
  let confirmOpen = $state(false);
  let confirmedVersion = 0;
  let auditRef = $state<{ refresh: () => Promise<void> } | null>(null);
  createResourceStream("/api/tax/stream", () => {
    void invalidateAll();
    void auditRef?.refresh();
  });
  function ask(action: "review" | "finalise" | "resume") {
    confirmedVersion = r.version;
    confirm = action;
    confirmOpen = true;
  }
  async function command(action: string) {
    saving = true;
    error = "";
    try {
      const response = await fetch(`/api/tax/${d.worksheet.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, expectedVersion: confirmedVersion }),
      });
      const result = await response.json();
      if (!response.ok) {
        error = result.error ?? "This action could not be completed.";
        return;
      }
      await invalidateAll();
      await auditRef?.refresh();
      toast.success(
        action === "finalise"
          ? "Revision finalised."
          : action === "review"
            ? "Worksheet marked reviewed."
            : "Worksheet returned to draft.",
      );
    } catch {
      error =
        "The result could not be confirmed. Refresh the worksheet before retrying.";
    } finally {
      saving = false;
    }
  }
  function correct(source: (typeof t.lines)[number]) {
    line = source;
    mode = "source";
  }
  async function saved(result: Detail) {
    error = "";
    if (result.revision.revision !== r.revision)
      await goto(resolve("/(app)/tax/[id]", { id: String(d.worksheet.id) }));
    await invalidateAll();
    await auditRef?.refresh();
    toast.success("Annual tax worksheet saved.");
  }
</script>

<DetailPage backHref={resolve("/(app)/tax")} backLabel="Annual tax">
  {#snippet actions()}
    <Button
      variant="outline"
      size="sm"
      href={resolve(
        `/api/tax/${d.worksheet.id}?revision=${r.revision}&format=csv`,
      )}
      download><Download size={14} />Export CSV</Button
    >
    <Button
      variant="outline"
      size="sm"
      href={resolve(
        `/api/tax/${d.worksheet.id}?revision=${r.revision}&format=html`,
      )}
      target="_blank"
      rel="noopener noreferrer"><Printer size={14} />Print / PDF</Button
    >
  {/snippet}
  {#snippet hero()}
    <div class="detail-hero-eyebrow">
      Annual tax · Revision {r.revision} · {r.snapshot.currency}
    </div>
    <h1 class="detail-hero-title">Tax year {d.worksheet.ya}</h1>
    <div class="detail-hero-figure">
      <span class="detail-hero-amount">{money(t.resultMinor)}</span><StatusBadge
        status={`tax-${r.status}`}
      />
    </div>
    <p class="detail-hero-note">
      Preparatory tax result · {formatDate(d.worksheet.dateFrom)} to {formatDate(
        d.worksheet.dateTo,
      )}
    </p>
  {/snippet}
  {#snippet main()}
    {#if error}<div role="alert">
        <ReportNotes notes={[error]} firstIsWarning />
      </div>{/if}
    {#if d.stale}
      <section class="detail-card" aria-labelledby="tax-changes-title">
        <div class="detail-card-head">
          <h2 id="tax-changes-title" class="detail-card-title">
            Accounting records changed
          </h2>
        </div>
        <div class="tax-stack">
          <ReportNotes
            notes={[
              r.status === "finalised"
                ? "This revision keeps its finalised figures. Create an amendment to include later accounting changes."
                : "Review the changes below before refreshing. Refreshing returns the worksheet to draft.",
            ]}
            firstIsWarning
          />
          {#if d.profitChanged}<dl class="detail-list tax-summary">
              <div class="detail-row">
                <dt class="detail-key">Saved accounting profit</dt>
                <dd class="detail-val tax-amount">
                  {money(r.snapshot.profitMinor)}
                </dd>
              </div>
              <div class="detail-row">
                <dt class="detail-key">Current accounting profit</dt>
                <dd class="detail-val tax-amount">
                  {money(d.liveProfitMinor)}
                </dd>
              </div>
            </dl>{/if}
          {#if d.changes.length}<details class="tax-disclosure">
              <summary>Changed expense lines ({d.changes.length})</summary>
              <div class="tax-disclosure-body">
                <ul class="tax-support-list">
                  {#each d.changes as change (change.movementId)}<li>
                      <span class="tax-item-title"
                        >{change.after?.label ??
                          change.after?.description ??
                          change.before?.label ??
                          change.before?.description}</span
                      >
                      <p class="field-hint">
                        {change.after?.recordNumber ??
                          change.before?.recordNumber ??
                          `Record ${change.after?.recordId ?? change.before?.recordId}`}
                      </p>
                      <p class="hint">
                        {change.before
                          ? money(change.before.expenseMinor)
                          : "New expense"} → {change.after
                          ? money(change.after.expenseMinor)
                          : "Removed"}{change.before &&
                        change.after &&
                        change.before.expenseMinor === change.after.expenseMinor
                          ? " · Classification or source details changed"
                          : ""}
                      </p>
                    </li>{/each}
                </ul>
              </div>
            </details>{/if}
          {#if editable}<div class="tax-actions">
              <Button
                variant="outline"
                size="sm"
                disabled={saving}
                onclick={() => (mode = "refresh")}>Review and refresh</Button
              >
            </div>{/if}
        </div>
      </section>
    {/if}
    <section class="detail-card" aria-labelledby="tax-summary-title">
      <div class="detail-card-head">
        <h2 id="tax-summary-title" class="detail-card-title">Tax summary</h2>
      </div>
      <div class="tax-stack">
        <dl class="detail-list tax-summary">
          <div class="detail-row">
            <dt class="detail-key">Accounting profit</dt>
            <dd class="detail-val tax-amount">
              {money(r.snapshot.profitMinor)}
            </dd>
          </div>
          <div class="detail-row">
            <dt class="detail-key">Expense add-backs</dt>
            <dd class="detail-val tax-amount">{money(t.addBackMinor)}</dd>
          </div>
          {#each d.adjustments.filter((a) => a.kind !== "source" && a.withdrawnAt === null) as a (a.id)}<div
              class="detail-row"
            >
              <dt class="detail-key">
                {a.kind === "source" ? "" : taxManualLabels[a.kind]}{a.originYa
                  ? ` · YA ${a.originYa}`
                  : ""}
              </dt>
              <dd class="detail-val tax-amount">
                {money(
                  a.direction === "increase" ? a.amountMinor : -a.amountMinor,
                )}
              </dd>
            </div>{/each}
          {#if d.capital.active}<div class="detail-row">
              <dt class="detail-key">Asset allowance schedule</dt>
              <dd class="detail-val tax-amount">{money(t.capitalMinor)}</dd>
            </div>{/if}
          <div class="detail-row tax-result">
            <dt class="detail-key">Preparatory tax result</dt>
            <dd class="detail-val tax-amount">{money(t.resultMinor)}</dd>
          </div>
        </dl>
        <details class="tax-disclosure">
          <summary>Add-back breakdown</summary>
          <div class="tax-disclosure-body">
            <dl class="detail-list tax-summary">
              <div class="detail-row">
                <dt class="detail-key">Saved classification estimates</dt>
                <dd class="detail-val tax-amount">
                  {money(t.baseAddBackMinor)}
                </dd>
              </div>
              <div class="detail-row">
                <dt class="detail-key">Annual treatment corrections</dt>
                <dd class="detail-val tax-amount">
                  {money(t.correctionMinor)}
                </dd>
              </div>
              <div class="detail-row">
                <dt class="detail-key">Effective expense add-backs</dt>
                <dd class="detail-val tax-amount">{money(t.addBackMinor)}</dd>
              </div>
            </dl>
          </div>
        </details>
        {#if t.unresolvedCount}<ReportNotes
            notes={[
              `${t.unresolvedCount} expense line(s), net ${money(t.unresolvedMinor)}, need annual classification. They are excluded from add-back estimates. Resolve them before reviewing or finalising.`,
            ]}
            firstIsWarning
          />{/if}
      </div>
    </section>
    <TaxExpenses
      lines={t.lines}
      currency={r.snapshot.currency}
      canChange={editable}
      canReadRecords={data.canReadRecords}
      disabled={saving || d.stale}
      onchange={correct}
    />
    <CapitalAllowances
      detail={d}
      {editable}
      canReadAssets={data.canReadAssets}
      onsaved={saved}
    />
    <TaxAdjustments
      adjustments={d.adjustments}
      lines={t.lines}
      currency={r.snapshot.currency}
      canChange={editable}
      disabled={saving}
      onadd={() => (mode = "manual")}
      onwithdraw={(id) => {
        adjustmentId = id;
        mode = "withdraw";
      }}
    />
    <ReportNotes notes={[TAX_PREPARATION_NOTE, ...r.snapshot.notes]} />
  {/snippet}
  {#snippet rail()}
    <section class="detail-card" aria-labelledby="tax-review-title">
      <div class="detail-card-head">
        <h2 id="tax-review-title" class="detail-card-title">
          Review and finalise
        </h2>
      </div>
      <div class="tax-stack">
        <p class="hint">
          {r.status === "draft"
            ? "Check expense classifications and manual claims, then mark the worksheet reviewed."
            : r.status === "reviewed"
              ? "Review is recorded. Finalise to lock this revision."
              : "This revision is locked. Create an amendment for further changes."}
        </p>
        {#if d.isLatest}
          <div class="tax-actions">
            {#if r.status === "draft" && data.canReview}<Button
                size="sm"
                disabled={saving ||
                  d.stale ||
                  t.unresolvedCount > 0 ||
                  (d.capital.active &&
                    (d.capital.assetsStale ||
                      d.capital.predecessorStale ||
                      d.capital.currencyMismatch ||
                      !!d.capital.totals?.problems.length))}
                onclick={() => ask("review")}
                >{saving ? "Saving…" : "Mark reviewed"}</Button
              >{/if}
            {#if r.status === "reviewed" && data.canFinalise}<Button
                size="sm"
                disabled={saving ||
                  d.stale ||
                  t.unresolvedCount > 0 ||
                  (d.capital.active &&
                    (d.capital.assetsStale ||
                      d.capital.predecessorStale ||
                      d.capital.currencyMismatch ||
                      !!d.capital.totals?.problems.length))}
                onclick={() => ask("finalise")}
                >{saving ? "Saving…" : "Finalise worksheet"}</Button
              >{/if}
            {#if r.status === "reviewed" && data.canUpdate}<button
                type="button"
                class="detail-card-action"
                disabled={saving}
                onclick={() => ask("resume")}>Return to draft</button
              >{/if}
            {#if r.status === "finalised" && data.canAmend}<Button
                size="sm"
                variant="outline"
                disabled={saving}
                onclick={() => (mode = "amend")}>Create amendment</Button
              >{/if}
          </div>
          {#if d.stale && r.status !== "finalised"}<p class="field-hint">
              Refresh the changed accounting figures before continuing.
            </p>{:else if t.unresolvedCount && r.status !== "finalised"}<p
              class="field-hint"
            >
              {t.unresolvedCount} expense line(s) still need classification.
            </p>{/if}
        {:else}<div>
            <p class="hint">You are viewing a retained revision.</p>
            <a
              class="detail-card-action"
              href={resolve("/(app)/tax/[id]", { id: String(d.worksheet.id) })}
              >Open latest revision<ChevronRight size={13} /></a
            >
          </div>{/if}
        {#if d.capital.active && (d.capital.assetsStale || d.capital.predecessorStale || d.capital.currencyMismatch || d.capital.totals?.problems.length)}<p
            class="field-hint"
          >
            Complete the capital allowance review before continuing.
          </p>{/if}
        <dl class="detail-list tax-summary">
          <div class="detail-row">
            <dt class="detail-key">Captured</dt>
            <dd class="detail-val tax-date">{formatAuditTime(r.capturedAt)}</dd>
          </div>
          {#if r.reviewedAt}<div class="detail-row">
              <dt class="detail-key">Reviewed</dt>
              <dd class="detail-val tax-date">
                {formatAuditTime(r.reviewedAt)}
              </dd>
            </div>{/if}
          {#if r.finalisedAt}<div class="detail-row">
              <dt class="detail-key">Finalised</dt>
              <dd class="detail-val tax-date">
                {formatAuditTime(r.finalisedAt)}
              </dd>
            </div>{/if}
        </dl>
      </div>
    </section>
    <section class="detail-card" aria-labelledby="tax-revisions-title">
      <div class="detail-card-head">
        <h2 id="tax-revisions-title" class="detail-card-title">Revisions</h2>
      </div>
      <div class="tax-stack">
        {#each visibleItems(d.revisions, revisionsExpanded) as revision (revision.id)}
          {#snippet revisionLabel()}<span class="tax-revision-label"
              >Revision {revision.revision}{#if revision.amendmentReason}<span
                  class="field-hint">{revision.amendmentReason}</span
                >{/if}</span
            ><StatusBadge status={`tax-${revision.status}`} />{/snippet}
          {#if revision.id === r.id}<div
              class="tax-revision-link tax-revision-current"
              aria-current="page"
            >
              {@render revisionLabel()}
            </div>{:else}<a
              class="related-link tax-revision-link"
              href={resolve(
                `/tax/${d.worksheet.id}?revision=${revision.revision}`,
              )}>{@render revisionLabel()}<ChevronRight size={13} /></a
            >{/if}
        {/each}
        <ListExpand
          total={d.revisions.length}
          bind:expanded={revisionsExpanded}
        />
      </div>
    </section>
    <section class="detail-card">
      <div class="detail-card-head">
        <h2 class="detail-card-title">Activity</h2>
      </div>
      <AuditTrail
        bind:this={auditRef}
        recordType="tax_worksheet"
        recordId={d.worksheet.id}
      />
    </section>
  {/snippet}
</DetailPage>
{#if mode}<TaxWorksheetSheet
    {mode}
    detail={d}
    {line}
    {adjustmentId}
    onclose={() => (mode = null)}
    onsaved={saved}
  />{/if}
<ConfirmDialog
  bind:open={confirmOpen}
  title={confirm === "finalise"
    ? "Finalise this revision?"
    : confirm === "review"
      ? "Mark this worksheet reviewed?"
      : "Return to draft?"}
  description={confirm === "finalise"
    ? "The saved figures and adjustments will be locked. Later corrections require a separate amendment."
    : confirm === "review"
      ? "Confirm that classifications, manual claims and their supporting references have been reviewed. This does not submit a tax return."
      : "Reviewed status will be cleared so you can change annual tax preparation."}
  onConfirm={() => {
    const action = confirm;
    confirm = null;
    if (action) void command(action);
  }}
/>
