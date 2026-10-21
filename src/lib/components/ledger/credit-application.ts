/** Whole-cent allocation of explicitly selected prior payments, in display order. */
export function planCreditApplication(
  allocations: { owedMovementId: number; amountMinor: number }[],
  credits: { paymentMovementId: number; amountMinor: number }[],
) {
  const cashAllocations = allocations.map((a) => ({ ...a }));
  const creditApplications: {
    paymentMovementId: number;
    owedMovementId: number;
    amountMinor: number;
  }[] = [];
  for (const credit of credits) {
    let left = credit.amountMinor;
    for (const allocation of cashAllocations) {
      const amountMinor = Math.min(left, allocation.amountMinor);
      if (amountMinor > 0) {
        creditApplications.push({
          paymentMovementId: credit.paymentMovementId,
          owedMovementId: allocation.owedMovementId,
          amountMinor,
        });
        allocation.amountMinor -= amountMinor;
        left -= amountMinor;
      }
    }
  }
  return {
    creditApplications,
    cashAllocations: cashAllocations.filter((a) => a.amountMinor > 0),
    creditAppliedMinor: creditApplications.reduce(
      (n, a) => n + a.amountMinor,
      0,
    ),
  };
}
