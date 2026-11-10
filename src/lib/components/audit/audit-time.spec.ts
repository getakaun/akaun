import { describe, expect, it } from "vitest";
import { auditTime } from "./audit-format.js";
describe("shared activity timestamps", () => {
  it("preserves SQLite UTC, ISO UTC and explicit offsets when displaying tax review history", () => {
    const expected = Date.parse("2026-11-10T11:23:26.000Z");
    for (const value of [
      "2026-11-10 11:23:26",
      "2026-11-10T11:23:26.000Z",
      "2026-11-10T19:23:26+08:00",
    ]) {
      expect(auditTime(value).getTime()).toBe(expected);
    }
  });
});
