import { page } from "vitest/browser";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import type { ComponentProps } from "svelte";
import StatementMatch from "./StatementMatch.svelte";
import { beforeNavigate, goto } from "$app/navigation";

vi.mock("$app/navigation", () => ({
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
