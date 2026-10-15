import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  confirmImport,
  discardImportJob,
  overridesShape,
  selectionShape,
  skipImport,
  updateImportItem,
} from "../../application/import.js";
import { reviewOverridesSchema } from "../../import/settle-review.js";
import { expectedVersion, registerWrite, type McpContext } from "../common.js";

const jobId = z.string().uuid();

export function registerImportWrites(server: McpServer, context: McpContext) {
  registerWrite(
    server,
    context,
    "update_import_item",
    "Save corrections to one waiting item of a grouped import (see get_import_job items): item_name (the description), supplier, date, amount, currency, exchangeRate, reference, category, remark, contactId or newContactName, accountId, and for a transfer counterAccountId. Only the fields sent change. Requires the item's `version`.",
    { jobId, itemId: z.string().min(1), expectedVersion, ...overridesShape },
    ({ jobId, itemId, expectedVersion, ...overrides }) =>
      updateImportItem(context, jobId, itemId, overrides, expectedVersion),
    {
      idempotent: true,
      ids: (input) => ({ jobId: input.jobId, itemId: input.itemId }),
    },
  );

  registerWrite(
    server,
    context,
    "confirm_import",
    "Confirm a document waiting for review, making its record(s). A single receipt takes optional `overrides` (the same fields as update_import_item). A grouped document confirms `itemIds` or `all` (a confirm-all holds back possible duplicates). A foreign currency with no known rate is refused with RATE_UNAVAILABLE: pass overrides.exchangeRate. Requires the job's `version` from get_import_job.",
    {
      jobId,
      expectedVersion,
      ...selectionShape,
      overrides: reviewOverridesSchema.optional(),
    },
    ({ jobId, expectedVersion, ...input }) =>
      confirmImport(context, jobId, input, expectedVersion),
    { ids: (input) => ({ jobId: input.jobId }) },
  );

  registerWrite(
    server,
    context,
    "skip_import",
    "Decline a document waiting for review, or `itemIds`/`all` of a grouped one. No record is made; the file is kept only while something else uses it. Requires the job's `version`.",
    { jobId, expectedVersion, ...selectionShape },
    ({ jobId, expectedVersion, ...input }) =>
      skipImport(context, jobId, input, expectedVersion),
    { idempotent: true, ids: (input) => ({ jobId: input.jobId }) },
  );

  registerWrite(
    server,
    context,
    "discard_import_job",
    "Permanently discard a queued, failed or waiting import job. For a grouped document only the waiting items go; records already made stay. Confirm with the user before calling.",
    { jobId, expectedVersion },
    ({ jobId, expectedVersion }) =>
      discardImportJob(context, jobId, expectedVersion),
    { destructive: true, ids: (input) => ({ jobId: input.jobId }) },
  );
}
