<script lang="ts">
  import { isAccumulatedDepreciationAccount } from "$lib/depreciation.js";
  import { untrack } from "svelte";
  import { resolve } from "$app/paths";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Textarea } from "$lib/components/ui/textarea/index.js";
  import * as Select from "$lib/components/ui/select/index.js";
  import DatePicker from "$lib/components/ui/date-picker/DatePicker.svelte";
  import {
    assetMoneyMinor,
    assetMoneyInput,
    ASSET_TYPE_OPTIONS,
  } from "$lib/fixed-assets.js";
  import OpeningRecordSelect from "./OpeningRecordSelect.svelte";
  import { percentageToBps } from "$lib/expense-tax.js";
  import { formatDate, formatMinor } from "$lib/format.js";
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
    onsaved,
    dirty = $bindable(false),
    saving = $bindable(false),
    error = $bindable(""),
  }: {
    asset?: RegisteredAsset | null;
    source?: AssetLedgerLine | null;
    accounts: AssetRegister["accounts"];
    canChange?: boolean;
    onsaved: () => Promise<void>;
    dirty?: boolean;
    saving?: boolean;
    error?: string;
  } = $props();
  const legacy = $derived(!source && !asset?.sourceRecordId);
  let initialVersion = $state(untrack(() => asset?.version));
  let initialSourceVersion = $state(
    untrack(() => asset?.sourceVersion ?? undefined),
  );
  function values() {
    return {
      name: asset?.name ?? source?.label ?? source?.description ?? "",
      assetType:
        asset?.assetType ??
        ASSET_TYPE_OPTIONS.find((type) =>
          (source?.accountName ?? "")
            .toLowerCase()
            .includes(type.toLowerCase()),
        ) ??
        "Other",
      description: asset?.description ?? "",
      acquisitionDate:
        asset?.acquisitionDate ??
        source?.recordDate ??
        new Date().toISOString().slice(0, 10),
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
        asset?.residualMinor == null
          ? ""
          : assetMoneyInput(asset.residualMinor),
      expenseAccount: String(asset?.depreciationExpenseAccountId ?? ""),
      reason: "",
    };
  }
  let initial = $state(untrack(values));
  let fields = $state(untrack(() => ({ ...initial })));
  let formElement: HTMLFormElement;
  $effect(() => {
    dirty = JSON.stringify(fields) !== JSON.stringify(initial);
  });
  export function revert() {
    initial = values();
    fields = { ...initial };
    initialVersion = asset?.version;
    initialSourceVersion = asset?.sourceVersion ?? undefined;
    error = "";
    dirty = false;
  }
  let seenVersion = $state(untrack(() => asset?.version));
  $effect(() => {
    const version = asset?.version;
    if (version === seenVersion) return;
    seenVersion = version;
    if (!dirty) untrack(revert);
  });
  const costAccounts = $derived(
    accounts.filter(
      (account) =>
        account.type === AccountType.Asset &&
        account.subType === AccountSubType.FixedAsset &&
        (account.active || String(account.id) === fields.assetAccount),
    ),
  );
  const assetAccounts = $derived(
    accounts.filter(
      (account) =>
        (isAccumulatedDepreciationAccount(account) && account.active) ||
        String(account.id) === fields.accumulatedAccount,
    ),
  );
  // Keep a previously saved custom type selectable when editing older assets.
  const assetTypes = $derived(
    asset?.assetType && !ASSET_TYPE_OPTIONS.includes(asset.assetType)
      ? [...ASSET_TYPE_OPTIONS, asset.assetType]
      : ASSET_TYPE_OPTIONS,
  );
  export async function submit() {
    if (saving) return;
    if (!formElement.reportValidity()) return;
    error = "";
    if (
      legacy &&
      (!fields.assetAccount || !fields.acquisitionDate || !fields.openingAsAt)
    ) {
      error = "Choose an asset cost account, purchase date and opening date.";
      return;
    }
    if (
      ((legacy && (assetMoneyMinor(fields.openingDep) ?? 0) > 0) ||
        asset?.accumulatedDepreciationAccountId) &&
      !fields.accumulatedAccount
    ) {
      error = "Choose an existing accumulated depreciation account.";
      return;
    }
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
      serialNumber: asset?.serialNumber ?? "",
      // A null date makes depreciation use the purchase date. Preserve existing dates.
      inServiceDate: asset?.inServiceDate ?? null,
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
          acknowledgeSource: false,
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
      initial = { ...fields };
      initialVersion = String(result.revision);
      dirty = false;
      await onsaved();
    } catch {
      error =
        "Could not save the asset. Check the connection and refresh before retrying.";
    } finally {
      saving = false;
    }
  }
