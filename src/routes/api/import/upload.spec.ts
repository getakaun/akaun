import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { eq } from "drizzle-orm";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { buildXlsx } from "$lib/server/extraction/spreadsheet/__fixtures__/build-xlsx.js";

/**
 * Uploading to Auto Import (006 FR-050): a PDF, a photo, an Excel workbook or
 * a CSV file is queued, anything else is refused with a reason that names the
 * problem, and a stored spreadsheet is offered as a download.
 *
 * The routes import the singleton `db`, so that module is mocked with a
 * database file under `os.tmpdir()`, migrated from `drizzle/`, and the storage
 * path with a folder there too: nothing under `data/` is touched. Nothing is
 * read: the worker is not part of these routes.
 */

const sandbox = mkdtempSync(join(tmpdir(), "akaun-upload-spec-"));

const holder = vi.hoisted(() => ({
  db: null as unknown,
  storageRoot: "",
}));

vi.mock("$lib/server/env.js", () => ({
  get STORAGE_PATH() {
    return holder.storageRoot;
  },
  DATABASE_PATH: "/dev/null",
  OCR_CACHE_PATH: "/dev/null",
}));

vi.mock("$lib/server/db/client.js", () => ({
  get db() {
    return holder.db;
  },
}));

vi.mock("$lib/server/permissions.js", () => ({
  can: () => true,
  canAll: () => true,
}));

vi.mock("$lib/server/logger.js", () => {
  const silent = {
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  return { createLogger: () => silent };
});

const { ImportState } = await import("$lib/enums.js");
const schema = await import("$lib/server/db/schema.js");
const { importQueue, users } = schema;
// Loaded here, not inside the first test, so the time the routes take to load
// under a busy test run never counts against that test's timeout.
const { POST } = await import("./+server.js");
const { GET } = await import("./[jobId]/file/+server.js");

let dir: string;
let sqlite: Database;

beforeEach(() => {
  dir = mkdtempSync(join(sandbox, "case-"));
  holder.storageRoot = join(dir, "storage");
  sqlite = new Database(join(dir, "test.db"));
  sqlite.exec("PRAGMA foreign_keys = ON;");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "drizzle" });
  db.insert(users)
    .values({ id: 1, email: "u@test", username: "u", passwordHash: "x" })
    .run();
  holder.db = db;
});

