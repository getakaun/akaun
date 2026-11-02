import { page } from "vitest/browser";
import { expect, it } from "vitest";
import { render } from "vitest-browser-svelte";
import { AccountSubType, AccountType } from "$lib/enums.js";
import type { AccountView } from "$lib/server/ledger/types.js";
import RecordForm from "./RecordForm.svelte";

const bank = {
  id: 1,
  code: 1000,
  name: "Bank",
  type: AccountType.Asset,
  subType: AccountSubType.Bank,
} as AccountView;
const categories = [
  {
    id: 2,
    code: 4000,
    name: "Sales",
    type: AccountType.Revenue,
    subType: null,
  },
  {
    id: 3,
    code: 4001,
    name: "Sales discounts",
    type: AccountType.Revenue,
    subType: AccountSubType.ContraOperatingRevenue,
  },
  {
    id: 4,
    code: 4002,
    name: "Other discounts",
    type: AccountType.Revenue,
    subType: AccountSubType.ContraOtherRevenue,
  },
  { id: 5, code: 5000, name: "Fuel", type: AccountType.Expense, subType: null },
  {
    id: 6,
    code: 4003,
    name: "Other income",
    type: AccountType.Revenue,
    subType: AccountSubType.OtherRevenue,
  },
  {
    id: 7,
    code: 1500,
    name: "Equipment",
    type: AccountType.Asset,
    subType: AccountSubType.FixedAsset,
  },
] as AccountView[];

function renderForm() {
  render(RecordForm, {
    accounts: [bank],
    categories,
    allAccounts: [bank, ...categories],
    canAdjust: false,
  });
}

it.each(["Sales discounts", "Other discounts"])(
  "predicts bank to %s as expense and offers only spending split categories",
  async (name) => {
    renderForm();
    await page
      .getByRole("button", { name: "Debit account", exact: true })
      .click();
    await page.getByRole("option", { name: new RegExp(name) }).click();
    await page.getByRole("button", { name: /Add.*line/i }).click();
    // Expense prediction fixes the category amount on the debit side.
    expect(
      document.querySelector(
        '.entry-lines > .entry-line:nth-child(2) input[inputmode="decimal"]',
      ),
    ).not.toBeNull();
    await page
      .getByRole("button", { name: "Choose an account", exact: true })
      .click();
    for (const category of categories) {
      const offered =
        category.name !== name &&
        category.name !== "Sales" &&
        category.name !== "Other income";
      const option = page.getByRole("option", {
        name: `${category.code} · ${category.name}`,
        exact: true,
      });
      if (offered) await expect.element(option).toBeVisible();
      else await expect.element(option).not.toBeInTheDocument();
    }
  },
);

it("excludes contra revenue from income split categories", async () => {
  renderForm();
  await page
    .getByRole("button", { name: "Credit account", exact: true })
    .click();
  await page.getByRole("option", { name: /4000 · Sales ·/ }).click();
  await page
    .getByRole("button", { name: "Debit account", exact: true })
    .click();
  await page.getByRole("option", { name: /1000 · Bank ·/ }).click();
  await page.getByRole("button", { name: /Add.*line/i }).click();
  await page
    .getByRole("button", { name: "Choose an account", exact: true })
    .click();
  await expect
    .poll(() => document.querySelectorAll('[role="option"]').length)
    .toBe(1);
  await expect
    .element(
      page.getByRole("option", { name: "4003 · Other income", exact: true }),
    )
    .toBeVisible();
});
