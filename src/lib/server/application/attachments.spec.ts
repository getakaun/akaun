import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../db/schema.js";
import { LocalBlobStore } from "../storage/blob-store.js";
import { createRecord } from "./records.js";
import { attachFile } from "./attachments.js";
import { releaseBook, resultValue } from "./__fixtures__/release-book.js";

type Book = ReturnType<typeof releaseBook>;
let book: Book;
let root: string;
let record: { id: number };

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

beforeEach(() => {
  book = releaseBook();
  root = mkdtempSync(join(tmpdir(), "akaun-attachments-spec-"));
  record = resultValue(
    createRecord(book.ctx, {
      kind: "expense",
      date: "2026-09-02",
      amount: 12.5,
      currency: "MYR",
      exchangeRate: 1,
      description: "Attachment hash",
      categoryAccountId: book.expense,
      paidFromAccountId: book.bank,
    }),
  ).record;
});
afterEach(() => {
  book.raw.close();
  rmSync(root, { recursive: true, force: true });
});

const attach = (bytes: Buffer, filename = "receipt.pdf") =>
  attachFile(
    { ...book.ctx, storageRoot: root, store: new LocalBlobStore(root) },
    {
      recordId: record.id,
      filename,
      contentBase64: bytes.toString("base64"),
    },
  );
const rowFor = (id: number) =>
  book.db
    .select()
    .from(schema.recordAttachments)
    .all()
    .find((row) => row.id === id)!;

describe("attachFile and the file's sha256", () => {
  it("stores the sha256 of the stored bytes on the attachment row", async () => {
    const bytes = Buffer.from("%PDF-1.4 a receipt with some content\n");
    const value = resultValue(await attach(bytes));
    const row = rowFor((value.attachment as { id: number }).id);

    expect(row.sha256).toBe(sha256(bytes));
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    // The hash describes what is on disk, not only what was sent.
    const onDisk = readFileSync(new LocalBlobStore(root).pathOf(row.filename));
    expect(row.sha256).toBe(sha256(onDisk));
  });

  it("gives the same bytes the same hash and different bytes a different one", async () => {
    const first = Buffer.from("%PDF-1.4 receipt one\n");
    const second = Buffer.from("%PDF-1.4 receipt two\n");
    const a = resultValue(await attach(first, "a.pdf"));
    const b = resultValue(await attach(first, "renamed-copy.pdf"));
    const c = resultValue(await attach(second, "c.pdf"));
    const hashOf = (v: Record<string, unknown>) =>
      rowFor((v.attachment as { id: number }).id).sha256;

    expect(hashOf(a)).toBe(hashOf(b));
    expect(hashOf(c)).not.toBe(hashOf(a));
    expect(hashOf(c)).toBe(sha256(second));
  });

  it("hashes a PNG by its bytes too", async () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("not a real image body"),
    ]);
    const value = resultValue(await attach(png, "photo.png"));
    expect(rowFor((value.attachment as { id: number }).id).sha256).toBe(
      sha256(png),
    );
  });

  it("leaves the result contract unchanged and does not expose the hash", async () => {
    const value = resultValue(await attach(Buffer.from("%PDF-1.4 contract\n")));

    expect(Object.keys(value).sort()).toEqual([
      "attachment",
      "recordId",
      "version",
    ]);
    expect(Object.keys(value.attachment as object).sort()).toEqual([
      "addedDate",
      "displayName",
      "id",
    ]);
    expect(value.recordId).toBe(record.id);
    expect((value.attachment as { displayName: string }).displayName).toBe(
      "receipt.pdf",
    );
    expect(JSON.stringify(value)).not.toMatch(/sha256|[0-9a-f]{64}/);
  });

  it("saves nothing, hash included, when the file is refused", async () => {
    const result = await attach(Buffer.from("plain text, not a PDF"), "x.pdf");
    expect(result).toMatchObject({ ok: false, code: "UNSUPPORTED_MEDIA_TYPE" });
    expect(book.db.select().from(schema.recordAttachments).all()).toEqual([]);
  });
});
