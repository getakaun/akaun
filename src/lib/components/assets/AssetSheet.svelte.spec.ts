import { page } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { AccountSubType, AccountType, LedgerRecordKind } from "$lib/enums.js";
import AssetSheet from "./AssetSheet.svelte";
import FixedAssetsPage from "./FixedAssetsPage.svelte";

vi.mock("$app/navigation", () => ({
  beforeNavigate: vi.fn(),
  invalidateAll: vi.fn(async () => {}),
}));
vi.mock("$app/state", () => ({
  page: { url: new URL("https://akaun.test/accounts/fixed-assets") },
}));
vi.mock("$lib/sse.js", () => ({ createResourceStream: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());

const accounts = [
  {
    id: 1,
    name: "Computer equipment",
    type: AccountType.Asset,
    subType: AccountSubType.FixedAsset,
    active: true,
  },
  {
    id: 2,
    name: "Accumulated depreciation",
    type: AccountType.Asset,
    subType: AccountSubType.OtherNonCurrentAsset,
    active: true,
  },
];
const source = {
  movementId: 12,
  recordId: 10,
  sortOrder: 0,
  recordDate: "2026-01-15",
  accountId: 1,
  accountName: "Computer equipment",
  type: AccountType.Asset,
  subType: AccountSubType.FixedAsset,
  amountMinor: 600000,
  recordNumber: "EX-10",
  description: "Laptop",
  label: null,
  kind: LedgerRecordKind.Expense,
  voided: 0,
};

function registerData(canChange: boolean) {
  return {
    canChange,
    register: {
      asAt: "2026-12-31",
      accounts,
      assets: [],
      unregistered: [source],
      costReconciliation: [
        {
          accountId: 1,
          accountName: "Computer equipment",
          registerMinor: 0,
          ledgerMinor: 600000,
          differenceMinor: 600000,
          unregisteredCount: 1,
          reviewCount: 0,
          exceptions: [source],
        },
      ],
      depreciationReconciliation: [],
      totalCostMinor: 0,
      totalOpeningDepMinor: 0,
    },
  };
}

it("opens the same registration form from unregistered purchases", async () => {
  render(FixedAssetsPage, { data: registerData(true) });
  await page
    .getByRole("button", { name: "Unregistered purchases", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Register asset", exact: true })
    .click();
  await expect
    .element(page.getByRole("heading", { name: "Register asset", exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByLabelText("Asset name *"))
    .toHaveValue("Laptop");
});

it("shows reconciliation exceptions to readers while withholding registration actions", async () => {
  render(FixedAssetsPage, { data: registerData(false) });
  await expect
    .element(
      page.getByRole("button", { name: "Add existing asset", exact: true }),
    )
    .not.toBeInTheDocument();
  await page
    .getByRole("button", { name: "Unregistered purchases", exact: true })
    .click();
  await expect
    .element(page.getByRole("button", { name: "Register asset", exact: true }))
    .not.toBeInTheDocument();
  await page
    .getByRole("button", { name: "Reconciliation", exact: true })
    .click();
  await expect
    .element(page.getByRole("heading", { name: "Gross cost reconciliation" }))
    .toBeVisible();
  await expect
    .element(page.getByText("1 unregistered · 0 source reviews"))
    .toBeVisible();
  await expect
    .element(
      page.getByRole("heading", {
        name: "Accumulated depreciation reconciliation",
      }),
    )
    .toBeVisible();
});

it("registers a saved purchase with source-derived cost and no opening or ledger request", async () => {
  const fetchMock = vi.fn(async () =>
    Response.json({ id: 1 }, { status: 201 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const onsaved = vi.fn(async () => {});
  render(AssetSheet, {
    source,
    accounts,
    canChange: true,
    onclose: vi.fn(),
    onsaved,
  });
  await expect.element(page.getByRole("dialog")).toBeVisible();
  await expect
    .element(page.getByLabelText("Acquisition date *"))
    .toHaveAttribute("readonly");
  await page
    .getByRole("button", { name: "Register asset", exact: true })
    .click();
  await expect.poll(() => fetchMock.mock.calls.length).toBe(1);
  const [url, init] = fetchMock.mock.calls[0] as unknown as [
    string,
    RequestInit,
  ];
  expect(url).toBe("/api/fixed-assets");
  const body = JSON.parse(String(init.body));
  expect(body.sourceMovementId).toBe(12);
  expect(body).not.toHaveProperty("costMinor");
  expect(body).not.toHaveProperty("openingAsAt");
  await expect.poll(() => onsaved.mock.calls.length).toBe(1);
});

it("requires evidence for an existing asset and keeps opening depreciation explicit", async () => {
  vi.stubGlobal("fetch", vi.fn());
  render(AssetSheet, {
    accounts,
    canChange: true,
    onclose: vi.fn(),
    onsaved: vi.fn(async () => {}),
  });
  await expect
    .element(page.getByRole("heading", { name: "Add existing asset" }))
    .toBeVisible();
  await expect.element(page.getByLabelText("Original cost *")).toBeVisible();
  await expect
    .element(page.getByLabelText("Accumulated depreciation brought forward *"))
    .toHaveValue("0.00");
  await expect
    .element(page.getByLabelText("Supporting-document reference *"))
    .toHaveAttribute("required");
});

it("protects unsaved asset details on close", async () => {
  const onclose = vi.fn();
  render(AssetSheet, {
    source,
    accounts,
    canChange: true,
    onclose,
    onsaved: vi.fn(async () => {}),
  });
  await page.getByLabelText("Asset name *").fill("Edited laptop");
  await page.getByRole("button", { name: "Close asset", exact: true }).click();
  await expect.element(page.getByRole("alertdialog")).toBeVisible();
  expect(onclose).not.toHaveBeenCalled();
  await page
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  expect(onclose).toHaveBeenCalledOnce();
});
