import { describe, expect, it } from "vitest";
import { niceScale, toY } from "./chart-scale.js";

describe("niceScale", () => {
  it("always includes zero", () => {
    const scale = niceScale([120_000, 340_000]);
    expect(scale.min).toBe(0);
    expect(scale.max).toBeGreaterThanOrEqual(340_000);
    expect(scale.ticks[0]).toBe(0);
  });

  it("reaches below zero for a loss", () => {
    const scale = niceScale([50_000, -12_000]);
    expect(scale.min).toBeLessThanOrEqual(-12_000);
    expect(scale.max).toBeGreaterThanOrEqual(50_000);
    expect(scale.ticks).toContain(0);
  });

  it("steps in 1, 2, 2.5 or 5 times a power of ten", () => {
    const scale = niceScale([0, 873_000]);
    const step = scale.ticks[1] - scale.ticks[0];
    const leading = step / 10 ** Math.floor(Math.log10(step));
    expect([1, 2, 2.5, 5]).toContain(leading);
    expect(scale.ticks.at(-1)).toBe(scale.max);
  });

  it("gives all-zero data a usable axis", () => {
    expect(niceScale([0, 0, 0])).toEqual({ min: 0, max: 1, ticks: [0, 1] });
    expect(niceScale([])).toEqual({ min: 0, max: 1, ticks: [0, 1] });
  });
});

describe("toY", () => {
  it("puts the maximum at the top and the minimum at the bottom", () => {
    const scale = { min: -100, max: 300, ticks: [] };
    expect(toY(300, scale, 200)).toBe(0);
    expect(toY(-100, scale, 200)).toBe(200);
    expect(toY(0, scale, 200)).toBe(150);
  });
});
