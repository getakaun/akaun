import { describe, it, expect } from "vitest";
import { getDocumentProxy, extractTextItems } from "unpdf";
import type { LayoutRenderData } from "$lib/pdf/render-types.js";
import { InvoiceStatus } from "$lib/enums.js";
import { renderClassic } from "./classic.js";
import { renderCompact } from "./compact.js";
import { invoicePdfAmounts, statusStampFor } from "../sales-pdf.js";

const base: LayoutRenderData = {
  document: {
    invoiceNumber: "INV-1",
    issueDate: "2026-01-01",
    currency: "MYR",
    lines: [{ description: "Item", quantity: 1, unitPrice: 20, lineTotal: 20 }],
    subtotal: 20,
    total: 20,
  },
  settings: { companyName: "Company" },
  docTypeLabel: "INVOICE",
};
const theme = { color: "#1a56db" };
async function pages(buffer: Buffer) {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { items } = await extractTextItems(pdf);
  await pdf.destroy();
  return items.map((page) => page.filter((item) => item.str.trim()));
}
describe("PDF review regressions", () => {
  it("uses the latest payment accounting date rather than allocation timestamps", async () => {
    const data = {
      ...base,
      document: {
        ...base.document,
        paid: true,
        settlements: [
          {
            amountMinor: 1000,
            createdAt: "2026-09-01",
            otherDate: "2026-02-15",
          },
          {
            amountMinor: 1000,
            createdAt: "2026-10-01",
            otherDate: "2026-01-15",
          },
        ],
      },
    };
    const text = (await pages(await renderClassic(data, theme, "Invoice")))[0]
      .map((i) => i.str)
      .join(" ");
    expect(text).toContain("Date paid 15 February 2026");
  });
  it("advances compact rows past every wrapped description line", async () => {
    const data = {
      ...base,
      document: {
        ...base.document,
        lines: [
          {
            ...base.document.lines[0],
            description: "Wrapped description ".repeat(15) + "ENDROW",
          },
          { ...base.document.lines[0], description: "NEXTROW" },
        ],
      },
    };
    const items = (await pages(await renderCompact(data, theme, "Invoice")))[0];
    const last = items.find((i) => i.str.includes("ENDROW"))!;
    const next = items.find((i) => i.str.includes("NEXTROW"))!;
    expect(last.y - next.y).toBeGreaterThanOrEqual(last.height);
  });
  it("paginates items with repeated headers, reserves the footer, and retains long notes and terms", async () => {
    const data = {
      ...base,
      document: {
        ...base.document,
        lines: Array.from({ length: 100 }, (_, i) => ({
          ...base.document.lines[0],
          description: `ITEM-${i}`,
        })),
        notes: "Notes text ".repeat(1000) + "ENDNOTES",
        terms: "Terms text ".repeat(1000) + "ENDTERMS",
      },
    };
    const result = await pages(await renderClassic(data, theme, "Invoice"));
    expect(result.length).toBeGreaterThan(3);
    for (const [index, page] of result.entries()) {
      expect(
        page.some((i) => i.str === `Page ${index + 1} of ${result.length}`),
      ).toBe(true);
      const body = page.filter((i) => !i.str.startsWith("Page "));
      expect(body.every((i) => i.y > 70)).toBe(true);
      if (body.some((i) => /^ITEM-/.test(i.str)))
        expect(body.some((i) => i.str === "Description")).toBe(true);
    }
    const text = result
      .flat()
      .map((i) => i.str)
      .join(" ");
    expect(text).toContain("ITEM-99");
    expect(text).toContain("ENDNOTES");
    expect(text).toContain("ENDTERMS");
  });
  it("splits a description taller than a page without losing its tail", async () => {
    const data = {
      ...base,
      document: {
        ...base.document,
        lines: [
          {
            ...base.document.lines[0],
            description: "Long description ".repeat(1200) + "ENDITEM",
          },
        ],
      },
    };
    const result = await pages(await renderClassic(data, theme, "Invoice"));
    expect(result.length).toBeGreaterThan(1);
    expect(result.flat().some((i) => i.str.includes("ENDITEM"))).toBe(true);
    for (const page of result.filter((p) =>
      p.some((i) => i.str.includes("Long description")),
    )) {
      expect(page.some((i) => i.str === "Description")).toBe(true);
      expect(
        page.filter((i) => !i.str.startsWith("Page ")).every((i) => i.y > 70),
      ).toBe(true);
    }
  });
});

