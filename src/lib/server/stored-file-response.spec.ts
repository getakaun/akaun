import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, describe, expect, it, vi } from "vitest";

/**
 * How a stored file is sent: its type comes from its content, anything that is
 * not a PDF or an image is downloaded, and a repeat request is a 304. The
 * store is a folder under `os.tmpdir()`, and the configured storage path is
 * mocked so that nothing can reach `data/`.
 */

const sandbox = mkdtempSync(join(tmpdir(), "akaun-stored-file-spec-"));
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

vi.mock("$lib/server/env.js", () => ({
  STORAGE_PATH: join(sandbox, "unused"),
  DATABASE_PATH: "/dev/null",
  OCR_CACHE_PATH: "/dev/null",
}));

const { LocalBlobStore } = await import("./storage/blob-store.js");
const { storedFileResponse } = await import("./stored-file-response.js");

const store = new LocalBlobStore(join(sandbox, "root"));
const PDF = new TextEncoder().encode("%PDF-1.7 body");
const request = (headers: Record<string, string> = {}) =>
  new Request("http://localhost/", { headers });

describe("storedFileResponse", () => {
  it("shows a PDF in the page by its content, whatever its name", async () => {
    await store.put("records/x_receipt.html", PDF);
    const response = await storedFileResponse(
      store,
      request(),
      "records/x_receipt.html",
      "receipt.html",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(response.headers.get("Content-Disposition")).toMatch(/^inline;/);
    expect(response.headers.get("Content-Length")).toBe(String(PDF.length));
    expect(response.headers.get("Cache-Control")).toBe("private, no-cache");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PDF);
  });

  it("downloads anything that is not a PDF or an image", async () => {
    await store.put("x_page.html", new TextEncoder().encode("<script>"));
    const html = await storedFileResponse(
      store,
      request(),
      "x_page.html",
      "page.html",
    );
    expect(html.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(html.headers.get("Content-Disposition")).toMatch(/^attachment;/);

    await store.put("x_export.csv", new TextEncoder().encode("a,b\n1,2\n"));
    const csv = await storedFileResponse(
      store,
      request(),
      "x_export.csv",
      "export.csv",
    );
    expect(csv.headers.get("Content-Type")).toBe("text/csv");
    expect(csv.headers.get("Content-Disposition")).toMatch(/^attachment;/);
  });

  it("answers a repeat request with 304", async () => {
    await store.put("again.pdf", PDF);
    const first = await storedFileResponse(store, request(), "again.pdf", "a");
    const etag = first.headers.get("ETag")!;
    const second = await storedFileResponse(
      store,
      request({ "If-None-Match": etag }),
      "again.pdf",
      "a",
    );
    expect(second.status).toBe(304);
  });

  it("is 404 for a missing file or a key outside the store", async () => {
    for (const key of ["missing.pdf", "../outside.pdf"]) {
      const response = await storedFileResponse(store, request(), key, "x");
      expect(response.status).toBe(404);
    }
  });

  it("keeps quotes and control characters out of the header", async () => {
    await store.put("named.pdf", PDF);
    const response = await storedFileResponse(
      store,
      request(),
      "named.pdf",
      'a"b\r\nc.pdf',
    );
    expect(response.headers.get("Content-Disposition")).toBe(
      `inline; filename="a_b__c.pdf"; filename*=UTF-8''a%22b%0D%0Ac.pdf`,
    );
  });
});
