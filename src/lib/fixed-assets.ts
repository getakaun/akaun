/** Exact decimal text to integer units; refuse excess precision instead of rounding. */
export function assetUnits(
  value: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match)
    throw new Error(
      "Enter a non-negative number with at most two decimal places.",
    );
  const units =
    BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
  if (units > BigInt(maximum)) throw new Error("The value is too large.");
  return Number(units);
}

/** Exact cents to decimal text, including values near the safe integer limit. */
export function assetDecimal(minor: number): string {
  if (!Number.isSafeInteger(minor))
    throw new Error("Amount must be safe integer cents.");
  const cents = BigInt(minor);
  const absolute = cents < 0n ? -cents : cents;
  return `${cents < 0n ? "-" : ""}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
}
