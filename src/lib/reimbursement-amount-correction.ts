/** Parse entered money exactly; do not silently round a correction to cents. */
export function correctionAmountMinor(raw: string): number | null {
  if (!/^\d+(?:\.\d{0,2})?$/.test(raw.trim())) return null;
  const [whole, fraction = ""] = raw.trim().split(".");
  const value = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(value) ? value : null;
}

export type CorrectionExpense = {
  owedMovementId: number;
  amountMinor: number;
  allocatedMinor: number;
  otherPaidMinor: number;
  availableMinor: number;
};

export function correctionPreview(
  amountMinor: number | null,
  expenses: CorrectionExpense[],
  picked: Record<number, string>,
) {
  const allocations = expenses.map((e) => ({
    owedMovementId: e.owedMovementId,
    amountMinor:
      expenses.length === 1
        ? Math.min(amountMinor ?? 0, e.availableMinor)
        : correctionAmountMinor(picked[e.owedMovementId] ?? ""),
  }));
  const total = allocations.reduce((sum, a) => sum + (a.amountMinor ?? 0), 0);
  const valid =
    amountMinor !== null &&
    amountMinor > 0 &&
    Number.isSafeInteger(total) &&
    total <= amountMinor &&
    allocations.every(
      (a, i) =>
        a.amountMinor !== null &&
        a.amountMinor >= 0 &&
        a.amountMinor <= expenses[i].availableMinor,
    );
  return {
    valid,
    creditMinor: (amountMinor ?? 0) - total,
    allocations: allocations.map((a) => ({
      ...a,
      amountMinor: a.amountMinor ?? 0,
    })),
  };
}
