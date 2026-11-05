import { expect, it } from "vitest";
import { splitRecordLines } from "./journal-rules.js";

it("loads every extra line of a mixed split, preserving duplicate-account labels and tax snapshots", () => {
  const movements = [
    { id: 1, accountId: 10, amountMinor: -100000, label: "Bank", tax: null },
    {
      id: 2,
      accountId: 20,
      amountMinor: 30000,
      label: "Fuel business",
      tax: 10000,
    },
    { id: 3, accountId: 20, amountMinor: 20000, label: "Fuel private", tax: 0 },
    { id: 4, accountId: 30, amountMinor: 25000, label: "Travel", tax: 5000 },
    { id: 5, accountId: 40, amountMinor: 25000, label: "Supplies", tax: 10000 },
  ];
  const { into, outOf, extra } = splitRecordLines(movements);
  expect(into).toBe(movements[1]);
  expect(outOf).toBe(movements[0]);
  expect(extra).toEqual(movements.slice(2));
  expect(
    [outOf!, into!, ...extra].reduce((sum, m) => sum + m.amountMinor, 0),
  ).toBe(0);
  expect(extra.map((m) => [m.id, m.label, m.tax])).toEqual([
    [3, "Fuel private", 0],
    [4, "Travel", 5000],
    [5, "Supplies", 10000],
  ]);
});
