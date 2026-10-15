import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, describe, expect, it, vi } from "vitest";

/**
 * The company logo and letterhead are served by name, and the file comes from
 * the setting, never from the request. The settings and the database are
 * mocked; the storage path is a folder under `os.tmpdir()`.
 */

const sandbox = mkdtempSync(join(tmpdir(), "akaun-company-image-spec-"));
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

vi.mock("$lib/server/env.js", () => ({
  STORAGE_PATH: join(sandbox, "storage"),
  DATABASE_PATH: "/dev/null",
  OCR_CACHE_PATH: "/dev/null",
}));
vi.mock("$lib/server/db/client.js", () => ({ db: {} }));

const stored: Record<string, string> = {
  "company.logoPath": "company/logo.png",
  "company.letterheadPath": "",
};
vi.mock("$lib/server/settings.js", () => ({
  SETTING_KEYS: {
    companyLogoPath: "company.logoPath",
    companyLetterheadPath: "company.letterheadPath",
  },
  getSetting: (_db: unknown, key: string) => stored[key] ?? null,
}));

mkdirSync(join(sandbox, "storage", "company"), { recursive: true });
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
writeFileSync(join(sandbox, "storage", "company", "logo.png"), PNG);

const { GET } = await import("./+server.js");

function get(image: string, user: unknown = { id: 1 }) {
  return (GET as (event: never) => Promise<Response>)({
    locals: { user },
    params: { image },
    request: new Request("http://localhost/"),
  } as never);
}

describe("GET /api/company/[image]", () => {
  it("serves the saved logo as an image", async () => {
    const response = await get("logo");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
  });

  it("is 404 when no letterhead is saved", async () => {
    expect((await get("letterhead")).status).toBe(404);
  });

  it("is 404 for any other name", async () => {
    for (const name of ["favicon", "__proto__", "constructor"]) {
      expect((await get(name)).status).toBe(404);
    }
  });

  it("refuses a caller who is not signed in", async () => {
    expect((await get("logo", null)).status).toBe(401);
  });
});
