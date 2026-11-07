<script lang="ts">
  import { untrack } from "svelte";
  import { beforeNavigate } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { X } from "@lucide/svelte";
  import * as Sheet from "$lib/components/ui/sheet/index.js";
  import ConfirmDialog from "$lib/components/ui/ConfirmDialog.svelte";
  import AuditTrail from "$lib/components/ui/AuditTrail.svelte";
  import { Input } from "$lib/components/ui/input/index.js";
  import { useIsMobile } from "$lib/hooks/useIsMobile.svelte.js";
  import {
    assetMoneyMinor,
    assetMoneyInput,
    assetNumber,
    ASSET_TYPE_SUGGESTIONS,
  } from "$lib/fixed-assets.js";
  import { percentageToBps } from "$lib/expense-tax.js";
  import { formatMinor } from "$lib/format.js";
  import { AccountType, AccountSubType } from "$lib/enums.js";
  import type {
    AssetRegister,
    RegisteredAsset,
    AssetLedgerLine,
  } from "$lib/server/queries/fixed-assets.js";

  let {
    asset = null,
    source = null,
    accounts,
    canChange = false,
    onclose,
    onsaved,
  }: {
    asset?: RegisteredAsset | null;
    source?: AssetLedgerLine | null;
    accounts: AssetRegister["accounts"];
    canChange?: boolean;
    onclose: () => void;
    onsaved: () => Promise<void>;
  } = $props();
  const screen = useIsMobile();
  const legacy = $derived(!source && !asset?.sourceRecordId);
  const initialVersion = untrack(() => asset?.version);
  const initialSourceVersion = untrack(() => asset?.sourceVersion ?? undefined);
  const initial = untrack(() => ({
    name: asset?.name ?? source?.label ?? source?.description ?? "",
    assetType: asset?.assetType ?? "Computer equipment",
    description: asset?.description ?? "",
    serialNumber: asset?.serialNumber ?? "",
    acquisitionDate:
      asset?.acquisitionDate ??
      source?.recordDate ??
      new Date().toISOString().slice(0, 10),
    inServiceDate: asset?.inServiceDate ?? "",
    cost: asset
      ? assetMoneyInput(asset.costMinor)
      : source
        ? assetMoneyInput(source.amountMinor)
        : "",
    assetAccount: String(asset?.assetAccountId ?? source?.accountId ?? ""),
    openingAsAt: asset?.openingAsAt ?? new Date().toISOString().slice(0, 10),
    openingDep: assetMoneyInput(asset?.broughtForwardDepMinor ?? 0),
    accumulatedAccount: String(asset?.accumulatedDepreciationAccountId ?? ""),
    openingRecord: String(asset?.openingRecordId ?? ""),
    businessUse:
      asset?.businessUseBps == null
        ? ""
        : (asset.businessUseBps / 100).toFixed(2),
    documentReference: asset?.documentReference ?? "",
    bookMethod: asset?.bookMethod ?? "",
    life: String(asset?.usefulLifeMonths ?? ""),
    residual:
      asset?.residualMinor == null ? "" : assetMoneyInput(asset.residualMinor),
    expenseAccount: String(asset?.depreciationExpenseAccountId ?? ""),
    reason: "",
    acknowledgeSource: false,
  }));
  let fields = $state({ ...initial });
  let saving = $state(false);
  let error = $state("");
  let discardOpen = $state(false);
  const dirty = $derived(JSON.stringify(fields) !== JSON.stringify(initial));
  const costAccounts = $derived(
    accounts.filter(
      (account) =>
        account.type === AccountType.Asset &&
        account.subType === AccountSubType.FixedAsset &&
        account.active,
    ),
  );
  const assetAccounts = $derived(
    accounts.filter((account) => account.type === AccountType.Asset),
  );
  const expenseAccounts = $derived(
    accounts.filter(
      (account) => account.type === AccountType.Expense && account.active,
    ),
  );
  function close() {
    if (saving) return;
    if (dirty) discardOpen = true;
    else onclose();
  }
  beforeNavigate(({ cancel }) => {
    if (dirty) {
      cancel();
      discardOpen = true;
    }
  });

  async function save(event: SubmitEvent) {
    event.preventDefault();
    error = "";
    const businessUseBps =
      fields.businessUse === "" ? null : percentageToBps(fields.businessUse);
    const residualMinor =
      fields.residual === "" ? null : assetMoneyMinor(fields.residual);
    const costMinor = assetMoneyMinor(fields.cost);
    const broughtForwardDepMinor = assetMoneyMinor(fields.openingDep);
    if (
      (fields.businessUse !== "" && businessUseBps === null) ||
      (fields.residual !== "" && residualMinor === null) ||
      (legacy && (costMinor === null || broughtForwardDepMinor === null))
    ) {
      error =
        "Enter valid money with at most two decimal places and a business-use percentage from 0 to 100.";
      return;
    }
    const details = {
      name: fields.name,
      assetType: fields.assetType,
      description: fields.description,
      serialNumber: fields.serialNumber,
      inServiceDate: fields.inServiceDate || null,
      businessUseBps,
      documentReference: fields.documentReference,
      bookMethod: fields.bookMethod || null,
      usefulLifeMonths: fields.life ? Number(fields.life) : null,
      residualMinor,
      depreciationExpenseAccountId: fields.expenseAccount
        ? Number(fields.expenseAccount)
        : null,
    };
    const opening = {
      acquisitionDate: fields.acquisitionDate,
      assetAccountId: Number(fields.assetAccount),
      costMinor,
      openingAsAt: fields.openingAsAt,
      broughtForwardDepMinor,
      openingRecordId: fields.openingRecord
        ? Number(fields.openingRecord)
        : null,
    };
    const body = asset
      ? {
          ...details,
          expectedVersion: initialVersion,
          expectedSourceVersion: initialSourceVersion,
          reason: fields.reason,
          acknowledgeSource: fields.acknowledgeSource,
          accumulatedDepreciationAccountId: fields.accumulatedAccount
            ? Number(fields.accumulatedAccount)
            : null,
          ...(legacy ? { legacyOpening: opening } : {}),
        }
      : {
          ...details,
          sourceMovementId: source?.movementId ?? null,
          ...(legacy ? opening : {}),
          accumulatedDepreciationAccountId: fields.accumulatedAccount
            ? Number(fields.accumulatedAccount)
            : null,
        };
    saving = true;
    try {
      const response = await fetch(
        asset ? `/api/fixed-assets/${asset.id}` : "/api/fixed-assets",
        {
          method: asset ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const result = await response.json();
      if (!response.ok) {
        error =
          result.issues?.[0]?.message ??
          result.error ??
          "Could not save the asset.";
        return;
      }
      await onsaved();
      onclose();
    } catch {
      error =
        "Could not save the asset. Check the connection and refresh before retrying.";
    } finally {
      saving = false;
    }
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
      ? "height:100dvh; border-radius:0; border-top:none; overflow:hidden; display:flex; flex-direction:column; gap:0;"
      : "width:500px; max-width:95vw; overflow:hidden; display:flex; flex-direction:column; gap:0;"}
  >
    <div class="asset-sheet-head">
      <div>
        <div class="sheet-eyebrow">
          Fixed assets {asset ? `· ${assetNumber(asset.id)}` : ""}
        </div>
        <Sheet.Title class="sheet-title-text"
          >{asset
            ? asset.name
            : source
              ? "Register asset"
              : "Add existing asset"}</Sheet.Title
        >
        <Sheet.Description class="text-muted-foreground text-xs"
          >Registration updates the asset register. It posts no accounting
          entry.</Sheet.Description
        >
      </div>
      <button
        type="button"
        class="sheet-close"
        aria-label="Close asset"
        onclick={close}><X size={16} /></button
      >
    </div>
    <form onsubmit={save} class="asset-sheet-form">
      <div class="asset-sheet-body">
        {#if error}<p role="alert" class="asset-error">{error}</p>{/if}
        {#if asset?.reviewReason}<p class="asset-error">{asset.reviewReason}</p>
          {#if asset.source}<p class="hint">
              Current source: {asset.source.recordDate} · {asset.source
                .accountName} · {formatMinor(asset.source.amountMinor)}.
              Accepting it changes the register only.
            </p>{/if}{/if}
        {#if asset?.sourceRecordId || source}
          <a
            class="sheet-btn mb-4"
            href={resolve("/(app)/records/[id]", {
              id: String(asset?.sourceRecordId ?? source?.recordId),
            })}>View purchase and documents</a
          >
        {/if}
        <fieldset disabled={!canChange || saving}>
          <div class="field">
            <label class="field-label" for="asset-name">Asset name *</label
            ><Input
              id="asset-name"
              bind:value={fields.name}
              required
              maxlength={200}
            />
          </div>
          <div class="field">
            <label class="field-label" for="asset-type">Asset type *</label
            ><Input
              id="asset-type"
              bind:value={fields.assetType}
              list="asset-type-suggestions"
              required
              maxlength={100}
            /><datalist id="asset-type-suggestions"
              >{#each ASSET_TYPE_SUGGESTIONS as type (type)}<option value={type}
                ></option>{/each}</datalist
            >
          </div>
          <div class="field">
            <label class="field-label" for="asset-account"
              >Asset cost account *</label
            >
            {#if legacy}<select
                id="asset-account"
                bind:value={fields.assetAccount}
                required
                ><option value="">Choose account</option
                >{#each costAccounts as account (account.id)}<option
                    value={String(account.id)}>{account.name}</option
                  >{/each}</select
              >
            {:else}<p id="asset-account" class="text-sm">
                {accounts.find(
                  (account) => String(account.id) === fields.assetAccount,
                )?.name ?? "Missing account"}
              </p>{/if}
          </div>
          <div class="field">
            <label class="field-label" for="asset-cost"
              >{legacy ? "Original cost *" : "Registered cost"}</label
            >{#if legacy}<Input
                id="asset-cost"
                inputmode="decimal"
                bind:value={fields.cost}
                required
              />{:else}<p id="asset-cost">
                {formatMinor(asset?.costMinor ?? source?.amountMinor ?? 0)}
              </p>{/if}
          </div>
          <div class="field">
            <label class="field-label" for="asset-acquired"
              >Acquisition date *</label
            ><Input
              id="asset-acquired"
              type="date"
              bind:value={fields.acquisitionDate}
              readonly={!legacy}
              required
            />
          </div>
          <div class="field">
            <label class="field-label" for="asset-in-service"
              >In-service date</label
            ><Input
              id="asset-in-service"
              type="date"
              bind:value={fields.inServiceDate}
              min={fields.acquisitionDate}
            />
            <p class="hint">Leave blank if the asset is not yet in use.</p>
          </div>
          <details open={legacy || !!asset?.openingAsAt}>
            <summary>Opening values for existing assets</summary>
            {#if legacy || asset?.openingAsAt}
              <div class="field">
                <label class="field-label" for="asset-opening-date"
                  >Opening values as at *</label
                ><Input
                  id="asset-opening-date"
                  type="date"
                  bind:value={fields.openingAsAt}
                  readonly={!legacy}
                  min={fields.acquisitionDate}
                  required
                />
              </div>
              <div class="field">
                <label class="field-label" for="asset-opening-dep"
                  >Accumulated depreciation brought forward *</label
                ><Input
                  id="asset-opening-dep"
                  bind:value={fields.openingDep}
                  inputmode="decimal"
                  readonly={!legacy}
                  required
                />
              </div>
              {#if asset}<p class="hint">
                  Opening net book value as at {asset.openingAsAt}: {formatMinor(
                    asset.costMinor - asset.broughtForwardDepMinor,
                  )}. This is not a current valuation.
                </p>{/if}
              <div class="field">
                <label class="field-label" for="asset-opening-record"
                  >Existing opening record ID (optional)</label
                ><Input
                  id="asset-opening-record"
                  bind:value={fields.openingRecord}
                  inputmode="numeric"
                  readonly={!legacy}
                />
              </div>
              {#if asset?.openingRecordId}<a
                  href={resolve("/(app)/records/[id]", {
                    id: String(asset.openingRecordId),
                  })}>View opening record and documents</a
                >{/if}
              <p class="hint">
                Values must already be represented in the ledger. Missing
                balances remain reconciliation differences.
              </p>
            {:else}<p class="hint">
                Opening values apply to legacy assets. This purchase uses its
                saved ledger cost.
              </p>{/if}
          </details>
          <div class="field">
            <label class="field-label" for="asset-accumulated"
              >Accumulated depreciation account {legacy &&
              fields.openingDep !== "0.00"
                ? "*"
                : "(optional)"}</label
            ><select
              id="asset-accumulated"
              bind:value={fields.accumulatedAccount}
              ><option value="">Choose account</option
              >{#each assetAccounts.filter((account) => String(account.id) !== fields.assetAccount) as account (account.id)}<option
                  value={String(account.id)}>{account.name}</option
                >{/each}</select
            >
            <p class="hint">
              A separate Asset account. No depreciation is posted in this phase.
            </p>
          </div>
          <details>
            <summary>Additional details</summary>
            <div class="field">
              <label class="field-label" for="asset-serial">Serial number</label
              ><Input
                id="asset-serial"
                bind:value={fields.serialNumber}
                maxlength={200}
              />
            </div>
            <div class="field">
              <label class="field-label" for="asset-description"
                >Description</label
              ><textarea
                id="asset-description"
                bind:value={fields.description}
                maxlength={2000}
              ></textarea>
            </div>
            <div class="field">
              <label class="field-label" for="asset-business"
                >Business use (%)</label
              ><Input
                id="asset-business"
                bind:value={fields.businessUse}
                inputmode="decimal"
              />
              <p class="hint">
                For review only. This does not reduce asset cost or determine
                tax eligibility.
              </p>
            </div>
          </details>
          <div class="field">
            <label class="field-label" for="asset-document"
              >Supporting-document reference {legacy
                ? "*"
                : "(optional)"}</label
            ><textarea
              id="asset-document"
              bind:value={fields.documentReference}
              maxlength={2000}
              required={legacy && !fields.openingRecord}
            ></textarea>
            <p class="hint">
              For older assets, enter a document location or accountant's
              schedule reference. Linked purchase documents remain on the
              original record.
            </p>
          </div>
          <details>
            <summary>Future book depreciation settings (optional)</summary>
            <p class="hint">
              Preparatory details only. No schedule or journal is generated.
            </p>
            <div class="field">
              <label class="field-label" for="asset-method">Method</label
              ><select id="asset-method" bind:value={fields.bookMethod}
                ><option value="">Not set</option><option value="straight_line"
                  >Straight line</option
                ></select
              >
            </div>
            <div class="field">
              <label class="field-label" for="asset-life"
                >Useful life (months)</label
              ><Input
                id="asset-life"
                bind:value={fields.life}
                type="number"
                min={1}
                max={1200}
              />
            </div>
            <div class="field">
              <label class="field-label" for="asset-residual"
                >Residual value</label
              ><Input
                id="asset-residual"
                bind:value={fields.residual}
                inputmode="decimal"
              />
            </div>
            <div class="field">
              <label class="field-label" for="asset-expense"
                >Depreciation expense account</label
              ><select id="asset-expense" bind:value={fields.expenseAccount}
                ><option value="">Not set</option
                >{#each expenseAccounts as account (account.id)}<option
                    value={String(account.id)}>{account.name}</option
                  >{/each}</select
              >
            </div>
          </details>
          {#if asset && canChange}
            {#if asset.sourceRecordId && asset.reviewReason}<div class="field">
                <label class="flex items-start gap-2 text-sm"
                  ><input
                    type="checkbox"
                    bind:checked={fields.acknowledgeSource}
                  /> I reviewed the source line. Update the register to its current
                  saved purchase values.</label
                >
              </div>{/if}
            <div class="field">
              <label class="field-label" for="asset-reason"
                >Reason for change *</label
              ><Input
                id="asset-reason"
                bind:value={fields.reason}
                required
                maxlength={1000}
              />
            </div>
          {/if}
        </fieldset>
        {#if asset}<AuditTrail
            recordType="fixed_asset"
            recordId={asset.id}
          />{/if}
      </div>
      <div class="sheet-foot">
        <div class="sheet-foot-actions">
          <button
            type="button"
            class="sheet-btn"
            onclick={close}
            disabled={saving}>Close</button
          >{#if canChange}<button
              class="sheet-btn sheet-btn-primary"
              type="submit"
              disabled={saving || (!!asset && !dirty)}
              >{saving
                ? "Saving…"
                : asset
                  ? "Save changes"
                  : "Register asset"}</button
            >{/if}
        </div>
      </div>
    </form>
  </Sheet.Content>
</Sheet.Root>
<ConfirmDialog
  bind:open={discardOpen}
  title="Discard asset changes?"
  description="Your unsaved asset details will be lost."
  confirmLabel="Discard changes"
  onConfirm={onclose}
/>

<style>
  .asset-sheet-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    padding: 22px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .asset-sheet-form {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .asset-sheet-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 20px 22px;
  }
  fieldset {
    min-width: 0;
    border: 0;
    padding: 0;
  }
  select,
  textarea {
    width: 100%;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--card);
    color: var(--foreground);
    font-family: inherit;
    font-size: 13.5px;
    line-height: 1.5;
  }
  select {
    min-height: 36px;
  }
  textarea {
    min-height: 80px;
    resize: vertical;
  }
  select:focus-visible,
  textarea:focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: 2px;
  }
  select:disabled,
  textarea:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .asset-sheet-body :global(input[readonly]) {
    background: var(--muted);
    color: var(--muted-foreground);
  }
  .hint {
    color: var(--muted-foreground);
    font-size: 12px;
    margin: 6px 0 14px;
  }
  .asset-error {
    color: var(--red);
    background: var(--red-soft);
    padding: 12px;
    border-radius: 6px;
    margin-bottom: 14px;
  }
  details {
    border-top: 1px solid var(--border);
    margin: 14px 0;
    padding-top: 12px;
  }
  summary {
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    margin-bottom: 12px;
  }
</style>
