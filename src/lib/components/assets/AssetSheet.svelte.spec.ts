import { page } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render } from "vitest-browser-svelte";
import { AccountSubType, AccountType, LedgerRecordKind } from "$lib/enums.js";
import AssetSheet from "./AssetSheet.svelte";
import FixedAssetsPage from "./FixedAssetsPage.svelte";
import AssetDetail from "./AssetDetail.svelte";
import AssetDepreciation from "./AssetDepreciation.svelte";
import type { ComponentProps } from "svelte";
import type { RegisteredAsset } from "$lib/server/queries/fixed-assets.js";
import "../../../routes/layout.css";

vi.mock("$app/navigation", () => ({
  beforeNavigate: vi.fn(),
  afterNavigate: vi.fn(),
  goto: vi.fn(async () => {}),
  invalidateAll: vi.fn(async () => {}),
}));
vi.mock("$app/state", () => ({
  page: { url: new URL("https://akaun.test/assets") },
}));
vi.mock("$lib/sse.js", () => ({ createResourceStream: vi.fn() }));
afterEach(async () => {
  // Unmount sheets before resizing so their modal layers finish cleaning up.
  cleanup();
  vi.unstubAllGlobals();
  await page.viewport(1280, 900);
});

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
  await page.getByRole("button", { name: /^Unregistered/ }).click();
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
  await page.getByRole("button", { name: /^Unregistered/ }).click();
  await expect
    .element(page.getByRole("button", { name: "Register asset", exact: true }))
    .not.toBeInTheDocument();
  await page
    .getByRole("button", { name: "Reconciliation", exact: true })
    .click();
  await expect
    .element(
      page.getByRole("heading", { name: "Original cost reconciliation" }),
    )
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
    .element(page.getByRole("region", { name: "Saved purchase details" }))
    .toBeVisible();
  await expect
    .element(page.getByLabelText("Purchase date *"))
    .not.toBeInTheDocument();
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
  expect(body.inServiceDate).toBeNull();
  expect(body.serialNumber).toBe("");
  expect(body).not.toHaveProperty("costMinor");
  expect(body).not.toHaveProperty("openingAsAt");
  await expect
    .element(
      page.getByText("Opening values for existing assets", { exact: true }),
    )
    .not.toBeInTheDocument();
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

it("uses the shared button styling and keeps a long asset form inside the sheet", async () => {
  await page.viewport(1280, 900);
  render(AssetSheet, {
    accounts,
    canChange: true,
    onclose: vi.fn(),
    onsaved: vi.fn(async () => {}),
  });
  await expect.element(page.getByRole("dialog")).toBeVisible();
  const dialog = document.querySelector<HTMLElement>(
    '[data-slot="sheet-content"]',
  )!;
  const primary = page
    .getByRole("button", { name: "Register asset", exact: true })
    .element();
  const body = dialog.querySelector<HTMLElement>(".sheet-body")!;
  expect(getComputedStyle(primary).height).toBe("34px");
  expect(getComputedStyle(primary).paddingLeft).toBe("14px");
  expect(getComputedStyle(primary).borderRadius).toBe("8px");
  expect(getComputedStyle(dialog).overflowY).toBe("hidden");
  expect(getComputedStyle(body).overflowY).toBe("auto");
  expect(getComputedStyle(body).minHeight).toBe("0px");
  expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
  const footer = dialog.querySelector<HTMLElement>(".sheet-foot")!;
  expect(footer.getBoundingClientRect().bottom).toBeLessThanOrEqual(
    dialog.getBoundingClientRect().bottom + 1,
  );
});

it("keeps the asset sheet footer visible on a phone", async () => {
  await page.viewport(390, 844);
  render(AssetSheet, {
    accounts,
    canChange: true,
    onclose: vi.fn(),
    onsaved: vi.fn(async () => {}),
  });
  await expect.element(page.getByRole("dialog")).toBeVisible();
  const dialog = document.querySelector<HTMLElement>(
    '[data-slot="sheet-content"]',
  )!;
  await expect.poll(() => dialog.dataset.side).toBe("bottom");
  expect(dialog.getBoundingClientRect().width).toBeLessThanOrEqual(390);
  const button = page
    .getByRole("button", { name: "Register asset", exact: true })
    .element();
  await expect
    .poll(() => button.getBoundingClientRect().bottom)
    .toBeLessThanOrEqual(844);
  expect(getComputedStyle(button).height).toBe("34px");
});

