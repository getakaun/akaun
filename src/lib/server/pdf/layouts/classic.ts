import PDFDocument from "pdfkit";
import type { LayoutRenderData, ThemeData } from "$lib/pdf/render-types.js";
import { registerPdfFonts } from "../fonts.js";
import {
  C,
  cleanText,
  drawLetterhead,
  drawStatusStamp,
  fmt,
  fmtDate,
  fmtMoney,
} from "../layout.js";

// Page geometry — US Letter, matching the reference invoice this layout is
// modeled on (measured from its /MediaBox: 612x792pt, 30pt margins). This is
// local to `classic.ts` rather than the shared M/CW in layout.ts, because
// `compact.ts` still targets A4 and shares none of these measurements.
const M = 30;
const PAGE_W = 612;
const CW = PAGE_W - 2 * M;

/** The latest settlement date, for the "Date paid" row — falls back to null if there's nothing to read. */
function latestSettlementDate(
  settlements: { otherDate: string }[] | undefined,
): string | null {
  if (!settlements || settlements.length === 0) return null;
  return settlements.reduce(
    (latest, s) => (s.otherDate > latest ? s.otherDate : latest),
    settlements[0].otherDate,
  );
}

// Line items table columns — widths measured from the reference invoice,
// except Unit price: the reference's 46pt fits neither "Unit price (MYR)" nor
// a seven-digit price, so it is wider and the Description column gives way.
// The Amount column and the right edge are unchanged.
const QTY_W = 50;
const PRICE_W = 70;
const AMOUNT_W = 83;
const DESC_W = CW - QTY_W - PRICE_W - AMOUNT_W;
const QTY_X = M + DESC_W;
const PRICE_X = QTY_X + QTY_W;
const AMOUNT_X = PRICE_X + PRICE_W;

