import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  getDocumentProxy,
  extractTextItems,
  type StructuredTextItem,
} from "unpdf";
import { OPS } from "unpdf/pdfjs";
import type { LayoutRenderData, ThemeData } from "$lib/pdf/render-types.js";
import { renderClassic } from "./classic.js";

// Structural/text-position diff against a real invoice PDF the user wants the
// "classic" layout to resemble (a Stripe-generated invoice for their own
// company — see __fixtures__/reference-invoice.pdf). We compare rendered text
// positions rather than pixels: no image-diff tooling needed, `unpdf` (already
// a dependency, used elsewhere for OCR) gives exact per-run x/y/fontSize.
//
// The fixture below mirrors the reference invoice's actual content field for
// field, so that most rows can be found by matching identical text in both
// documents. Two fields don't map onto `LayoutRenderData` and are accepted
// gaps rather than bugs to fix:
//   - the reference's tiered sub-line pricing ("First 1" / "2 and above" rows
//     nested under "Printago Core") — `LayoutLineItem` has no sub-line concept
//   - the date format ("August 11, 2026" vs. this app's "11 August 2026") —
//     `fmtDate` in layout.ts is a deliberate app-wide format, not a per-layout
//     bug, so date *values* are matched by position (see `afterLabel`), not by
//     comparing the formatted string.

type Item = StructuredTextItem;

async function pageItems(data: Uint8Array): Promise<Item[]> {
  const pdf = await getDocumentProxy(data);
  const { items } = await extractTextItems(pdf);
  return items[0].filter((i) => i.str.trim().length > 0);
}

function mediaBox(data: Uint8Array): { width: number; height: number } {
  const text = Buffer.from(data).toString("latin1");
  const match = text.match(
    /\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/,
  );
  if (!match) throw new Error("no /MediaBox found in generated PDF");
  return {
    width: parseFloat(match[3]) - parseFloat(match[1]),
    height: parseFloat(match[4]) - parseFloat(match[2]),
  };
}

/** Extracts the thickness of every horizontal rule drawn on the page, via
 * pdf.js's operator list — rules are vector graphics, not text, so
 * `extractTextItems` can't see them. A rule shows up one of two ways:
 *   - a stroked path (PDFKit's `.moveTo().lineTo().lineWidth(w).stroke()`):
 *     a zero-height `constructPath` bbox, thickness = the last `setLineWidth`.
 *   - a hairline drawn as a thin filled rectangle (how the reference invoice
 *     draws its rules): a `constructPath` bbox with a small non-zero height,
 *     thickness = that height.
 * Bboxes wildly outside the page (embedded artwork drawn in its own internal
 * coordinate space) and short segments (not a page-width/column-width rule)
 * are filtered out. */
async function horizontalRuleThicknesses(data: Uint8Array): Promise<number[]> {
  const pdf = await getDocumentProxy(data);
  const page = await pdf.getPage(1);
  const opList = await page.getOperatorList();
  const thicknesses: number[] = [];
  let lineWidth = 1; // PDF default stroke width if never set
  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i];
    if (fn === OPS.setLineWidth) {
      lineWidth = (opList.argsArray[i] as [number])[0];
      continue;
    }
    if (fn !== OPS.constructPath) continue;
    const bbox = opList.argsArray[i][2] as {
      0: number;
      1: number;
      2: number;
      3: number;
    };
    const x0 = bbox[0],
      y0 = bbox[1],
      x1 = bbox[2],
      y1 = bbox[3];
    const width = Math.abs(x1 - x0);
    const height = Math.abs(y1 - y0);
    if (Math.max(x0, x1, y0, y1) > 1000) continue; // not page-space
    if (width < 20) continue; // too short to be a divider/rule
    if (Math.min(y0, y1) < 5) continue; // the top accent bar, not a rule
    if (height === 0) thicknesses.push(lineWidth);
    else if (height <= 3) thicknesses.push(height);
  }
  return thicknesses;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/** Groups text items into visual rows by y-position. `tolerance` must comfortably
 * cover baseline drift between differently-sized runs on one nominal row (a few pt)
 * while staying well under real row-to-row spacing (13-14pt in this layout). */
function rows(items: Item[], tolerance = 3): Item[][] {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const groups: Item[][] = [];
  for (const item of sorted) {
    const group = groups.find((g) => Math.abs(g[0].y - item.y) <= tolerance);
    if (group) group.push(item);
    else groups.push([item]);
  }
  for (const g of groups) g.sort((a, b) => a.x - b.x);
  return groups;
}

