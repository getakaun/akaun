import type { RequestHandler } from "@sveltejs/kit";
import { readFileSync } from "fs";
import { join, resolve, sep } from "path";
import { eq } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { recordAttachments, bankStatements } from "$lib/server/db/schema.js";
import { getSetting, SETTING_KEYS } from "$lib/server/settings.js";
import { STORAGE_PATH } from "$lib/server/env.js";
import { hasPermission } from "$lib/server/permissions.js";

const MIME: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
};

// A spreadsheet imported as a record's source document is offered as a
// download rather than shown in the page (006 FR-050): a browser has no viewer
// for a workbook, and a CSV file shown as text would be the uploader's content
// rendered under the app's address.
const DOWNLOAD_ONLY = new Set(["xlsx", "csv"]);

export const GET: RequestHandler = ({ locals, params }) => {
  if (!locals.user) return new Response("Unauthorized", { status: 401 });

  const filePath = params.path!;
  const storageRoot = resolve(STORAGE_PATH);
  const abs = resolve(join(STORAGE_PATH, filePath));

  if (!abs.startsWith(storageRoot + sep) && abs !== storageRoot) {
    return new Response("Forbidden", { status: 403 });
  }

  // Shared ledger — any authenticated user may read a file that belongs to a
  // record. One table answers now: the three legacy attachment tables this also
  // checked are dropped by this release, and the conversion had already moved
  // every one of their rows into `record_attachments` (FR-014, FR-039).
  const owned = db
    .select({ id: recordAttachments.id })
    .from(recordAttachments)
    .where(eq(recordAttachments.filename, filePath))
    .get();
  const bankStatementFile = db
    .select({ id: bankStatements.id })
    .from(bankStatements)
    .where(eq(bankStatements.storedFilePath, filePath))
    .get();
  if (bankStatementFile && !hasPermission(locals, "reconciliation", "view")) {
    return new Response("Forbidden", { status: 403 });
  }

  const isCompanyImage = [
    SETTING_KEYS.companyLogoPath,
    SETTING_KEYS.companyLetterheadPath,
  ].some((key) => {
    const path = getSetting(db, key);
    return !!path && filePath === path;
  });

  if (!owned && !bankStatementFile && !isCompanyImage)
    return new Response("Forbidden", { status: 403 });

  let content: Blob;
  try {
    content = new Blob([readFileSync(abs)]);
  } catch {
    return new Response("Not Found", { status: 404 });
  }

  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const contentType = MIME[ext] ?? "application/octet-stream";
  const filename = filePath.split("/").pop() ?? "file";
  const displayFilename = filename.replace(/^[0-9a-f-]{36}_/i, "");

  // Sanitize before placing the user-supplied name into a header value: strip control
  // chars and quotes for the ASCII fallback, and provide an RFC 5987 encoded variant.
  const asciiFallback =
    [...displayFilename]
      .map((character) => {
        const code = character.charCodeAt(0);
        return code <= 31 || character === '"' || character === "\\"
          ? "_"
          : character;
      })
      .join("") || "file";
  const encoded = encodeURIComponent(displayFilename);
  const mode = DOWNLOAD_ONLY.has(ext) ? "attachment" : "inline";
  const disposition = `${mode}; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;

  return new Response(content, {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": disposition,
    },
  });
};
