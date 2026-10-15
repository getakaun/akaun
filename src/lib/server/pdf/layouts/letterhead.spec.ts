import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getDocumentProxy, extractTextItems } from "unpdf";
import type { LayoutRenderData } from "$lib/pdf/render-types.js";
import { renderClassic } from "./classic.js";
import { renderCompact } from "./compact.js";
import { resolveLetterhead } from "../sales-pdf.js";

// A 1×1 PNG: enough for PDFKit to embed, and the fit math is the same at any size.
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const NAME = "Acme Trading";
const theme = { color: "#1a56db" };
const base: LayoutRenderData = {
  document: {
    invoiceNumber: "INV-1",
    issueDate: "2026-01-01",
    currency: "MYR",
    lines: [{ description: "Item", quantity: 1, unitPrice: 20, lineTotal: 20 }],
    subtotal: 20,
    total: 20,
  },
  settings: { companyName: NAME },
  docTypeLabel: "INVOICE",
};

let root: string;
let letterhead: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "akaun-letterhead-"));
  letterhead = join(root, "letterhead.png");
  writeFileSync(letterhead, PNG_1X1);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function text(buffer: Buffer): Promise<string[]> {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { items } = await extractTextItems(pdf);
  await pdf.destroy();
  return items[0].map((i) => i.str).filter((s) => s.trim());
}
const hasImage = (buffer: Buffer) =>
  buffer.toString("latin1").includes("/Subtype /Image");
const withLetterhead = (): LayoutRenderData => ({
  ...base,
  settings: { ...base.settings, letterheadPath: letterhead },
});

describe("letterhead header", () => {
  it("classic: prints the name twice and no image without a letterhead", async () => {
    const pdf = await renderClassic(base, theme, "Invoice");
    expect(hasImage(pdf)).toBe(false);
    expect((await text(pdf)).filter((s) => s === NAME)).toHaveLength(2);
  });

  it("classic: the letterhead replaces the masthead name, the From block keeps it", async () => {
    const pdf = await renderClassic(withLetterhead(), theme, "Invoice");
    expect(hasImage(pdf)).toBe(true);
    expect((await text(pdf)).filter((s) => s === NAME)).toHaveLength(1);
  });

  it("compact: the letterhead replaces the company name", async () => {
    const plain = await renderCompact(base, theme, "Invoice");
    expect(hasImage(plain)).toBe(false);
    expect(await text(plain)).toContain(NAME);

    const pdf = await renderCompact(withLetterhead(), theme, "Invoice");
    expect(hasImage(pdf)).toBe(true);
    expect(await text(pdf)).not.toContain(NAME);
  });
});

describe("resolveLetterhead", () => {
  it("prints the name unless the letterhead is chosen and its file exists", () => {
    expect(resolveLetterhead(null, "letterhead.png", root)).toBeUndefined();
    expect(resolveLetterhead("name", "letterhead.png", root)).toBeUndefined();
    expect(resolveLetterhead("letterhead", "", root)).toBeUndefined();
    expect(resolveLetterhead("letterhead", null, root)).toBeUndefined();
    expect(resolveLetterhead("letterhead", "gone.png", root)).toBeUndefined();
  });

  it("returns the absolute path when the letterhead is chosen and present", () => {
    expect(resolveLetterhead("letterhead", "letterhead.png", root)).toBe(
      letterhead,
    );
  });
});
