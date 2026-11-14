import { describe, expect, it } from "vitest";
import { z } from "zod";
import { payloadBytes, SOFT_BUDGET_BYTES } from "./envelope.js";
import {
  DEFAULT_LIMIT,
  encodeCursor,
  filtersHash,
  MAX_LIMIT,
  moreNote,
  pageResult,
  pagingShape,
  startPage,
  type PageRequest,
} from "./paging.js";

const page = (
  args: { limit?: number; cursor?: string },
  filters: Record<string, unknown>,
) => {
  const result = startPage(args, filters);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

/** A list of 312 numbered rows, served the way a tool would: limit + 1. */
const ALL = Array.from({ length: 312 }, (_, i) => ({ id: i + 1 }));
const serve = (p: PageRequest) => ALL.slice(p.offset, p.offset + p.limit + 1);

describe("paging", () => {
  it("defaults to 50 rows and refuses more than 200 in the schema", () => {
    expect(page({}, {}).limit).toBe(DEFAULT_LIMIT);
    const schema = z.object(pagingShape);
    expect(schema.safeParse({ limit: MAX_LIMIT }).success).toBe(true);
    expect(schema.safeParse({ limit: MAX_LIMIT + 1 }).success).toBe(false);
  });

  it("hashes filters stably, ignoring cursor, limit, key order and undefined", () => {
    expect(filtersHash({ a: 1, b: { y: 2, x: 1 } })).toBe(
      filtersHash({
        b: { x: 1, y: 2 },
        a: 1,
        c: undefined,
        cursor: "z",
        limit: 9,
      }),
    );
    expect(filtersHash({ a: 1 })).not.toBe(filtersHash({ a: 2 }));
  });

  it("walks a list to the end with an opaque cursor and a steering note", () => {
    const filters = { period: "2026-Q1" };
    const seen: number[] = [];
    let cursor: string | undefined;
    let first: Record<string, unknown> | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const p = page({ cursor }, filters);
      const result = pageResult({
        rows: serve(p),
        page: p,
        narrow: "period or account",
        head: { currency: "MYR" },
      });
      first ??= result;
      seen.push(...(result.rows as { id: number }[]).map((r) => r.id));
      cursor = result.next_cursor as string | undefined;
      if (!cursor) {
        expect(result.note).toBe("");
        break;
      }
      expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    }
    expect(seen).toEqual(ALL.map((r) => r.id));
    expect(first).toMatchObject({ currency: "MYR" });
    expect(first!.note).toBe(
      "Showing 1–50 — narrow with period or account, or pass cursor for the next page.",
    );
  });

  it("says 'of N' when the total is known", () => {
    const p = page({ limit: 50 }, {});
    const result = pageResult({
      rows: ALL.slice(0, 50),
      page: p,
      total: 312,
      narrow: "period",
    });
    expect(result.total).toBe(312);
    expect(result.note).toBe(
      "Showing 1–50 of 312 — narrow with period, or pass cursor for the next page.",
    );
    const next = page({ cursor: result.next_cursor as string }, {});
    expect(next.offset).toBe(50);
  });

  it("refuses a cursor reused with different filters, and one that is not ours", () => {
    const p = page({}, { account: "Bank" });
    const cursor = pageResult({ rows: serve(p), page: p })
      .next_cursor as string;
    const reused = startPage({ cursor }, { account: "Cash" });
    expect(reused).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_INPUT",
        path: "cursor",
        fix: expect.stringContaining("without cursor"),
      },
    });
    expect(startPage({ cursor: "not-a-cursor" }, {})).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    const forged = encodeCursor({ offset: -1, filtersHash: filtersHash({}) });
    expect(startPage({ cursor: forged }, {}).ok).toBe(false);
  });

  it("carries a keyset in the cursor for keyset lists", () => {
    const p = page({ limit: 2 }, {});
    const result = pageResult({
      rows: serve(p),
      page: p,
      keysetOf: (row) => ["2026-01-01", row.id],
    });
    const next = page({ limit: 2, cursor: result.next_cursor as string }, {});
    expect(next).toMatchObject({ offset: 2, keyset: ["2026-01-01", 2] });
  });

  it("cuts a page to the soft budget and points the cursor after the last row shown", () => {
    const wide = Array.from({ length: 201 }, (_, i) => ({
      id: i + 1,
      text: "w".repeat(1000),
    }));
    const p = page({ limit: 200 }, {});
    const result = pageResult({ rows: wide, page: p, narrow: "query" });
    const shown = (result.rows as unknown[]).length;
    expect(shown).toBeLessThan(200);
    expect(payloadBytes(result)).toBeLessThanOrEqual(SOFT_BUDGET_BYTES);
    expect(result.note).toBe(
      `Showing 1–${shown} (cut to fit the response size) — narrow with query, or lower limit or pass cursor for the next page.`,
    );
    expect(
      page({ limit: 200, cursor: result.next_cursor as string }, {}).offset,
    ).toBe(shown);
  });

  it("writes nothing when the list is complete", () => {
    expect(moreNote({ offset: 0, shown: 3, total: 3, more: false })).toBe("");
  });
});
