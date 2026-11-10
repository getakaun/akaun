<script lang="ts">
  import TaxWorksheetsPage from "$lib/components/tax-worksheets/TaxWorksheetsPage.svelte";
  import type { PageData } from "./$types.js";
  let { data }: { data: PageData } = $props();
</script>

<svelte:head><title>Annual tax - Akaun</title></svelte:head>
<TaxWorksheetsPage {data} />