function rowWith(all: Item[][], label: string): Item[] {
  const row = all.find((r) => r.some((i) => i.str.trim() === label));
  if (!row) {
    throw new Error(`no row containing "${label}"`);
  }
  return row;
}

function cell(row: Item[], label: string): Item {
  const item = row.find((i) => i.str.trim() === label);
  if (!item) {
    throw new Error(
      `"${label}" not in row: ${row.map((i) => i.str).join("|")}`,
    );
  }
  return item;
}

/** Bounding box of everything in `row` after the item matching `label` — for
 * label/value pairs where the value's text content is expected to differ
 * (e.g. date format) but its position should still line up. */
function afterLabel(row: Item[], label: string): { x: number; right: number } {
  const idx = row.findIndex((i) => i.str.trim() === label);
  if (idx === -1) throw new Error(`label "${label}" not in row`);
  const rest = row.slice(idx + 1);
  if (rest.length === 0) throw new Error(`nothing after "${label}"`);
  return {
    x: Math.min(...rest.map((i) => i.x)),
    right: Math.max(...rest.map((i) => i.x + i.width)),
  };
}

const TOL = 3; // pt — pdfkit's font metrics won't land on the reference's exact sub-pixel positions
const FONT_TOL = 0.3; // pt — font sizes are literal numbers we control exactly, not glyph metrics

/** `toBeCloseTo(x, 0)` only allows ±0.5 — too strict for cross-renderer text
 * positions. This asserts |actual - expected| <= tolerance with a clear message. */
function closeTo(
  actual: number,
  expected: number,
  message: string,
  tolerance = TOL,
): void {
  const diff = Math.abs(actual - expected);
  expect(
    diff,
    `${message} (actual ${actual.toFixed(2)}, reference ${expected.toFixed(2)}, diff ${diff.toFixed(2)}, tolerance ${tolerance})`,
  ).toBeLessThanOrEqual(tolerance);
}

const fixture: LayoutRenderData = {
  document: {
    invoiceNumber: "R0XF2LMI-0011",
    issueDate: "2026-08-11",
    dueDate: "2026-08-11",
    currency: "USD",
    lines: [
      {
        description: "Printago Core\nAug 11–Sep 11, 2026",
        quantity: 6,
        unitPrice: 20 / 6,
        lineTotal: 20,
      },
    ],
    subtotal: 20,
    total: 20,
    contactName: "QUANLAB ENTERPRISE",
    contactAddress:
      "17, Lorong Hijauan Valdor 46,\nHijauan Valdor\n14200 Sungai Jawi\nPulau Pinang\nMalaysia",
    contactPhone: "+60 18-942 8211\ntanghq33@outlook.com",
    paid: false,
    amountDue: 20,
  },
  settings: {
    companyName: "Printago",
    companyAddress:
      "211 Haddock Road\nMcAdoo, Pennsylvania 18237\nUnited States\nmatt@printago.io",
  },
  docTypeLabel: "INVOICE",
};

const theme: ThemeData = { color: "#1a56db" };

const referencePath = fileURLToPath(
  new URL("./__fixtures__/reference-invoice.pdf", import.meta.url),
);

