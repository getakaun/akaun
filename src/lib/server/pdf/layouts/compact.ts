import PDFDocument from "pdfkit";
import type { LayoutRenderData, ThemeData } from "$lib/pdf/render-types.js";
import { registerPdfFonts } from "../fonts.js";
import {
  M,
  CW,
  C,
  cleanText,
  drawLetterhead,
  drawStatusStamp,
  fmt,
  fmtDate,
  fmtMoney,
} from "../layout.js";

// Column layout for the tighter table below.
const QTY_W = 40;
const PRICE_W = 75;
const TOTAL_W = 75;
const DESC_W = CW - QTY_W - PRICE_W - TOTAL_W;
const QTY_X = M + DESC_W;
const PRICE_X = QTY_X + QTY_W;
const TOTAL_X = PRICE_X + PRICE_W;

/** A tighter single-column layout with smaller type and no wasted whitespace. */
export function renderCompact(
  data: LayoutRenderData,
  theme: ThemeData,
  title: string,
): Promise<Buffer> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const doc = new (PDFDocument as any)({
    size: "A4",
    margin: 0,
    // Held until the end so the status stamp can go on every page.
    bufferPages: true,
    info: { Title: title },
  });
  const fonts = registerPdfFonts(doc);
  const { document: docu, settings, docTypeLabel } = data;

  // A colored accent band down the left margin gives the theme color a strong
  // presence without spending any vertical space on it.
  doc.rect(0, 0, 6, doc.page.height).fill(theme.color);

  let y = M * 0.7;
  const docNumber = docu.invoiceNumber ?? docu.quotationNumber ?? "";

  // ── HEADER (single row) ────────────────────────────────────────────────
  // The letterhead takes the company name's place, top left.
  // About the height the 15pt name stands; the row still ends below whichever
  // of it and the title beside it is lower.
  const letterheadBottom = settings.letterheadPath
    ? y + drawLetterhead(doc, settings.letterheadPath, M, y, CW * 0.6, 20)
    : 0;
  if (!settings.letterheadPath) {
    doc
      .font(fonts.bold)
      .fontSize(15)
      .fillColor(C.dark)
      .text(cleanText(settings.companyName) || "Company", M, y, {
        width: CW * 0.6,
      });
  }
  doc
    .font(fonts.bold)
    .fontSize(13)
    .fillColor(theme.color)
    .text(`${docTypeLabel} ${docNumber}`, M, y + 1, {
      width: CW,
      align: "right",
    });
  y = Math.max(letterheadBottom, doc.y) + 3;

  const subtitleParts = [
    settings.companyAddress && cleanText(settings.companyAddress),
    settings.companyRegistrationNo &&
      `Reg. ${cleanText(settings.companyRegistrationNo)}`,
  ]
    .filter(Boolean)
    .join("   ·   ");
  if (subtitleParts) {
    doc
      .font(fonts.regular)
      .fontSize(8)
      .fillColor(C.muted)
      .text(subtitleParts, M, y, { width: CW * 0.6 });
  }

  const metaParts = [
    `Issued ${fmtDate(docu.issueDate)}`,
    docu.dueDate &&
      `Due ${fmtDate(docu.dueDate)}${docu.isOverdue ? " (overdue)" : ""}`,
    docu.expiryDate && `Valid until ${fmtDate(docu.expiryDate)}`,
    docu.reference && `Ref ${cleanText(docu.reference)}`,
  ]
    .filter(Boolean)
    .join("   ·   ");
  doc
    .font(fonts.regular)
    .fontSize(8)
    .fillColor(docu.isOverdue ? C.red : C.muted)
    .text(metaParts, M, y, { width: CW, align: "right" });
  y = doc.y + 10;

  doc
    .moveTo(M, y)
    .lineTo(M + CW, y)
    .lineWidth(1)
    .strokeColor(theme.color)
    .stroke();
  y += 10;

  // ── BILL TO (single line) ──────────────────────────────────────────────
  if (docu.contactName) {
    doc
      .font(fonts.bold)
      .fontSize(8)
      .fillColor(C.muted)
      .text("BILL TO", M, y, { continued: true, characterSpacing: 0.5 });
    doc
      .font(fonts.regular)
      .fontSize(9)
      .fillColor(C.dark)
      .text(
        `  ${cleanText(docu.contactName)}${docu.contactAddress ? ", " + cleanText(docu.contactAddress) : ""}`,
        { width: CW - 50 },
      );
    y = doc.y + 8;
  }

  // ── LINE ITEMS (tight rows, alternating tint instead of rules) ─────────
  doc.font(fonts.bold).fontSize(7).fillColor(C.muted);
  doc.text("DESCRIPTION", M, y, { width: DESC_W, characterSpacing: 0.4 });
  doc.text("QTY", QTY_X, y, {
    width: QTY_W,
    align: "center",
    characterSpacing: 0.4,
  });
  doc.text(`PRICE (${docu.currency})`, PRICE_X, y, {
    width: PRICE_W,
    align: "right",
    characterSpacing: 0.4,
  });
  doc.text(`TOTAL (${docu.currency})`, TOTAL_X, y, {
    width: TOTAL_W,
    align: "right",
    characterSpacing: 0.4,
  });
  y += 12;

  docu.lines.forEach((line, i) => {
    doc.font(fonts.regular).fontSize(9);
    const rowH = Math.max(
      16,
      doc.heightOfString(cleanText(line.description), { width: DESC_W - 4 }) +
        4,
      doc.heightOfString(String(line.quantity), { width: QTY_W }) + 4,
      doc.heightOfString(fmt(line.unitPrice, docu.currency), {
        width: PRICE_W,
      }) + 4,
      doc.heightOfString(fmt(line.lineTotal, docu.currency), {
        width: TOTAL_W - 4,
      }) + 4,
    );
    if (i % 2 === 1) doc.rect(M, y - 2, CW, rowH).fill("#f7f7f7");
    doc.font(fonts.regular).fontSize(9).fillColor(C.body);
    doc.text(cleanText(line.description), M + 4, y, { width: DESC_W - 4 });
    doc.text(String(line.quantity), QTY_X, y, {
      width: QTY_W,
      align: "center",
    });
    doc.text(fmt(line.unitPrice, docu.currency), PRICE_X, y, {
      width: PRICE_W,
      align: "right",
    });
    doc.text(fmt(line.lineTotal, docu.currency), TOTAL_X, y, {
      width: TOTAL_W - 4,
      align: "right",
    });
    y += rowH;
  });
  y += 6;

  // ── TOTALS (compact block, right-aligned) ──────────────────────────────
  const totalsW = PRICE_W + TOTAL_W + 30;
  const totalsX = M + CW - totalsW;
  doc
    .font(fonts.regular)
    .fontSize(8)
    .fillColor(C.muted)
    .text("Subtotal", totalsX, y, { width: totalsW - TOTAL_W, align: "right" });
  doc.text(fmt(docu.subtotal, docu.currency), TOTAL_X, y, {
    width: TOTAL_W,
    align: "right",
  });
  y += 14;
  doc
    .font(fonts.bold)
    .fontSize(10)
    .fillColor(theme.color)
    .text(`Total (${docu.currency})`, totalsX, y, {
      width: totalsW - TOTAL_W,
      align: "right",
    });
  doc.text(fmt(docu.total, docu.currency), TOTAL_X, y, {
    width: TOTAL_W,
    align: "right",
  });
  y = doc.y + 12;

  // Nothing is paid on, or due from, a cancelled invoice.
  if (
    data.statusStamp !== "VOID" &&
    docu.amountPaid !== undefined &&
    docu.amountPaid > 0
  ) {
    doc
      .font(fonts.bold)
      .fontSize(8)
      .fillColor(C.green)
      .text(`Paid: ${fmtMoney(docu.amountPaid, docu.currency)}`, totalsX, y, {
        width: totalsW,
        align: "right",
      });
    y = doc.y + 2;
    if (docu.amountDue !== undefined && docu.amountDue > 0) {
      doc
        .font(fonts.bold)
        .fontSize(8)
        .fillColor(C.dark)
        .text(`Due: ${fmtMoney(docu.amountDue, docu.currency)}`, totalsX, y, {
          width: totalsW,
          align: "right",
        });
    }
    y = doc.y + 10;
  }

  // ── NOTES / TERMS (small print, no rules) ──────────────────────────────
  if (docu.notes) {
    doc
      .font(fonts.bold)
      .fontSize(7)
      .fillColor(C.muted)
      .text("NOTES", M, y, { characterSpacing: 0.4 });
    doc
      .font(fonts.regular)
      .fontSize(8)
      .fillColor(C.subtle)
      .text(cleanText(docu.notes), M, doc.y + 2, { width: CW });
    y = doc.y + 8;
  }
  if (docu.terms) {
    doc
      .font(fonts.bold)
      .fontSize(7)
      .fillColor(C.muted)
      .text("TERMS", M, y, { characterSpacing: 0.4 });
    doc
      .font(fonts.regular)
      .fontSize(8)
      .fillColor(C.subtle)
      .text(cleanText(docu.terms), M, doc.y + 2, { width: CW });
  }

  if (data.statusStamp) {
    const pages = doc.bufferedPageRange();
    for (let page = pages.start; page < pages.start + pages.count; page++) {
      doc.switchToPage(page);
      drawStatusStamp(doc, fonts.bold, data.statusStamp);
    }
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}
