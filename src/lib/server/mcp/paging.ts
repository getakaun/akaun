import { createHash } from "node:crypto";
import { z } from "zod";
import { checked, fitRows, rejected, type Checked } from "./envelope.js";

/**
 * Cursor paging for list tools.
 *
 * A cursor is opaque to the agent: base64url JSON of the next offset (and,
 * for keyset lists, the last row's key) plus a hash of the filters it was
 * made under. Sent back with different filters it is refused, because the
 * offset would point into a different list.
 *
 * A list tool does three things:
 * 1. Spread `pagingShape` into its input schema.
 * 2. `startPage(args, filters)` → `{offset, limit, keyset?}` (or the error).
 * 3. Query `limit + 1` rows (or `limit` rows and a `total`), then return
 *    `pageResult({ rows, page, total?, narrow, head })`: it trims to the
 *    response budget, adds `next_cursor` and the steering note.
 */

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

/** `limit` and `cursor`, for a list tool's input shape. */
export const pagingShape = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .describe(
      `Rows per page, ${DEFAULT_LIMIT} by default, at most ${MAX_LIMIT}.`,
    ),
  cursor: z
    .string()
    .optional()
    .describe(
      "next_cursor from the previous page. Send the same filters with it.",
    ),
};

export type JsonKey =
  | string
  | number
  | null
  | readonly (string | number | null)[];

export type PageRequest = {
  offset: number;
  limit: number;
  /** The last row's key on the previous page, for keyset lists. */
  keyset?: JsonKey;
  /** Hash of the filters this page is for; carried into the next cursor. */
  filtersHash: string;
};

type CursorBody = { v: 1; o: number; f: string; k?: JsonKey };

/** Paging inputs that do not change which rows match, so are left out of the hash. */
const NOT_FILTERS = new Set(["cursor", "limit"]);

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
        .sort()
        .map((key) => [key, stable((value as Record<string, unknown>)[key])]),
    );
  return value;
}

/**
 * A short, stable hash of the filters a list was asked with. Pass the parsed
 * args: `cursor` and `limit` are ignored at the top level, and key order and
 * undefined fields do not matter.
 */
export function filtersHash(filters: Record<string, unknown>): string {
  const kept = Object.fromEntries(
    Object.entries(filters).filter(([key]) => !NOT_FILTERS.has(key)),
  );
  return createHash("sha256")
    .update(JSON.stringify(stable(kept)))
    .digest("base64url")
    .slice(0, 16);
}

/** The cursor for the page that starts at `offset`. */
export function encodeCursor(state: {
  offset: number;
  filtersHash: string;
  keyset?: JsonKey;
}): string {
  const body: CursorBody = { v: 1, o: state.offset, f: state.filtersHash };
  if (state.keyset !== undefined) body.k = state.keyset;
  return Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
}

const RESTART_FIX =
  "Repeat the call without cursor to start from the first page with these filters, or send the cursor with the exact filters of the call that returned it.";

function decode(cursor: string): CursorBody | null {
  try {
    const body = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as CursorBody;
    if (
      body?.v !== 1 ||
      !Number.isSafeInteger(body.o) ||
      body.o < 0 ||
      typeof body.f !== "string"
    )
      return null;
    return body;
  } catch {
    return null;
  }
}

/**
 * The page a call asks for. `filters` is the parsed args (see `filtersHash`).
 * A cursor that is not one of ours, or was made under other filters, is
 * `INVALID_INPUT` with a fix.
 */
export function startPage(
  args: { limit?: number; cursor?: string },
  filters: Record<string, unknown>,
): Checked<PageRequest> {
  const limit = Math.min(Math.max(args.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const hash = filtersHash(filters);
  if (args.cursor === undefined || args.cursor === "")
    return checked({ offset: 0, limit, filtersHash: hash });
  const body = decode(args.cursor);
  if (!body)
    return rejected({
      code: "INVALID_INPUT",
      path: "cursor",
      message: "The cursor is not one this tool returned.",
      fix: RESTART_FIX,
    });
  if (body.f !== hash)
    return rejected({
      code: "INVALID_INPUT",
      path: "cursor",
      message: "The cursor belongs to a list with different filters.",
      fix: RESTART_FIX,
    });
  return checked({
    offset: body.o,
    limit,
    filtersHash: hash,
    ...(body.k !== undefined ? { keyset: body.k } : {}),
  });
}

/**
 * The steering sentence at the end of a list: "Showing 51–100 of 312 —
 * narrow with period or account, or pass cursor for the next page." Empty
 * when the list is complete and was not trimmed.
 */
export function moreNote(state: {
  /** Rows before this page. */
  offset: number;
  /** Rows on this page. */
  shown: number;
  /** All matching rows, when known. */
  total?: number;
  more: boolean;
  /** The filters worth narrowing with, e.g. "period, account or query". */
  narrow?: string;
  /** True when rows were cut to fit the response size. */
  trimmed?: boolean;
}): string {
  if (!state.more) return "";
  const first = state.shown ? state.offset + 1 : state.offset;
  const last = state.offset + state.shown;
  const of = state.total !== undefined ? ` of ${state.total}` : "";
  const cut = state.trimmed ? " (cut to fit the response size)" : "";
  const narrow = state.narrow ? `narrow with ${state.narrow}, or ` : "";
  const lower = state.trimmed ? "lower limit or " : "";
  return `Showing ${first}–${last}${of}${cut} — ${narrow}${lower}pass cursor for the next page.`;
}

/**
 * The payload of one page: `{...head, [key]: rows, total?, next_cursor?, note?}`.
 *
 * Pass the rows the query returned for `page` — either `page.limit + 1` rows
 * (the extra one only says there is more and is never shown) or `limit` rows
 * plus `total`. Rows are cut further to keep the payload within the soft
 * budget; `next_cursor` then starts after the last row actually shown.
 * `keysetOf` (keyset lists) gives the key stored in the cursor from the last
 * shown row.
 */
export function pageResult<R>(options: {
  rows: readonly R[];
  page: PageRequest;
  total?: number;
  narrow?: string;
  /** The rows' field name; `rows` by default. */
  key?: string;
  /** Fields that come before the rows: `currency`, totals, the period. */
  head?: Record<string, unknown>;
  keysetOf?: (row: R) => JsonKey;
  budget?: number;
}): Record<string, unknown> {
  const { page, total } = options;
  const key = options.key ?? "rows";
  const pageRows = options.rows.slice(0, page.limit);
  const build = (kept: readonly R[], trimmed: boolean) => {
    const more =
      trimmed ||
      (total !== undefined
        ? page.offset + kept.length < total
        : options.rows.length > page.limit);
    const last = kept[kept.length - 1];
    const next = more
      ? encodeCursor({
          offset: page.offset + kept.length,
          filtersHash: page.filtersHash,
          keyset:
            options.keysetOf && last !== undefined
              ? options.keysetOf(last)
              : undefined,
        })
      : undefined;
    return {
      ...options.head,
      [key]: kept,
      total,
      next_cursor: next,
      note: moreNote({
        offset: page.offset,
        shown: kept.length,
        total,
        more,
        narrow: options.narrow,
        trimmed,
      }),
    } as Record<string, unknown>;
  };
  // fitRows only appends its steering to a trimmed payload; ours already
  // says so in the note, so it adds nothing.
  return fitRows(pageRows, build, { budget: options.budget, steering: "" })
    .payload;
}