</script>

<form
  bind:this={formElement}
  onsubmit={(event) => {
    event.preventDefault();
    void submit();
  }}
  class="asset-form"
>
  {#if error}<p role="alert" class="form-error">{error}</p>{/if}
  <fieldset disabled={!canChange || saving}>
    {#if !legacy}
      <div
        class="purchase-summary detail-list"
        role="region"
        aria-label="Saved purchase details"
      >
        <div class="detail-row">
          <span class="detail-key">Purchase date</span><span class="detail-val"
            >{formatDate(fields.acquisitionDate)}</span
          >
        </div>
        <div class="detail-row">
          <span class="detail-key">Asset cost account</span><span
            class="detail-val"
            >{accounts.find(
              (account) => String(account.id) === fields.assetAccount,
            )?.name ?? "Missing account"}</span
          >
        </div>
        <div class="detail-row">
          <span class="detail-key">Original cost</span><span class="detail-val"
            >{formatMinor(asset?.costMinor ?? source?.amountMinor ?? 0)}</span
          >
        </div>
      </div>
      {#if source}<a
          class="detail-card-action purchase-link"
          href={resolve("/(app)/records/[id]", { id: String(source.recordId) })}
          >View purchase and documents</a
        >{/if}
    {/if}
    <div class="field">
      <label class="field-label" for="asset-name">Asset name *</label><Input
        id="asset-name"
        bind:value={fields.name}
        required
        maxlength={200}
      />
    </div>
    <div class="field">
      <label class="field-label" for="asset-type">Asset type *</label>
      <Select.Root
        type="single"
        bind:value={fields.assetType}
        disabled={!canChange || saving}
        required
      >
        <Select.Trigger id="asset-type" class="w-full justify-between"
          >{fields.assetType}</Select.Trigger
        >
        <Select.Content>
          {#each assetTypes as type (type)}
            <Select.Item value={type} label={type} />
          {/each}
        </Select.Content>
      </Select.Root>
    </div>
    <div class="field">
      <label class="field-label" for="asset-description">Description</label>
      <Textarea
        id="asset-description"
        bind:value={fields.description}
        maxlength={2000}
      />
    </div>
    {#if legacy}
      <div class="field">
        <label class="field-label" for="asset-account"
          >Asset cost account *</label
        >
        <Select.Root
          type="single"
          value={fields.assetAccount || "__none__"}
          onValueChange={(value) =>
            (fields.assetAccount = value === "__none__" ? "" : value)}
          disabled={!legacy || !canChange || saving}
        >
          <Select.Trigger id="asset-account" class="w-full justify-between"
            >{accounts.find(
              (account) => String(account.id) === fields.assetAccount,
            )?.name ?? "Choose asset cost account"}</Select.Trigger
          >
          <Select.Content
            ><Select.Item
              value="__none__"
              label="Choose asset cost account"
            />{#each costAccounts as account (account.id)}<Select.Item
                value={String(account.id)}
                label={account.name}
              />{/each}</Select.Content
          ></Select.Root
        >
      </div>
      <div class="field">
        <label class="field-label" for="asset-cost"
          >{legacy ? "Original cost *" : "Registered cost"}</label
        >
        <Input
          id="asset-cost"
          inputmode="decimal"
          bind:value={fields.cost}
          readonly={!legacy}
          required
        />
      </div>
      <div class="field">
        <span class="field-label" id="asset-acquired-label"
          >Purchase date *</span
        ><DatePicker
          bind:value={fields.acquisitionDate}
          labelledBy="asset-acquired-label"
          disabled={!legacy || !canChange || saving}
        />
      </div>
    {/if}
    {#if legacy || asset?.openingAsAt}<details class="asset-form-section" open>
        <summary>Opening values for existing assets</summary>
        {#if legacy || asset?.openingAsAt}
          <div class="field">
            <span class="field-label" id="asset-opening-date-label"
              >Opening values as at *</span
            ><DatePicker
              bind:value={fields.openingAsAt}
              labelledBy="asset-opening-date-label"
              disabled={!legacy || !canChange || saving}
              min={fields.acquisitionDate}
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
          {#if asset}<p class="field-hint">
              Opening net book value as at {asset.openingAsAt}: {formatMinor(
                asset.costMinor - asset.broughtForwardDepMinor,
              )}. This is not a current valuation.
            </p>{/if}
          <div class="field">
            <label class="field-label" for="asset-opening-record"
              >Existing record as evidence (optional)</label
            >
            <OpeningRecordSelect
              id="asset-opening-record"
              bind:value={fields.openingRecord}
              accountId={fields.assetAccount}
              dateTo={fields.openingAsAt}
              disabled={!canChange || saving}
            />
            <p class="field-hint">
              Search records on this asset account up to the opening date, or
              provide a document reference below.
            </p>
          </div>
          {#if asset?.openingRecordId}<a
              href={resolve("/(app)/records/[id]", {
                id: String(asset.openingRecordId),
              })}>View opening record and documents</a
            >{/if}
          <p class="field-hint">
            Values must already be represented in the ledger. Missing balances
            remain reconciliation differences.
          </p>
        {:else}<p class="field-hint">
            Opening values apply to legacy assets. This purchase uses its saved
            ledger cost.
          </p>{/if}
      </details>{/if}
    {#if (legacy && (assetMoneyMinor(fields.openingDep) ?? 0) > 0) || (asset && asset.accumulatedDepreciationAccountId !== null)}
      <div class="field">
        <label class="field-label" for="asset-accumulated"
          >Accumulated depreciation account *</label
        ><Select.Root
          type="single"
          bind:value={fields.accumulatedAccount}
          required
          disabled={!canChange || saving}
        >
          <Select.Trigger id="asset-accumulated" class="w-full justify-between"
            >{accounts.find(
              (account) => String(account.id) === fields.accumulatedAccount,
            )?.name ??
              "Choose accumulated depreciation account"}</Select.Trigger
          >
          <Select.Content
            >{#each assetAccounts.filter((account) => String(account.id) !== fields.assetAccount) as account (account.id)}<Select.Item
                value={String(account.id)}
                label={account.name}
              />{/each}</Select.Content
          ></Select.Root
        >
        <p class="field-hint">
          Choose a separate non-current asset account. Create missing accounts
          in Accounts before continuing. Registration posts no depreciation.
        </p>
      </div>
    {/if}
    {#if asset}<div class="field">
        <label class="field-label" for="asset-business">Business use (%)</label
        ><Input
          id="asset-business"
          bind:value={fields.businessUse}
          inputmode="decimal"
        />
        <p class="field-hint">
          For review only. This does not reduce asset cost or determine tax
          eligibility.
        </p>
      </div>
    {/if}
    {#if legacy || asset}<div class="field">
        <label class="field-label" for="asset-document"
          >Supporting-document reference {legacy && !fields.openingRecord
            ? "*"
            : "(optional)"}</label
        ><Textarea
          id="asset-document"
          bind:value={fields.documentReference}
          maxlength={2000}
          required={legacy && !fields.openingRecord}
        ></Textarea>
        <p class="field-hint">
          For older assets, enter a document location or accountant's schedule
          reference. Linked purchase documents remain on the original record.
        </p>
      </div>
    {/if}
    {#if asset && canChange}
      <div class="field">
        <label class="field-label" for="asset-reason">Reason for change *</label
        ><Input
          id="asset-reason"
          bind:value={fields.reason}
          required
          maxlength={1000}
        />
      </div>
    {/if}
  </fieldset>
</form>

<style>
  fieldset {
    min-width: 0;
    border: 0;
    padding: 0;
    margin: 0;
  }
  .purchase-link {
    margin-bottom: 16px;
  }
  .purchase-summary {
    margin: 0 0 12px;
  }
  .form-error {
    background: var(--red-soft);
    color: var(--red);
    border-radius: 8px;
    padding: 10px 12px;
    font-size: 13px;
    margin: 0 0 14px;
  }
  .asset-form-section {
    border-top: 1px solid var(--border);
    margin-top: 20px;
    padding-top: 16px;
  }
  summary {
    cursor: pointer;
    font-weight: 500;
    font-size: 13px;
    margin-bottom: 16px;
  }
</style>
