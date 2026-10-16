// Money formatting now lives in the currency layer so it tracks the active main
// currency. These are kept as thin re-exports for the many existing call sites.
//   - formatMoney(n)   → main-currency value, no symbol  (e.g. "1,234.56")
//   - formatMoneyRM(n) → main-currency value, with symbol (e.g. "$ 1,234.56")
// `formatMoneyRM` keeps its historical name only for compatibility; it is no longer
// RM-specific. Use `formatCurrency`/`formatMoney` from the currency modules in new code.
export {
  formatMoneyAmount as formatMoney,
  formatMoney as formatMoneyRM,
} from "./currency-state.svelte.js";

import {
  formatMoneyAmount as formatMainAmount,
  formatMoney as formatMainMoney,
  mainCurrencySymbol,
} from "./currency-state.svelte.js";

/**
 * The ledger holds money as whole cents of the main currency, so every screen
 * that reads a movement, a balance or a report line converts here rather than
 * dividing by 100 in a template. Display only — never sum these.
 */
export function formatMinor(minor: number): string {
  return formatMainMoney(minor / 100);
}

/** The same without the currency symbol, for a column that carries it in its header. */
export function formatMinorAmount(minor: number): string {
  return formatMainAmount(minor / 100);
}

const compactNumber = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});

/**
 * A short figure for a chart axis or a sparkline label — "$ 12.4K". Display
 * only, and only where the exact figure is one click away.
 */
export function formatCompactMinor(minor: number): string {
  const sign = minor < 0 ? "−" : "";
  return `${sign}${mainCurrencySymbol()} ${compactNumber.format(Math.abs(minor) / 100)}`;
}

/** A change as a signed percentage, "+12%" / "−4.5%". */
export function formatPct(fraction: number): string {
  const pct = fraction * 100;
  const digits = Math.abs(pct) < 10 ? 1 : 0;
  const text = Math.abs(pct).toFixed(digits).replace(/\.0$/, "");
  return `${pct > 0 ? "+" : pct < 0 ? "−" : ""}${text}%`;
}

export function formatDateShort(iso: string): string {
  if (!iso) return "";
  const [, m, d] = iso.split("-");
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${parseInt(d)} ${months[parseInt(m) - 1]}`;
}

export function formatDate(iso: string): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${parseInt(d)} ${months[parseInt(m) - 1]} ${y}`;
}

export function monthLabel(iso: string): string {
  const [y, m] = iso.split("-");
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${months[parseInt(m) - 1]} ${y}`;
}