it("styles Assets as a module with padded register rows", async () => {
  render(FixedAssetsPage, { data: registerData(true) });
  await expect
    .element(page.getByRole("heading", { name: "Assets", exact: true }))
    .toBeVisible();
  const primary = page
    .getByRole("button", { name: "Add existing asset", exact: true })
    .element();
  expect(getComputedStyle(primary).height).toBe("32px");
  await page.getByRole("button", { name: /^Unregistered/ }).click();
  const cell = document.querySelector<HTMLElement>(".table-card tbody td")!;
  expect(getComputedStyle(cell).paddingTop).toBe("13px");
  expect(getComputedStyle(cell).paddingLeft).toBe("14px");
});

const registeredAsset: RegisteredAsset = {
  id: 1,
  name: "Laptop",
  description: "",
  assetType: "Computer equipment",
  serialNumber: "",
  acquisitionDate: "2026-01-15",
  inServiceDate: "2026-02-01",
  assetAccountId: 1,
  costMinor: 600000,
  sourceMovementId: 12,
  sourceRecordId: 10,
  sourceSortOrder: 0,
  sourceSnapshot: {
    movementId: 12,
    recordId: 10,
    sortOrder: 0,
    recordDate: "2026-01-15",
    accountId: 1,
    amountMinor: 600000,
  },
  openingAsAt: null,
  broughtForwardDepMinor: 0,
  accumulatedDepreciationAccountId: null,
  openingRecordId: null,
  businessUseBps: null,
  documentReference: "",
  bookMethod: null,
  usefulLifeMonths: null,
  residualMinor: null,
  depreciationExpenseAccountId: null,
  createdBy: 1,
  createdAt: "2026-01-15",
  updatedBy: 1,
  revision: 1,
  accountName: "Computer equipment",
  source,
  sourceVersion: "source-v1",
  reviewReason: null,
  reviewIssues: [],
  canAcceptSource: false,
  postedDepreciationMinor: 0,
  accumulatedDepreciationMinor: 0,
  netBookValueMinor: 600000,
  version: "1",
  depreciation: {
    status: "depreciation-setup",
    dueCount: 0,
    firstDueMonth: null,
    lastPostedMonth: null,
    nextMonth: null,
    mode: null,
    reviewReason: null,
  },
};

it("uses the shared account dropdown and calendar in the create drawer", async () => {
  render(AssetSheet, {
    accounts,
    canChange: true,
    onclose: vi.fn(),
    onsaved: vi.fn(async () => {}),
  });
  await page
    .getByRole("button", { name: "Asset cost account *", exact: true })
    .click();
  await page
    .getByRole("option", { name: "Computer equipment", exact: true })
    .click();
  await expect
    .element(
      page.getByRole("button", { name: "Asset cost account *", exact: true }),
    )
    .toHaveTextContent("Computer equipment");
  expect(document.querySelector(".asset-form select")).toBeNull();
  await page
    .getByRole("button", { name: "Purchase date *", exact: true })
    .click();
  await expect.element(page.getByRole("grid")).toBeVisible();
});

