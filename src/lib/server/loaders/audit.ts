import { redirect } from "@sveltejs/kit";
import { db } from "$lib/server/db/client.js";
import { can } from "$lib/server/permissions.js";
import {
  auditFilterOptions,
  getAuditEntry,
  listAuditLog,
  parseAuditFilters,
  sameRequestEntries,
} from "$lib/server/audit-feed.js";

/**
 * The Audit Log: every change anyone made, and the channel it came through.
 * Gated on `audit.read` alone — it shows administrative changes no other
 * permission reveals, and it is the one place a whole agent's work is seen.
 */
export function loadAuditPage(locals: App.Locals, url: URL) {
  if (!can(locals, "audit.read")) throw redirect(302, "/dashboard");
  const filters = parseAuditFilters(url.searchParams);
  const page = listAuditLog(db, filters);
  return {
    entries: page.entries,
    nextCursor: page.nextCursor,
    filters,
    options: auditFilterOptions(db),
  };
}

export function loadAuditDetail(locals: App.Locals, id: number) {
  if (!can(locals, "audit.read")) throw redirect(302, "/dashboard");
  const entry = getAuditEntry(db, id);
  if (!entry) throw redirect(302, "/audit");
  return { entry, sameRequest: sameRequestEntries(db, entry) };
}
