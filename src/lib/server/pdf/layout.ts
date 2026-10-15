import { currencyDecimals } from "$lib/currency.js";
import type { StatusStamp } from "$lib/pdf/render-types.js";

export const PT_PER_MM = 2.8346; // points per millimetre

export const M = 15 * PT_PER_MM; // 15mm page margin in points
export const PW = 595.28; // A4 width
export const CW = PW - 2 * M; // content width ≈ 481.9

// Line items table column widths and X positions
export const COL_DESC = 248;
export const COL_QTY = 55;
export const COL_PRICE = 90;
export const COL_TOTAL = CW - COL_DESC - COL_QTY - COL_PRICE;

export const TX_QTY = M + COL_DESC;
export const TX_PRICE = TX_QTY + COL_QTY;
export const TX_TOTAL = TX_PRICE + COL_PRICE;

export const C = {
  dark: "#111111",
  body: "#1a1a1a",
  subtle: "#555555",
  muted: "#888888",
  light: "#e5e5e5",
  red: "#c0392b",
  green: "#166534",
} as const;

/** Normalizes line endings before handing free text to PDFKit. A CRLF or lone-CR
 * input (a browser textarea, a CSV import) leaves a stray \r glyph that PDFKit's
 * line wrapper doesn't split on — it stays attached to the end of the previous
 * line, and since our embedded Inter subset has no glyph for it, it renders as
 * a visible missing-glyph box instead of vanishing quietly. */
export function cleanText(s: string | null | undefined): string {
  if (!s) return "";
  return s.replace(/\r\n?/g, "\n");
}

/** A bare amount in the document currency's own decimals (JPY → 0, KWD → 3).
 * Only for figures under a column header that already names the currency. */
export function fmt(n: number, currency: string): string {
  const decimals = currencyDecimals(currency);
  return new Intl.NumberFormat("en-MY", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(n);
}

/** An amount that stands on its own — Total, Amount due/paid — with the ISO
 * code after it ("1,234.00 MYR"). The code, not a symbol: "$" is a dozen
 * currencies, and symbol plus code ("RM 1,234.00 MYR") says it twice. */
export function fmtMoney(n: number, currency: string): string {
  return `${fmt(n, currency)} ${currency}`;
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  const months = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  return `${parseInt(d)} ${months[parseInt(m) - 1]} ${y}`;
}

/**
 * VOID, DRAFT or SUPERSEDED, large, faint and on the diagonal across the
 * current page — the way a paper invoice is stamped, so a printed copy of a
 * cancelled or unsent invoice, or of a quotation since revised, cannot be
 * mistaken for a live one. A word too long for the page at full size is set
 * smaller to fit.
 *
 * Drawn with no `width`, so PDFKit's line wrapper never runs: a wrapped run
 * near the bottom margin would otherwise start a page of its own. The caller
 * calls this once per page, after the page's content, and the graphics state
 * (rotation, opacity) is restored before anything else is drawn.
 */
export function drawStatusStamp(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  doc: any,
  boldFont: string,
  stamp: StatusStamp,
): void {
  const { width, height } = doc.page;
  doc.save();
  doc.font(boldFont).fontSize(110);
  const fullW = doc.widthOfString(stamp);
  doc.fontSize(110 * Math.min(1, (width * 0.9) / fullW));
  const textW = doc.widthOfString(stamp);
  const textH = doc.currentLineHeight();
  doc.rotate(-30, { origin: [width / 2, height / 2] });
  doc
    .fillColor(stamp === "VOID" ? C.red : C.muted)
    .fillOpacity(0.12)
    .text(stamp, (width - textW) / 2, (height - textH) / 2, {
      lineBreak: false,
    });
  doc.restore();
}

/**
 * Draw the company letterhead at `(x, y)`, scaled to fit within `maxW × maxH`
 * without changing its shape, and return the height it took. A layout decides
 * only where its masthead goes; whether there is a letterhead at all, and
 * which file it is, was settled before the layout was called.
 */
export function drawLetterhead(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  doc: any,
  path: string,
  x: number,
  y: number,
  maxW: number,
  maxH: number,
  align: "left" | "center" | "right" = "left",
): number {
  const image = doc.openImage(path);
  const scale = Math.min(maxW / image.width, maxH / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  const offset =
    align === "right"
      ? maxW - width
      : align === "center"
        ? (maxW - width) / 2
        : 0;
  doc.image(image, x + offset, y, { width, height });
  return height;
}
