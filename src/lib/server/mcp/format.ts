import { z } from "zod";
import { formatMinor, parseMinor } from "../ledger/money.js";
import { mainCurrencyCode } from "../currency/form.js";
import { isValidDate } from "../date.js";
import type { LedgerDb } from "../ledger/types.js";
import { checked, rejected, type Checked } from "./envelope.js";

/**
 * How v2 MCP tools write values, in both directions.
 *
 * **Money.** An amount is a decimal string in major units with exactly two
 * places: `"1285.00"`, `"-0.50"`. Never a JSON number, never minor units.
 * - Every response that carries money has a top-level `currency` field: the
 *   book's main currency (`mainCurrency(db)`). Amounts with no currency of
 *   their own are in that currency, including every report figure and total.
 * - A row whose own figure is in another currency carries its own sibling
 *   `currency` (and `rate`) next to that figure; its main-currency value, when
 *   shown, is `amount_main`. The sibling is left out when it would equal the
 *   main currency, so a single-currency book never repeats it per row.
 * - Input amounts are strings or numbers in major units, parsed exactly by
 *   `parseMinor` (`moneyInput` for a zod field). Inside the server money is
 *   integer minor units, and `ledger/money.ts` is the only converter.
 *
 * **Enums** are snake_case labels both ways, over the `*Labels` maps in
 * `$lib/enums.ts` (`enumLabel`, `enumCode`, `enumInput`). Codes never reach
 * an agent.
 *
 * **Dates** are ISO `YYYY-MM-DD`. A **period** is `2026-03`, `2026-Q1`,
 * `2026`, `a..b` (each end a date, month, quarter or year) or `as_at` alone.
 */

// --- money ---------------------------------------------------------------

/** Minor units → the decimal string an agent reads, e.g. `"12.50"`. */
export function money(minor: number): string {
  return formatMinor(minor, 2);
}

/** The book's main currency code, e.g. `"MYR"`, for a response's `currency`. */
export function mainCurrency(db: LedgerDb): string {
  return mainCurrencyCode(db);
}

/**
 * An amount field for a tool's input: a decimal string (or number) in major
 * units that parses to integer minor units. The JSON schema shows the input
 * side (`string | number`); the handler receives the minor-unit integer.
 */
export const moneyInput = z
  .union([z.string(), z.number()])
  .transform((value, ctx) => {
    const parsed = parseMinor(value);
    if (!parsed.ok) {
      ctx.addIssue({ code: "custom", message: parsed.message });
      return z.NEVER;
    }
    return parsed.minor;
  })
  .describe('Decimal amount in major units, e.g. "1285.50".');

/** An ISO date field for a tool's input. */
export const dateInput = z
  .string()
  .refine(isValidDate, "Use a real date in YYYY-MM-DD form.")
  .describe("ISO date, YYYY-MM-DD.");

// --- near matches ---------------------------------------------------------

/** Edit distance between two short strings (case is the caller's business). */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++)
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    previous = current;
  }
  return previous[b.length];
}

/**
 * The option most like `input`, for a "did you mean" hint, or undefined when
 * nothing is close: a prefix either way, or an edit distance of at most a
 * third of the longer word (minimum 2). Case-insensitive.
 */
export function closestMatch(
  input: string,
  options: readonly string[],
): string | undefined {
  const wanted = input.toLowerCase();
  let best: string | undefined;
  let bestScore = Infinity;
  for (const option of options) {
    const candidate = option.toLowerCase();
    const prefix =
      wanted.length >= 3 &&
      (candidate.startsWith(wanted) || wanted.startsWith(candidate));
    const distance = editDistance(wanted, candidate);
    const limit = Math.max(
      2,
      Math.floor(Math.max(wanted.length, candidate.length) / 3),
    );
    if (!prefix && distance > limit) continue;
    const score = prefix ? Math.min(distance, 1) : distance;
    if (score < bestScore) {
      best = option;
      bestScore = score;
    }
  }
  return best;
}

