<script lang="ts">
  import { toast } from "svelte-sonner";
  import * as Select from "$lib/components/ui/select/index.js";
  import type {
    AccountDefaultView,
    AccountView,
  } from "$lib/components/accounts/account-types.js";
  import {
    AccountSubType,
    DefaultAccountPurpose,
    DefaultAccountPurposeDisplayLabels,
  } from "$lib/enums.js";

  let {
    defaults,
    accounts,
    disabled = false,
  }: {
    defaults: AccountDefaultView[];
    accounts: AccountView[];
    disabled?: boolean;
  } = $props();

  // The names come from `DefaultAccountPurposeDisplayLabels`; only the help
  // line, which explains this screen's choice, lives here.
  const help: Record<number, string> = {
    [DefaultAccountPurpose.Receivable]:
      "Used when an invoice is sent or a customer pays.",
    [DefaultAccountPurpose.Payable]:
      "Used when somebody else pays a business expense.",
    [DefaultAccountPurpose.OpeningBalances]:
      "Balances the amounts present when these books begin.",
    [DefaultAccountPurpose.SalesRevenue]:
      "Used when an invoice does not choose another revenue account.",
    [DefaultAccountPurpose.UncategorisedExpense]:
      "Used when an imported expense has no matching expense account.",
    [DefaultAccountPurpose.EverydayTransaction]:
      "The account new income and expenses default to.",
    [DefaultAccountPurpose.UncategorisedIncome]:
      "Used when an imported income document has no matching revenue account.",
  };
  // svelte-ignore state_referenced_locally
  let selected = $state<Record<number, number>>(
    Object.fromEntries(
      defaults.map((item) => [item.purpose, item.account?.id ?? 0]),
    ),
  );
  let saving = $state(false);

  function eligible(item: AccountDefaultView, account: AccountView): boolean {
    if (account.type !== item.requiredType || !account.postingEligible)
      return false;
    if (item.purpose === DefaultAccountPurpose.Payable) {
      return account.subType === AccountSubType.AccountsPayable;
    }
    if (item.purpose === DefaultAccountPurpose.Receivable) {
      return account.subType === AccountSubType.Receivable;
    }
    if (item.purpose === DefaultAccountPurpose.EverydayTransaction) {
      return new Set<number>([
        AccountSubType.Cash,
        AccountSubType.Bank,
        AccountSubType.Wallet,
        AccountSubType.Card,
        AccountSubType.Clearing,
      ]).has(account.subType ?? -1);
    }
    return true;
  }

  async function save() {
    saving = true;
    try {
      const response = await fetch("/api/settings/account-defaults", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          defaults: defaults.map((item) => ({
            purpose: item.purpose,
            accountId: selected[item.purpose],
          })),
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(
          body.reason ??
            body.error ??
            "The default accounts could not be updated.",
        );
      }
      toast.success("Default accounts updated");
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "The default accounts could not be updated.",
      );
    } finally {
      saving = false;
    }
  }
</script>

<section class="rounded-xl border border-border bg-card p-5">
  <h2 class="text-base font-semibold">Default accounts</h2>
  <p class="mt-1 text-sm text-muted-foreground">
    Choose where the app records each automatic side of a transaction.
  </p>
  <div class="mt-5 grid gap-4 md:grid-cols-2">
    {#each defaults as item (item.purpose)}
      <label class="grid gap-1.5 text-sm">
        <span class="font-medium">{DefaultAccountPurposeDisplayLabels[item.purpose]}</span>
        <span class="text-xs text-muted-foreground"
          >{help[item.purpose]}</span
        >
        <Select.Root
          type="single"
          value={String(selected[item.purpose] ?? 0)}
          onValueChange={(next) => next && (selected[item.purpose] = Number(next))}
        >
          <Select.Trigger class="w-full justify-between" disabled={disabled || saving}>
            {#if !selected[item.purpose]}
              Choose an account
            {:else}
              {@const chosen = accounts.find((account) => account.id === selected[item.purpose])}
              {chosen ? `${chosen.code} — ${chosen.name}` : "Choose an account"}
            {/if}
          </Select.Trigger>
          <Select.Content>
            <Select.Item value="0" label="Choose an account" />
            {#each accounts.filter((account) => eligible(item, account)) as account (account.id)}
              <Select.Item value={String(account.id)} label={`${account.code} — ${account.name}`} />
            {/each}
          </Select.Content>
        </Select.Root>
      </label>
    {/each}
  </div>
  <button
    type="button"
    class="mt-5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
    disabled={disabled ||
      saving ||
      defaults.some((item) => !selected[item.purpose])}
    onclick={save}
  >
    {saving ? "Saving…" : "Save defaults"}
  </button>
</section>
