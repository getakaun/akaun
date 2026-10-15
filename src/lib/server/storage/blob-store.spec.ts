import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, describe, expect, it } from "vitest";
import { LocalBlobStore } from "./blob-store.js";

/** The local store, against a root under `os.tmpdir()`. */

const sandbox = mkdtempSync(join(tmpdir(), "akaun-blob-store-spec-"));
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

const store = new LocalBlobStore(join(sandbox, "root"));

describe("LocalBlobStore", () => {
  it("refuses a key that would leave the root", async () => {
    for (const key of ["../outside.pdf", "a/../../outside.pdf", "/etc/x"]) {
      expect(() => store.pathOf(key)).toThrow();
      await expect(store.put(key, new Uint8Array([1]))).rejects.toThrow();
    }
  });

  it("stores, describes, streams and deletes a file", async () => {
    const bytes = new TextEncoder().encode("%PDF-1.7 hello");
    await store.put("records/2026/01/a.pdf", bytes);

    expect((await store.stat("records/2026/01/a.pdf"))?.size).toBe(
      bytes.length,
    );
    const head = await store.head("records/2026/01/a.pdf", 4);
    expect(head && new TextDecoder().decode(head)).toBe("%PDF");
    const streamed = new Uint8Array(
      await new Response(store.stream("records/2026/01/a.pdf")).arrayBuffer(),
    );
    expect(streamed).toEqual(bytes);

    await store.delete("records/2026/01/a.pdf");
    expect(await store.stat("records/2026/01/a.pdf")).toBeNull();
    await store.delete("records/2026/01/a.pdf"); // already gone: no error
  });

  it("reports nothing for a missing file or a folder", async () => {
    expect(await store.stat("missing.pdf")).toBeNull();
    expect(await store.head("missing.pdf", 8)).toBeNull();
    await store.put("folder/file.pdf", new Uint8Array([1]));
    expect(await store.stat("folder")).toBeNull();
  });
});