describe("status stamps", () => {
  const text = (pagesOf: { str: string }[][]) =>
    pagesOf
      .flat()
      .map((i) => i.str)
      .join(" ");

  for (const [name, render] of [
    ["classic", renderClassic],
    ["compact", renderCompact],
  ] as const) {
    it(`${name}: a cancelled invoice is stamped VOID and asks for nothing`, async () => {
      const data: LayoutRenderData = {
        ...base,
        document: { ...base.document, amountDue: 0, amountPaid: 0 },
        statusStamp: "VOID",
      };
      const result = await pages(await render(data, theme, "Invoice"));
      // The stamp never pushes the page over onto a second one.
      expect(result).toHaveLength(1);
      const all = text(result);
      expect(result[0].some((i) => i.str === "VOID")).toBe(true);
      expect(all).not.toMatch(/\bdue\b/i);
      expect(all).not.toContain("Paid:");
    });

    it(`${name}: a draft invoice is stamped DRAFT`, async () => {
      const data: LayoutRenderData = {
        ...base,
        document: { ...base.document, amountDue: 20, amountPaid: 0 },
        statusStamp: "DRAFT",
      };
      const result = await pages(await render(data, theme, "Invoice"));
      expect(result).toHaveLength(1);
      expect(result[0].some((i) => i.str === "DRAFT")).toBe(true);
    });

    it(`${name}: a sent invoice carries no stamp`, async () => {
      const result = await pages(await render(base, theme, "Invoice"));
      expect(result[0].some((i) => i.str === "VOID" || i.str === "DRAFT")).toBe(
        false,
      );
    });
  }

  it("is stamped on every page of a long invoice", async () => {
    const data: LayoutRenderData = {
      ...base,
      document: {
        ...base.document,
        lines: Array.from({ length: 100 }, (_, i) => ({
          ...base.document.lines[0],
          description: `ITEM-${i}`,
        })),
      },
      statusStamp: "DRAFT",
    };
    const result = await pages(await renderClassic(data, theme, "Invoice"));
    expect(result.length).toBeGreaterThan(1);
    for (const page of result) {
      expect(page.some((i) => i.str === "DRAFT")).toBe(true);
    }
  });

  it("only an invoice that is a draft or cancelled gets one", () => {
    expect(statusStampFor("invoice", { status: InvoiceStatus.Cancelled })).toBe(
      "VOID",
    );
    expect(statusStampFor("invoice", { status: InvoiceStatus.Draft })).toBe(
      "DRAFT",
    );
    expect(
      statusStampFor("invoice", { status: InvoiceStatus.Sent }),
    ).toBeNull();
    expect(
      statusStampFor("quotation", { status: InvoiceStatus.Draft }),
    ).toBeNull();
  });
});

