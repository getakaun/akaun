// Client+server-safe choice of what a PDF prints at the top of the page: the
// company name as text, or the uploaded letterhead image in its place. This is
// content, not layout — every layout honours it and decides only where its
// masthead goes, so it is one setting (`pdf.header`) rather than one per layout.

export type PdfHeaderStyle = "name" | "letterhead";

export const DEFAULT_PDF_HEADER: PdfHeaderStyle = "name";

export function isPdfHeaderStyle(value: unknown): value is PdfHeaderStyle {
  return value === "name" || value === "letterhead";
}
