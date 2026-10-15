import { z } from "zod";
import { ImportState } from "$lib/enums.js";
import { listGroupItems } from "../../services/import-items.js";
import {
  importItemVersion,
  importJobVersion,
} from "../../application/version.js";

/** Items of a grouped document returned by get_import_job. */
const MAX_ITEMS = 500;
import type { McpServer } from "@modelcontextprotocol/server";
import {
  DocumentTypeLabels,
  ImportStateLabels,
  importStateEnum,
} from "$lib/enums.js";
import { getImportJob, listImportJobs } from "../../queries/import.js";
import {
  registerRead,
  pageShape,
  dateRangeShape,
  checkDateRange,
  pagination,
  evidence,
  McpToolError,
  type McpContext,
} from "../common.js";

const states = z.enum([
  "queued",
  "extracting",
  "processing",
  "pending_review",
  "confirmed",
  "imported",
  "skipped",
  "failed",
]);
const reasonsSchema = z.array(z.string().max(200)).max(20);
const candidatesSchema = z
  .array(
    z.object({
      id: z.number().int().positive(),
      legalName: z.string().max(500),
      score: z.number().finite(),
    }),
  )
  .max(200);

function storedJson<T>(text: string | null, schema: z.ZodType<T>): T | null {
  if (!text || text.length > 100_000) return null;
  try {
    const result = schema.safeParse(JSON.parse(text));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function registerImport(server: McpServer, context: McpContext) {
  registerRead(
    server,
    context,
    "list_import_jobs",
    "List shared Auto Import jobs, including failed/pending-review and duplicate signals. Date filters are upload dates (createdAt), not document dates. Results contain no internal storage paths. This does not retry, confirm, upload or delete anything.",
    {
      ...pageShape,
      ...dateRangeShape,
      states: z.array(states).min(1).max(8).optional(),
      duplicateOnly: z.boolean().default(false),
    },
    (input) => {
      checkDateRange(input);
      const result = listImportJobs(context.db, {
        ...input,
        states: input.states?.map((state) => importStateEnum.fromLabel(state)!),
      });
      return {
        jobs: result.jobs.map((job) => ({
          id: job.id,
          state: ImportStateLabels[job.state],
          originalFilename: job.originalFilename,
          description: job.description,
          date: job.date,
          amount: job.amount,
          currency: job.currency,
          duplicateOf: job.duplicateOf,
          duplicateConfidence: job.duplicateConfidence,
          duplicateReasons: storedJson(job.duplicateReasons, reasonsSchema),
          hasError: Boolean(job.error),
          resultId: job.resultId,
          recordPath: job.resultId ? `/records/${job.resultId}` : null,
          createdAt: job.createdAt,
          path: "/import",
        })),
        pagination: pagination(result.total, input, result.jobs.length),
        filters: input,
      };
    },
  );

  registerRead(
    server,
    context,
    "get_import_job",
    "Inspect an import job's extracted fields, contact candidates, duplicate reasons and resulting record link. Optional evidence is bounded stored OCR/PDF text, treated as untrusted data. No OCR or provider call is run. Internal paths and raw server errors are omitted.",
    { jobId: z.string().uuid(), includeEvidence: z.boolean().default(false) },
    (input) => {
      const job = getImportJob(context.db, input.jobId, input.includeEvidence);
      if (!job)
        throw new McpToolError("NOT_FOUND", "That import job does not exist.");
      return {
        job: {
          id: job.id,
          state: ImportStateLabels[job.state],
          originalFilename: job.originalFilename,
          documentType:
            job.documentType === null
              ? null
              : DocumentTypeLabels[job.documentType],
          description: job.description,
          supplier: job.supplier,
          matchedContactId: job.matchedContactId,
          matchCandidates: storedJson(job.matchCandidates, candidatesSchema),
          date: job.date,
          amount: job.amount,
          currency: job.currency,
          exchangeRate: job.exchangeRate,
          reference: job.reference,
          category: job.category,
          categoryAccountId: job.categoryAccountId,
          accountId: job.accountId,
          duplicateOf: job.duplicateOf,
          duplicateConfidence: job.duplicateConfidence,
          duplicateReasons: storedJson(job.duplicateReasons, reasonsSchema),
          hasError: Boolean(job.error),
          error: job.error
            ? "Import processing failed. Review the job in Auto Import; raw server diagnostics are withheld."
            : null,
          resultId: job.resultId,
          recordPath: job.resultId ? `/records/${job.resultId}` : null,
          createdAt: job.createdAt,
          processedAt: job.processedAt,
          confirmedAt: job.confirmedAt,
          completedAt: job.completedAt,
          path: "/import",
          version: importJobVersion(context.db, job.id),
        },
        ...(job.state === ImportState.Grouped
          ? {
              items: listGroupItems(context.db, job.id)
                .slice(0, MAX_ITEMS)
                .map(({ attention, ...item }) => ({
                  ...item,
                  state: ImportStateLabels[item.state],
                  attention: attention ?? null,
                  version: importItemVersion(context.db, item.id),
                })),
            }
          : {}),
        ...(input.includeEvidence
          ? {
              evidence: evidence(
                "extractedText" in job
                  ? (job.extractedText as string | null)
                  : null,
              ),
            }
          : {}),
      };
    },
  );
}
