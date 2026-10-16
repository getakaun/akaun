<script lang="ts">
  import * as Select from "$lib/components/ui/select/index.js";
  import { isContraRevenueAccount } from "$lib/account-classification.js";
  import { AccountType } from "$lib/enums.js";
  import type { AccountView } from "$lib/server/ledger/types.js";

  let {
    accounts,
    value,
    onChange,
  }: {
    accounts: AccountView[];
    value: number | null;
    onChange: (value: string) => void;
  } = $props();

  const orderedGroups = $derived([
    { label: "Contra revenue", accounts: accounts.filter(isContraRevenueAccount) },
    {
      label: "Expense",
      accounts: accounts.filter(
        (account) => account.type === AccountType.Expense,
      ),
    },
    {
      label: "Assets",
      accounts: accounts.filter(
        (account) => account.type === AccountType.Asset,
      ),
    },
  ]);

  function label(account: AccountView): string {
    return `${account.code} · ${account.name}`;
  }
</script>

<Select.Root
  type="single"
  value={value == null ? "" : String(value)}
  onValueChange={(next) => next != null && onChange(next)}
>
  <Select.Trigger class="rinput w-full">
    {#if value == null}
      Select account
    {:else}
      {@const selected = accounts.find((account) => account.id === value)}
      {selected ? label(selected) : "Select account"}
    {/if}
  </Select.Trigger>
  <Select.Content>
    {#each orderedGroups as group (group.label)}
      {#if group.accounts.length > 0}
        <Select.Group>
          <Select.GroupHeading>{group.label}</Select.GroupHeading>
          {#each group.accounts as account (account.id)}
            <Select.Item value={String(account.id)} label={label(account)} />
          {/each}
        </Select.Group>
      {/if}
    {/each}
  </Select.Content>
</Select.Root>
