import { z } from "zod";
import { monthEndFor } from "$lib/closing.js";

export const depreciationMonth = z
  .string()
  .regex(/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/);
export const depreciationProfileSchema = z
  .object({
    startMonth: depreciationMonth,
    months: z.number().int().min(1).max(1200),
    residualMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    expenseAccountId: z.number().int().positive(),
    accumulatedAccountId: z.number().int().positive().nullable(),
    mode: z.enum(["review", "auto"]),
    reason: z.string().trim().min(1).max(1000),
  })
  .strict()
  .refine(
    (v) =>
      Number(v.startMonth.slice(0, 4)) * 12 +
        Number(v.startMonth.slice(5)) +
        v.months <=
      120001,
    "The schedule extends beyond year 9999.",
  );
export type DepreciationSettings = z.infer<typeof depreciationProfileSchema>;
export function shiftMonth(month: string, offset: number): string {
  const index =
    Number(month.slice(0, 4)) * 12 + Number(month.slice(5)) - 1 + offset;
  return `${String(Math.floor(index / 12)).padStart(4, "0")}-${String((index % 12) + 1).padStart(2, "0")}`;
}
/** Full monthly charges, integer cents, with all rounding left in the final period. */
export function straightLineSchedule(
  baseNbvMinor: number,
  residualMinor: number,
  startMonth: string,
  months: number,
) {
  if (
    !Number.isSafeInteger(baseNbvMinor) ||
    !Number.isSafeInteger(residualMinor) ||
    residualMinor < 0 ||
    residualMinor > baseNbvMinor ||
    !Number.isInteger(months) ||
    months < 1 ||
    months > 1200 ||
    !monthEndFor(startMonth)
  )
    throw Error("Invalid depreciation basis.");
  const depreciable = BigInt(baseNbvMinor) - BigInt(residualMinor);
  const ordinary = depreciable / BigInt(months);
  let balance = BigInt(baseNbvMinor);
  return Array.from({ length: months }, (_, index) => {
    const amount =
      index === months - 1 ? balance - BigInt(residualMinor) : ordinary;
    balance -= amount;
    return {
      month: shiftMonth(startMonth, index),
      amountMinor: Number(amount),
      projectedNbvMinor: Number(balance),
    };
  });
}
