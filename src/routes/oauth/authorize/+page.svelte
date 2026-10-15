<script lang="ts">
  import type { PageData, ActionData } from "./$types.js";
  import { Button } from "$lib/components/ui/button/index.js";
  let { data, form }: { data: PageData; form: ActionData } = $props();
  const labels: Record<string, string> = {
    "records:read": "Read records, their attached files, statements and outstanding amounts",
    "accounts:read": "Read accounts and balances",
    "contacts:read": "Read contacts",
    "reports:read": "Read financial reports",
    "import:read": "Read import jobs and extracted documents",
  };
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
    permissions you want to allow. It can only read data your Akaun account can
    view.
  </p>
  <p class="text-muted-foreground text-sm">
    The app name is supplied by the client. Client ID: {data.clientId}
  </p>
  <form method="POST" class="flex flex-col gap-4">
    {#each data.scopes as item (item.scope)}
      <label class="flex items-start gap-3">
        <input
          type="checkbox"
          name="scope"
          value={item.scope}
          checked={item.allowed}
          disabled={!item.allowed}
          class="mt-1"
        />
        <span
          >{labels[item.scope]}{#if !item.allowed}<span
              class="text-muted-foreground block text-sm"
              >Your account does not have this permission.</span
            >{/if}</span
        >
      </label>
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
