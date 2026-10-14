import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";

/**
 * Ownership of a served file (FR-014, FR-039).
 *
 * `/api/files/[...path]` will only serve a file it can find a row for. Every
 * attachment created since the double-entry conversion lives in
 * `record_attachments`, and that table was never consulted — so every
 * ledger-record attachment came back `403`. This spec pins the fix and the
 * three rules it must not disturb.
 *
 * The three legacy attachment tables this route also checked are dropped by
 * this release; the conversion had already moved every one of their rows into
 * `record_attachments`, so one lookup answers for all of them.
 *
 * The route imports the singleton `db`, which opens DATABASE_PATH *at import
 * time* and migrates it. Under a test runner that path resolves to the real
 * `data/akaun.db`, so the module is mocked here and never loaded.
 */

const storageRoot = mkdtempSync(join(tmpdir(), "akaun-files-spec-"));

// Rows the fake database holds, keyed by the table it would have been found in.
const rows = {
  record: new Set<string>(),
  statement: new Set<string>(),
};

vi.mock("$lib/server/env.js", () => ({
  get STORAGE_PATH() {
    return storageRoot;
  },
  DATABASE_PATH: "/dev/null",
  OCR_CACHE_PATH: "/dev/null",
}));

vi.mock("$lib/server/settings.js", () => ({
  getSetting: () => null,
  SETTING_KEYS: {
    companyLogoPath: "company_logo_path",
    companyLetterheadPath: "company_letterhead_path",
  },
}));

const permission = { granted: true };
vi.mock("$lib/server/permissions.js", () => ({
  hasPermission: () => permission.granted,
}));

vi.mock("$lib/server/db/client.js", async () => {
  const schema = await import("$lib/server/db/schema.js");
  // Which set answers for which table, by identity of the table object.
  const setFor = new Map<unknown, Set<string>>([
    [schema.recordAttachments, rows.record],
    [schema.bankStatements, rows.statement],
  ]);
  // The route asks `.where(eq(col, filePath))`; the filename is the only value
  // it ever compares, so the fake captures it from the drizzle expression.
  const db = {
    select() {
      return {
        from(table: unknown) {
          return {
            where(expr: { queryChunks?: unknown[] }) {
              const value = findParamValue(expr);
              return {
                get() {
                  const set = setFor.get(table);
                  return set && value !== undefined && set.has(value)
                    ? { id: 1 }
                    : undefined;
                },
              };
            },
          };
        },
      };
    },
  };
  return { db };
});

/** Pull the bound parameter out of a drizzle `eq()` expression. */
function findParamValue(expr: unknown): string | undefined {
  const seen = new Set<unknown>();
  const walk = (node: unknown): string | undefined => {
    if (!node || typeof node !== "object" || seen.has(node)) return undefined;
    seen.add(node);
    const record = node as Record<string, unknown>;
    if (typeof record["value"] === "string") return record["value"] as string;
    for (const child of Object.values(record)) {
      const found = walk(child);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return walk(expr);
}

const locals = { user: { id: 1 } } as never;

async function get(path: string) {
  const { GET } = await import("./[...path]/+server.js");
  return (GET as (event: never) => Response | Promise<Response>)({
    locals,
    params: { path },
  } as never);
}

function writeStored(relativePath: string) {
  const abs = join(storageRoot, relativePath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, "file body");
}

beforeAll(() => {
  writeStored("records/2026/08/receipt.pdf");
  writeStored("statements/august.pdf");
  writeStored("orphan.pdf");
  writeStored("records/2026/08/wallet.xlsx");
  writeStored("records/2026/08/wallet.csv");
});

afterAll(() => {
  rmSync(storageRoot, { recursive: true, force: true });
});

describe("/api/files ownership", () => {
  it("serves a file named only in record_attachments", async () => {
    rows.record.add("records/2026/08/receipt.pdf");
    const response = await get("records/2026/08/receipt.pdf");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
  });

  it("refuses a file named in no table at all", async () => {
    const response = await get("orphan.pdf");
    expect(response.status).toBe(403);
  });

  it("refuses a path that climbs out of the storage root", async () => {
    const response = await get("../../etc/passwd");
    expect(response.status).toBe(403);
  });

  it("refuses a bank statement without reconciliation view", async () => {
    rows.statement.add("statements/august.pdf");
    permission.granted = false;
    try {
      const response = await get("statements/august.pdf");
      expect(response.status).toBe(403);
    } finally {
      permission.granted = true;
    }
  });

  it("serves a bank statement with reconciliation view", async () => {
    rows.statement.add("statements/august.pdf");
    permission.granted = true;
    const response = await get("statements/august.pdf");
    expect(response.status).toBe(200);
  });
});

describe("/api/files content disposition (006 FR-050)", () => {
  it("offers a record's spreadsheet as a download and still shows a PDF in the page", async () => {
    rows.record.add("records/2026/08/receipt.pdf");
    rows.record.add("records/2026/08/wallet.xlsx");
    rows.record.add("records/2026/08/wallet.csv");

    const pdf = await get("records/2026/08/receipt.pdf");
    expect(pdf.headers.get("Content-Disposition")).toMatch(/^inline; /);

    const xlsx = await get("records/2026/08/wallet.xlsx");
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers.get("Content-Type")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(xlsx.headers.get("Content-Disposition")).toMatch(
      /^attachment; filename="wallet\.xlsx"/,
    );

    const csv = await get("records/2026/08/wallet.csv");
    expect(csv.headers.get("Content-Type")).toBe("text/csv");
    expect(csv.headers.get("Content-Disposition")).toMatch(
      /^attachment; filename="wallet\.csv"/,
    );
  });
});
