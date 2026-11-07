<script lang="ts">
  import { resolve } from "$app/paths";
  import AccountsPage from "$lib/components/accounts/AccountsPage.svelte";
  import type { PageData, ActionData } from "./$types.js";

  let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<svelte:head><title>Accounts - Akaun</title></svelte:head>

<a class="asset-register-link" href={resolve("/(app)/assets")}
  >Fixed asset register and GL reconciliation</a
>
<AccountsPage {data} {form} />

<style>
  .asset-register-link {
    display: block;
    margin: 1rem 1.5rem;
    text-decoration: underline;
  }
</style>
