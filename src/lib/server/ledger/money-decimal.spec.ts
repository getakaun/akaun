import { describe, expect, it } from "vitest";
import { formatMinor, parseMinor } from "./money.js";

const minor = (value: string | number, scale?: number) => {
  const result = parseMinor(value, scale);
  if (!result.ok) throw new Error(result.message);
  return result.minor;
};
const refusal = (value: string | number, scale?: number) => {
  const result = parseMinor(value, scale);
  if (result.ok) throw new Error(`"${value}" was accepted as ${result.minor}`);
  return result.message;
};

describe("formatMinor", () => {
  it("writes exact two-place decimals, negatives included", () => {
    expect(formatMinor(128500)).toBe("1285.00");
    expect(formatMinor(-50)).toBe("-0.50");
    expect(formatMinor(1)).toBe("0.01");
    expect(formatMinor(-1)).toBe("-0.01");
    expect(formatMinor(0)).toBe("0.00");
    expect(formatMinor(Number.MAX_SAFE_INTEGER)).toBe("90071992547409.91");
  });

  it("honours another scale", () => {
    expect(formatMinor(1234, 0)).toBe("1234");
    expect(formatMinor(5, 3)).toBe("0.005");
  });

  it("refuses a non-integer, which would be a programming error", () => {
    expect(() => formatMinor(1.5)).toThrow(RangeError);
  });
});

describe("parseMinor", () => {
  it("accepts the plain decimal forms", () => {
    expect(minor("1285")).toBe(128500);
    expect(minor("1285.5")).toBe(128550);
    expect(minor("1285.50")).toBe(128550);
    expect(minor("-12.30")).toBe(-1230);
    expect(minor(" 0.01 ")).toBe(1);
    expect(minor("-0.00")).toBe(0);
    expect(Object.is(minor("-0"), -0)).toBe(false);
  });

  it("takes a number through its shortest string form", () => {
    expect(minor(12.5)).toBe(1250);
    expect(minor(-0.01)).toBe(-1);
    expect(minor(1285)).toBe(128500);
    // 0.1 + 0.2 prints as 0.30000000000000004: refused, never rounded.
    expect(refusal(0.1 + 0.2)).toMatch(/decimal places/);
  });

  it("round-trips with formatMinor, negatives, a cent and large safe values", () => {
    for (const value of [
      0,
      1,
      -1,
      99,
      -12345,
      128550,
      Number.MAX_SAFE_INTEGER,
      -Number.MAX_SAFE_INTEGER,
    ])
      expect(minor(formatMinor(value))).toBe(value);
    expect(formatMinor(minor("0.01"))).toBe("0.01");
    expect(formatMinor(minor("-1285.5"))).toBe("-1285.50");
  });

  it("refuses three decimals at scale 2, and any decimals at scale 0", () => {
    expect(refusal("12.345")).toMatch(/3 decimal places; at most 2/);
    expect(refusal("12.5", 0)).toMatch(/whole units/);
    expect(minor("12.345", 3)).toBe(12345);
  });

  it("refuses thousands separators, saying what to write instead", () => {
    expect(refusal("1,285.00")).toMatch(/write 1285\.00/);
    expect(refusal("1 285 000")).toMatch(/thousands separators/);
  });

  it("refuses empty, symbol, exponent and malformed values", () => {
    expect(refusal("")).toMatch(/empty/);
    expect(refusal("   ")).toMatch(/empty/);
    expect(refusal("RM12.00")).toMatch(/plain decimal/);
    expect(refusal("1e3")).toMatch(/plain decimal/);
    expect(refusal(1e21)).toMatch(/plain decimal/);
    expect(refusal(".5")).toMatch(/plain decimal/);
    expect(refusal("5.")).toMatch(/plain decimal/);
    expect(refusal("--5")).toMatch(/plain decimal/);
    expect(refusal(Number.NaN)).toMatch(/finite/);
  });

  it("refuses an amount beyond the safe-integer range", () => {
    expect(refusal("90071992547409.92")).toMatch(/too large/);
    expect(refusal("-90071992547409.92")).toMatch(/too large/);
  });
});
