<script lang="ts">
  import type { PageData, ActionData } from "./$types.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import {
    SCOPE_LABELS,
    scopeTier,
    type ScopeTier,
  } from "$lib/permissions/oauth-scopes.js";
  let { data, form }: { data: PageData; form: ActionData } = $props();

  const tiers: { tier: ScopeTier; heading: string; note: string | null }[] = [
    { tier: "read", heading: "Read", note: null },
    {
      tier: "write",
      heading: "Change",
      note: "The app can record and change things in your books, as you could yourself. Changes are saved straight away and appear in the audit trail under your name.",
    },
    {
      tier: "delete",
      heading: "Delete",
      note: "The app can permanently remove what you could remove yourself. A deleted record cannot be restored.",
    },
    {
      tier: "adjust",
      heading: "Adjust",
      note: "The app can post journals and records between any accounts. These can change any balance and still add up, so allow this only for an app you trust with your books.",
    },
    {
      tier: "correct",
      heading: "Corrections",
      note: "The app can perform the selected corrections with a reason and review. Grouped correction access covers payment allocations and payees, settled dates and reimbursement amounts. These changes can affect previously finalized reports and balances. Your role and delegation permissions still limit each operation.",
    },
  ];
  const groups = $derived(
    tiers
      .map((t) => ({
        ...t,
        items: data.scopes.filter((s) => scopeTier(s.scope) === t.tier),
      }))
      .filter((g) => g.items.length > 0),
  );
</script>

<svelte:head><title>Connect app - Akaun</title></svelte:head>
<main
  class="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-6 p-6"
>
  <img src="/icons/icon-192.png" alt="Akaun" class="size-16" />
  <h1 class="text-2xl font-semibold">Connect {data.clientName}</h1>
  <p>Signed in as <strong>{data.username}</strong> on {data.instance}.</p>
  <p>
    This app is requesting access to your bookkeeping data. Choose the
    permissions you want to allow. It can never do more than your Akaun account
    can.
  </p>
  <p class="text-muted-foreground text-sm">
    The app name is supplied by the client. Client ID: {data.clientId}
  </p>
  <form method="POST" class="flex flex-col gap-6">
    {#each groups as group (group.tier)}
      <fieldset class="flex flex-col gap-3">
        <legend class="mb-1 font-medium">{group.heading}</legend>
        {#if group.note}
          <p
            class="text-sm {group.tier === 'delete' ||
            group.tier === 'adjust' ||
            group.tier === 'correct'
              ? 'text-destructive'
              : 'text-muted-foreground'}"
          >
            {group.note}
          </p>
        {/if}
        {#each group.items as item (item.scope)}
          <label class="flex items-start gap-3">
            <input
              type="checkbox"
              name="scope"
              value={item.scope}
              checked={item.preselected}
              disabled={!item.allowed}
              class="mt-1"
            />
            <span
              >{SCOPE_LABELS[item.scope] ?? item.scope}<span
                class="text-muted-foreground block text-xs"
                >Includes: {item.includes.join(", ")}</span
              >{#if !item.allowed}<span
                  class="text-muted-foreground block text-sm"
                  >{item.reason === "ceiling"
                    ? "Your administrator does not allow apps to do this."
                    : "Your account does not have this permission."}</span
                >{/if}</span
            >
          </label>
        {/each}
      </fieldset>
    {/each}
    {#if form?.error}<p role="alert" class="text-destructive">
        {form.error}
      </p>{/if}
    <div class="mt-4 flex gap-3">
      <Button
        type="submit"
        name="decision"
        value="approve"
        disabled={!data.scopes.some((s) => s.allowed)}
        >Allow selected access</Button
      >
      <Button type="submit" name="decision" value="deny" variant="outline"
        >Cancel</Button
      >
    </div>
  </form>
</main>
