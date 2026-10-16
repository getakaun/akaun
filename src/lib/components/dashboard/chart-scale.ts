/**
 * The arithmetic behind the dashboard's hand-drawn SVG charts. Pure, so the
 * axis a chart draws can be checked without rendering it.
 */

export type Scale = { min: number; max: number; ticks: number[] };

/** 1, 2, 2.5 or 5 times a power of ten — the steps an axis reads easily in. */
function niceStep(rough: number): number {
  const power = 10 ** Math.floor(Math.log10(rough));
  const fraction = rough / power;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return nice * power;
}

/**
 * An axis covering `values` and always zero, rounded out to even steps.
 *
 * Zero is always on it: a bar chart of money that does not start at zero
 * makes a small month look like nothing and a loss look like a smaller profit.
 * All-zero data still gets a usable axis (0 to 1) rather than a division by
 * zero.
 */
export function niceScale(values: number[], tickCount = 4): Scale {
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values);
  if (lo === hi) return { min: 0, max: 1, ticks: [0, 1] };
  const step = niceStep((hi - lo) / tickCount);
  const min = Math.floor(lo / step) * step;
  const max = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let t = min; t <= max + step / 2; t += step) {
    // Snap away float drift (0.1 + 0.2) so a tick reads exactly.
    ticks.push(Math.round(t / step) * step);
  }
  return { min, max, ticks };
}

/** Where `value` sits on an SVG y axis `height` tall (0 at the top). */
export function toY(value: number, scale: Scale, height: number): number {
  return height - ((value - scale.min) / (scale.max - scale.min)) * height;
}
