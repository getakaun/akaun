import type { LedgerDb } from "../ledger/types.js";
import { recordAudit, type AuditAction, type FieldChange } from "../audit.js";

/**
 * Auditing an import job: one entry per action on it — an upload, a skip, a
 * correction, a discard. Records it makes are audited as records by
 * `createRecord`, in the same request, so the log groups them with the
 * confirm that made them.
 *
 * An item of a grouped document is named by its place in the document
 * (`item 3.amount`), the way a reviewer finds it; item ids are opaque.
 */
export function auditImportJob(
  db: LedgerDb,
  opts: {
    jobId: string;
    userId: number;
    action: AuditAction;
    changes?: FieldChange[];
    /** The file's name, when the job's row is already gone. */
    label?: string | null;
  },
): void {
  recordAudit(db, {
    recordType: "import_job",
    recordId: opts.jobId,
    userId: opts.userId,
    action: opts.action,
    changes: opts.changes,
    label: opts.label,
  });
}

export function itemField(item: { position: number }, field?: string): string {
  return `item ${item.position + 1}${field ? `.${field}` : ""}`;
}

/** Field changes for one item, from the columns a write set on it. */
export function itemChangesOf(
  item: { position: number } & Record<string, unknown>,
  written: Record<string, unknown>,
): FieldChange[] {
  return Object.entries(written)
    .filter(([key]) => key !== "updatedAt")
    .filter(
      ([key, value]) =>
        JSON.stringify(item[key] ?? null) !== JSON.stringify(value ?? null),
    )
    .map(([key, value]) => ({
      field: itemField(item, key),
      before: item[key] ?? null,
      after: value ?? null,
    }));
}

/** A single document declined in review: no record is made. */
export function auditJobSkipped(
  db: LedgerDb,
  jobId: string,
  userId: number,
): void {
  auditImportJob(db, {
    jobId,
    userId,
    action: "update",
    changes: [{ field: "state", before: "waiting", after: "skipped" }],
  });
}

/** A queued, failed or waiting document thrown away. */
export function auditJobDiscarded(
  db: LedgerDb,
  job: { id: string; originalFilename: string },
  userId: number,
): void {
  auditImportJob(db, {
    jobId: job.id,
    userId,
    action: "delete",
    changes: [
      { field: "originalFilename", before: job.originalFilename, after: null },
    ],
    label: job.originalFilename,
  });
}
