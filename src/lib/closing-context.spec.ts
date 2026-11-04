import { describe, expect, it } from "vitest";
import { periodClosedThroughFor } from "./closing-context.js";

describe("live month-close presentation", () => {
  it("freezes an already loaded entry when the live boundary closes its date", () => {
    const boundary = { closedThrough: "2026-10-31" };
    expect(periodClosedThroughFor("2026-10-31", null, boundary)).toBe(
      "2026-10-31",
    );
    expect(periodClosedThroughFor("2026-11-01", null, boundary)).toBeNull();
  });

  it("reopens an entry even when its original DTO still says closed", () => {
    expect(
      periodClosedThroughFor("2026-10-15", "2026-10-31", {
        closedThrough: null,
      }),
    ).toBeNull();
    expect(
      periodClosedThroughFor("2026-10-15", "2026-10-31", {
        closedThrough: "2026-09-30",
      }),
    ).toBeNull();
  });

  it("keeps unposted drafts editable regardless of their proposed date", () => {
    expect(
      periodClosedThroughFor(null, null, { closedThrough: "2026-10-31" }),
    ).toBeNull();
  });

  it("uses the server flag when rendered without the app layout", () => {
    expect(periodClosedThroughFor("2026-10-15", "2026-10-31", undefined)).toBe(
      "2026-10-31",
    );
    expect(periodClosedThroughFor("2026-11-01", null, undefined)).toBeNull();
  });
});
