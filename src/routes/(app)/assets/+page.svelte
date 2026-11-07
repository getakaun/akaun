<script lang="ts">
  import { onMount } from "svelte";
  import { invalidateAll } from "$app/navigation";
  import { enhance } from "$app/forms";
  import { resolve } from "$app/paths";
  import { AccountType, AssetSubType } from "$lib/enums.js";
  import { assetUnits, assetDecimal } from "$lib/fixed-assets.js";
  import type { PageData, ActionData } from "./$types.js";
  let { data, form }: { data: PageData; form: ActionData } = $props();
  const empty = () => ({
    assetCode: "",
    name: "",
    description: "",
    category: "",
    acquisitionDate: "",
    inServiceDate: "",
    cost: "",
    accountId: "",
    origin: data.sourceRead ? "purchase" : "legacy",
    sourceMovementId: "",
    openingDate: "",
    accumulated: "0.00",
    accumulatedAccountId: "",
    reconciliationNote: "",
    businessUse: "",
    documentation: "",
    method: "none",
    usefulLifeMonths: "",
    residual: "0.00",
    expenseAccountId: "",
  });
  let draft = $state(empty());
  let editId = $state<number | null>(null);
  let version = $state(1);
  let reason = $state("");
  let acknowledged = $state(false);
  let localError = $state("");
  let pending = $state(false);
  const money = assetDecimal;
  const assetAccounts = $derived(
    data.accounts.filter(
      (a) =>
        a.archivedAt === null &&
        a.type === AccountType.Asset &&
        a.subType === AssetSubType.FixedAsset,
    ),
  );
  const expenseAccounts = $derived(
    data.accounts.filter(
      (a) => a.archivedAt === null && a.type === AccountType.Expense,
    ),
  );
  function reset() {
    draft = empty();
    editId = null;
    reason = "";
    acknowledged = false;
    localError = "";
  }
  function edit(a: PageData["report"]["rows"][number]) {
    draft = {
      assetCode: a.assetCode,
      name: a.name,
      description: a.description,
      category: a.category,
      acquisitionDate: a.acquisitionDate,
      inServiceDate: a.inServiceDate ?? "",
      cost: assetDecimal(a.costMinor),
      accountId: String(a.accountId),
      origin: a.origin,
      sourceMovementId: a.sourceMovementId ? String(a.sourceMovementId) : "",
      openingDate: a.openingDate ?? "",
      accumulated: assetDecimal(a.openingAccumulatedMinor),
      accumulatedAccountId: a.accumulatedAccountId
        ? String(a.accumulatedAccountId)
        : "",
      reconciliationNote: a.reconciliationNote,
      businessUse:
        a.businessUseBps === null ? "" : (a.businessUseBps / 100).toFixed(2),
      documentation: a.documentation,
      method: a.method,
      usefulLifeMonths: a.usefulLifeMonths ? String(a.usefulLifeMonths) : "",
      residual: assetDecimal(a.residualMinor),
      expenseAccountId: a.expenseAccountId ? String(a.expenseAccountId) : "",
    };
    editId = a.id;
    version = a.version;
    reason = "";
    acknowledged = false;
    document
      .getElementById("registration")
      ?.scrollIntoView({ behavior: "smooth" });
  }
  function chooseSource(m: PageData["report"]["unregistered"][number]) {
    reset();
    draft.sourceMovementId = String(m.id);
    draft.acquisitionDate = m.date;
    draft.cost = assetDecimal(m.amountMinor);
    draft.accountId = String(m.accountId);
    draft.description = m.description;
    document
      .getElementById("registration")
      ?.scrollIntoView({ behavior: "smooth" });
  }
  onMount(() => {
    const stream = new EventSource(resolve("/api/assets/stream"));
    stream.onmessage = () => {
      void invalidateAll();
    };
    return () => stream.close();
  });
</script>

