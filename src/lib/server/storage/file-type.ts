import { extname } from "path";
import type { BlobStore } from "./blob-store.js";

/**
 * Verify the buffer's leading "magic bytes" identify an allowed type (PDF/JPEG/PNG).
 * This is content-based and cannot be spoofed by the client-supplied MIME or extension.
 */
export function sniffAllowedType(
  buffer: Buffer,
): "pdf" | "jpeg" | "png" | null {
  if (buffer.length >= 4 && buffer.toString("ascii", 0, 4) === "%PDF")
    return "pdf";
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return "jpeg";
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "png";
  }
  return null;
}

const MIME = {
  pdf: "application/pdf",
  jpeg: "image/jpeg",
  png: "image/png",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
} as const;

export type StoredFileKind = keyof typeof MIME;

/**
 * What a stored file is. A PDF or an image is found by its content, not its
 * name, so a PDF stored under a misleading name is still a PDF. A spreadsheet
 * cannot be told apart that way and was checked against its name on upload,
 * so its extension decides. Anything else is `null`.
 */
export async function storedFileType(
  store: BlobStore,
  key: string,
): Promise<{ kind: StoredFileKind | null; mime: string }> {
  const head = await store.head(key, 8);
  const sniffed = head ? sniffAllowedType(Buffer.from(head)) : null;
  const extension = extname(key).slice(1).toLowerCase();
  const kind: StoredFileKind | null =
    sniffed ?? (extension === "xlsx" || extension === "csv" ? extension : null);
  return { kind, mime: kind ? MIME[kind] : "application/octet-stream" };
}
