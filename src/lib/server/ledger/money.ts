import type { Minor } from "./types.js";

/**
 * Turning what a user typed into whole cents, and splitting a payment across
 * what it covers without losing or inventing a cent.
 *
 * Pure arithmetic — no database, no rounding policy hidden anywhere else. Every
 * conversion in the ledger goes through `toMinor`, so "the two sides cancel out
 * exactly" is a property of one function rather than a hope.
 */

/**
 * Binary floating point cannot hold most decimal amounts exactly: `1.005 * 100`
 * is 100.49999999999999, which `Math.round` would take *down* to 100. Rounding
 * the value to twelve significant digits first discards that representation
 * error while keeping every digit a money amount can actually carry, so the tie
 * lands where a person reading "1.005" expects it to.
 */
const SIGNIFICANT_DIGITS = 12;

/**
 * The record's entered figure at its own stored rate, in whole cents of the
 * main currency. Halves round away from zero, the way a person totals a column
 * by hand (FR-005).
 */
export function toMinor(amount: number, exchangeRate: number): Minor {
  const scaled = amount * exchangeRate * 100;
  if (!Number.isFinite(scaled)) return 0;
  const clean = Number(scaled.toPrecision(SIGNIFICANT_DIGITS));
  return Math.sign(clean) * Math.round(Math.abs(clean));
}

/** Cents back to a decimal. For display only — never sum these. */
export function fromMinor(minor: Minor): number {
  return Number((minor / 100).toFixed(2));
}

/**
 * What is left for the one category a caller already knows about, once every
 * other typed category (`extraAmounts`, each a signed movement) has taken its
 * own share of `total`. Whether zero-or-less is worth refusing, and in what
 * words, is the caller's — this only does the arithmetic (data-model.md
 * invariant 6: a record's movements must add up to its own figure).
 */
export function remainderMinor(total: Minor, extraAmounts: Minor[]): Minor {
  const extraTotal = extraAmounts.reduce((sum, m) => sum + Math.abs(m), 0);
  return total - extraTotal;
}

/**
 * Splits `total` in proportion to `weights` so the parts sum to exactly
 * `total`. Whole division rarely comes out even in cents, so the remainder is
 * handed out one cent at a time to the largest weights first — the largest
 * share absorbs the rounding, which is what a person doing it by hand does.
 *
 * A zero weight is always given zero, even when cents are left over, so an item
 * that is owed nothing is never credited with a payment.
 */
export function allocateMinor(total: Minor, weights: Minor[]): Minor[] {
  if (weights.length === 0) return [];
  if (weights.length === 1) return [total];

  const magnitudes = weights.map((w) => Math.abs(w));
  const weightTotal = magnitudes.reduce((sum, w) => sum + w, 0);
  if (weightTotal === 0) return weights.map(() => 0);

  const parts = magnitudes.map((w) => Math.trunc((total * w) / weightTotal));
  let remainder = total - parts.reduce((sum, p) => sum + p, 0);

  // Largest weight first, and ties by original position, so the same inputs
  // always split the same way.
  const order = magnitudes
    .map((w, i) => ({ w, i }))
    .sort((a, b) => b.w - a.w || a.i - b.i);

  const step = Math.sign(remainder);
  for (const { w, i } of order) {
    if (remainder === 0) break;
    if (w === 0) continue;
    parts[i] += step;
    remainder -= step;
  }

  return parts;
}

/**
 * Whole minor units as an exact decimal string: `128500` → `"1285.00"`,
 * `-50` → `"-0.50"`, `7` → `"0.07"`. String arithmetic only, so no float ever
 * touches the figure. `scale` is the number of decimal places (2 for cents; 0
 * gives a plain integer string).
 *
 * This and `parseMinor` are the MCP layer's only money converters: an agent
 * reads and writes amounts as these strings, never as JSON numbers.
 *
 * Throws on a non-integer or unsafe `minor` — that is a programming error,
 * not something a user typed.
 */
export function formatMinor(minor: number, scale = 2): string {
  if (!Number.isSafeInteger(minor))
    throw new RangeError(`formatMinor needs a safe integer, got ${minor}.`);
  if (!Number.isInteger(scale) || scale < 0)
    throw new RangeError(`formatMinor needs a whole scale, got ${scale}.`);
  const sign = minor < 0 ? "-" : "";
  const digits = String(Math.abs(minor)).padStart(scale + 1, "0");
  if (scale === 0) return `${sign}${digits}`;
  const cut = digits.length - scale;
  return `${sign}${digits.slice(0, cut)}.${digits.slice(cut)}`;
}

export type ParsedMinor =
  | { ok: true; minor: number }
  | { ok: false; message: string };

const PLAIN_DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;
const GROUPED = /^-?\d{1,3}([,_ '’]\d{3})+(\.\d+)?$/;

/**
 * A decimal amount, as a user or an agent wrote it, to whole minor units —
 * exactly, by string, with no float arithmetic.
 *
 * Accepts `"1285"`, `"1285.5"`, `"1285.50"`, `"-12.30"` (surrounding spaces
 * are ignored). A number is first turned into its shortest string form
 * (`String(12.5)` → `"12.5"`), so `0.1 + 0.2` is refused for its seventeen
 * decimals rather than silently rounded.
 *
 * Refuses, each with a sentence that says what to send instead: an empty
 * value, thousands separators (`"1,285.00"`), more decimals than `scale`,
 * exponent or other non-plain forms, and a result outside the safe-integer
 * range. `-0` comes back as `0`.
 */
export function parseMinor(value: string | number, scale = 2): ParsedMinor {
  let text: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      return { ok: false, message: "The amount must be a finite number." };
    text = String(value);
  } else if (typeof value === "string") {
    text = value.trim();
  } else {
    return {
      ok: false,
      message: 'Send the amount as a decimal string, e.g. "1285.50".',
    };
  }
  if (text === "")
    return {
      ok: false,
      message: 'The amount is empty. Send a decimal such as "1285.50".',
    };
  if (GROUPED.test(text))
    return {
      ok: false,
      message: `Remove the thousands separators from "${text}": write ${text.replace(/[,_ '’]/g, "")}.`,
    };
  const match = PLAIN_DECIMAL.exec(text);
  if (!match)
    return {
      ok: false,
      message: `"${text}" is not a plain decimal amount. Use digits, an optional leading "-" and at most one ".", with no currency symbol, e.g. "1285.50".`,
    };
  const [, sign, whole, fraction = ""] = match;
  if (fraction.length > scale)
    return {
      ok: false,
      message:
        scale === 0
          ? `"${text}" has decimals, but this amount takes whole units only.`
          : `"${text}" has ${fraction.length} decimal places; at most ${scale} are allowed.`,
    };
  const magnitude =
    BigInt(whole) * 10n ** BigInt(scale) +
    BigInt(fraction.padEnd(scale, "0") || "0");
  if (magnitude > BigInt(Number.MAX_SAFE_INTEGER))
    return { ok: false, message: `"${text}" is too large an amount.` };
  const minor = Number(magnitude);
  return { ok: true, minor: sign === "-" && minor !== 0 ? -minor : minor };
}