<svelte:head><title>Fixed assets - Akaun</title></svelte:head>
<div class="assets-page">
  <header>
    <a href={resolve("/(app)/accounts")}>Accounts</a>
    <h1>Fixed asset register</h1>
    <p>
      Track capital assets already recorded in the ledger. Registration creates
      no purchase, cash movement or depreciation journal.
    </p>
  </header>
  <form method="GET" class="date-filter">
    <label
      >Reconcile through <input
        type="date"
        name="asOf"
        value={data.report.asOf}
        required
      /></label
    ><button>View reconciliation</button>
  </form>
  <p>{data.report.note}</p>
  <div class="totals">
    <p>Registered cost <strong>{money(data.report.costMinor)}</strong></p>
    <p>
      Brought-forward depreciation <strong
        >{money(data.report.accumulatedMinor)}</strong
      >
    </p>
    <p>
      Cost less brought-forward depreciation <strong
        >{money(data.report.openingNetMinor)}</strong
      >
    </p>
  </div>
  <h2>Assets</h2>
  <div class="table-scroll">
    <table>
      <thead
        ><tr
          ><th>Asset</th><th>Category / status</th><th
            >Acquisition / in service</th
          ><th>Cost</th><th>Prior depreciation</th><th
            >Evidence and exceptions</th
          ></tr
        ></thead
      ><tbody>
        {#each data.report.rows as a (a.id)}<tr
            ><td
              ><strong>{a.assetCode} · {a.name}</strong>
              <p>{a.description}</p>
              {#if data.canWrite && (a.origin === "legacy" || data.sourceRead)}<button
                  type="button"
                  onclick={() => edit(a)}>Correct registration</button
                >{/if}</td
            ><td
              >{a.category}
              <p>{a.status}</p>
              {#if !a.included}<p>Outside reconciliation date</p>{/if}
              <p>
                Business use: {a.businessUseBps === null
                  ? "Unspecified"
                  : `${a.businessUseBps / 100}%`}
              </p></td
            ><td
              >{a.acquisitionDate}
              <p>{a.inServiceDate ?? "Not specified"}</p></td
            ><td class="amount"
              >{money(a.costMinor)}
              <p>{a.accountName}</p></td
            ><td class="amount"
              >{money(a.openingAccumulatedMinor)}
              <p>{a.openingDate ?? "Purchase registration"}</p></td
            ><td
              >{#if a.sourceRecordId}<a
                  href={resolve("/(app)/records/[id]", {
                    id: String(a.sourceRecordId),
                  })}
                  >Purchase record #{a.sourceRecordId}, line #{a.sourceMovementId}</a
                >{:else}{a.origin === "legacy"
                  ? "Legacy opening registration"
                  : "Purchase source (record permission required)"}{/if}
              <p>{a.documentation}</p>
              <p>{a.reconciliationNote}</p>
              {#each a.exceptions as exception (exception)}<p class="exception">
                  {exception}
                </p>{/each}
              <details>
                <summary>Suggested book profile (no posting)</summary>
                <p>
                  {a.method}; life: {a.usefulLifeMonths ?? "unspecified"} months;
                  residual: {money(a.residualMinor)}. Expense account: {a.expenseAccountId ??
                    "unspecified"}; accumulated account: {a.accumulatedAccountId ??
                    "unspecified"}.
                </p>
              </details></td
            ></tr
          >{:else}<tr><td colspan="6">No assets registered.</td></tr>{/each}
      </tbody>
    </table>
  </div>
  <h2>Register versus GL</h2>
  <p>
    Figures use the book's main currency. Positive differences mean GL exceeds
    the signed register expectation. Contra accounts remain Asset accounts and
    use negative credit balances.
  </p>
  <div class="table-scroll">
    <table>
      <thead
        ><tr
          ><th>Account</th><th>Registered cost</th><th>Prior depreciation</th
          ><th>Expected signed balance</th><th>GL balance</th><th
            >GL less register</th
          ></tr
        ></thead
      ><tbody
        >{#each data.report.reconciliation as r (r.accountId)}<tr
            ><td
              ><a
                href={resolve("/(app)/accounts/[id]", {
                  id: String(r.accountId),
                })}>{r.accountName}</a
              ></td
            ><td class="amount">{money(r.costMinor)}</td><td class="amount"
              >{money(r.accumulatedMinor)}</td
            ><td class="amount">{money(r.expectedMinor)}</td><td class="amount"
              >{money(r.glMinor)}</td
            ><td class:exception={r.differenceMinor !== 0} class="amount"
              >{money(r.differenceMinor)}</td
            ></tr
          >{/each}</tbody
      >
    </table>
  </div>
  <h2>Positive fixed-asset lines without a registration</h2>
  <p>
    These may include pooled opening balances or other adjustments. Review
    before registering. Existing accumulated-account mappings are excluded.
  </p>
  {#if !data.sourceRead}<p>
      Record read permission is required to inspect source lines.
    </p>{/if}
  <ul>
    {#each data.report.unregistered as m (m.id)}<li>
        <a href={resolve("/(app)/records/[id]", { id: String(m.recordId) })}
          >{m.date} · {m.description} · line #{m.id}</a
        >
        — {money(m.amountMinor)}
        {#if data.canWrite}<button type="button" onclick={() => chooseSource(m)}
            >Register this line</button
          >{/if}
      </li>{:else}<li>No source lines to display.</li>{/each}
  </ul>
  {#if data.canWrite}
    <section id="registration">
      <h2>{editId ? "Correct registration" : "Register asset"}</h2>
      <p>
        Capital purchases belong in a fixed-asset GL account, separately from
        ordinary deductible expenses. Legacy values must already exist in the
        ledger. Disposal and depreciation posting are deferred.
      </p>
      {#if form?.error || localError}<p role="alert" class="exception">
          {localError || form?.error}
        </p>{/if}
      {#if form && "saved" in form}<p role="status">
          Registration saved. The ledger has not changed.
        </p>{/if}
      <form
        method="POST"
        action="?/save"
        use:enhance={({ formData, cancel }) => {
          localError = "";
          try {
            formData.set(
              "input",
              JSON.stringify({
                assetCode: draft.assetCode,
                name: draft.name,
                description: draft.description,
                category: draft.category,
                acquisitionDate: draft.acquisitionDate,
                inServiceDate: draft.inServiceDate || null,
                costMinor: assetUnits(draft.cost),
                accountId: Number(draft.accountId),
                origin: draft.origin,
                sourceMovementId:
                  draft.origin === "purchase"
                    ? Number(draft.sourceMovementId)
                    : null,
                openingDate:
                  draft.origin === "legacy" ? draft.openingDate : null,
                openingAccumulatedMinor:
                  draft.origin === "legacy" ? assetUnits(draft.accumulated) : 0,
                accumulatedAccountId: draft.accumulatedAccountId
                  ? Number(draft.accumulatedAccountId)
                  : null,
                reconciliationNote: draft.reconciliationNote,
                businessUseBps: draft.businessUse
                  ? assetUnits(draft.businessUse, 10000)
                  : null,
                documentation: draft.documentation,
                method: draft.method,
                usefulLifeMonths: draft.usefulLifeMonths
                  ? Number(draft.usefulLifeMonths)
                  : null,
                residualMinor: assetUnits(draft.residual),
                expenseAccountId: draft.expenseAccountId
                  ? Number(draft.expenseAccountId)
                  : null,
                acknowledgedExistingGl: acknowledged,
              }),
            );
          } catch (error) {
            localError =
              error instanceof Error
                ? error.message
                : "Check the entered values.";
            cancel();
            return;
          }
          pending = true;
          return async ({ result, update }) => {
            pending = false;
            await update({ reset: false });
            if (result.type === "success") reset();
          };
        }}
      >
        <div class="fields">
          <label
            >Asset identity <input
              bind:value={draft.assetCode}
              required
              maxlength="80"
            /></label
          >
          <label
            >Name <input
              bind:value={draft.name}
              required
              maxlength="160"
            /></label
          >
          <label
            >Category / type <input
              bind:value={draft.category}
              required
              maxlength="120"
              placeholder="e.g. Computer equipment"
            /></label
          >
          <label
            >Registration origin <select
              bind:value={draft.origin}
              disabled={editId !== null}
              ><option value="purchase" disabled={!data.sourceRead}
                >Existing capital purchase</option
              ><option value="legacy">Legacy / opening balance</option></select
            ></label
          >
          <label
            >Acquisition date <input
              type="date"
              bind:value={draft.acquisitionDate}
              required
            /></label
          >
          <label
            >In-service date (optional) <input
              type="date"
              bind:value={draft.inServiceDate}
            /></label
          >
          <label
            >Gross cost <input
              inputmode="decimal"
              bind:value={draft.cost}
              required
            /></label
          >
          <label
            >Fixed-asset GL account <select
              bind:value={draft.accountId}
              required
              ><option value="">Choose account</option
              >{#each assetAccounts as a (a.id)}<option value={String(a.id)}
                  >{a.name}</option
                >{/each}</select
            ></label
          >
          {#if draft.origin === "purchase"}<label
              >Purchase movement / line ID <input
                type="number"
                min="1"
                step="1"
                bind:value={draft.sourceMovementId}
                required
                disabled={editId !== null}
              /></label
            >{:else}
            <label
              >Opening reconciliation date <input
                type="date"
                bind:value={draft.openingDate}
                required
              /></label
            >
            <label
              >Accumulated depreciation brought forward <input
                inputmode="decimal"
                bind:value={draft.accumulated}
                required
              /></label
            >{/if}
          <label
            >Accumulated depreciation GL account (optional unless brought
            forward) <select bind:value={draft.accumulatedAccountId}
              ><option value="">Unspecified</option
              >{#each assetAccounts as a (a.id)}<option value={String(a.id)}
                  >{a.name}</option
                >{/each}</select
            ></label
          >
          <label
            >Business use % (optional) <input
              inputmode="decimal"
              bind:value={draft.businessUse}
            /></label
          >
        </div>
        <label
          >Description <textarea
            bind:value={draft.description}
            required
            maxlength="4000"
          ></textarea></label
        >
        <label
          >Source documentation reference / location <textarea
            bind:value={draft.documentation}
            required
            maxlength="4000"
            placeholder="Invoice number, record attachment name, or document location"
          ></textarea></label
        >
        <label
          >Reconciliation explanation <textarea
            bind:value={draft.reconciliationNote}
            required
            maxlength="4000"
            placeholder="Explain existing GL values and any known differences"
          ></textarea></label
        >
        <details>
          <summary>Suggested depreciation profile (stored only)</summary>
          <div class="fields">
            <label
              >Method <select bind:value={draft.method}
                ><option value="none">Not specified</option><option
                  value="straight_line">Straight line</option
                ></select
              ></label
            >
            <label
              >Useful life in months <input
                type="number"
                min="1"
                max="1200"
                bind:value={draft.usefulLifeMonths}
              /></label
            >
            <label
              >Residual value <input
                inputmode="decimal"
                bind:value={draft.residual}
              /></label
            >
            <label
              >Default depreciation expense account <select
                bind:value={draft.expenseAccountId}
                ><option value="">Unspecified</option
                >{#each expenseAccounts as a (a.id)}<option value={String(a.id)}
                    >{a.name}</option
                  >{/each}</select
              ></label
            >
          </div>
        </details>
        {#if editId}<input type="hidden" name="id" value={editId} /><input
            type="hidden"
            name="version"
            value={version}
          /><label
            >Reason for correction <textarea
              name="reason"
              bind:value={reason}
              required
              maxlength="4000"
            ></textarea></label
          >{/if}
        <label class="ack"
          ><input type="checkbox" bind:checked={acknowledged} required /> I confirm
          these capitalised values already exist in the GL. This registration must
          not create any ledger entries.</label
        >
        <button disabled={pending}
          >{pending
            ? "Saving…"
            : editId
              ? "Save audited correction"
              : "Register asset"}</button
        > <button type="button" onclick={reset}>Clear / cancel</button>
        <noscript
          >This form requires JavaScript to validate exact monetary inputs.</noscript
        >
      </form>
    </section>{/if}
  <details>
    <summary>Recent registration audit (latest 100 changes)</summary
    >{#each data.audit as entry (entry.id)}<p>
        Asset #{entry.recordId} · {entry.action} · {entry.actorName ??
          "Unknown actor"} · {entry.createdAt}
      </p>
      <pre>{entry.changes}</pre>{/each}
  </details>
</div>

<style>
  .assets-page {
    max-width: 1400px;
    margin: 0 auto;
    padding: 1.5rem;
  }
  h1 {
    font-size: 1.75rem;
    font-weight: 650;
  }
  h2 {
    font-size: 1.2rem;
    font-weight: 600;
    margin: 1.8rem 0 0.8rem;
  }
  p {
    margin: 0.4rem 0;
  }
  .totals,
  .fields {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 1rem;
    margin: 1rem 0;
  }
  strong {
    display: block;
  }
  .table-scroll {
    overflow-x: auto;
  }
  table {
    width: 100%;
    border-collapse: collapse;
  }
  th,
  td {
    text-align: left;
    padding: 0.8rem;
    border-bottom: 1px solid var(--border, #ccc);
    vertical-align: top;
  }
  th {
    white-space: nowrap;
  }
  .amount {
    font-variant-numeric: tabular-nums;
    text-align: right;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    margin: 0.7rem 0;
  }
  input,
  select,
  textarea,
  button {
    padding: 0.5rem 0.7rem;
    border: 1px solid var(--border, #aaa);
    border-radius: 0.4rem;
    background: var(--background, transparent);
    color: inherit;
  }
  input[type="checkbox"] {
    width: auto;
  }
  .ack {
    flex-direction: row;
    align-items: start;
  }
  button {
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  a {
    text-decoration: underline;
  }
  textarea {
    min-height: 4rem;
  }
  .exception {
    color: var(--destructive, #b45309);
  }
  section {
    border-top: 1px solid var(--border, #ccc);
    margin-top: 2rem;
  }
  pre {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-size: 0.75rem;
  }
  .date-filter {
    display: flex;
    gap: 1rem;
    align-items: center;
  }
  li {
    margin: 0.6rem 0;
  }
</style>
