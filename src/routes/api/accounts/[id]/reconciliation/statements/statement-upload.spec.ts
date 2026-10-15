import { existsSync, mkdtempSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A statement upload that the service refuses (for example an account where
 * no money sits) must not leave its file behind: no statement row points at
 * it, so nothing would ever delete it. The service and the database are
 * mocked; the storage path is a folder under `os.tmpdir()`.
 */

const sandbox = mkdtempSync(join(tmpdir(), "akaun-statement-upload-spec-"));
const storage = join(sandbox, "storage");
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

vi.mock("$lib/server/env.js", () => ({
  STORAGE_PATH: join(sandbox, "storage"),
  DATABASE_PATH: "/dev/null",
  OCR_CACHE_PATH: "/dev/null",
}));
vi.mock("$lib/server/db/client.js", () => ({ db: {} }));
vi.mock("$lib/server/permissions.js", () => ({
  can: () => true,
  canAll: () => true,
}));

const outcome = { refuse: true };
vi.mock("$lib/server/services/reconciliation.js", () => {
  class ReconciliationError extends Error {
    constructor(
      message: string,
      public status: number,
    ) {
      super(message);
    }
  }
  return {
    ReconciliationError,
    createStatement: () => {
      if (outcome.refuse)
        throw new ReconciliationError(
          "Choose an active account for this statement.",
          409,
        );
      return { id: 1 };
    },
  };
});
vi.mock("$lib/server/reconciliation/statement-import.js", () => ({
  processStatementImport: async () => {},
}));

const { POST } = await import("./+server.js");

function upload() {
  const form = new FormData();
  form.set("file", new File(["%PDF-1.4 statement"], "august.pdf"));
  return (POST as (event: never) => Promise<Response>)({
    locals: { user: { id: 1 } },
    params: { id: "3" },
    request: new Request("http://localhost/", { method: "POST", body: form }),
  } as never);
}

beforeEach(() => {
  rmSync(storage, { recursive: true, force: true });
});

describe("POST /api/accounts/[id]/reconciliation/statements", () => {
  it("removes the stored file and its folder when the statement is refused", async () => {
    outcome.refuse = true;
    const response = await upload();
    expect(response.status).toBe(409);
    expect(readdirSync(join(storage, "reconciliation"))).toEqual([]);
  });

  it("keeps the file when the statement is saved", async () => {
    outcome.refuse = false;
    expect((await upload()).status).toBe(202);
    const [folder] = readdirSync(join(storage, "reconciliation"));
    expect(existsSync(join(storage, "reconciliation", folder))).toBe(true);
    expect(readdirSync(join(storage, "reconciliation", folder))).toHaveLength(
      1,
    );
  });
});