describe("renderClassic vs. reference invoice layout", () => {
  let generatedBuffer: Buffer;
  let generated: Item[];
  let generatedRows: Item[][];
  let referenceBuffer: Buffer;
  let reference: Item[];
  let referenceRows: Item[][];

  beforeAll(async () => {
    generatedBuffer = await renderClassic(fixture, theme, "INV-TEST");
    generated = await pageItems(new Uint8Array(generatedBuffer));
    generatedRows = rows(generated);

    referenceBuffer = readFileSync(referencePath);
    reference = await pageItems(new Uint8Array(referenceBuffer));
    referenceRows = rows(reference);
  });

  it("uses the reference's US Letter page size", () => {
    const size = mediaBox(new Uint8Array(generatedBuffer));
    closeTo(
      size.width,
      612,
      "page width — check the `size` passed to PDFDocument in classic.ts",
      0.5,
    );
    closeTo(
      size.height,
      792,
      "page height — check the `size` passed to PDFDocument in classic.ts",
      0.5,
    );
  });

  it("aligns the title and the company name with the reference", () => {
    const gTitleRow = rowWith(generatedRows, "Invoice");
    const rTitleRow = rowWith(referenceRows, "Invoice");
    const gTitle = cell(gTitleRow, "Invoice");
    const rTitle = cell(rTitleRow, "Invoice");
    closeTo(gTitle.x, rTitle.x, "title x — check M in classic.ts");
    closeTo(
      gTitle.fontSize,
      rTitle.fontSize,
      "title font size — check the title fontSize() in classic.ts",
      FONT_TOL,
    );

    const gCompany = cell(gTitleRow, "Printago");
    const rCompany = cell(rTitleRow, "Printago");
    closeTo(
      gCompany.x + gCompany.width,
      rCompany.x + rCompany.width,
      "company-name right edge — check the right-aligned width box in classic.ts's header",
    );
  });

  it("positions the invoice-number / date meta rows like the reference", () => {
    for (const label of ["Invoice number", "Date of issue", "Date due"]) {
      const gRow = rowWith(generatedRows, label);
      const rRow = rowWith(referenceRows, label);
      closeTo(
        cell(gRow, label).x,
        cell(rRow, label).x,
        `"${label}" label x — check M in classic.ts`,
      );
      const gValue = afterLabel(gRow, label);
      const rValue = afterLabel(rRow, label);
      closeTo(
        gValue.x,
        rValue.x,
        `"${label}" value x — check LABEL_W in classic.ts's meta rows`,
      );
    }

    const issueRow = rowWith(generatedRows, "Date of issue");
    const dueRow = rowWith(generatedRows, "Date due");
    const refIssueRow = rowWith(referenceRows, "Date of issue");
    const refDueRow = rowWith(referenceRows, "Date due");
    const generatedSpacing =
      cell(issueRow, "Date of issue").y - cell(dueRow, "Date due").y;
    const referenceSpacing =
      cell(refIssueRow, "Date of issue").y - cell(refDueRow, "Date due").y;
    closeTo(
      generatedSpacing,
      referenceSpacing,
      "meta row spacing — check the meta-row loop's y increment in classic.ts",
    );
  });

  it("positions the two address columns like the reference", () => {
    const gRow = rowWith(generatedRows, "QUANLAB ENTERPRISE");
    const rRow = rowWith(referenceRows, "QUANLAB ENTERPRISE");
    const gName = cell(gRow, "QUANLAB ENTERPRISE");
    const rName = cell(rRow, "QUANLAB ENTERPRISE");
    closeTo(
      gName.x,
      rName.x,
      "right (bill-to) column x — check rightX in classic.ts's address columns",
    );
    closeTo(
      gName.fontSize,
      rName.fontSize,
      "contact-name font size — check the docu.contactName fontSize() in classic.ts",
      FONT_TOL,
    );

    const gAddrRow = rowWith(generatedRows, "United States");
    const rAddrRow = rowWith(referenceRows, "United States");
    closeTo(
      cell(gAddrRow, "United States").x,
      cell(rAddrRow, "United States").x,
      "left (own company) column x — check M in classic.ts's address columns",
    );

    // "Bill to" sits on the same visual row as the left column's own-company
    // name (both at addressTop), so it's the row to anchor that lookup on.
    const gBillTo = rowWith(generatedRows, "Bill to");
    const rBillTo = rowWith(referenceRows, "Bill to");
    closeTo(
      cell(gBillTo, "Bill to").fontSize,
      cell(rBillTo, "Bill to").fontSize,
      `"Bill to" label font size — check classic.ts's address columns`,
      FONT_TOL,
    );

    const gCompanyName = cell(gBillTo, "Printago");
    const rCompanyName = cell(rBillTo, "Printago");
    closeTo(
      gCompanyName.fontSize,
      rCompanyName.fontSize,
      "own-company name font size — check settings.companyName fontSize() in classic.ts",
      FONT_TOL,
    );
  });

  it("aligns the line-items table header columns with the reference", () => {
    // Our headers name the currency ("Unit price (USD)"); the reference's don't.
    for (const [label, generatedLabel] of [
      ["Description", "Description"],
      ["Unit price", "Unit price (USD)"],
      ["Amount", "Amount (USD)"],
    ] as const) {
      const gRow = rowWith(generatedRows, generatedLabel);
      const rRow = rowWith(referenceRows, label);
      const g = cell(gRow, generatedLabel);
      const r = cell(rRow, label);
      // Description is left-aligned (compare left edge); Unit price/Amount
      // are right-aligned columns (compare right edge).
      if (label === "Unit price" || label === "Amount") {
        closeTo(
          g.x + g.width,
          r.x + r.width,
          `"${label}" column right edge — check the *_W column constants in classic.ts`,
        );
      } else {
        closeTo(
          g.x,
          r.x,
          `"${label}" column x — check the *_W column constants in classic.ts`,
        );
      }
    }
    // Qty sits left of the reference on purpose: the Unit price column is wider
    // than the reference's 46pt so "Unit price (MYR)" fits. It stays centred
    // over a 50pt column ending where Unit price begins.
    const gQty = cell(rowWith(generatedRows, "Qty"), "Qty");
    const gPrice = cell(
      rowWith(generatedRows, "Unit price (USD)"),
      "Unit price (USD)",
    );
    const priceColumnLeft = gPrice.x + gPrice.width - 70;
    closeTo(
      gQty.x + gQty.width / 2,
      priceColumnLeft - 25,
      `"Qty" column centre — check QTY_W/PRICE_W in classic.ts`,
    );
  });

  it("aligns the totals block with the reference", () => {
    for (const label of ["Subtotal", "Total", "Amount due"]) {
      const gRow = rowWith(generatedRows, label);
      const rRow = rowWith(referenceRows, label);
      closeTo(
        cell(gRow, label).x,
        cell(rRow, label).x,
        `"${label}" label x — check totalsX in classic.ts's totals block`,
      );
    }

    const gSubtotalRow = rowWith(generatedRows, "Subtotal");
    const gTotalRow = rowWith(generatedRows, "Total");
    const rSubtotalRow = rowWith(referenceRows, "Subtotal");
    const rTotalRow = rowWith(referenceRows, "Total");
    const generatedSpacing =
      cell(gSubtotalRow, "Subtotal").y - cell(gTotalRow, "Total").y;
    const referenceSpacing =
      cell(rSubtotalRow, "Subtotal").y - cell(rTotalRow, "Total").y;
    closeTo(
      generatedSpacing,
      referenceSpacing,
      "totals row spacing — check the totals block's y increment in classic.ts",
    );
  });

  it("positions the footer like the reference", () => {
    const gRow = generatedRows.find((r) =>
      r.some((i) => i.str.includes("Page 1 of 1")),
    );
    const rRow = referenceRows.find((r) =>
      r.some((i) => i.str.includes("Page 1 of 1")),
    );
    if (!gRow) throw new Error("generated PDF: footer not found");
    if (!rRow) throw new Error("reference PDF: footer not found");
    const g = gRow.find((i) => i.str.includes("Page 1 of 1"))!;
    const r = rRow.find((i) => i.str.includes("Page 1 of 1"))!;
    closeTo(
      g.x + g.width,
      r.x + r.width,
      "footer right edge — check the footer's `M + CW` in classic.ts",
    );
    closeTo(g.y, r.y, "footer y — check footerRuleY in classic.ts");
  });

  it("draws horizontal rules at the same thickness as the reference", async () => {
    const generatedThicknesses = await horizontalRuleThicknesses(
      new Uint8Array(generatedBuffer),
    );
    const referenceThicknesses = await horizontalRuleThicknesses(
      new Uint8Array(referenceBuffer),
    );
    expect(
      generatedThicknesses.length,
      "no horizontal rules found in the generated PDF — check horizontalRuleThicknesses() still matches classic.ts's stroke calls",
    ).toBeGreaterThan(0);
    expect(
      referenceThicknesses.length,
      "no horizontal rules found in the reference PDF",
    ).toBeGreaterThan(0);
    closeTo(
      median(generatedThicknesses),
      median(referenceThicknesses),
      "horizontal rule thickness — check the `.lineWidth(...)` calls in classic.ts",
      0.15,
    );
  });
});

