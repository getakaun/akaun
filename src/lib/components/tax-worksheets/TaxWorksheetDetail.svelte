<script lang="ts">
  import { SvelteMap } from "svelte/reactivity";
  import { goto, invalidateAll } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { Download, Printer, Plus } from "@lucide/svelte";
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
    safeTaxSum,
  } from "$lib/tax-worksheet.js";
  import { TaxTreatmentLabels } from "$lib/expense-tax.js";
  import TaxWorksheetSheet from "./TaxWorksheetSheet.svelte";
  import type { loadTaxWorksheet } from "$lib/server/loaders/tax-worksheets.js";
  import type { TaxWorksheetDetail as Detail } from "$lib/server/queries/tax-worksheets.js";
  import "$lib/components/reports/reports.css";
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
  let notice = $state("");
  let onlyReview = $state(true);
  let confirm = $state<"review" | "finalise" | "resume" | null>(null);
  let confirmOpen = $state(false);
  let confirmedVersion = 0;
  let auditRef = $state<{ refresh: () => Promise<void> } | null>(null);
  const groups = $derived.by(() => {
    const grouped = new SvelteMap<
      number,
      {
        accountId: number;
        name: string;
        expenseMinor: number;
        addBackMinor: number;
        lines: typeof t.lines;
      }
    >();
    for (const source of t.lines) {
      if (onlyReview && !source.unresolved) continue;
      const group = grouped.get(source.accountId) ?? {
        accountId: source.accountId,
        name: source.accountName,
        expenseMinor: 0,
        addBackMinor: 0,
        lines: [],
      };
      group.lines.push(source);
      group.expenseMinor = safeTaxSum([
        group.expenseMinor,
        source.expenseMinor,
      ]);
      group.addBackMinor = safeTaxSum([
        group.addBackMinor,
        source.addBackMinor ?? 0,
      ]);
      grouped.set(source.accountId, group);
    }
    return [...grouped.values()];
  });
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
    notice = "";
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
      notice =
        action === "finalise"
          ? "Revision finalised."
          : action === "review"
            ? "Worksheet marked reviewed."
            : "Worksheet returned to draft.";
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
    notice = "Annual tax worksheet saved.";
  }
</script>

