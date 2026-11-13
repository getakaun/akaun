/**
 * A deterministic one-page text PDF, for the evaluation book's receipts, its
 * bank statement and its inbox attachments.
 *
 * The same lines always give the same bytes: a fixed object layout, one of the
 * standard fonts (nothing embedded), no compression, and no creation date,
 * producer or document id. A receipt's sha256 is therefore the same on every
 * build and every machine, which the duplicate-receipt plant and its verifier
 * rely on.
 *
 * Text is limited to printable ASCII so that no encoding choice can change a
 * byte. A line that does not fit is refused rather than wrapped or cut.
 */

const PAGE_WIDTH = 595; // A4, in points
const PAGE_HEIGHT = 842;
const MARGIN = 56;
const FONT_SIZE = 10;
const LEADING = 14;

/** The most lines one page holds at this size. */
export const TEXT_PDF_MAX_LINES = Math.floor(
  (PAGE_HEIGHT - 2 * MARGIN) / LEADING,
);
/** The longest line, in characters, that stays inside the margins. */
export const TEXT_PDF_MAX_LINE_LENGTH = 90;

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

function escapeText(line: string): string {
  return line.replace(/[\\()]/g, (char) => `\\${char}`);
}

/** The bytes of a one-page PDF that shows `lines`, top to bottom. */
export function textPdf(lines: readonly string[]): Uint8Array {
  if (lines.length === 0)
    throw new Error("A text PDF needs at least one line.");
  if (lines.length > TEXT_PDF_MAX_LINES)
    throw new Error(
      `A text PDF holds at most ${TEXT_PDF_MAX_LINES} lines; got ${lines.length}.`,
    );
  for (const line of lines) {
    if (!PRINTABLE_ASCII.test(line))
      throw new Error(
        `Only printable ASCII is allowed: ${JSON.stringify(line)}`,
      );
    if (line.length > TEXT_PDF_MAX_LINE_LENGTH)
      throw new Error(
        `A line may be at most ${TEXT_PDF_MAX_LINE_LENGTH} characters: ${line}`,
      );
  }

  const content = [
    "BT",
    `/F1 ${FONT_SIZE} Tf`,
    `${LEADING} TL`,
    `${MARGIN} ${PAGE_HEIGHT - MARGIN} Td`,
    ...lines.map(
      (line, index) => `${index === 0 ? "" : "T* "}(${escapeText(line)}) Tj`,
    ),
    "ET",
  ].join("\n");

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    // ASCII only, so the length in characters is the length in bytes.
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  // Every cross-reference entry is exactly 20 bytes, its end of line included.
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets)
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf, "latin1"));
}

/**
 * The lines a `textPdf` shows, read back from its bytes. Only for PDFs this
 * module wrote: it reads the one content stream's text operators and nothing
 * else.
 */
export function textPdfLines(bytes: Uint8Array): string[] {
  const source = Buffer.from(bytes).toString("latin1");
  const lines: string[] = [];
  for (const match of source.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g))
    lines.push(match[1].replace(/\\(.)/g, "$1"));
  return lines;
}
