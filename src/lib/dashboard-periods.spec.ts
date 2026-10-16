import { describe, expect, it } from "vitest";
import {
  comparisonRange,
  currentRange,
  formatRange,
  lastTwelveMonths,
  parseCompareMode,
  parsePeriodId,
  resolveDashboardPeriod,
} from "./dashboard-periods.js";

describe("parsePeriodId", () => {
  it("reads the four periods and maps the pre-007 values", () => {
    expect(parsePeriodId("quarter")).toBe("quarter");
    expect(parsePeriodId("l12m")).toBe("l12m");
    expect(parsePeriodId("year")).toBe("ytd");
    expect(parsePeriodId("m-1")).toBe("month");
    expect(parsePeriodId(null)).toBe("month");
  });

  it("defaults the comparison to the previous period", () => {
    expect(parseCompareMode("yoy")).toBe("yoy");
    expect(parseCompareMode("nonsense")).toBe("prev");
    expect(parseCompareMode(null)).toBe("prev");
  });
});

describe("currentRange", () => {
  it("always ends today", () => {
    expect(currentRange("month", "2026-10-16")).toEqual({ from: "2026-10-01", to: "2026-10-16" });
    expect(currentRange("quarter", "2026-11-20")).toEqual({ from: "2026-10-01", to: "2026-11-20" });
    expect(currentRange("quarter", "2026-03-31")).toEqual({ from: "2026-01-01", to: "2026-03-31" });
    expect(currentRange("ytd", "2026-10-16")).toEqual({ from: "2026-01-01", to: "2026-10-16" });
  });

  it("starts Last 12 months on the first of the month eleven months back", () => {
    expect(currentRange("l12m", "2026-10-16")).toEqual({ from: "2025-11-01", to: "2026-10-16" });
    expect(currentRange("l12m", "2026-01-05")).toEqual({ from: "2025-02-01", to: "2026-01-05" });
  });
});

describe("comparisonRange", () => {
  it("compares a month to date with the same days of the previous month", () => {
    expect(comparisonRange("month", "prev", "2026-10-16")).toEqual({
      from: "2026-09-01",
      to: "2026-09-16",
    });
  });

  it("clamps to the end of a shorter previous month", () => {
    expect(comparisonRange("month", "prev", "2026-03-31")).toEqual({
      from: "2026-02-01",
      to: "2026-02-28",
    });
    expect(comparisonRange("month", "prev", "2028-03-31")).toEqual({
      from: "2028-02-01",
      to: "2028-02-29",
    });
  });

  it("crosses a year boundary", () => {
    expect(comparisonRange("month", "prev", "2026-01-10")).toEqual({
      from: "2025-12-01",
      to: "2025-12-10",
    });
    expect(comparisonRange("quarter", "prev", "2026-02-14")).toEqual({
      from: "2025-10-01",
      to: "2025-11-14",
    });
  });

  it("clamps a quarter to the end of the previous quarter", () => {
    // 92 days into Q4 is past the end of Q3's 92 days, so all of Q3.
    expect(comparisonRange("quarter", "prev", "2026-12-31")).toEqual({
      from: "2026-07-01",
      to: "2026-09-30",
    });
  });

  it("shifts back one year, landing 29 February on the 28th", () => {
    expect(comparisonRange("month", "yoy", "2028-02-29")).toEqual({
      from: "2027-02-01",
      to: "2027-02-28",
    });
  });

  it("uses last year for Year to date and Last 12 months whatever is asked", () => {
    expect(comparisonRange("ytd", "prev", "2026-10-16")).toEqual({
      from: "2025-01-01",
      to: "2025-10-16",
    });
    expect(comparisonRange("l12m", "prev", "2026-10-16")).toEqual(
      comparisonRange("l12m", "yoy", "2026-10-16"),
    );
  });
});

describe("lastTwelveMonths", () => {
  it("returns twelve calendar months, oldest first, the last ending today", () => {
    const months = lastTwelveMonths("2026-10-16");
    expect(months).toHaveLength(12);
    expect(months[0]).toEqual({ key: "2025-11", label: "Nov", from: "2025-11-01", to: "2025-11-30" });
    expect(months[3]).toEqual({ key: "2026-02", label: "Feb", from: "2026-02-01", to: "2026-02-28" });
    expect(months[11]).toEqual({ key: "2026-10", label: "Oct", from: "2026-10-01", to: "2026-10-16" });
  });

  it("covers every day exactly once", () => {
    const months = lastTwelveMonths("2026-10-16");
    for (let i = 1; i < months.length; i++) {
      const prevEnd = new Date(`${months[i - 1].to}T00:00:00Z`);
      prevEnd.setUTCDate(prevEnd.getUTCDate() + 1);
      expect(prevEnd.toISOString().slice(0, 10)).toBe(months[i].from);
    }
  });
});

describe("resolveDashboardPeriod", () => {
  it("forces the yearly comparison where previous means the same thing", () => {
    const ytd = resolveDashboardPeriod("ytd", "prev", "2026-10-16");
    expect(ytd.compare).toBe("yoy");
    expect(ytd.canComparePrevious).toBe(false);
    expect(ytd.label).toBe("2026 to date");

    const month = resolveDashboardPeriod("month", "prev", "2026-10-16");
    expect(month.compare).toBe("prev");
    expect(month.label).toBe("October 2026");
    expect(month.comparisonLabel).toBe("1–16 Sep 2026");
  });

  it("labels a quarter", () => {
    expect(resolveDashboardPeriod("quarter", "prev", "2026-10-16").label).toBe("Q4 2026");
  });
});

describe("formatRange", () => {
  it("names each end once", () => {
    expect(formatRange({ from: "2026-07-01", to: "2026-09-30" })).toBe("1 Jul – 30 Sep 2026");
    expect(formatRange({ from: "2025-11-01", to: "2026-10-16" })).toBe("1 Nov 2025 – 16 Oct 2026");
  });
});