/** Flags two text runs whose rendered boxes genuinely overlap (not just
 * touch/kern) — catches a wrapped line bleeding into the row below it, e.g.
 * a long meta-row label or value wrapping onto a second line that the next
 * row's fixed y-increment didn't leave room for. */
function findOverlap(items: Item[]): [Item, Item] | null {
  const EPS = 1; // pt — tolerance for adjacent glyphs/lines that merely touch
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i];
      const b = items[j];
      const xOverlap =
        Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const yOverlap =
        Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      if (xOverlap > EPS && yOverlap > EPS) return [a, b];
    }
  }
  return null;
}

describe("renderClassic meta rows never overlap", () => {
  const baseFixture: LayoutRenderData = {
    document: {
      quotationNumber: "Q-R0XF2LMI-0011", // longer than "Invoice number" — the original overlap report
      issueDate: "2026-08-11",
      expiryDate: "2026-09-11",
      currency: "USD",
      lines: [
        {
          description: "Printago Core",
          quantity: 6,
          unitPrice: 20 / 6,
          lineTotal: 20,
        },
      ],
      subtotal: 20,
      total: 20,
    },
    settings: { companyName: "Printago" },
    docTypeLabel: "QUOTATION",
  };

  it("does not overlap rows for a quotation's longer meta-row label", async () => {
    const buffer = await renderClassic(baseFixture, theme, "Q-TEST");
    const items = await pageItems(new Uint8Array(buffer));
    const overlap = findOverlap(items);
    expect(
      overlap,
      overlap
        ? `"${overlap[0].str}" overlaps "${overlap[1].str}" — check the meta-row loop's y advance in classic.ts`
        : undefined,
    ).toBeNull();
  });

  it("does not overlap rows when a meta-row value wraps onto two lines", async () => {
    const fixture: LayoutRenderData = {
      ...baseFixture,
      document: {
        ...baseFixture.document,
        reference:
          "A very long customer-supplied reference string that is long enough to wrap onto a second line within its column",
      },
    };
    const buffer = await renderClassic(fixture, theme, "Q-TEST");
    const items = await pageItems(new Uint8Array(buffer));
    const overlap = findOverlap(items);
    expect(
      overlap,
      overlap
        ? `"${overlap[0].str}" overlaps "${overlap[1].str}" — check the meta-row loop's y advance in classic.ts`
        : undefined,
    ).toBeNull();
  });
});

