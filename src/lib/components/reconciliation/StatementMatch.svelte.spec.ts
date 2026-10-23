import { page } from "vitest/browser";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import type { ComponentProps } from "svelte";
import StatementMatch from "./StatementMatch.svelte";
import { beforeNavigate, goto } from "$app/navigation";

vi.mock("$app/navigation", () => ({
  afterNavigate: vi.fn(),
  beforeNavigate: vi.fn(),
  goto: vi.fn(),
  invalidateAll: vi.fn(),
  replaceState: vi.fn(),
}));
vi.mock("$app/state", () => ({
  page: {
    url: new URL("http://localhost/accounts/1/reconcile/1?movement=1"),
    state: {},
  },
}));
vi.mock("$lib/sse.js", () => ({ createResourceStream: vi.fn() }));

it("toggles matched records and transactions independently while preserving record order", async () => {
  type Data = ComponentProps<typeof StatementMatch>["data"];
  const movement = (
    movementId: number,
    date: string,
    overrides: Partial<Data["movements"][number]> = {},
  ) => ({
    movementId,
    accountId: 1,
    amount: 10,
    amountMinor: 1000,
    remainingAmount: 10,
    allocatedAmount: 0,
    suggestedLineIds: [],
    label: `Record ${movementId}`,
    date,
    ...overrides,
  });
  const data = {
    account: { id: 1, name: "Bank" },
    accounts: [],
    transferTargetIds: [],
    statement: {
      id: 1,
      originalFilename: "Statement",
      createdAt: "2026-10-23",
      totalLines: 0,
      matchedCount: 0,
    },
    permissions: { match: true },
    allocations: [],
    lines: [
      {
        id: 20,
        description: "Completed transaction",
        allocatedAmount: 10,
        remainingAmount: 0,
      },
      {
        id: 21,
        description: "Partial transaction",
        allocatedAmount: 5,
        remainingAmount: 5,
      },
      {
        id: 22,
        description: "Overallocated transaction",
        allocatedAmount: 11,
        remainingAmount: -1,
      },
      {
        id: 23,
        description: "Unmatched transaction",
        allocatedAmount: 0,
        remainingAmount: 10,
      },
    ].map((line) => ({
      accountId: 1,
      amount: 10,
      date: "2026-10-23",
      direction: 1,
      ...line,
    })),
    movements: [
      movement(9, "2026-10-23", { suggestedLineIds: [1] }),
      movement(8, "2026-10-22", { allocatedAmount: 5, remainingAmount: 5 }),
      movement(7, "2026-10-21"),
      movement(6, "2026-10-20", { suggestionConflict: true }),
      movement(5, "2026-10-19", { suggestedLineIds: [2] }),
      movement(4, "2026-10-18", { allocatedAmount: 5, remainingAmount: 5 }),
      movement(3, "2026-10-17"),
      movement(2, "2026-10-16", { suggestionConflict: true }),
      movement(12, "2026-10-19", { suggestedLineIds: [3] }),
      movement(10, "2026-10-15", { allocatedAmount: 10, remainingAmount: 0 }),
      movement(11, "2026-10-15", {
        allocatedAmount: 10,
        remainingAmount: 0.001,
      }),
      movement(13, "2026-10-20", { allocatedAmount: 11, remainingAmount: -1 }),
    ],
  } as unknown as Data;
  const { container, rerender } = render(StatementMatch, { data });
  const labels = () =>
    Array.from(
      container.querySelectorAll(".record-pane .cell-itemname"),
      (cell) => cell.textContent,
    );
  const transactions = () =>
    Array.from(
      container.querySelectorAll(".statement-line-copy strong"),
      (cell) => cell.textContent,
    );
  const recordsToggle = page.getByRole("switch", {
    name: "Show matched records",
  });
  const transactionsToggle = page.getByRole("switch", {
    name: "Show matched transactions",
  });
  await expect.element(recordsToggle).not.toBeChecked();
  await expect.element(transactionsToggle).not.toBeChecked();
  await expect
    .poll(transactions)
    .toEqual([
      "Partial transaction",
      "Overallocated transaction",
      "Unmatched transaction",
    ]);

  await expect
    .poll(labels)
    .toEqual([
      "Record 5",
      "Record 12",
      "Record 9",
      "Record 4",
      "Record 13",
      "Record 8",
      "Record 3",
      "Record 7",
      "Record 2",
      "Record 6",
    ]);
  await page
    .getByRole("searchbox", { name: "Search records" })
    .fill("Record 1");
  await expect.poll(labels).toEqual(["Record 12", "Record 13"]);
  await recordsToggle.click();
  await expect
    .poll(labels)
    .toEqual(["Record 12", "Record 13", "Record 10", "Record 11"]);
  await expect.poll(transactions).toHaveLength(3);
  await transactionsToggle.click();
  await expect
    .poll(transactions)
    .toEqual([
      "Completed transaction",
      "Partial transaction",
      "Overallocated transaction",
      "Unmatched transaction",
    ]);
  await recordsToggle.click();
  await expect.poll(labels).toEqual(["Record 12", "Record 13"]);
  await expect.poll(transactions).toHaveLength(4);
  await transactionsToggle.click();
  await expect.poll(transactions).toHaveLength(3);
  await page.getByRole("searchbox", { name: "Search records" }).fill("");

  // A fresh loader snapshot after saving must remove the completed record.
  await rerender({
    data: {
      ...data,
      movements: data.movements.map((row) => ({
        ...row,
        allocatedAmount: 10,
        remainingAmount: 0,
      })),
      lines: data.lines.map((line) => ({
        ...line,
        allocatedAmount: 10,
        remainingAmount: 0,
      })),
    },
  });
  await expect.poll(labels).toEqual([]);
  await expect
    .element(page.getByText("Nothing to match", { exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByText("All transactions matched", { exact: true }))
    .toBeVisible();
  await transactionsToggle.click();
  await expect.poll(transactions).toHaveLength(4);
});

it("discards unsaved suggestions before retrying navigation and keeps cancellation guarded", async () => {
  const data = {
    account: { id: 1, name: "Bank" },
    accounts: [],
    statement: {
      id: 1,
      originalFilename: "Statement",
      createdAt: "2026-10-21",
      totalLines: 1,
      matchedCount: 0,
    },
    permissions: { match: true },
    allocations: [],
    movements: [
      {
        movementId: 1,
        accountId: 1,
        amount: 10,
        amountMinor: 1000,
        remainingAmount: 10,
        allocatedAmount: 0,
        suggestedLineIds: [1],
        label: "Sale",
        date: "2026-10-21",
      },
    ],
    lines: [
      {
        id: 1,
        accountId: 1,
        amount: 10,
        remainingAmount: 10,
        allocatedAmount: 0,
        date: "2026-10-21",
        description: "Bank sale",
        direction: 1,
      },
    ],
  } as unknown as ComponentProps<typeof StatementMatch>["data"];
  render(StatementMatch, { data });
  await expect
    .element(page.getByRole("button", { name: "Save", exact: true }))
    .toBeVisible();
  const guard = vi.mocked(beforeNavigate).mock.calls.at(-1)![0];
  const cancel = vi.fn();
  const destination = new URL("http://localhost/dashboard");
  const navigation = {
    to: { url: destination },
    cancel,
  } as unknown as Parameters<typeof guard>[0];
  guard(navigation);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(goto).not.toHaveBeenCalled();
  guard(navigation);
  await page
    .getByRole("button", { name: "Discard Changes", exact: true })
    .click();
  expect(goto).toHaveBeenCalledExactlyOnceWith(destination);
  cancel.mockClear();
  guard(navigation);
  expect(cancel).not.toHaveBeenCalled();
});
