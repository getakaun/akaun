import { join } from "node:path";
import { StatementExtractionState } from "$lib/enums.js";
import { STORAGE_PATH } from "$lib/server/env.js";
import {
  extractText,
  inferMimeType,
} from "$lib/server/extraction/document-text.js";
import { getEnabledProviders } from "$lib/server/llmProviders.js";
import {
  insertLines,
  type ReconciliationDb,
} from "$lib/server/queries/reconciliation.js";
import { setStatementExtraction } from "$lib/server/services/reconciliation.js";
import { getSetting, SETTING_KEYS } from "$lib/server/settings.js";
import { createLogger } from "$lib/server/logger.js";
import { normaliseExtractedLines } from "./statement-parse.js";
import { extractStatementLines } from "./statement-llm.js";
import { reconciliationEvents } from "./events.js";
import { runAsSystem } from "$lib/server/audit-context.js";

const log = createLogger("reconciliation:statement-import");

type StatementImportInput = {
  statementId: number;
  relativePath: string;
  originalFilename: string;
  userId: number;
};

/**
 * Started with `void` after the upload responds, so it runs as the system: the
 * extraction is the app's work, not the request's, and must not be recorded
 * under whichever channel happened to upload the file.
 */
export function processStatementImport(
  db: ReconciliationDb,
  input: StatementImportInput,
): Promise<void> {
  return runAsSystem(() => importStatement(db, input));
}

async function importStatement(
  db: ReconciliationDb,
  input: StatementImportInput,
): Promise<void> {
  try {
    log.info({ statementId: input.statementId }, "Statement import started");
    const text = await extractText(
      join(STORAGE_PATH, input.relativePath),
      inferMimeType(input.originalFilename),
    );
    if (text.trim().length < 10)
      throw new Error("Not enough readable statement text was found");

    const providers = getEnabledProviders(db);
    if (providers.length === 0)
      throw new Error("No document extraction provider is configured");
    const intervalMs = Number(
      getSetting(db, SETTING_KEYS.autoImportRateLimitMs) ?? 0,
    );
    const extracted = await extractStatementLines(text, providers, intervalMs);
    const parsed = normaliseExtractedLines(extracted);
    log.info(
      {
        statementId: input.statementId,
        extractedRows: extracted.lines.length,
        normalizedRows: parsed.length,
      },
      "Statement transactions normalized",
    );
    if (parsed.length === 0) {
      throw new Error(
        "No transactions could be extracted. Try another statement file or add the transactions manually.",
      );
    }
    const lines = insertLines(
      db,
      parsed.map((line) => ({
        ...line,
        statementId: input.statementId,
      })),
    );
    setStatementExtraction(
      db,
      input.statementId,
      StatementExtractionState.Ready,
    );
    reconciliationEvents.emit("lines-added", {
      statementId: input.statementId,
      lines,
    });
    log.info(
      { statementId: input.statementId, insertedRows: lines.length },
      "Statement import completed",
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Statement extraction failed";
    log.error(
      { statementId: input.statementId, message },
      "Statement import failed",
    );
    setStatementExtraction(
      db,
      input.statementId,
      StatementExtractionState.Failed,
      `Statement extraction failed: ${message}`,
    );
  }
}
