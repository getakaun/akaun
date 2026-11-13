import type { ToolCandidate, ToolErrorBody } from "./envelope.js";

/**
 * Turning a reference that did not resolve into the error an agent can act
 * on. No lookups happen here: `application/refs.ts` resolves ids, numbers and
 * names against the book (an exact, case-insensitive match resolves; anything
 * else does not — a fuzzy match never links) and hands its miss to
 * `resolveError`.
 */

/** The most candidates an error lists. */
export const MAX_CANDIDATES = 5;

/** What a resolver reports when a reference did not resolve to exactly one item. */
export type ResolveMiss = {
  kind: "not_found" | "ambiguous";
  /** Best first. Each `{ id, name, ...details }`; details such as `code` or `date` are kept. */
  candidates?: readonly ToolCandidate[];
};

/** The first `max` candidates, with `id` and `name` first in each. */
export function topCandidates(
  candidates: readonly ToolCandidate[] | undefined,
  max = MAX_CANDIDATES,
): ToolCandidate[] {
  return (candidates ?? [])
    .slice(0, max)
    .map(({ id, name, ...details }) => ({ id, name, ...details }));
}

/**
 * The `NOT_FOUND` or `AMBIGUOUS` error for a reference.
 *
 * - `what`: the kind of item, singular, e.g. `"account"`, `"contact"`.
 * - `ref`: what the agent sent, quoted back in the message.
 * - `path`: where in the input, e.g. `records[2].category`, for batch items.
 * - `lookup`: the tool (already named in the active scheme) that lists
 *   these items, for the fix when there are no candidates.
 * - `fix`: replaces the default fix entirely.
 *
 * Up to `MAX_CANDIDATES` candidates are listed. The fix asks for an id,
 * because an id always resolves.
 */
export function resolveError(
  miss: ResolveMiss,
  options: {
    what: string;
    ref: string | number;
    path?: string;
    lookup?: string;
    fix?: string;
  },
): ToolErrorBody {
  const candidates = topCandidates(miss.candidates);
  const quoted =
    typeof options.ref === "number" ? String(options.ref) : `"${options.ref}"`;
  const where = options.path ? `${options.path}: ` : "";
  if (miss.kind === "ambiguous")
    return {
      code: "AMBIGUOUS",
      path: options.path,
      message: `${where}${quoted} matches more than one ${options.what}.`,
      fix:
        options.fix ??
        `Send the id of the ${options.what} you mean${candidates.length ? " from candidates" : ""}.`,
      candidates,
    };
  const lookup = options.lookup ? `, or look it up with ${options.lookup}` : "";
  return {
    code: "NOT_FOUND",
    path: options.path,
    message: `${where}No ${options.what} matches ${quoted}.`,
    fix:
      options.fix ??
      (candidates.length
        ? `If one of candidates is meant, send its id${lookup}. Close names are never used on their own.`
        : `Check the ${options.what}${lookup}, then send its id.`),
    candidates,
  };
}
