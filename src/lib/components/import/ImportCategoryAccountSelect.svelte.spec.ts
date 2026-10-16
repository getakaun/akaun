import { page } from "vitest/browser";
import { expect, it } from "vitest";
import { render } from "vitest-browser-svelte";
import { AccountSubType, AccountType } from "$lib/enums.js";
import type { AccountView } from "$lib/server/ledger/types.js";
import ImportCategoryAccountSelect from "./ImportCategoryAccountSelect.svelte";

it("offers contra revenue targets and displays the selected account", async () => {
  const account = {
    id: 1,
    code: 4001,
    name: "Sales discounts",
    type: AccountType.Revenue,
    subType: AccountSubType.ContraOperatingRevenue,
    active: true,
    postingEligible: true,
  } as AccountView;
  let selected: string | null = null;
  render(ImportCategoryAccountSelect, {
    accounts: [account],
    value: null,
    onChange: (value) => {
      selected = value;
    },
  });
  await expect
    .element(page.getByRole("button"))
    .toHaveTextContent("Select account");
  await page.getByRole("button").click();
  await expect
    .element(page.getByText("Contra revenue", { exact: true }))
    .toBeVisible();
  await page.getByRole("option", { name: "4001 · Sales discounts" }).click();
  await expect.poll(() => selected).toBe("1");
});
