import { createHash } from "node:crypto";
/** Shared canonical snapshot/retry hashing; retained object key order is intentional. */
export const evidenceHash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

// Only bookkeeping/asset reads: tax operations cannot write these sources.
// Adjustments, schemes, revisions and authority are never cached.
const scopes = new WeakMap<object, Map<string, unknown>>();
export function withTaxEvidenceReads<T>(db: object, body: () => T): T {
  if (scopes.has(db)) return body();
  scopes.set(db, new Map());
  try {
    return body();
  } finally {
    scopes.delete(db);
  }
}
export function taxEvidenceRead<T>(
  db: object,
  key: string,
  capture: () => T,
): T {
  const scope = scopes.get(db);
  if (!scope) return capture();
  if (scope.has(key)) return scope.get(key) as T;
  const value = capture();
  scope.set(key, value);
  return value;
}
