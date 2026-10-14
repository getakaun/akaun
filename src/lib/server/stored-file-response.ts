import { extname } from "path";
import { sniffAllowedType } from "./file-storage.js";
import type { BlobStore } from "./storage/blob-store.js";

/** The types a stored file may be shown in the page as, found by content. */
const INLINE_MIME = {
  pdf: "application/pdf",
  jpeg: "image/jpeg",
  png: "image/png",
} as const;

// A spreadsheet is offered as a download rather than shown in the page
// (006 FR-050): a browser has no viewer for a workbook, and a CSV file shown
// as text would be the uploader's content rendered under the app's address.
const DOWNLOAD_MIME: Record<string, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
};

/**
 * `Content-Disposition` for a name the user chose. Control characters and
 * quotes are stripped for the ASCII fallback, and an RFC 5987 encoded variant
 * carries the real name.
 */
function contentDisposition(mode: string, name: string): string {
  const asciiFallback =
    // eslint-disable-next-line no-control-regex
    name.replace(/[\u0000-\u001f"\\]/g, "_") || "file";
  return `${mode}; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * Streams a stored file to the browser. Every route that serves a file goes
 * through here, after it has checked that the caller may see that file — this
 * helper checks nothing about who is asking.
 *
 * The file is streamed, not read into memory. It is never kept by a shared
 * cache (`private`), and the browser must ask again each time (`no-cache`), so
 * a revoked session cannot keep reading from its cache; the `ETag` lets that
 * repeat request be a 304.
 */
export async function storedFileResponse(
  store: BlobStore,
  request: Request,
  key: string,
  downloadName: string,
): Promise<Response> {
  const stat = await store.stat(key).catch(() => null);
  if (!stat) return new Response("Not found", { status: 404 });

  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.modifiedMs).toString(16)}"`;
  const headers: Record<string, string> = {
    ETag: etag,
    "Cache-Control": "private, no-cache",
  };
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }

  // The type shown inline is read from the content, not the name, so a PDF
  // stored under a misleading name is still a PDF, and anything that is not a
  // PDF or an image is downloaded rather than rendered.
  const head = await store.head(key, 8);
  const sniffed = head ? sniffAllowedType(Buffer.from(head)) : null;
  const contentType = sniffed
    ? INLINE_MIME[sniffed]
    : (DOWNLOAD_MIME[extname(key).slice(1).toLowerCase()] ??
      "application/octet-stream");
  const mode = sniffed ? "inline" : "attachment";

  return new Response(store.stream(key), {
    headers: {
      ...headers,
      "Content-Type": contentType,
      "Content-Length": String(stat.size),
      "Content-Disposition": contentDisposition(mode, downloadName),
    },
  });
}
