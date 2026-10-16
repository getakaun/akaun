<script lang="ts">
  import { AccountTypeDisplayLabels } from "$lib/enums.js";
  import * as Select from "$lib/components/ui/select/index.js";
  import type { AccountView } from "$lib/server/ledger/types.js";

  const NONE_VALUE = "__none__";

  /**
   * The one control that answers "which account paid?" / "which account
   * received it?".
   *
   * Two rules make it invisible when it should be (FR-011, SC-009):
   *
   *  - it starts on the default account, so the common case needs no thought;
   *  - when there is only one account to choose from, there is no question to
   *    ask, so it renders as a plain line of text and a hidden field rather
   *    than a picker with one option in it.
   *
   * A business that never opens a second account should never learn that
   * accounts exist.
   */
  let {
    accounts,
    allAccounts = [],
    canAdjust = false,
    value = $bindable<number | null>(null),
    name,
    label = "Account",
    defaultAccountId = null,
    required = true,
    disabled = false,
    disabledReason = "",
    bare = false,
  }: {
    /** The shortlist: the accounts this side would sensibly be. */
    accounts: AccountView[];
    /** Every account, offered in place of the shortlist for a user with `adjustments`. */
    allAccounts?: AccountView[];
    canAdjust?: boolean;
    value?: number | null;
    name: string;
    label?: string;
    defaultAccountId?: number | null;
    required?: boolean;
    disabled?: boolean;
    disabledReason?: string;
    /**
     * Drop the `.field` wrapper and the label: the caller has already said
     * what this side is. `EntryBlock` uses it, where the row's own columns
     * name the direction and a second label would only break the alignment.
     * Every rule about *what* is offered stays here — there is one picker.
     */
    bare?: boolean;
  } = $props();

  // Each side offers the accounts it would sensibly be — categories for what a
  // record was for, money pots for where it came from or went. That shortlist
  // is what makes the form answerable without knowing the chart of accounts
  // exists. A user with `adjustments` gets the whole chart instead, because a
  // record between any two accounts is exactly what that ability is for
  // (FR-008a, FR-031).
  const offered = $derived(
    canAdjust && allAccounts.length > 0 ? allAccounts : accounts,
  );

  // Archived accounts stay out of the picker but never disappear from history.
  const choices = $derived(
    offered
      .filter(
        (a) =>
          ((a.active ?? a.archivedAt == null) && (a.postingEligible ?? true)) ||
          a.id === value,
      )
      .sort((a, b) => a.type - b.type || (a.code ?? a.id) - (b.code ?? b.id)),
  );

  // Pre-select once there is something to select. Guarded on `value` being
  // unset so re-running this never overwrites what the user picked.
  $effect(() => {
    if (value != null || choices.length === 0) return;
    const preferred = choices.find((a) => a.id === defaultAccountId);
    value = (preferred ?? choices[0]).id;
  });

  const onlyChoice = $derived(choices.length === 1 ? choices[0] : null);
  const id = $derived(`account-select-${name}`);

  function accountLabel(account: AccountView): string {
    return `${account.code} · ${account.name} · ${AccountTypeDisplayLabels[account.type]}`;
  }

  function selectAccount(next: string | null): void {
    if (next === null) return;
    if (next === NONE_VALUE) {
      value = null;
      return;
    }
    const accountId = Number(next);
    if (
      Number.isInteger(accountId) &&
      choices.some((account) => account.id === accountId)
    ) {
      value = accountId;
    }
  }
</script>

{#if onlyChoice}
  <!-- One account means no question to ask. Bare mode still says which one it
	     is, because there it is a line of the entry rather than a field the
	     reader can skip. -->
  <input type="hidden" {name} value={onlyChoice.id} />
  {#if bare}
    <span class="only-choice">{onlyChoice.name}</span>
  {/if}
{:else if choices.length > 0}
  <div class={bare ? "bare" : "field"}>
    {#if !bare}
      <label class="field-label" for={id}>{label}{required ? " *" : ""}</label>
    {/if}
    <input type="hidden" {name} value={value ?? ""} {disabled} />
    <Select.Root
      type="single"
      value={value === null ? NONE_VALUE : String(value)}
      onValueChange={selectAccount}
    >
      <Select.Trigger
        {id}
        {disabled}
        class="account-select w-full justify-between"
        aria-label={bare ? label : undefined}
      >
        {#if value === null}
          Accounts payable (paid by another party)
        {:else}
          {@const selected = choices.find((account) => account.id === value)}
          {selected ? accountLabel(selected) : "Select account"}
        {/if}
      </Select.Trigger>
      <Select.Content>
        {#if !required}
          <Select.Item value={NONE_VALUE} label="Accounts payable (paid by another party)" />
        {/if}
        {#each choices as account (account.id)}
          <Select.Item
            value={String(account.id)}
            label={accountLabel(account)}
          />
        {/each}
      </Select.Content>
    </Select.Root>
    {#if disabled && disabledReason}
      <p class="hint">{disabledReason}</p>
    {/if}
  </div>
{/if}

<style>
  .only-choice {
    font-size: 13.5px;
  }
  .bare {
    min-width: 0;
  }
</style>