afterEach(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

type Handler = (event: never) => Promise<Response> | Response;
const locals = { user: { id: 1 } } as never;

async function upload(name: string, data: Buffer | string, readAs = "items") {
  const form = new FormData();
  const bytes = typeof data === "string" ? data : new Uint8Array(data);
  form.set("file", new File([bytes], name));
  form.set("readAs", readAs);
  return (POST as Handler)({
    locals,
    request: new Request("http://test.local/api/import", {
      method: "POST",
      body: form,
    }),
  } as never);
}

async function fileOf(jobId: string) {
  return (GET as Handler)({
    locals,
    params: { jobId },
    request: new Request("http://localhost/"),
  } as never);
}

function rowOf(jobId: string) {
  const db = holder.db as ReturnType<typeof drizzle<typeof schema>>;
  return db.select().from(importQueue).where(eq(importQueue.id, jobId)).get();
}

function oldOfficeFile(protectedFile: boolean): Buffer {
  const file = Buffer.alloc(1024);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(file);
  Buffer.from(protectedFile ? "EncryptedPackage" : "Workbook", "utf16le").copy(
    file,
    600,
  );
  return file;
}

const XLSX = buildXlsx({
  sheets: [
    {
      name: "Sheet1",
      rows: [
        ["Date", "Amount"],
        ["2026-03-01", { raw: "5.00" }],
      ],
    },
  ],
});
const CSV = "Date,Amount\n2026-03-01,5.00\n";
const PDF = Buffer.from("%PDF-1.7\n1 0 obj <<>> endobj\n");

describe("POST /api/import with a spreadsheet", () => {
  it("queues an Excel workbook and a CSV file, in any way of reading", async () => {
    for (const [name, data, readAs] of [
      ["Report.xlsx", XLSX, "items"],
      ["export.csv", CSV, "receipt"],
      ["wallet.XLSX", XLSX, "auto"],
    ] as const) {
      const response = await upload(name, data, readAs);
      expect(response.status).toBe(202);
      const { jobId } = (await response.json()) as { jobId: string };
      const row = rowOf(jobId)!;
      expect(row).toMatchObject({
        state: ImportState.Queued,
        originalFilename: name,
        readAs,
      });
      expect(existsSync(join(holder.storageRoot, row.tempFilePath))).toBe(true);
    }
  });

  it("names an old .xls file and a password-protected workbook", async () => {
    const xls = await upload("report.xls", oldOfficeFile(false));
    expect(xls.status).toBe(400);
    expect(((await xls.json()) as { error: string }).error).toMatch(
      /old Excel file \(\.xls\)/,
    );

    const renamed = await upload("report.xlsx", oldOfficeFile(false));
    expect(renamed.status).toBe(400);
    expect(((await renamed.json()) as { error: string }).error).toMatch(
      /old Excel file \(\.xls\)/,
    );

    const locked = await upload("report.xlsx", oldOfficeFile(true));
    expect(locked.status).toBe(400);
    expect(((await locked.json()) as { error: string }).error).toMatch(
      /protected with a password/,
    );
  });

  it("refuses a file whose content is not what its name says, storing nothing", async () => {
    const workbookAsCsv = await upload("export.csv", XLSX);
    expect(workbookAsCsv.status).toBe(400);
    const textAsWorkbook = await upload("report.xlsx", CSV);
    expect(textAsWorkbook.status).toBe(400);
    expect(((await textAsWorkbook.json()) as { error: string }).error).toBe(
      "The file is not an Excel workbook (.xlsx).",
    );
    expect(existsSync(join(holder.storageRoot, "import/temp"))).toBe(false);
  });

  it("refuses another file type, naming what is accepted", async () => {
    const response = await upload("notes.docx", "hello");
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      "Unsupported file type. Upload a PDF, JPG, PNG, Excel workbook (.xlsx) or CSV file.",
    );
  });

  it("takes a PDF and refuses a broken one as before (FR-004)", async () => {
    expect((await upload("fees.pdf", PDF)).status).toBe(202);
    const broken = await upload("fees.pdf", "not a pdf");
    expect(broken.status).toBe(400);
    expect(((await broken.json()) as { error: string }).error).toBe(
      "File content is not a valid PDF, JPG, or PNG.",
    );
  });
});

describe("POST /api/import when the job cannot be saved", () => {
  it("removes the stored upload again", async () => {
    const form = new FormData();
    form.set("file", new File([new Uint8Array(PDF)], "fees.pdf"));
    form.set("readAs", "items");
    // No user 999, so the job row fails its foreign key after the file is saved.
    const saving = (POST as Handler)({
      locals: { user: { id: 999 } },
      request: new Request("http://test.local/api/import", {
        method: "POST",
        body: form,
      }),
    } as never);
    await expect(saving).rejects.toThrow();
    expect(readdirSync(join(holder.storageRoot, "import/temp"))).toEqual([]);
  });
});

describe("GET /api/import/[jobId]/file", () => {
  it("offers a stored spreadsheet as a download and shows a PDF in the page", async () => {
    const cases = [
      [
        "Report.xlsx",
        XLSX,
        "attachment",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ],
      ["export.csv", CSV, "attachment", "text/csv"],
      ["fees.pdf", PDF, "inline", "application/pdf"],
    ] as const;
    for (const [name, data, disposition, type] of cases) {
      const { jobId } = (await (await upload(name, data)).json()) as {
        jobId: string;
      };
      const response = await fileOf(jobId);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe(type);
      expect(response.headers.get("Content-Disposition")).toBe(
        `${disposition}; filename="${name}"; filename*=UTF-8''${name}`,
      );
    }
  });
});
