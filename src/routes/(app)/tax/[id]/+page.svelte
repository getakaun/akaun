<script lang="ts">
  import TaxWorksheetDetail from "$lib/components/tax-worksheets/TaxWorksheetDetail.svelte";
  import type { PageData } from "./$types.js";
  let { data }: { data: PageData } = $props();
</script>

<svelte:head
  ><title>YA {data.detail.worksheet.ya} - Annual tax - Akaun</title
  ></svelte:head
>
{#key data.detail.worksheet.id}<TaxWorksheetDetail {data} />{/key}