it("opens an asset on the standard detail page with Activity and a dirty-only save bar", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json([])),
  );
  render(AssetDetail, {
    data: { asset: registeredAsset, accounts, canChange: true },
  });
  await expect
    .element(page.getByRole("heading", { name: "Laptop", exact: true }))
    .toBeVisible();
  expect(document.querySelector(".detail-grid")).not.toBeNull();
  await expect
    .element(page.getByText("No depreciation posted", { exact: true }))
    .toBeVisible();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await expect
    .element(page.getByText("Activity", { exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Save changes", exact: true }))
    .not.toBeInTheDocument();
  await page.getByLabelText("Asset name *").fill("Office laptop");
  await expect
    .element(page.getByRole("button", { name: "Save changes", exact: true }))
    .toBeVisible();
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await expect
    .element(page.getByLabelText("Asset name *"))
    .toHaveValue("Laptop");
  await expect
    .element(page.getByRole("button", { name: "Save changes", exact: true }))
    .not.toBeInTheDocument();
});

it("saves detail edits through the existing versioned asset operation", async () => {
  const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
    Response.json(
      init?.method === "PATCH"
        ? { ...registeredAsset, name: "Office laptop", revision: 2 }
        : [],
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  render(AssetDetail, {
    data: { asset: registeredAsset, accounts, canChange: true },
  });
  await page.getByLabelText("Asset name *").fill("Office laptop");
  await page
    .getByLabelText("Reason for change *")
    .fill("Update equipment label");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect
    .poll(
      () =>
        fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH")
          .length,
    )
    .toBe(1);
  const [url, init] = fetchMock.mock.calls.find(
    ([, init]) => init?.method === "PATCH",
  )!;
  expect(url).toBe("/api/fixed-assets/1");
  expect(JSON.parse(String(init?.body))).toMatchObject({
    name: "Office laptop",
    expectedVersion: "1",
    reason: "Update equipment label",
    inServiceDate: registeredAsset.inServiceDate,
    serialNumber: registeredAsset.serialNumber,
  });
  await expect
    .element(page.getByRole("button", { name: "Save changes", exact: true }))
    .not.toBeInTheDocument();
});

it("uses the same mobile row cards and header search as Accounts", async () => {
  await page.viewport(390, 844);
  const data = registerData(true);
  render(FixedAssetsPage, {
    data: {
      ...data,
      register: { ...data.register, assets: [registeredAsset] },
    },
  });
  const row = document.querySelector<HTMLElement>(".exp-row")!;
  expect(getComputedStyle(row).display).toBe("flex");
  await expect
    .element(page.getByRole("link", { name: /Laptop/ }))
    .toHaveAttribute("href", "/assets/1");
  await page
    .getByRole("button", { name: "Search assets", exact: true })
    .click();
  await page
    .getByRole("searchbox", { name: "Search assets or purchases on mobile" })
    .fill("No such equipment");
  await expect
    .element(page.getByText("Nothing to show", { exact: true }))
    .toBeVisible();
});

it("shows description directly and saves a preset asset type from the shared select", async () => {
  const fetchMock = vi.fn(async () =>
    Response.json({ id: 1 }, { status: 201 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  render(AssetSheet, {
    source,
    accounts,
    canChange: true,
    onclose: vi.fn(),
    onsaved: vi.fn(async () => {}),
  });
  await expect.element(page.getByLabelText("Description")).toBeVisible();
  await expect
    .element(page.getByLabelText("Serial number"))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByText("In-service date", { exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByText("More details", { exact: true }))
    .not.toBeInTheDocument();
  await page
    .getByLabelText("Description")
    .fill("Delivery van for customer orders");
  await page.getByRole("button", { name: "Asset type *", exact: true }).click();
  for (const type of [
    "Computer equipment",
    "Office equipment",
    "Furniture",
    "Fixtures and fittings",
    "Motor vehicle",
    "Machinery",
    "Buildings",
    "Land",
    "Other",
  ]) {
    await expect
      .element(page.getByRole("option", { name: type, exact: true }))
      .toBeVisible();
  }
  await page
    .getByRole("option", { name: "Motor vehicle", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Register asset", exact: true })
    .click();
  await expect.poll(() => fetchMock.mock.calls.length).toBe(1);
  const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(JSON.parse(String(init.body))).toMatchObject({
    assetType: "Motor vehicle",
    description: "Delivery van for customer orders",
    inServiceDate: null,
    serialNumber: "",
  });
});

it("preserves a saved custom type and retired fields when editing", async () => {
  const asset = {
    ...registeredAsset,
    assetType: "Specialist laboratory equipment",
    serialNumber: "LAB-123",
    accumulatedDepreciationAccountId: 2,
  };
  const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
    Response.json(init?.method === "PATCH" ? { ...asset, revision: 2 } : []),
  );
  vi.stubGlobal("fetch", fetchMock);
  render(AssetDetail, { data: { asset, accounts, canChange: true } });
  await expect
    .element(
      page.getByRole("button", {
        name: "Accumulated depreciation account *",
        exact: true,
      }),
    )
    .toHaveTextContent("Accumulated depreciation");
  await page.getByRole("button", { name: "Asset type *", exact: true }).click();
  await expect
    .element(page.getByRole("option", { name: asset.assetType, exact: true }))
    .toBeVisible();
  await page
    .getByRole("option", { name: asset.assetType, exact: true })
    .click();
  await page.getByLabelText("Description").fill("Updated description");
  await page
    .getByLabelText("Reason for change *")
    .fill("Clarify asset purpose");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect
    .poll(
      () =>
        fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH")
          .length,
    )
    .toBe(1);
  const [, init] = fetchMock.mock.calls.find(
    ([, init]) => init?.method === "PATCH",
  )!;
  expect(JSON.parse(String(init?.body))).toMatchObject({
    assetType: asset.assetType,
    serialNumber: "LAB-123",
    inServiceDate: "2026-02-01",
    description: "Updated description",
  });
});

const postingAccounts = [
  ...accounts,
  {
    id: 3,
    name: "Depreciation expense",
    type: AccountType.Expense,
    subType: null,
    active: true,
  },
];
function depreciationData(): ComponentProps<typeof AssetDepreciation>["data"] {
  return {
    asset: registeredAsset,
    profiles: [],
    rows: [],
    history: [],
    allocations: [],
    version: "dep-v1",
    hasDue: false,
    postingIssue: null,
    defaults: { expenseAccountId: null, accumulatedAccountId: null },
    manualCandidates: [],
    reconciliation: null,
    historyReview: [],
    asAt: "2026-11-10",
    postedMinor: 0,
    scheduleReviewReason: null,
    accumulatedMinor: 0,
    nbvMinor: 600000,
    canConfigure: true,
    canReverse: true,
  };
}

it("requires existing posting accounts before previewing depreciation", async () => {
  const fetchMock = vi.fn(async () =>
    Response.json({
      version: "preview-v1",
      baseNbvMinor: 600000,
      schedule: [
        { month: "2026-02", amountMinor: 16666, projectedNbvMinor: 583334 },
      ],
      history: {
        count: 0,
        closedMonths: [],
        totalMinor: 0,
        from: null,
        through: null,
      },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  render(AssetDepreciation, {
    data: depreciationData(),
    accounts: postingAccounts,
    onsaved: vi.fn(async () => {}),
  });
  await page
    .getByRole("button", { name: "Set up depreciation", exact: true })
    .click();
  await expect
    .element(
      page.getByRole("button", {
        name: "Depreciation expense account *",
        exact: true,
      }),
    )
    .toBeVisible();
  await expect
    .element(
      page.getByRole("button", {
        name: "Accumulated depreciation account *",
        exact: true,
      }),
    )
    .toBeVisible();
  await expect
    .element(
      page.getByRole("link", { name: "Create missing accounts in Accounts" }),
    )
    .toHaveAttribute("href", "/accounts");
  await page
    .getByRole("button", { name: "Preview schedule", exact: true })
    .click();
  expect(fetchMock).not.toHaveBeenCalled();
  await page
    .getByRole("button", {
      name: "Depreciation expense account *",
      exact: true,
    })
    .click();
  await page
    .getByRole("option", { name: "Depreciation expense", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "Accumulated depreciation account *",
      exact: true,
    })
    .click();
  await expect
    .element(
      page.getByRole("option", { name: "Computer equipment", exact: true }),
    )
    .not.toBeInTheDocument();
  await page
    .getByRole("option", { name: "Accumulated depreciation", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Preview schedule", exact: true })
    .click();
  await expect.poll(() => fetchMock.mock.calls.length).toBe(1);
  const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(JSON.parse(String(init.body))).toMatchObject({
    action: "preview",
    input: { expenseAccountId: 3, accumulatedAccountId: 2 },
  });
});

it("shows saved posting accounts directly when setting up depreciation", async () => {
  const data = depreciationData();
  data.defaults = { expenseAccountId: 3, accumulatedAccountId: 2 };
  render(AssetDepreciation, {
    data,
    accounts: postingAccounts,
    onsaved: vi.fn(async () => {}),
  });
  await page
    .getByRole("button", { name: "Set up depreciation", exact: true })
    .click();
  await expect
    .element(
      page.getByRole("button", {
        name: "Depreciation expense account *",
        exact: true,
      }),
    )
    .toHaveTextContent("Depreciation expense");
  await expect
    .element(
      page.getByRole("button", {
        name: "Accumulated depreciation account *",
        exact: true,
      }),
    )
    .toHaveTextContent("Accumulated depreciation");
});

it("shows only status chips and review warnings in the registered asset status column", async () => {
  await page.viewport(1280, 900);
  const data = registerData(true);
  const asset: RegisteredAsset = {
    ...registeredAsset,
    depreciation: {
      status: "depreciation-pending",
      dueCount: 3,
      firstDueMonth: "2026-06",
      lastPostedMonth: "2026-05",
      nextMonth: "2026-09",
      mode: "auto",
      reviewReason:
        "Source purchase details changed. Review before accepting new values.",
    },
  };
  render(FixedAssetsPage, {
    data: { ...data, register: { ...data.register, assets: [asset] } },
  });
  await expect
    .element(page.getByRole("columnheader", { name: "Status", exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByRole("columnheader", { name: "Review", exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByText("Pending posting", { exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByText("Needs review", { exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByText("3 months pending · from 2026-06", { exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByText("Last posted 2026-05", { exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByText("Auto-post enabled", { exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByText("Source linked", { exact: true }))
    .not.toBeInTheDocument();
});

it("keeps asset setup status visible on phone row cards", async () => {
  await page.viewport(390, 844);
  const data = registerData(true);
  render(FixedAssetsPage, {
    data: {
      ...data,
      register: { ...data.register, assets: [registeredAsset] },
    },
  });
  await expect
    .element(page.getByText("Setup needed", { exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByText("No depreciation posted", { exact: true }))
    .not.toBeInTheDocument();
  const statusCell = document.querySelector<HTMLElement>(
    '[data-label="Status"]',
  )!;
  expect(statusCell.getBoundingClientRect().right).toBeLessThanOrEqual(390);
});

it.each([1280, 390])(
  "keeps structured asset activity compact and readable at %ipx",
  async (width) => {
    await page.viewport(width, 844);
    const longReference = "supporting-document-".repeat(150);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json([
          {
            id: 100,
            action: "update",
            createdAt: "2026-11-10 08:00:00",
            userId: 1,
            userName: "Alice",
            via: "session",
            credentialLabel: null,
            changes: [
              {
                field: "depreciationProfile",
                before: null,
                after: {
                  months: 36,
                  residualMinor: 123456,
                  mode: "auto",
                  basis: JSON.stringify([
                    600000,
                    1,
                    "2026-01-15",
                    null,
                    null,
                    0,
                  ]),
                },
              },
              {
                field: "documentReference",
                before: "Old reference",
                after: longReference,
              },
            ],
          },
        ]),
      ),
    );
    render(AssetDetail, {
      data: { asset: registeredAsset, accounts, canChange: true },
    });
    const viewMore = page.getByRole("button", {
      name: "View more",
      exact: true,
    });
    await expect.element(viewMore).toBeVisible();
    await expect.element(viewMore).toHaveAttribute("aria-expanded", "false");
    await expect
      .element(
        page.getByText("Depreciation setup · Useful life (months):", {
          exact: true,
        }),
      )
      .toBeVisible();
    await expect.element(page.getByText("36", { exact: true })).toBeVisible();
    await expect
      .element(page.getByText("1,234.56", { exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByText(longReference, { exact: true }))
      .not.toBeInTheDocument();
    const activity = document.querySelector<HTMLElement>(".audit-list")!;
    expect(activity.scrollWidth).toBeLessThanOrEqual(activity.clientWidth + 1);
    const collapsedHeight = activity.getBoundingClientRect().height;
    await viewMore.click();
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    await expect
      .element(
        page.getByText(
          "Depreciation setup · Financial basis · Original cost:",
          { exact: true },
        ),
      )
      .toBeVisible();
    await expect
      .element(page.getByText("Auto-post monthly", { exact: true }))
      .toBeVisible();
    await expect
      .element(
        page.getByText(
          "Depreciation setup · Financial basis · In service date:",
          { exact: true },
        ),
      )
      .not.toBeInTheDocument();
    await expect
      .element(page.getByText("Old reference", { exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByText(longReference, { exact: true }))
      .toBeVisible();
    expect(activity.scrollWidth).toBeLessThanOrEqual(activity.clientWidth + 1);
    expect(activity.getBoundingClientRect().right).toBeLessThanOrEqual(width);
    expect(activity.getBoundingClientRect().height).toBeGreaterThan(
      collapsedHeight,
    );
    const viewLess = page.getByRole("button", {
      name: "View less",
      exact: true,
    });
    await expect.element(viewLess).toHaveAttribute("aria-expanded", "true");
    await viewLess.click();
    await expect.element(viewMore).toHaveAttribute("aria-expanded", "false");
    await expect
      .element(page.getByText(longReference, { exact: true }))
      .not.toBeInTheDocument();
  },
);
