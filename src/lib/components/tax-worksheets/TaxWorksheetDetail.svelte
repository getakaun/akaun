<script lang="ts">
  import { untrack } from "svelte";
  import { goto, invalidateAll, beforeNavigate } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { Download, Printer, ChevronRight } from "@lucide/svelte";
  import Disclosure from "$lib/components/ui/Disclosure.svelte";
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
    taxAdjustmentLabels,
    taxAdjustmentSchema,
  } from "$lib/tax-worksheet.js";
  import TaxWorksheetSheet from "./TaxWorksheetSheet.svelte";
  import type { loadTaxWorksheet } from "$lib/server/loaders/tax-worksheets.js";
  import type { TaxWorksheetDetail as Detail } from "$lib/server/queries/tax-worksheets.js";
  import {
    draftTotals,
    stagedAdjustments,
    type StagedAdjustment,
    type WorksheetWithdrawal,
    type CapitalDraft,
    changedStagedSources,
  } from "./worksheet-draft.js";
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
  const d = $derived(data.detail),
    r = $derived(d.revision);
  let sourceHashes = $state<Record<string, string>>({});
  let additions = $state<StagedAdjustment[]>([]),
    withdrawals = $state<WorksheetWithdrawal[]>([]);
  let capitalDraft = $state<CapitalDraft | null>(null),
    capitalDirty = $state(false);
  let resetKey = $state(0),
    saving = $state(false),
    error = $state("");
  let baseVersion = $state(untrack(() => data.detail.revision.version));
  const dirty = $derived(
    !!additions.length || !!withdrawals.length || capitalDirty,
  );
  const conflict = $derived(dirty && r.version !== baseVersion);
  $effect(() => {
    if (!dirty && !saving) baseVersion = r.version;
  });
  const adjustments = $derived(
    r.status === "finalised"
      ? d.adjustments
      : stagedAdjustments(d, additions, withdrawals),
  );
  const t = $derived(
    r.status === "finalised"
      ? d.totals
      : draftTotals(d, additions, withdrawals, capitalDraft),
  );
  const money = (minor: number) => formatTaxMinor(minor, r.snapshot.currency);
  const editable = $derived(
    d.isLatest && r.status !== "finalised" && data.canUpdate,
  );
  let mode = $state<"source" | "adjustment" | "amend" | "withdraw" | null>(
    null,
  );
  let line = $state<Detail["totals"]["lines"][number] | null>(null),
    adjustmentId = $state<number | null>(null);
  let revisionsExpanded = $state(false),
    confirmOpen = $state(false);
  let completion = $state<"reviewed" | "finalised">("finalised"),
    confirmedPayload = $state("");
  let auditRef = $state<{ refresh: () => Promise<void> } | null>(null);
  createResourceStream("/api/tax/stream", () => {
    void invalidateAll();
    void auditRef?.refresh();
  });
  const outstanding = $derived.by(() => {
    const problems: string[] = [];
    if (
      !data.canReview &&
      data.canFinalise &&
      r.status !== "reviewed" &&
      d.savedRevision.status === "reviewed"
    )
      problems.push(
        "Figures changed after review. Save the current draft and have it reviewed again before finalising.",
      );
    if (conflict)
      problems.push(
        "This worksheet was saved elsewhere. Discard changes to load the latest version.",
      );
    if (
      !data.canUpdate &&
      (d.stale || d.capital.assetsStale || d.capital.predecessorStale)
    )
      problems.push(
        "Accounting evidence changed. A preparer must save the latest draft before review or finalisation.",
      );
    if (changedStagedSources(additions, sourceHashes, d.sourceHashes).length)
      problems.push(
        "An expense changed after its annual treatment was entered. Reopen that treatment to confirm the updated record.",
      );
    if (t.unresolvedCount)
      problems.push(
        `${t.unresolvedCount} expense classification(s) need attention.`,
      );
    for (const c of d.sourceConflicts ?? [])
      if (
        !withdrawals.some((w) => w.adjustmentId === c.adjustmentId) &&
        !additions.some(
          (a) => a.kind === "source" && a.sourceMovementId === c.movementId,
        )
      )
        problems.push(c.reason);
    problems.push(
      ...(capitalDraft?.errors ?? []),
      ...(capitalDraft?.problems ?? []),
    );
    if (d.capital.active && d.capital.currencyMismatch && !capitalDraft?.input)
      problems.push("The asset schedule currency differs from this worksheet.");
    if (
      d.capital.active &&
      d.capital.predecessorStale &&
      !d.capital.autoRollover
    )
      problems.push(
        "Earlier tax balances changed. Complete the prior-year amendment before finalising this worksheet.",
      );
    return [...new Set(problems)];
  });
  const inputErrors = $derived([
    ...(capitalDraft?.errors ?? []),
    ...(conflict ? ["This worksheet was saved elsewhere."] : []),
  ]);
  const canComplete = $derived(!saving && !outstanding.length);
  const finalisePeriodOpen = $derived(!d.periodEnded);
  function correct(source: (typeof t.lines)[number]) {
    line = source;
    mode = "source";
  }
  function stage(payload: Record<string, unknown>) {
    error = "";
    if (payload.action === "withdraw") {
      const id = Number(payload.adjustmentId);
      if (id < 0) additions.splice(-id - 1, 1);
      else
        withdrawals = [
          ...withdrawals.filter((w) => w.adjustmentId !== id),
          { adjustmentId: id, reason: String(payload.reason) },
        ];
    } else {
      const { sourceHash, ...input } = payload;
      const parsed = taxAdjustmentSchema.safeParse(input);
      if (!parsed.success) {
        error = parsed.error.issues[0]?.message ?? "Check the adjustment.";
        return;
      }
      const value = parsed.data;
      if (value.kind === "source") {
        sourceHashes[String(value.sourceMovementId)] = String(sourceHash ?? "");
        additions = additions.filter(
          (a) =>
            a.kind !== "source" ||
            a.sourceMovementId !== value.sourceMovementId,
        );
      }
      additions = [...additions, value];
    }
  }
  function discard() {
    additions = [];
    sourceHashes = {};
    withdrawals = [];
    capitalDraft = null;
    capitalDirty = false;
    baseVersion = r.version;
    resetKey++;
    error = "";
    uncertainSave = null;
  }
  let retryPayload = "",
    retryKey = "";
  type SaveTarget = "draft" | "reviewed" | "finalised";
  let uncertainSave = $state<{ body: string; target: SaveTarget } | null>(null);
  function makePayload(target: "draft" | "reviewed" | "finalised") {
    // Review and finalisation permissions do not imply edit permission.
    if (
      target !== "draft" &&
      (!data.canUpdate || (target === "finalised" && !data.canReview))
    )
      return {
        action: target === "reviewed" ? "review" : "finalise",
        expectedVersion: baseVersion,
      };
    return {
      action: "save-worksheet",
      target,
      expectedVersion: baseVersion,
      liveHash: d.liveHash,
      sourceHashes,
      adjustments: additions.map((a) => ({
        ...a,
        expectedVersion: baseVersion,
      })),
      withdrawals,
      ...(capitalDraft?.input
        ? {
            capital: {
              input: capitalDraft.input,
              liveAssetHash: capitalDraft.liveAssetHash,
              ...(capitalDraft.rolloverHash
                ? { rolloverHash: capitalDraft.rolloverHash }
                : {}),
              confirmFirstYearTreatments: true,
            },
          }
        : {}),
    };
  }
  function askCompletion(target: "reviewed" | "finalised") {
    completion = target;
    confirmedPayload = JSON.stringify(makePayload(target));
    confirmOpen = true;
  }
  async function save(
    target: "draft" | "reviewed" | "finalised",
    frozen?: string,
  ) {
    if (
      saving ||
      uncertainSave ||
      inputErrors.length ||
      (target !== "draft" &&
        (!canComplete || (target === "finalised" && finalisePeriodOpen)))
    )
      return;
    const payload = frozen ? JSON.parse(frozen) : makePayload(target);
    const encoded = JSON.stringify(payload);
    if (encoded !== retryPayload) {
      retryPayload = encoded;
      retryKey = crypto.randomUUID();
    }
    const body = JSON.stringify(
      payload.action === "save-worksheet"
        ? { ...payload, requestKey: retryKey }
        : payload,
    );
    await sendSave(body, target);
  }
  async function sendSave(body: string, target: SaveTarget) {
    if (saving) return;
    saving = true;
    error = "";
    try {
      const response = await fetch(`/api/tax/${d.worksheet.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      const result = await response.json();
      if (!response.ok) {
        uncertainSave = null;
        error =
          result.issues?.[0]?.message ??
          result.error ??
          "The worksheet could not be saved.";
        if (response.status === 409) await invalidateAll().catch(() => {});
        return;
      }
      await invalidateAll();
      discard();
      void auditRef?.refresh().catch(() => {});
      toast.success(
        target === "draft"
          ? "Worksheet draft saved."
          : target === "reviewed"
            ? "Worksheet saved and reviewed."
            : "Worksheet finalised.",
      );
    } catch {
      if (JSON.parse(body).action === "save-worksheet") {
        uncertainSave = { body, target };
        error =
          "The result could not be confirmed. Retry the last save to check its result before making further changes.";
      } else
        error =
          "The result could not be confirmed. Reload the worksheet to check its latest status.";
    } finally {
      saving = false;
    }
  }
  async function saved(result: Detail) {
    if (result.revision.revision !== r.revision)
      await goto(resolve("/(app)/tax/[id]", { id: String(d.worksheet.id) }));
    await invalidateAll();
    discard();
    await auditRef?.refresh();
  }
  let leaveOpen = $state(false),
    pendingHref: string | null = null,
    leaving = false;
  beforeNavigate((nav) => {
    if (leaving || !dirty || nav.willUnload || !nav.to) return;
    nav.cancel();
    pendingHref = nav.to.url.href;
    leaveOpen = true;
  });
  function discardAndLeave() {
    discard();
    leaving = true;
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- SvelteKit supplied the destination.
    if (pendingHref) void goto(pendingHref);
  }
</script>

<svelte:window
  onbeforeunload={(event) => {
    if (dirty) {
      event.preventDefault();
      event.returnValue = "";
    }
  }}
/>

<DetailPage backHref={resolve("/(app)/tax")} backLabel="Annual tax">
  {#snippet actions()}
    {#if outstanding.length && r.status !== "finalised"}<a
        class="detail-card-action"
        href="#worksheet-attention"
        >{outstanding.length} item(s) need attention</a
      >{/if}
    {#if editable}<Button
        variant="outline"
        disabled={saving || !!uncertainSave || !!inputErrors.length}
        onclick={() => save("draft")}
        >{saving ? "Saving…" : "Save draft"}</Button
      >{/if}
    {#if d.isLatest && r.status !== "finalised"}
      {#if data.canFinalise && (d.savedRevision.status === "reviewed" || data.canReview)}<Button
          disabled={!!uncertainSave ||
            !canComplete ||
            finalisePeriodOpen ||
            ((!data.canUpdate || !data.canReview) && dirty)}
          onclick={() => askCompletion("finalised")}>Finalise worksheet</Button
        >
      {:else if data.canReview}<Button
          disabled={!!uncertainSave ||
            !canComplete ||
            ((!data.canUpdate || !data.canReview) && dirty)}
          onclick={() => askCompletion("reviewed")}
          >{data.canUpdate ? "Save & mark reviewed" : "Mark reviewed"}</Button
        >{/if}
    {/if}
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
    {#if editable}<p class="field-hint">
        {dirty
          ? "Unsaved worksheet changes"
          : "Up to date with accounting records"} · Figures update automatically.
      </p>{/if}
  {/snippet}
  {#snippet main()}
    {#if conflict && r.status === "finalised"}<ReportNotes
        notes={[
          "Another user finalised this worksheet. The summary shows its saved figures. Your unsaved asset inputs are kept below; discard worksheet changes to display the completed asset workings.",
        ]}
        firstIsWarning
      />{/if}
    {#if error}<div role="alert">
        <ReportNotes notes={[error]} firstIsWarning />
      </div>{/if}
    {#if uncertainSave}<Button
        variant="outline"
        disabled={saving}
        onclick={() => {
          if (uncertainSave)
            void sendSave(uncertainSave.body, uncertainSave.target);
        }}>Retry last save</Button
      >{/if}
    {#if outstanding.length && r.status !== "finalised"}<section
        class="detail-card"
        id="worksheet-attention"
        aria-labelledby="worksheet-attention-title"
      >
        <div class="detail-card-head">
          <h2 id="worksheet-attention-title" class="detail-card-title">
            Needs attention ({outstanding.length})
          </h2>
        </div>
        <ReportNotes notes={outstanding} firstIsWarning />
        <div class="tax-actions">
          <a class="detail-card-action" href="#tax-expenses-title"
            >Review expense treatments ({t.unresolvedCount})</a
          ><a class="detail-card-action" href="#capital-allowances-title"
            >Review asset deductions ({capitalDraft?.problems.length ?? 0})</a
          ><a class="detail-card-action" href="#tax-adjustments-title"
            >Review adjustments</a
          >
        </div>
      </section>{/if}
    {#if d.stale && r.status === "finalised"}<ReportNotes
        notes={[
          "Accounting records changed after finalisation. This revision keeps its original figures. Create an amendment to include the changes.",
        ]}
        firstIsWarning
      />{/if}
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
          {#each adjustments.filter((a) => a.kind !== "source" && a.withdrawnAt === null) as a (a.id)}<div
              class="detail-row"
            >
              <dt class="detail-key">
                {a.kind === "source"
                  ? ""
                  : taxAdjustmentLabels[a.kind]}{a.originYa
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
      disabled={saving || !!uncertainSave || conflict}
      onchange={correct}
    />
    {#key resetKey}<CapitalAllowances
        detail={d}
        {editable}
        bind:dirty={capitalDirty}
        saving={saving || !!uncertainSave}
        worksheetDirty={dirty}
        resultBase={t.resultMinor - t.capitalMinor}
        bind:draft={capitalDraft}
      />
    {/key}
    <TaxAdjustments
      {adjustments}
      lines={t.lines}
      currency={r.snapshot.currency}
      canChange={editable}
      disabled={saving || !!uncertainSave || conflict}
      onadd={() => (mode = "adjustment")}
      onwithdraw={(id) => {
        adjustmentId = id;
        mode = "withdraw";
      }}
    />
    <ReportNotes notes={[TAX_PREPARATION_NOTE, ...r.snapshot.notes]} />
  {/snippet}
  {#snippet rail()}
    <section class="detail-card" aria-labelledby="worksheet-status-title">
      <div class="detail-card-head">
        <h2 id="worksheet-status-title" class="detail-card-title">
          Worksheet status
        </h2>
      </div>
      <div class="tax-stack">
        <p class="hint">
          {r.status === "finalised"
            ? "This revision is locked. Further changes require an amendment."
            : "Save a draft at any time. Finalise when all tax treatments and claims are ready."}
        </p>
        {#if finalisePeriodOpen && r.status !== "finalised"}<p
            class="field-hint"
          >
            Finalisation is available after this accounting period ends. You can
            save a draft now.
          </p>{/if}
        {#if dirty}<button
            class="detail-card-action"
            type="button"
            disabled={saving}
            onclick={discard}>Discard worksheet changes</button
          >{/if}
        {#if r.status === "finalised" && d.isLatest && data.canAmend}<Button
            variant="outline"
            onclick={() => (mode = "amend")}>Create amendment</Button
          >{/if}
        {#if !d.isLatest}<a
            class="detail-card-action"
            href={resolve("/(app)/tax/[id]", { id: String(d.worksheet.id) })}
            >Open latest revision<ChevronRight size={13} /></a
          >{/if}
        <dl class="detail-list">
          <div class="detail-row">
            <dt class="detail-key">Last saved</dt>
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
        <Disclosure label="Export saved worksheet"
          ><p class="field-hint">
            Exports contain the last saved figures. Save this draft first to
            include the latest records and your changes.
          </p>
          <div class="tax-actions">
            <Button
              variant="outline"
              size="sm"
              href={resolve(
                `/api/tax/${d.worksheet.id}?revision=${r.revision}&format=csv`,
              )}
              download><Download size={14} />Export CSV</Button
            ><Button
              variant="outline"
              size="sm"
              href={resolve(
                `/api/tax/${d.worksheet.id}?revision=${r.revision}&format=html`,
              )}
              target="_blank"
              rel="noopener noreferrer"><Printer size={14} />Print / PDF</Button
            >
          </div></Disclosure
        >
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
    detail={{ ...d, adjustments }}
    {line}
    {adjustmentId}
    onclose={() => (mode = null)}
    onsaved={saved}
    onstage={mode !== "amend" ? stage : undefined}
  />{/if}
<ConfirmDialog
  bind:open={confirmOpen}
  title={completion === "finalised"
    ? "Finalise this worksheet?"
    : "Save and mark reviewed?"}
  description={completion === "finalised"
    ? "Save all changes, record review and lock these figures. Later changes require an amendment. This does not file a tax return."
    : "Save all changes and record that the tax treatments and claims have been reviewed. This does not file a tax return."}
  confirmLabel={completion === "finalised"
    ? "Finalise worksheet"
    : "Save & mark reviewed"}
  onConfirm={() => save(completion, confirmedPayload)}
/>
<ConfirmDialog
  bind:open={leaveOpen}
  title="Discard unsaved worksheet changes?"
  description="Your worksheet changes have not been saved."
  confirmLabel="Discard and leave"
  danger
  onConfirm={discardAndLeave}
/>
