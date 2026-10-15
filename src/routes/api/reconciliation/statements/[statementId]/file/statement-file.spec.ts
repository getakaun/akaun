import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Opening the file a bank statement was read from needs
 * `reconciliation:view`. The statement query and the database are mocked; the
 * storage path is a folder under `os.tmpdir()`.
 */

const sandbox = mkdtempSync(join(tmpdir(), "akaun-statement-file-spec-"));
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

vi.mock("$lib/server/env.js", () => ({
  STORAGE_PATH: join(sandbox, "storage"),
  DATABASE_PATH: "/dev/null",
  OCR_CACHE_PATH: "/dev/null",
}));
vi.mock("$lib/server/db/client.js", () => ({ db: {} }));

const allowed = { view: true };
vi.mock("$lib/server/permissions.js", () => ({
  hasPermission: (_locals: unknown, resource: string, action: string) =>
    resource === "reconciliation" && action === "view" && allowed.view,
}));

const statements: Record<
  number,
  { storedFilePath: string; originalFilename: string }
> = {
  5: {
    storedFilePath: "reconciliation/k1/0b3f8e8e_august.pdf",
    originalFilename: "August statement.pdf",
  },
  6: { storedFilePath: "", originalFilename: "none.pdf" },
};
vi.mock("$lib/server/queries/reconciliation.js", () => ({
  getStatement: (_db: unknown, id: number) => statements[id],
}));

const { GET } = await import("./+server.js");
const PDF = "%PDF-1.4 statement";

function open(statementId: string, user: unknown = { id: 1 }) {
  return (GET as (event: never) => Promise<Response>)({
    locals: { user },
    params: { statementId },
    request: new Request("http://localhost/"),
  } as never);
}

beforeEach(() => {
  allowed.view = true;
  mkdirSync(join(sandbox, "storage", "reconciliation", "k1"), {
    recursive: true,
  });
  writeFileSync(join(sandbox, "storage", statements[5].storedFilePath), PDF);
});

describe("GET /api/reconciliation/statements/[statementId]/file", () => {
  it("serves the statement file to a user with reconciliation:view", async () => {
    const response = await open("5");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(response.headers.get("Content-Disposition")).toContain(
      'filename="August statement.pdf"',
    );
    expect(await response.text()).toBe(PDF);
  });

  it("refuses a caller who is not signed in", async () => {
    expect((await open("5", null)).status).toBe(401);
  });

  it("refuses a user without reconciliation:view", async () => {
    allowed.view = false;
    expect((await open("5")).status).toBe(403);
  });

  it("is 404 for a bad id, an unknown statement or one with no file", async () => {
    for (const id of ["abc", "999", "6"]) {
      expect((await open(id)).status).toBe(404);
    }
  });
});