<DetailPage backHref={resolve("/(app)/tax")} backLabel="Annual tax">
  {#snippet actions()}
    <a
      class="sheet-btn"
      href={resolve(
        `/api/tax/${d.worksheet.id}?revision=${r.revision}&format=csv`,
      )}
      download><Download size={14} />CSV</a
    >
    <a
      class="sheet-btn"
      href={resolve(
        `/api/tax/${d.worksheet.id}?revision=${r.revision}&format=html`,
      )}
      target="_blank"
      rel="noopener noreferrer"><Printer size={14} />Print / PDF</a
    >
  {/snippet}
  {#snippet hero()}
    <div class="detail-hero-eyebrow">
      Annual tax · Revision {r.revision} · {r.snapshot.currency}
    </div>
    <h1 class="detail-hero-title">YA {d.worksheet.ya}</h1>
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
    <p class="tax-note">{TAX_PREPARATION_NOTE}</p>
  {/snippet}
  {#snippet main()}
    {#if error}<p class="tax-error" role="alert">{error}</p>{/if}
    {#if notice}<p class="tax-success" role="status">{notice}</p>{/if}
    {#if d.stale}
      <section class="detail-card">
        <div class="detail-card-head">
          <span class="detail-card-title">Accounting records changed</span>
        </div>
        <div class="tax-card-body">
          <p>
            {r.status === "finalised"
              ? "This finalised revision keeps its original figures. Create an amendment to include later accounting changes."
              : "Review the differences before refreshing this draft. Reviewed status will be cleared."}
          </p>
          {#if d.profitChanged}<p>
              Accounting profit: {money(r.snapshot.profitMinor)} → {money(
                d.liveProfitMinor,
              )}
            </p>{/if}
          <details>
            <summary>{d.changes.length} changed expense line(s)</summary>
            <ul>
              {#each d.changes as change (change.movementId)}<li>
                  {change.after?.recordNumber ??
                    change.before?.recordNumber ??
                    `Record ${change.after?.recordId ?? change.before?.recordId}`}
                  · {change.after?.label ??
                    change.after?.description ??
                    change.before?.description} — {change.before
                    ? money(change.before.expenseMinor)
                    : "New"} → {change.after
                    ? money(change.after.expenseMinor)
                    : "Removed"}{change.before &&
                  change.after &&
                  change.before.expenseMinor === change.after.expenseMinor
                    ? " (classification or source details changed)"
                    : ""}
                </li>{/each}
            </ul>
          </details>
          {#if editable}<Button
              variant="outline"
              disabled={saving}
              onclick={() => (mode = "refresh")}
              >Review and refresh figures</Button
            >{/if}
        </div>
      </section>
    {/if}
    {#each r.snapshot.notes as note (note)}<p class="tax-note">{note}</p>{/each}
    <section class="rep-block">
      <div class="rep-block-head">
        <div>
          <h2 class="rep-block-title">From accounting profit to tax result</h2>
          <p class="rep-block-sub">
            Saved accounting figures with annual tax adjustments
          </p>
        </div>
      </div>
      <table class="rep-table">
        <tbody>
          <tr
            ><td>Accounting profit</td><td class="rep-amount"
              >{money(r.snapshot.profitMinor)}</td
            ></tr
          >
          <tr
            ><td>Original estimated add-backs</td><td class="rep-amount"
              >{money(t.baseAddBackMinor)}</td
            ></tr
          >
          <tr
            ><td>Annual treatment corrections</td><td class="rep-amount"
              >{money(t.correctionMinor)}</td
            ></tr
          >
          <tr class="rep-total"
            ><td>Effective expense add-backs</td><td class="rep-amount"
              >{money(t.addBackMinor)}</td
            ></tr
          >
          {#each d.adjustments.filter((a) => a.kind !== "source" && a.withdrawnAt === null) as a (a.id)}<tr
              ><td
                >{a.kind === "source" ? "" : taxManualLabels[a.kind]}{a.originYa
                  ? ` · YA ${a.originYa}`
                  : ""}</td
              ><td class="rep-amount"
                >{money(
                  a.direction === "increase" ? a.amountMinor : -a.amountMinor,
                )}</td
              ></tr
            >{/each}
          <tr class="rep-total"
            ><td>Preparatory tax result</td><td class="rep-amount"
              >{money(t.resultMinor)}</td
            ></tr
          >
        </tbody>
      </table>
      {#if t.unresolvedCount}<p class="tax-card-body tax-note">
          Incomplete: {t.unresolvedCount} expense line(s), net {money(
            t.unresolvedMinor,
          )}, still need annual classification. They are excluded from add-back
          estimates. Review and finalisation remain unavailable.
        </p>{/if}
    </section>
    <section class="detail-card">
      <div class="detail-card-head tax-wrap">
        <h2 class="detail-card-title">Expenses to review</h2>
        <label class="tax-toggle"
          ><input type="checkbox" bind:checked={onlyReview} />Needs review only</label
        >
      </div>
      {#if groups.length === 0}<p class="tax-card-body tax-note">
          {onlyReview
            ? "No unresolved expense lines. Turn off the filter to inspect all saved classifications."
            : "No expense lines in this accounting period."}
        </p>{/if}
      {#each groups as group (group.accountId)}
        <details class="tax-group" open={onlyReview}>
          <summary
            ><strong>{group.name}</strong><span
              >{group.lines.length} line(s) · {money(group.expenseMinor)}</span
            ></summary
          >
          {#each group.lines as source (source.movementId)}
            <div class="tax-source">
              <div>
                <strong>{source.label ?? source.description}</strong>
                <p class="tax-note">
                  {formatDate(source.date)} · {money(
                    source.expenseMinor,
                  )}{source.voided ? " · Void pair" : ""}
                </p>
                {#if data.canReadRecords}<a
                    class="related-link"
                    href={resolve("/(app)/records/[id]", {
                      id: String(source.recordId),
                    })}>{source.recordNumber ?? `Record ${source.recordId}`}</a
                  >{:else}<span
                    >{source.recordNumber ?? `Record ${source.recordId}`}</span
                  >{/if}
              </div>
              <div class="tax-source-values">
                <p>
                  Saved: {source.classification?.percentageBps == null
                    ? "Unclassified"
                    : `${source.classification.percentageBps / 100}%`}
                </p>
                <p>
                  Annual: {source.effectivePercentageBps == null
                    ? "Needs review"
                    : `${source.effectivePercentageBps / 100}%`} · {TaxTreatmentLabels[
                    source.effectiveTreatment
                  ]}
                </p>
                <p>
                  Add-back: {source.addBackMinor === null
                    ? "Unresolved"
                    : money(source.addBackMinor)}
                </p>
                {#if editable && !source.voided}<button
                    class="related-link"
                    type="button"
                    onclick={() => correct(source)}
                    disabled={saving || d.stale}>Change annual treatment</button
                  >{/if}
              </div>
            </div>
          {/each}
        </details>
      {/each}
    </section>
    <section class="detail-card">
      <div class="detail-card-head tax-wrap">
        <h2 class="detail-card-title">Annual adjustments</h2>
        {#if editable}<Button
            variant="outline"
            size="sm"
            onclick={() => (mode = "manual")}
            disabled={saving}><Plus size={14} />Add adjustment</Button
          >{/if}
      </div>
      {#if !d.adjustments.some((a) => a.withdrawnAt === null)}<p
          class="tax-card-body tax-note"
        >
          No annual adjustments. Saved expense classifications still contribute
          their add-backs.
        </p>{/if}
      {#each d.adjustments.filter((a) => a.withdrawnAt === null) as a (a.id)}<div
          class="tax-adjustment"
        >
          <strong
            >{a.kind === "source"
              ? `Annual treatment · expense line ${a.sourceMovementId}`
              : taxManualLabels[a.kind]}</strong
          >
          <p>
            {a.kind === "source"
              ? `${a.percentageBps! / 100}% deductible`
              : `${a.direction === "increase" ? "Increase" : "Decrease"} ${money(a.amountMinor)}`}
          </p>
          {#if a.originYa}<p>
              YA {a.originYa} balance: {money(a.balanceMinor)} · utilised: {money(
                a.amountMinor,
              )} · remaining: {money(a.balanceMinor - a.amountMinor)}
            </p>{/if}
          <p>{a.reason}</p>
          <p class="tax-note">
            {a.evidence} · {a.actorName} · {formatDate(
              a.createdAt.slice(0, 10),
            )}
          </p>
          {#if editable}<button
              type="button"
              class="related-link"
              onclick={() => {
                adjustmentId = a.id;
                mode = "withdraw";
              }}
              disabled={saving}>Withdraw adjustment</button
            >{/if}
        </div>{/each}
      {#if d.adjustments.some((a) => a.withdrawnAt !== null)}<details
          class="tax-group"
        >
          <summary>Withdrawn and replaced adjustments</summary
          >{#each d.adjustments.filter((a) => a.withdrawnAt !== null) as a (a.id)}<div
              class="tax-adjustment"
            >
              <strong
                >Adjustment {a.id} · {a.kind === "source"
                  ? "Annual treatment"
                  : taxManualLabels[a.kind]}</strong
              >
              <p>{a.reason}</p>
              <p class="tax-note">
                {a.actorName} · {a.createdAt} · {a.evidence}
              </p>
              <p>Withdrawn {a.withdrawnAt}: {a.withdrawalReason}</p>
            </div>{/each}
        </details>{/if}
    </section>
  {/snippet}
  {#snippet rail()}
    <section class="detail-card">
      <div class="detail-card-head">
        <h2 class="detail-card-title">Review and finalise</h2>
      </div>
      <div class="tax-card-body">
        <p>
          {r.status === "draft"
            ? "Resolve expense classifications and check manual claims before review."
            : r.status === "reviewed"
              ? "Review is recorded. Finalisation locks this revision."
              : "This revision is locked. An amendment creates a separate draft."}
        </p>
        {#if d.isLatest}
          {#if r.status === "draft" && data.canReview}<Button
              disabled={saving || d.stale || t.unresolvedCount > 0}
              onclick={() => ask("review")}>Mark reviewed</Button
            >{/if}
          {#if r.status === "reviewed" && data.canFinalise}<Button
              disabled={saving || d.stale || t.unresolvedCount > 0}
              onclick={() => ask("finalise")}>Finalise worksheet</Button
            >{/if}
          {#if r.status === "reviewed" && data.canUpdate}<Button
              variant="outline"
              disabled={saving}
              onclick={() => ask("resume")}>Return to draft</Button
            >{/if}
          {#if r.status === "finalised" && data.canAmend}<Button
              variant="outline"
              disabled={saving}
              onclick={() => (mode = "amend")}>Create amendment</Button
            >{/if}
        {:else}<p class="tax-note">
            Viewing a retained revision. Open the latest revision to continue.
          </p>{/if}
        <p class="tax-note">
          Captured: {r.capturedAt}{r.reviewedAt
            ? ` · Reviewed: ${r.reviewedAt}`
            : ""}{r.finalisedAt ? ` · Finalised: ${r.finalisedAt}` : ""}
        </p>
      </div>
    </section>
    <section class="detail-card">
      <div class="detail-card-head">
        <h2 class="detail-card-title">Revisions</h2>
      </div>
      <div class="tax-card-body">
        {#each d.revisions as revision (revision.id)}<div>
            <a
              class="related-link"
              href={resolve(
                `/tax/${d.worksheet.id}?revision=${revision.revision}`,
              )}>Revision {revision.revision}</a
            >
            · {revision.status}{#if revision.amendmentReason}<p
                class="tax-note"
              >
                {revision.amendmentReason}
              </p>{/if}
          </div>{/each}
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

<style>
  .tax-card-body {
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    font-size: 13px;
    line-height: 1.6;
  }
  .tax-note {
    color: var(--muted-foreground);
    font-size: 12px;
    line-height: 1.6;
    overflow-wrap: anywhere;
  }
  .tax-error {
    color: var(--destructive);
    font-size: 13px;
  }
  .tax-success {
    color: var(--primary);
    font-size: 13px;
  }
  .tax-wrap {
    flex-wrap: wrap;
    gap: 10px;
  }
  .tax-toggle {
    display: flex;
    gap: 6px;
    align-items: center;
    font-size: 12px;
  }
  .tax-group {
    padding: 12px 16px;
    border-top: 1px solid var(--border);
  }
  .tax-group summary {
    cursor: pointer;
    font-size: 13px;
  }
  .tax-group summary span {
    display: block;
    color: var(--muted-foreground);
    font-size: 12px;
    margin-top: 4px;
  }
  .tax-source,
  .tax-adjustment {
    padding: 14px 16px;
    border-top: 1px solid var(--border);
    font-size: 13px;
    line-height: 1.6;
    overflow-wrap: anywhere;
  }
  .tax-source {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
    padding-left: 0;
    padding-right: 0;
  }
  .tax-source-values {
    text-align: right;
  }
  @media (max-width: 767px) {
    .tax-source-values {
      text-align: left;
    }
  }
</style>