describe("renderClassic strips CRLF line endings from free text", () => {
  // A browser textarea or a CSV import commonly produces \r\n. PDFKit's line
  // wrapper only splits on \n, so a bare \r is left attached to the end of
  // each visual line — and our embedded Inter subset has no glyph for it, so
  // it renders as a visible missing-glyph box (reported as "weird character"
  // after every wrapped line of a multi-line contact address).
  const crlfFixture: LayoutRenderData = {
    document: {
      invoiceNumber: "R0XF2LMI-0011",
      issueDate: "2026-08-11",
      currency: "USD",
      lines: [
        { description: "Item", quantity: 1, unitPrice: 20, lineTotal: 20 },
      ],
      subtotal: 20,
      total: 20,
      contactName: "QUANLAB",
      contactAddress:
        "No 17, Lorong Hijauan Valdor 46,\r\nHijauan Valdor,\r\n14200 Pulau Pinang,\r\nMalaysia",
    },
    settings: { companyName: "Printago" },
    docTypeLabel: "INVOICE",
  };

  it("renders no missing-glyph placeholder for a CRLF contact address", async () => {
    const buffer = await renderClassic(crlfFixture, theme, "INV-TEST");
    const items = await pageItems(new Uint8Array(buffer));
    const hasNotdef = items.some((i) =>
      [...i.str].some((c) => c.codePointAt(0)! < 0x20),
    );
    expect(
      hasNotdef,
      "a control character survived into rendered text — check cleanText() is applied in classic.ts",
    ).toBe(false);
  });
});

describe("renderClassic top accent bar", () => {
  const fixture: LayoutRenderData = {
    document: {
      invoiceNumber: "R0XF2LMI-0011",
      issueDate: "2026-08-11",
      currency: "USD",
      lines: [
        { description: "Item", quantity: 1, unitPrice: 20, lineTotal: 20 },
      ],
      subtotal: 20,
      total: 20,
    },
    settings: { companyName: "Printago" },
    docTypeLabel: "INVOICE",
  };

  it("is 3pt thick", async () => {
    const buffer = await renderClassic(fixture, theme, "INV-TEST");
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const page = await pdf.getPage(1);
    const opList = await page.getOperatorList();
    let bar: { 0: number; 1: number; 2: number; 3: number } | undefined;
    for (let i = 0; i < opList.fnArray.length; i++) {
      if (opList.fnArray[i] !== OPS.constructPath) continue;
      const bbox = opList.argsArray[i][2] as {
        0: number;
        1: number;
        2: number;
        3: number;
      };
      // The accent bar is the one full-page-width filled rect anchored at
      // the very top edge (y in [0, 20] to tolerate the transform's flip).
      if (
        Math.abs(bbox[2] - bbox[0]) > 500 &&
        Math.min(bbox[1], bbox[3]) < 20
      ) {
        bar = bbox;
        break;
      }
    }
    if (!bar) throw new Error("top accent bar not found in operator list");
    closeTo(
      Math.abs(bar[3] - bar[1]),
      3,
      "top accent bar thickness — check the `doc.rect(0, 0, doc.page.width, ...)` height in classic.ts",
      0.1,
    );
  });
});