/** A tight, receipt-style layout: bold title, label/value meta rows, two address columns, and a compact line-items table. Within each address column the name (own company / "Bill to" contact) stays regular weight but near-black (C.dark), while the address lines beneath it drop to a dark grey (C.subtle) — color, not weight, is what separates the two there. */
export function renderClassic(
  data: LayoutRenderData,
  theme: ThemeData,
  title: string,
): Promise<Buffer> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const doc = new (PDFDocument as any)({
    size: [PAGE_W, 792],
    margins: { top: M, bottom: 70, left: M, right: M },
    bufferPages: true,
    info: { Title: title },
  });
  const fonts = registerPdfFonts(doc);
  const { document: docu, settings, docTypeLabel } = data;
  const isInvoice = docTypeLabel === "INVOICE";
  const docNumber = docu.invoiceNumber ?? docu.quotationNumber ?? "";
  // A cancelled invoice asks for nothing, so it never says what is "due".
  const isVoid = data.statusStamp === "VOID";

  // A full-width accent bar along the very top edge of the page.
  doc.rect(0, 0, doc.page.width, 3).fill(theme.color);

  doc.on("pageAdded", () => {
    doc.save().rect(0, 0, doc.page.width, 3).fill(theme.color).restore();
  });
  let y = M;
  const bodyBottom = 792 - 70;
  function ensureSpace(height: number) {
    if (y + height > bodyBottom) {
      doc.addPage();
      y = M;
    }
  }

  // ── HEADER ────────────────────────────────────────────────────────────────
  const docTitle = docTypeLabel.charAt(0) + docTypeLabel.slice(1).toLowerCase();
  doc
    .font(fonts.bold)
    .fontSize(18)
    .fillColor(C.dark)
    .text(docTitle, M, y, { width: CW * 0.6 });
  // The letterhead takes the company name's slot, top right, at about the
  // height the 18pt name stands, so the header keeps its proportions.
  if (settings.letterheadPath) {
    drawLetterhead(
      doc,
      settings.letterheadPath,
      M + CW * 0.5,
      y,
      CW * 0.5,
      24,
      "right",
    );
  } else {
    doc
      .font(fonts.bold)
      .fontSize(18)
      .fillColor(C.muted)
      .text(cleanText(settings.companyName) || "Company", M, y, {
        width: CW,
        align: "right",
      });
  }
  y += 48;

  // ── META ROWS (label/value, one line each) ──────────────────────────────
  const metaRows: [string, string][] = [
    [isInvoice ? "Invoice number" : "Quotation number", docNumber],
    ["Date of issue", fmtDate(docu.issueDate)],
  ];
  if (isInvoice && docu.dueDate) {
    metaRows.push([
      "Date due",
      fmtDate(docu.dueDate) + (docu.isOverdue ? " — overdue" : ""),
    ]);
  }
  // The total itself is under the line items; the day it was settled is
  // only said here.
  if (isInvoice && !isVoid && docu.paid) {
    const paidDate = latestSettlementDate(docu.settlements) ?? docu.issueDate;
    metaRows.push(["Date paid", fmtDate(paidDate)]);
  }
  if (!isInvoice && docu.expiryDate) {
    metaRows.push(["Valid until", fmtDate(docu.expiryDate)]);
  }
  if (docu.reference) metaRows.push(["Reference", cleanText(docu.reference)]);

  // 73.5pt fits "Invoice number" (measured from the reference invoice) — but
  // "Quotation number" and other labels can run longer, so widen the column
  // rather than let a longer label wrap onto two lines.
  doc.font(fonts.bold).fontSize(9);
  const LABEL_W = Math.max(
    73.5,
    ...metaRows.map(([label]) => doc.widthOfString(label) + 8),
  );

  for (const [label, value] of metaRows) {
    doc
      .font(fonts.bold)
      .fontSize(9)
      .fillColor(C.dark)
      .text(label, M, y, { width: LABEL_W });
    const labelBottom = doc.y;
    doc
      .font(fonts.bold)
      .fontSize(9)
      .fillColor(C.dark)
      .text(value, M + LABEL_W, y, { width: CW - LABEL_W });
    // A long label ("Quotation number" vs. "Invoice number") or value can
    // wrap onto a second line within its narrow column — advance past
    // whichever of the two actually ran taller, not a fixed line height, or
    // the next row overlaps the wrapped line.
    y = Math.max(labelBottom, doc.y, y + 13.5);
  }
  y += 14;

  // ── ADDRESS COLUMNS ──────────────────────────────────────────────────────
  // The reference gives the left (own company) column a narrow, fixed width
  // and starts the right (bill-to) column well before the content midpoint,
  // rather than splitting the row evenly.
  const leftColW = 200;
  const rightX = 250.79;
  const rightColW = M + CW - rightX;
  const addressTop = y;

  let leftY = addressTop;
  doc
    .font(fonts.regular)
    .fontSize(9)
    .fillColor(C.dark)
    .text(cleanText(settings.companyName) || "Company", M, leftY, {
      width: leftColW,
    });
  leftY = doc.y + 2;
  if (settings.companyAddress) {
    doc
      .font(fonts.regular)
      .fontSize(9)
      .fillColor(C.subtle)
      .text(cleanText(settings.companyAddress), M, leftY, { width: leftColW });
    leftY = doc.y + 2;
  }
  if (settings.companyRegistrationNo) {
    doc
      .font(fonts.regular)
      .fontSize(8)
      .fillColor(C.subtle)
      .text("Reg. No: " + cleanText(settings.companyRegistrationNo), M, leftY, {
        width: leftColW,
      });
    leftY = doc.y;
  }

  let rightY = addressTop;
  if (docu.contactName) {
    doc
      .font(fonts.bold)
      .fontSize(9)
      .fillColor(C.dark)
      .text("Bill to", rightX, rightY, { width: rightColW });
    rightY = doc.y + 2;
    doc
      .font(fonts.regular)
      .fontSize(9)
      .fillColor(C.dark)
      .text(cleanText(docu.contactName), rightX, rightY, { width: rightColW });
    rightY = doc.y + 2;
    if (docu.contactAddress) {
      doc
        .font(fonts.regular)
        .fontSize(9)
        .fillColor(C.subtle)
        .text(cleanText(docu.contactAddress), rightX, rightY, {
          width: rightColW,
        });
      rightY = doc.y + 2;
    }
    if (docu.contactRegistrationNo) {
      doc
        .font(fonts.regular)
        .fontSize(8)
        .fillColor(C.subtle)
        .text(
          "Reg. No: " + cleanText(docu.contactRegistrationNo),
          rightX,
          rightY,
          { width: rightColW },
        );
      rightY = doc.y + 2;
    }
    if (docu.contactPhone) {
      doc
        .font(fonts.regular)
        .fontSize(8)
        .fillColor(C.subtle)
        .text(cleanText(docu.contactPhone), rightX, rightY, {
          width: rightColW,
        });
      rightY = doc.y;
    }
  }

  y = Math.max(leftY, rightY) + 26;

  // ── LINE ITEMS ───────────────────────────────────────────────────────────
  function tableHeader() {
    doc.font(fonts.regular).fontSize(7.5).fillColor(C.dark);
    doc.text("Description", M, y, { width: DESC_W });
    doc.text("Qty", QTY_X, y, { width: QTY_W, align: "center" });
    // The currency is named once per column, not on every cell.
    doc.text(`Unit price (${docu.currency})`, PRICE_X, y, {
      width: PRICE_W,
      align: "right",
    });
    doc.font(fonts.bold).fontSize(7.5).fillColor(C.dark);
    doc.text(`Amount (${docu.currency})`, AMOUNT_X, y, {
      width: AMOUNT_W,
      align: "right",
    });
    y += 12;
    doc
      .moveTo(M, y)
      .lineTo(M + CW, y)
      .lineWidth(1)
      .strokeColor(C.dark)
      .stroke();
    y += 8;
  }
  ensureSpace(40);
  tableHeader();

  for (const line of docu.lines) {
    doc.font(fonts.regular).fontSize(9.5);
    const description = cleanText(line.description);
    // Split exceptionally long descriptions so even a single item can span pages.
    let remaining = description;
    let firstPart = true;
    do {
      doc.font(fonts.regular).fontSize(9.5);
      if (y + 17 > bodyBottom) {
        doc.addPage();
        y = M;
        tableHeader();
        doc.font(fonts.regular).fontSize(9.5);
      }
      if (
        doc.heightOfString(remaining, { width: DESC_W }) + 4 > bodyBottom - y &&
        y > M + 20
      ) {
        doc.addPage();
        y = M;
        tableHeader();
        doc.font(fonts.regular).fontSize(9.5);
      }
      let low = 1;
      let high = remaining.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (
          doc.heightOfString(remaining.slice(0, mid), { width: DESC_W }) + 4 <=
          bodyBottom - y
        )
          low = mid;
        else high = mid - 1;
      }
      let end = low;
      if (end < remaining.length) {
        const boundary = remaining.slice(0, end).search(/\s+\S*$/);
        if (boundary > 0) end = boundary + 1;
      }
      const part = remaining.slice(0, end);
      remaining = remaining.slice(end);
      const rowY = y;
      doc
        .font(fonts.regular)
        .fontSize(9.5)
        .fillColor(C.dark)
        .text(part, M, rowY, { width: DESC_W });
      const rowEndY = doc.y;
      if (firstPart) {
        doc
          .font(fonts.regular)
          .fontSize(9.5)
          .fillColor(C.dark)
          .text(String(line.quantity), QTY_X, rowY, {
            width: QTY_W,
            align: "center",
          });
        doc
          .font(fonts.regular)
          .fontSize(9.5)
          .fillColor(C.dark)
          .text(fmt(line.unitPrice, docu.currency), PRICE_X, rowY, {
            width: PRICE_W,
            align: "right",
          });
        doc
          .font(fonts.bold)
          .fontSize(9.5)
          .fillColor(C.dark)
          .text(fmt(line.lineTotal, docu.currency), AMOUNT_X, rowY, {
            width: AMOUNT_W,
            align: "right",
          });
      }
      y = Math.max(rowEndY, rowY + 13) + 4;
      firstPart = false;
    } while (remaining.length > 0);
  }
  ensureSpace(100);
  y += 6;
  doc
    .moveTo(M, y)
    .lineTo(M + CW, y)
    .lineWidth(1)
    .strokeColor(C.light)
    .stroke();
  y += 12;

  // ── TOTALS (label left-aligned from the content midpoint, value
  // right-aligned to the page margin — matching the reference) ────────────
  const totalsX = M + CW / 2;
  const totalsLabelW = AMOUNT_X - totalsX;

  doc
    .font(fonts.regular)
    .fontSize(9)
    .fillColor(C.dark)
    .text("Subtotal", totalsX, y, { width: totalsLabelW });
  doc
    .font(fonts.regular)
    .fontSize(9)
    .fillColor(C.dark)
    .text(fmt(docu.subtotal, docu.currency), AMOUNT_X, y, {
      width: AMOUNT_W,
      align: "right",
    });
  y += 14.25;

  doc
    .font(fonts.bold)
    .fontSize(9)
    .fillColor(C.dark)
    .text("Total", totalsX, y, { width: totalsLabelW });
  doc
    .font(fonts.bold)
    .fontSize(9)
    .fillColor(C.dark)
    .text(fmtMoney(docu.total, docu.currency), AMOUNT_X, y, {
      width: AMOUNT_W,
      align: "right",
    });
  y += 14.25;

  if (isInvoice && !isVoid) {
    const label = docu.paid ? "Amount paid" : "Amount due";
    const amount = docu.paid
      ? fmtMoney(docu.amountPaid ?? docu.total, docu.currency)
      : fmtMoney(docu.amountDue ?? docu.total, docu.currency);
    doc
      .font(fonts.bold)
      .fontSize(9)
      .fillColor(C.dark)
      .text(label, totalsX, y, { width: totalsLabelW });
    doc
      .font(fonts.bold)
      .fontSize(9)
      .fillColor(C.dark)
      .text(amount, AMOUNT_X, y, {
        width: AMOUNT_W,
        align: "right",
      });
    y += 14.25;
  }
  y += 12;

  // ── NOTES / TERMS ────────────────────────────────────────────────────────
  if (docu.notes) {
    ensureSpace(35);
    doc
      .font(fonts.bold)
      .fontSize(8)
      .fillColor(C.dark)
      .text("NOTES", M, y, { characterSpacing: 0.5 });
    y = doc.y + 3;
    doc
      .font(fonts.regular)
      .fontSize(9)
      .fillColor(C.dark)
      .text(cleanText(docu.notes), M, y, { width: CW });
    y = doc.y + 12;
  }
  if (docu.terms) {
    ensureSpace(35);
    doc
      .font(fonts.bold)
      .fontSize(8)
      .fillColor(C.dark)
      .text("TERMS & CONDITIONS", M, y, { characterSpacing: 0.5 });
    y = doc.y + 3;
    doc
      .font(fonts.regular)
      .fontSize(9)
      .fillColor(C.dark)
      .text(cleanText(docu.terms), M, y, { width: CW });
  }

  // Stamp buffered pages only after all body text has been laid out.
  const pages = doc.bufferedPageRange();
  for (let page = pages.start; page < pages.start + pages.count; page++) {
    doc.switchToPage(page);
    if (data.statusStamp) drawStatusStamp(doc, fonts.bold, data.statusStamp);
    const footerRuleY = doc.page.height - 53.75;
    doc
      .moveTo(M, footerRuleY)
      .lineTo(M + CW, footerRuleY)
      .lineWidth(1)
      .strokeColor(C.light)
      .stroke();
    // The footer occupies the reserved bottom margin.
    doc.page.margins.bottom = 0;
    doc
      .font(fonts.regular)
      .fontSize(8)
      .fillColor(C.dark)
      .text(`Page ${page + 1} of ${pages.count}`, M, footerRuleY + 8, {
        width: CW,
        align: "right",
      });
    doc.page.margins.bottom = 70;
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}