// --- enums ----------------------------------------------------------------

/** A code → label map from `$lib/enums.ts`, wire (`*Labels`) or display. */
export type EnumMap = Readonly<Record<number, string>>;

/** `"Accounts receivable"`, `"Short-term loan"`, `"Prepaid/debit card"` → `accounts_receivable`, `short_term_loan`, `prepaid_debit_card`. */
export function snakeCase(label: string): string {
  return label
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export type EnumCodec = {
  /** Every snake_case label, in code order. */
  labels: readonly [string, ...string[]];
  label(code: number): string | undefined;
  code(label: string): number | undefined;
};

const CODECS = new WeakMap<EnumMap, EnumCodec>();

/**
 * The two-way codec for one enum map, built once and cached per map. Labels
 * are the map's values in snake_case (the `*Labels` maps already are, except
 * `EntityTypeLabels` and `RoleLabels`, which are Title Case). Throws if two
 * codes would share a label — that is a mistake in `enums.ts`.
 */
export function enumCodec(map: EnumMap): EnumCodec {
  const cached = CODECS.get(map);
  if (cached) return cached;
  const byCode = new Map<number, string>();
  const byLabel = new Map<string, number>();
  for (const [code, text] of Object.entries(map)) {
    const label = snakeCase(text);
    if (byLabel.has(label))
      throw new Error(
        `Enum labels collide on "${label}" (codes ${byLabel.get(label)} and ${code}).`,
      );
    byCode.set(Number(code), label);
    byLabel.set(label, Number(code));
  }
  const labels = [...byCode.keys()]
    .sort((a, b) => a - b)
    .map((code) => byCode.get(code)!);
  if (labels.length === 0) throw new Error("An enum map has no codes.");
  const codec: EnumCodec = {
    labels: labels as [string, ...string[]],
    label: (code) => byCode.get(code),
    code: (label) => byLabel.get(snakeCase(label)),
  };
  CODECS.set(map, codec);
  return codec;
}

/** The snake_case label of `code`, or undefined (so `compact` drops it) for null or an unknown code. */
export function enumLabel(
  map: EnumMap,
  code: number | null | undefined,
): string | undefined {
  return code == null ? undefined : enumCodec(map).label(code);
}

/**
 * The code for a label an agent sent. Matching ignores case and spacing
 * (`"Pending Review"` finds `pending_review`). An unknown label is
 * `INVALID_INPUT` listing every allowed label, with a "did you mean" when one
 * is close. `field` names the input field in the message and as `path`.
 */
export function enumCode(
  map: EnumMap,
  label: string,
  field = "value",
): Checked<number> {
  const codec = enumCodec(map);
  const code = codec.code(label);
  if (code !== undefined) return checked(code);
  const near = closestMatch(snakeCase(label), codec.labels);
  return rejected({
    code: "INVALID_INPUT",
    path: field,
    message: `"${label}" is not a valid ${field}.${near ? ` Did you mean "${near}"?` : ""}`,
    fix: `Use one of: ${codec.labels.join(", ")}.`,
  });
}

/** A zod enum of the map's snake_case labels, for a tool's input schema. */
export function enumInput(map: EnumMap) {
  return z.enum(enumCodec(map).labels);
}

// --- periods ----------------------------------------------------------------

/** An inclusive ISO date range. `from` is null for `as_at` (from the start of the books). */
export type Period = { from: string | null; to: string };

const pad = (n: number) => String(n).padStart(2, "0");
const lastDay = (year: number, month: number) =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

const PERIOD_FORMS =
  'Use "2026-03" (a month), "2026-Q1" (a quarter), "2026" (a year), "2026-01-05..2026-02-10" (a range; each end may also be a month, quarter or year), or as_at "2026-03-31" alone.';

/** One period term: a date, month, quarter or year, as its first and last day. */
function term(text: string): { from: string; to: string } | null {
  if (isValidDate(text)) return { from: text, to: text };
  let match = /^(\d{4})$/.exec(text);
  if (match) return { from: `${match[1]}-01-01`, to: `${match[1]}-12-31` };
  match = /^(\d{4})-(\d{2})$/.exec(text);
  if (match) {
    const [year, month] = [Number(match[1]), Number(match[2])];
    if (month < 1 || month > 12) return null;
    return {
      from: `${match[1]}-${pad(month)}-01`,
      to: `${match[1]}-${pad(month)}-${pad(lastDay(year, month))}`,
    };
  }
  match = /^(\d{4})-[Qq]([1-4])$/.exec(text);
  if (match) {
    const year = Number(match[1]);
    const first = (Number(match[2]) - 1) * 3 + 1;
    const last = first + 2;
    return {
      from: `${match[1]}-${pad(first)}-01`,
      to: `${match[1]}-${pad(last)}-${pad(lastDay(year, last))}`,
    };
  }
  return null;
}

/**
 * A period string as an inclusive `{from, to}` date range: `"2026-03"`,
 * `"2026-Q1"`, `"2026"`, `"2026-01-05..2026-02-10"` (each end of a range may
 * itself be a date, month, quarter or year: `"2026-01..2026-Q2"`). Anything
 * else, or a range that ends before it starts, is `INVALID_INPUT` with a fix
 * listing the forms.
 */
export function parsePeriodText(
  text: string,
  field = "period",
): Checked<Period> {
  const trimmed = text.trim();
  const parts = trimmed.split("..");
  const invalid = (message: string) =>
    rejected<Period>({
      code: "INVALID_INPUT",
      path: field,
      message,
      fix: PERIOD_FORMS,
    });
  if (parts.length === 1) {
    const one = term(trimmed);
    return one
      ? checked(one)
      : invalid(`"${text}" is not a period Akaun understands.`);
  }
  if (parts.length !== 2) return invalid(`"${text}" has more than one "..".`);
  const [start, end] = parts.map((p) => term(p.trim()));
  if (!start || !end)
    return invalid(`"${text}" is not a period Akaun understands.`);
  if (start.from > end.to)
    return invalid(
      `"${text}" ends (${end.to}) before it starts (${start.from}).`,
    );
  return checked({ from: start.from, to: end.to });
}

/**
 * The period a tool was asked about, from its `period` and `as_at` inputs
 * (see `periodShape`). `as_at` alone is `{ from: null, to: as_at }`. Neither
 * is `null`, so the tool applies its own default. Both is `INVALID_INPUT`.
 */
export function parsePeriod(input: {
  period?: string;
  as_at?: string;
}): Checked<Period | null> {
  if (input.period !== undefined && input.as_at !== undefined)
    return rejected({
      code: "INVALID_INPUT",
      path: "as_at",
      message: "Send either period or as_at, not both.",
      fix: "Use period for a range of dates, or as_at for balances on one date.",
    });
  if (input.as_at !== undefined) {
    if (!isValidDate(input.as_at))
      return rejected({
        code: "INVALID_INPUT",
        path: "as_at",
        message: `"${input.as_at}" is not a real YYYY-MM-DD date.`,
        fix: 'Send as_at as one date, e.g. "2026-03-31".',
      });
    return checked({ from: null, to: input.as_at });
  }
  if (input.period !== undefined) return parsePeriodText(input.period);
  return checked(null);
}

/**
 * The `period` / `as_at` fields for a tool's input shape. Spread it into a
 * `z.object({...})` and pass the parsed args to `parsePeriod`. Both stay
 * plain strings in the schema so that a bad period comes back with the forms
 * listed, not a bare regex failure.
 */
export const periodShape = {
  period: z
    .string()
    .optional()
    .describe(
      'A month "2026-03", quarter "2026-Q1", year "2026" or range "2026-01-05..2026-02-10".',
    ),
  as_at: z
    .string()
    .optional()
    .describe(
      'A single date "2026-03-31", for balances as at that day. Not with period.',
    ),
};