describe("amount due on the printed invoice", () => {
  // USD 123.45 at 4.4567 is 550.18 in the main currency: 55018 cents.
  const usd = {
    status: InvoiceStatus.Sent,
    total: 123.45,
    exchangeRate: 4.4567,
    totalMinor: 55018,
  };

  it("is the invoice's own total while nothing is paid, with no trip through the rate", () => {
    expect(invoicePdfAmounts({ ...usd, outstandingMinor: 55018 })).toEqual({
      amountDue: 123.45,
      amountPaid: 0,
    });
  });

  it("is in the invoice's currency once part is paid, never the main currency's cents", () => {
    // MYR 300.00 received: 25018 cents still owed, which is USD 56.14.
    const amounts = invoicePdfAmounts({ ...usd, outstandingMinor: 25018 });
    expect(amounts).toEqual({ amountDue: 56.14, amountPaid: 67.31 });
    // The two always add back up to the total.
    expect(
      Math.round(amounts.amountDue * 100) +
        Math.round(amounts.amountPaid * 100),
    ).toBe(12345);
  });

  it("is exact at rate 1, and nothing once fully paid", () => {
    const myr = {
      status: InvoiceStatus.Sent,
      total: 100.1,
      exchangeRate: 1,
      totalMinor: 10010,
    };
    expect(invoicePdfAmounts({ ...myr, outstandingMinor: 4007 })).toEqual({
      amountDue: 40.07,
      amountPaid: 60.03,
    });
    expect(invoicePdfAmounts({ ...myr, outstandingMinor: 0 })).toEqual({
      amountDue: 0,
      amountPaid: 100.1,
    });
  });

  it("is the whole total on a draft, and nothing on a cancelled invoice", () => {
    expect(
      invoicePdfAmounts({
        ...usd,
        status: InvoiceStatus.Draft,
        outstandingMinor: 0,
      }),
    ).toEqual({ amountDue: 123.45, amountPaid: 0 });
    expect(
      invoicePdfAmounts({
        ...usd,
        status: InvoiceStatus.Cancelled,
        outstandingMinor: 0,
      }),
    ).toEqual({ amountDue: 0, amountPaid: 0 });
  });

  it("prints the part-paid figure in the invoice's currency", async () => {
    const data: LayoutRenderData = {
      ...base,
      document: {
        ...base.document,
        currency: "USD",
        total: 123.45,
        subtotal: 123.45,
        ...invoicePdfAmounts({ ...usd, outstandingMinor: 25018 }),
      },
    };
    const all = (await pages(await renderClassic(data, theme, "Invoice")))
      .flat()
      .map((i) => i.str)
      .join(" ");
    expect(all).toContain("Amount due 56.14 USD");
    expect(all).not.toContain("250.18");
  });
});

describe("currency on the printed amounts", () => {
  const strings = async (buffer: Buffer) =>
    (await pages(buffer)).flat().map((i) => i.str.trim());

  for (const [name, render, priceHeader, amountHeader] of [
    ["classic", renderClassic, "Unit price (USD)", "Amount (USD)"],
    ["compact", renderCompact, "PRICE (USD)", "TOTAL (USD)"],
  ] as const) {
    it(`${name}: names the document currency on the price and amount columns`, async () => {
      const data: LayoutRenderData = {
        ...base,
        document: { ...base.document, currency: "USD" },
      };
      const all = await strings(await render(data, theme, "Invoice"));
      expect(all).toContain(priceHeader);
      expect(all).toContain(amountHeader);
    });

    it(`${name}: puts the code after the figure a reader pays from`, async () => {
      const data: LayoutRenderData = {
        ...base,
        document: {
          ...base.document,
          currency: "USD",
          amountDue: 5,
          amountPaid: 15,
        },
      };
      const all = (await strings(await render(data, theme, "Invoice"))).join(
        " ",
      );
      expect(all).toMatch(/5\.00 USD/);
      expect(all).not.toMatch(/USD \d/);
    });

    it(`${name}: prints a zero-decimal currency without decimals`, async () => {
      const data: LayoutRenderData = {
        ...base,
        document: {
          ...base.document,
          currency: "JPY",
          lines: [
            {
              description: "Item",
              quantity: 1,
              unitPrice: 1000,
              lineTotal: 1000,
            },
          ],
          subtotal: 1000,
          total: 1000,
          amountDue: 1000,
        },
      };
      const all = await strings(await render(data, theme, "Invoice"));
      expect(all.join(" ")).not.toContain("1,000.00");
      expect(all).toContain("1,000");
    });
  }
});
