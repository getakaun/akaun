import { getContext, setContext } from "svelte";

export const MONTH_CLOSED_REASON = "Month closed — reopen to edit";

export type ClosingBoundary = { readonly closedThrough: string | null };
const CLOSING_BOUNDARY = Symbol("closing-boundary");

/** The layout supplies a reactive getter; no book state is shared between SSR requests. */
export function provideClosingBoundary(boundary: ClosingBoundary): void {
  setContext(CLOSING_BOUNDARY, boundary);
}

export function getClosingBoundary(): ClosingBoundary | undefined {
  return getContext<ClosingBoundary | undefined>(CLOSING_BOUNDARY);
}

/**
 * Mirrors server/closing/policy.ts's inclusive date boundary for presentation.
 * A live null is an explicit reopen and overrides an older DTO's closed value.
 * Outside the app layout, the server-derived DTO remains the source of truth.
 */
export function periodClosedThroughFor(
  date: string | null,
  initial: string | null,
  boundary: ClosingBoundary | undefined,
): string | null {
  if (boundary === undefined) return initial;
  const through = boundary.closedThrough;
  return date !== null && through !== null && date <= through ? through : null;
}
