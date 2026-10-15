import { describe, expect, it } from "vitest";
import { addDaysISO, daysBetweenISO, localToday } from "./local-date.js";

describe("localToday", () => {
  it("reads the local calendar day, not UTC's", () => {
    // Built from local parts, so it is 00:30 on 9 Oct wherever this runs — a
    // UTC reading would say 8 Oct anywhere east of Greenwich.
    expect(localToday(new Date(2026, 9, 9, 0, 30))).toBe("2026-10-09");
    expect(localToday(new Date(2026, 9, 9, 23, 59))).toBe("2026-10-09");
  });

  it("pads month and day", () => {
    expect(localToday(new Date(2026, 0, 5, 12))).toBe("2026-01-05");
  });
});

describe("addDaysISO", () => {
  it("adds within a month", () => {
    expect(addDaysISO("2026-08-01", 30)).toBe("2026-08-31");
  });

  it("crosses a month end", () => {
    expect(addDaysISO("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDaysISO("2026-04-30", 30)).toBe("2026-05-30");
  });

  it("crosses a year end", () => {
    expect(addDaysISO("2026-12-15", 30)).toBe("2027-01-14");
  });

  it("knows leap days", () => {
    expect(addDaysISO("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDaysISO("2028-02-29", 1)).toBe("2028-03-01");
    expect(addDaysISO("2027-02-28", 1)).toBe("2027-03-01");
    expect(addDaysISO("2100-02-28", 1)).toBe("2100-03-01");
  });

  it("goes backwards, and treats zero as the same day", () => {
    expect(addDaysISO("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDaysISO("2026-03-01", 0)).toBe("2026-03-01");
  });
});

describe("daysBetweenISO", () => {
  it("counts calendar days, across month, year and leap-day ends", () => {
    expect(daysBetweenISO("2026-08-01", "2026-08-31")).toBe(30);
    expect(daysBetweenISO("2026-12-15", "2027-01-14")).toBe(30);
    expect(daysBetweenISO("2028-02-28", "2028-03-01")).toBe(2);
    expect(daysBetweenISO("2027-02-28", "2027-03-01")).toBe(1);
  });

  it("is zero for the same day and negative going backwards", () => {
    expect(daysBetweenISO("2026-03-01", "2026-03-01")).toBe(0);
    expect(daysBetweenISO("2026-03-01", "2026-02-28")).toBe(-1);
  });

  it("undoes addDaysISO", () => {
    for (const n of [0, 7, 14, 30, 60, 365]) {
      expect(daysBetweenISO("2026-10-09", addDaysISO("2026-10-09", n))).toBe(n);
    }
  });
});
