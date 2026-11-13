import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AccountType,
  DocumentType,
  EntityType,
  ImportState,
  StatementDirection,
  StatementExtractionState,
} from "$lib/enums.js";
import * as schema from "../db/schema.js";
import type { RecordView } from "../ledger/types.js";
import { createAccount } from "../services/accounts.js";
import { LocalBlobStore } from "../storage/blob-store.js";
import { reset } from "../rate-limit.js";
import {
  releaseBook,
  resultValue,
} from "../application/__fixtures__/release-book.js";
import {
  createRecord,
  prepareVoidRecord,
  voidRecord,
} from "../application/records.js";
import { createReimbursement } from "../application/reimbursements.js";
import { attachFile } from "../application/attachments.js";
import { setMovementMatches } from "../application/reconciliation.js";
import { addAttachment, setExtractedText } from "./ledger.js";
import { textPdf } from "../mcp/__fixtures__/pdf.js";
import { buildEvalBook, type EvalBook } from "../mcp/__fixtures__/eval-book.js";
import {
  findDuplicateRecords,
  storageFiles,
  type DuplicateFileSource,
  type DuplicateRecordsResult,
} from "./duplicate-records.js";

// Each book is an in-memory database with its files in a folder under
// os.tmpdir(); nothing here imports db/client.ts. Run with the MCP preload to
// prove it:
//   bun test --preload ./scripts/mcp-test-preload.ts src/lib/server/queries/duplicate-records.spec.ts

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

type Book = ReturnType<typeof newBook>;
let book: Book | undefined;
afterEach(() => {
  if (!book) return;
  book.raw.close();
  rmSync(book.dir, { recursive: true, force: true });
  book = undefined;
});

function newBook() {
  const base = releaseBook();
  const dir = mkdtempSync(join(tmpdir(), "akaun-duplicate-records-"));
  const storageRoot = join(dir, "storage");
  mkdirSync(storageRoot);
  const ctx = {
    ...base.ctx,
    storageRoot,
    store: new LocalBlobStore(storageRoot),
  };
  const contact = (
    legalName: string,
    entityType: number = EntityType.Business,
  ) =>
    base.db
      .insert(schema.contacts)
      .values({ legalName, entityType })
      .returning()
      .get()!.id;
  const sales = resultValue(
    createAccount(base.db, 1, { name: "Sales", type: AccountType.Revenue }),
  ).id;
  return {
    ...base,
    ctx,
    dir,
    storageRoot,
    sales,
    who: {
      unifi: contact("TM Unifi"),
      grab: contact("Grab"),
      grabCar: contact("GrabCar"),
      nandos: contact("Nando's"),
      kilang: contact("Kilang Kotak Sdn Bhd"),
      tnb: contact("Tenaga Nasional Berhad"),
      partner: contact("Aisyah Rahman", EntityType.Individual),
    },
  };
}

function open(): Book {
  book = newBook();
  return book;
}

function expense(
  b: Book,
  o: {
    date: string;
    amount: number;
    contact?: number;
    /** Not paid yet: owed to the contact. */
    payable?: boolean;
    description?: string;
    reference?: string;
  },
): RecordView {
  return resultValue(
    createRecord(b.ctx, {
      kind: "expense",
      date: o.date,
      amount: o.amount,
      currency: "MYR",
      exchangeRate: 1,
      description: o.description ?? "Expense",
      categoryAccountId: b.expense,
      paidFromAccountId: o.payable ? null : b.bank,
      ...(o.contact ? { contactId: o.contact } : {}),
      ...(o.reference ? { reference: o.reference } : {}),
    }),
  ).record;
}

/** A file attached the way MCP attaches one: its sha256 is saved. */
async function attach(b: Book, recordId: number, bytes: Uint8Array) {
  resultValue(
    await attachFile(b.ctx, {
      recordId,
      filename: "receipt.pdf",
      contentBase64: Buffer.from(bytes).toString("base64"),
    }),
  );
  reset("mcp-attach:1");
}

/** A file attached before hashes were saved: the row's sha256 is NULL. */
function attachUnhashed(b: Book, recordId: number, bytes: Uint8Array) {
  const key = `records/2026/08/${randomUUID()}_scan.pdf`;
  const path = join(b.storageRoot, key);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return { key, row: addAttachment(b.db, recordId, key, "scan.pdf") };
}

function storedHashes(b: Book): (string | null)[] {
  return b.db
    .select({ sha256: schema.recordAttachments.sha256 })
    .from(schema.recordAttachments)
    .all()
    .map((row) => row.sha256);
}

/** Reads through to the book's files, counting reads per key. */
function countingFiles(b: Book) {
  const inner = storageFiles(b.storageRoot);
  const reads = new Map<string, number>();
  const files: DuplicateFileSource = {
    id: inner.id,
    size: (key) => inner.size!(key),
    read: (key) => {
      reads.set(key, (reads.get(key) ?? 0) + 1);
      return inner.read(key);
    },
  };
  return { files, reads };
}

function receipt(lines: string[]): Uint8Array {
  return textPdf(lines);
}

const ids = (result: DuplicateRecordsResult) =>
  result.groups.map((g) => g.records.map((r) => r.id));

describe("findDuplicateRecords", () => {
  it("groups one receipt on two expenses, one reimbursed and one unpaid, by its file", async () => {
    const b = open();
    const claimed = expense(b, {
      date: "2026-08-15",
      amount: 86.4,
      contact: b.who.nandos,
      payable: true,
      description: "Team lunch",
    });
    // The same receipt claimed again weeks later: only the file gives it away.
    const again = expense(b, {
      date: "2026-10-02",
      amount: 86.4,
      contact: b.who.nandos,
      payable: true,
      description: "Nando's team lunch",
    });
    resultValue(
      createReimbursement(b.ctx, {
        contactId: b.who.partner,
        date: "2026-09-02",
        description: "Reimbursement - team lunch",
        reference: "",
        remark: "",
        personallyPaid: true,
        items: [
          {
            owedMovementId: claimed.movements.find((m) => m.amountMinor < 0)!
              .id,
            amountMinor: 8640,
          },
        ],
        cashMinor: 8640,
        paidFromAccountId: b.bank,
        credits: [],
      }),
    );
    const bytes = receipt([
      "Nando's Malaysia",
      "Receipt 20260815-221",
      "Team lunch (6 pax)  RM 86.40",
    ]);
    await attach(b, claimed.id, bytes);
    await attach(b, again.id, bytes);
    // Saved when the file was attached.
    expect(storedHashes(b)).toEqual([sha256(bytes), sha256(bytes)]);

    const result = findDuplicateRecords(b.db);

    expect(result.groups).toHaveLength(1);
    const [group] = result.groups;
    expect(group.signals).toEqual(["same_file"]);
    expect(group.score).toBe(90);
    expect(group.records.map((r) => r.id)).toEqual([claimed.id, again.id]);
    expect(group.records[0]).toMatchObject({
      date: "2026-08-15",
      amountMinor: 8640,
      currency: "MYR",
      contact: { id: b.who.nandos, name: "Nando's" },
      settled: true,
      reimbursed: true,
      bankMatched: false,
      voided: false,
      attachmentSha256s: [sha256(bytes)],
    });
    expect(group.records[1]).toMatchObject({
      settled: false,
      reimbursed: false,
      bankMatched: false,
      voided: false,
      attachmentSha256s: [sha256(bytes)],
    });
    expect(result.hashedOnTheFly).toBe(0);
  });

  it("finds the same file with no saved hash by hashing it in memory, and writes nothing", () => {
    const b = open();
    const first = expense(b, {
      date: "2026-08-03",
      amount: 23.5,
      contact: b.who.grab,
      description: "Ride to client",
    });
    const second = expense(b, {
      date: "2026-09-20",
      amount: 25,
      contact: b.who.grabCar,
      description: "Client visit transport",
    });
    const bytes = receipt(["Grab e-receipt", "Booking A-5XK2Q9", "RM 23.50"]);
    attachUnhashed(b, first.id, bytes);
    attachUnhashed(b, second.id, bytes);

    // Without the files nothing links them.
    const blind = findDuplicateRecords(b.db);
    expect(blind.groups).toEqual([]);
    expect(blind.hashedOnTheFly).toBe(0);

    // A read: it must work where the connection may not write at all.
    b.raw.exec("PRAGMA query_only = ON");
    let result: DuplicateRecordsResult;
    try {
      result = findDuplicateRecords(b.db, {}, storageFiles(b.storageRoot));
    } finally {
      b.raw.exec("PRAGMA query_only = OFF");
    }

    expect(ids(result)).toEqual([[first.id, second.id]]);
    expect(result.groups[0].signals).toEqual(["same_file"]);
    expect(result.groups[0].records.map((r) => r.attachmentSha256s)).toEqual([
      [sha256(bytes)],
      [sha256(bytes)],
    ]);
    expect(result.hashedOnTheFly).toBe(2);
    // Never written back.
    expect(storedHashes(b)).toEqual([null, null]);
  });

  it("takes an imported receipt's hash from its import, without reading the file", () => {
    const b = open();
    const hash = sha256(
      receipt(["Kedai Runcit Aman", "Receipt 88", "RM 31.20"]),
    );
    const records = [
      ["2026-07-02", b.who.grab],
      ["2026-09-14", b.who.kilang],
      ["2026-10-30", b.who.unifi],
    ].map(([date, contact], i) => {
      const record = expense(b, {
        date: String(date),
        amount: 31.2 + i,
        contact: Number(contact),
      });
      // Auto Import moves the upload from temp into records/, keeping its name.
      const name = `${randomUUID()}_receipt.pdf`;
      addAttachment(b.db, record.id, `records/2026/07/${name}`, "receipt.pdf");
      b.db
        .insert(schema.importQueue)
        .values({
          id: randomUUID(),
          createdBy: 1,
          state: ImportState.Imported,
          // The last one's upload is not the file its record now has.
          tempFilePath: `import/temp/${i < 2 ? name : "another_receipt.pdf"}`,
          originalFilename: "receipt.pdf",
          fileHash: hash,
          resultId: record.id,
          resultType: DocumentType.Expense,
        })
        .run();
      return record;
    });

    // No file is on disk, and none is needed.
    const result = findDuplicateRecords(b.db);
    expect(ids(result)).toEqual([[records[0].id, records[1].id]]);
    expect(result.groups[0].signals).toEqual(["same_file"]);
    expect(result.groups[0].records.map((r) => r.attachmentSha256s)).toEqual([
      [hash],
      [hash],
    ]);
    expect(result.hashedOnTheFly).toBe(0);
    expect(storedHashes(b)).toEqual([null, null, null]);
  });

  it("finds the other copy outside the scanned period, reading only files of a size that could match", () => {
    const b = open();
    const august = expense(b, {
      date: "2026-08-12",
      amount: 450,
      contact: b.who.kilang,
      payable: true,
      description: "Cartons",
    });
    const october = expense(b, {
      date: "2026-10-20",
      amount: 450,
      contact: b.who.kilang,
      payable: true,
      description: "Corrugated cartons 3-ply",
    });
    const other = expense(b, {
      date: "2026-10-21",
      amount: 12,
      contact: b.who.grab,
      description: "Parking",
    });
    const bill = receipt(["Kilang Kotak Sdn Bhd", "Invoice", "RM 450.00"]);
    const a = attachUnhashed(b, august.id, bill);
    const o = attachUnhashed(b, october.id, bill);
    const p = attachUnhashed(
      b,
      other.id,
      receipt(["Parking receipt with a longer text", "RM 12.00"]),
    );

    const { files, reads } = countingFiles(b);
    const result = findDuplicateRecords(
      b.db,
      { from: "2026-10-01", to: "2026-10-31" },
      files,
    );

    expect(result.scannedRecords).toBe(2);
    expect(ids(result)).toEqual([[august.id, october.id]]);
    // August's file is read: it is the size of a scanned one. The other
    // October file is scanned, so it is read too; nothing else is.
    expect(reads.get(a.key)).toBe(1);
    expect(reads.get(o.key)).toBe(1);
    expect(reads.get(p.key)).toBe(1);

    // Hashed once: the same files at the same sizes are not read again.
    const again = findDuplicateRecords(
      b.db,
      { from: "2026-10-01", to: "2026-10-31" },
      files,
    );
    expect(ids(again)).toEqual(ids(result));
    expect(again.hashedOnTheFly).toBe(result.hashedOnTheFly);
    expect([...reads.values()]).toEqual([1, 1, 1]);

    // Scanning August alone, the parking file's size matches no August
    // file, so it is never read.
    const { files: fresh, reads: freshReads } = countingFiles(b);
    const augustOnly = findDuplicateRecords(
      b.db,
      { from: "2026-08-01", to: "2026-08-31" },
      { ...fresh, id: `${fresh.id}#second-store` },
    );
    expect(ids(augustOnly)).toEqual([[august.id, october.id]]);
    expect(freshReads.has(p.key)).toBe(false);

    // A file rewritten at another size is read again, under its new hash;
    // August's file no longer matches any scanned size, so it stays unread.
    writeFileSync(
      join(b.storageRoot, o.key),
      receipt(["A different scan", "of another bill entirely", "RM 9.99"]),
    );
    const changed = findDuplicateRecords(
      b.db,
      { from: "2026-10-01", to: "2026-10-31" },
      files,
    );
    expect(reads.get(o.key)).toBe(2);
    expect(reads.get(a.key)).toBe(1);
    expect(changed.groups).toEqual([]);
  });

  it("groups two bills of one amount and contact four days apart once maxDays reaches them", () => {
    const b = open();
    const bill = expense(b, {
      date: "2026-08-07",
      amount: 129,
      contact: b.who.unifi,
      description: "Fibre broadband August 2026",
    });
    const copy = expense(b, {
      date: "2026-08-11",
      amount: 129,
      contact: b.who.unifi,
      description: "Unifi bill August 2026",
    });
    const statementId = b.db
      .insert(schema.bankStatements)
      .values({
        originalFilename: "august.pdf",
        storedFilePath: "reconciliation/august.pdf",
        extractionState: StatementExtractionState.Ready,
        uploadedBy: 1,
        accountId: b.bank,
      })
      .returning()
      .get()!.id;
    const lineId = b.db
      .insert(schema.bankStatementLines)
      .values({
        statementId,
        date: "2026-08-07",
        amount: 129,
        direction: StatementDirection.Out,
      })
      .returning()
      .get()!.id;
    resultValue(
      setMovementMatches(
        b.ctx,
        bill.movements.find((m) => m.accountId === b.bank)!.id,
        [{ lineId, amount: 129 }],
      ),
    );

    // Four days apart is outside the default window of three.
    expect(findDuplicateRecords(b.db).groups).toEqual([]);

    const result = findDuplicateRecords(b.db, { maxDays: 4 });
    expect(ids(result)).toEqual([[bill.id, copy.id]]);
    expect(result.groups[0].signals).toEqual(["amount_date_contact"]);
    expect(result.groups[0].score).toBe(50);
    expect(result.groups[0].records.map((r) => r.bankMatched)).toEqual([
      true,
      false,
    ]);
  });

  it("leaves two rides of the same fare 19 days apart alone under the default window", () => {
    const b = open();
    const rides = (["2026-09-03", "2026-09-22"] as const).map((date, i) => {
      const ride = expense(b, {
        date,
        amount: 59,
        contact: b.who.grab,
        description: `Ride ${i ? "from" : "to"} airport - supplier visit`,
      });
      setExtractedText(
        b.db,
        ride.id,
        [
          "Grab e-receipt",
          `Booking ${date.replaceAll("-", "")}R005900`,
          `Date ${date}`,
          "GrabCar ride RM 59.00",
          "Paid by card",
        ].join("\n"),
      );
      return ride;
    });

    const result = findDuplicateRecords(b.db);
    expect(result.groups).toEqual([]);
    expect(result.scannedRecords).toBe(2);
    // The window stops at 14 days, so no setting joins them.
    expect(findDuplicateRecords(b.db, { maxDays: 31 }).groups).toEqual([]);

    // A third ride of that fare two days after the first is a suspect.
    const third = expense(b, {
      date: "2026-09-05",
      amount: 59,
      contact: b.who.grab,
      description: "Ride to supplier",
    });
    expect(ids(findDuplicateRecords(b.db))).toEqual([[rides[0].id, third.id]]);
  });

  it("never links two different document numbers by amount, date or text", () => {
    const b = open();
    const first = expense(b, {
      date: "2026-08-05",
      amount: 640,
      contact: b.who.kilang,
      payable: true,
      description: "Corrugated cartons 3-ply (500 pcs)",
      reference: "KK-2207",
    });
    const second = expense(b, {
      date: "2026-08-07",
      amount: 640,
      contact: b.who.kilang,
      payable: true,
      description: "Corrugated cartons 3-ply (500 pcs)",
      reference: "KK-2231",
    });
    expect(findDuplicateRecords(b.db).groups).toEqual([]);

    // A copy with no number of its own could be either bill's, so all three
    // are listed together.
    const unnumbered = expense(b, {
      date: "2026-08-06",
      amount: 640,
      contact: b.who.kilang,
      payable: true,
      description: "Cartons",
    });
    const result = findDuplicateRecords(b.db);
    expect(ids(result)).toEqual([[first.id, unnumbered.id, second.id]]);
    expect(result.groups[0].signals).toEqual(["amount_date_contact"]);
  });

  it("never lists a voided record or its reversal", () => {
    const b = open();
    const copies = [1, 2, 3].map((n) =>
      expense(b, {
        date: "2026-08-07",
        amount: 129,
        contact: b.who.unifi,
        description: `Unifi bill (${n})`,
      }),
    );
    expect(ids(findDuplicateRecords(b.db))).toEqual([copies.map((c) => c.id)]);

    const voided = copies[2];
    resultValue(
      voidRecord(b.ctx, voided.id, {
        reason: "Entered three times by mistake (spec).",
        expectedVersion: resultValue(prepareVoidRecord(b.ctx, voided.id))
          .version,
      }),
    );

    const result = findDuplicateRecords(b.db);
    expect(ids(result)).toEqual([[copies[0].id, copies[1].id]]);
    expect(result.scannedRecords).toBe(2);
  });

  it("links one supplier's bills by reference, but not a label, another supplier's number or a standing number", () => {
    const b = open();
    const bill = expense(b, {
      date: "2026-08-05",
      amount: 450,
      contact: b.who.kilang,
      payable: true,
      reference: "INV-2207",
    });
    const reentered = expense(b, {
      date: "2026-09-30",
      amount: 455,
      contact: b.who.kilang,
      payable: true,
      reference: "inv 2207",
    });
    // Another supplier's invoice with the same number.
    expense(b, {
      date: "2026-07-01",
      amount: 80,
      contact: b.who.unifi,
      reference: "INV-2207",
    });
    // A label, not a document number.
    expense(b, {
      date: "2026-06-01",
      amount: 10,
      contact: b.who.grab,
      reference: "cash",
    });
    expense(b, {
      date: "2026-07-15",
      amount: 14,
      contact: b.who.grab,
      reference: "Cash",
    });
    // An account number on every monthly bill.
    for (const [date, amount] of [
      ["2026-05-06", 210.4],
      ["2026-06-05", 198.1],
      ["2026-07-06", 225.75],
      ["2026-08-05", 240],
    ] as const)
      expense(b, {
        date,
        amount,
        contact: b.who.tnb,
        reference: "220001234567",
      });

    const result = findDuplicateRecords(b.db);
    expect(ids(result)).toEqual([[bill.id, reentered.id]]);
    expect(result.groups[0].signals).toEqual(["same_reference"]);
    expect(result.groups[0].score).toBe(80);
    expect(result.groups[0].records.map((r) => r.reference)).toEqual([
      "INV-2207",
      "inv 2207",
    ]);
  });

  it("links one receipt entered under two names of a supplier by its text", () => {
    const b = open();
    const text = [
      "Grab e-receipt",
      "Booking 20260811R002350",
      "GrabCar ride RM 23.50",
      "Paid by card",
    ].join("\n");
    const entries = [b.who.grab, b.who.grabCar].map((contact) => {
      const entry = expense(b, {
        date: "2026-08-11",
        amount: 23.5,
        contact,
        description: "GRAB*RIDE 8821KL MY",
      });
      setExtractedText(b.db, entry.id, text);
      return entry;
    });

    const result = findDuplicateRecords(b.db);
    expect(ids(result)).toEqual([entries.map((e) => e.id)]);
    // Two contacts, so not the amount/date/contact signal.
    expect(result.groups[0].signals).toEqual(["similar_text"]);
    expect(result.groups[0].score).toBe(40);
  });

  it("compares records of the same kind only", () => {
    const b = open();
    expense(b, { date: "2026-08-07", amount: 100, contact: b.who.kilang });
    resultValue(
      createRecord(b.ctx, {
        kind: "income",
        date: "2026-08-07",
        amount: 100,
        currency: "MYR",
        exchangeRate: 1,
        description: "Expense",
        categoryAccountId: b.sales,
        receivedIntoAccountId: b.bank,
        contactId: b.who.kilang,
      }),
    );
    const result = findDuplicateRecords(b.db);
    expect(result.groups).toEqual([]);
    expect(result.scannedRecords).toBe(2);
  });

  it("ranks the strongest group first and counts every group before the limit", async () => {
    const b = open();
    const bytes = receipt([
      "Kilang Kotak Sdn Bhd",
      "Invoice 2231",
      "RM 610.00",
    ]);
    const filed = [
      expense(b, {
        date: "2026-08-26",
        amount: 610,
        contact: b.who.kilang,
        payable: true,
      }),
      expense(b, {
        date: "2026-10-01",
        amount: 616,
        contact: b.who.kilang,
        payable: true,
      }),
    ];
    for (const e of filed) await attach(b, e.id, bytes);
    expense(b, { date: "2026-09-10", amount: 42, contact: b.who.grab });
    expense(b, { date: "2026-09-12", amount: 42, contact: b.who.grab });

    const all = findDuplicateRecords(b.db);
    expect(all.groups.map((g) => g.signals)).toEqual([
      ["same_file"],
      ["amount_date_contact"],
    ]);
    const first = findDuplicateRecords(b.db, { limit: 1 });
    expect(ids(first)).toEqual([filed.map((e) => e.id)]);
    expect(first.totalGroups).toBe(2);

    // A contact filter scans that contact's records, whoever the copies name.
    const grabOnly = findDuplicateRecords(b.db, { contactIds: [b.who.grab] });
    expect(grabOnly.scannedRecords).toBe(2);
    expect(grabOnly.groups.map((g) => g.signals)).toEqual([
      ["amount_date_contact"],
    ]);
    // An empty filter asks for nothing.
    expect(findDuplicateRecords(b.db, { recordIds: [] }).scannedRecords).toBe(
      0,
    );
  });
});

describe("findDuplicateRecords on the evaluation book", () => {
  it("finds the double claim and the bill entered twice, leaves the decoys, and hashes older files without saving them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "akaun-duplicate-records-eval-"));
    let evalBook: EvalBook | undefined;
    try {
      evalBook = await buildEvalBook({
        dir,
        variant: "A",
        today: "2026-11-13",
      });
      const { db, raw, manifest, storageRoot } = evalBook;
      const p2 = manifest.plants.doubleClaims;
      const decoys = manifest.plants.bankStatement.decoyPair.map(
        (d) => d.record,
      );

      const check = (result: DuplicateRecordsResult) => {
        expect(
          ids(result)
            .map((group) => [...group].sort((x, y) => x - y))
            .sort((x, y) => x[0] - y[0]),
        ).toEqual(
          [
            [...p2.enteredTwice].sort((x, y) => x - y),
            [p2.reimbursedCopy, p2.unpaidCopy].sort((x, y) => x - y),
          ].sort((x, y) => x[0] - y[0]),
        );
        const listed = result.groups.flatMap((g) => g.records.map((r) => r.id));
        for (const decoy of decoys) expect(listed).not.toContain(decoy);
        const claim = result.groups.find((g) =>
          g.records.some((r) => r.id === p2.reimbursedCopy),
        )!;
        expect(claim.signals).toContain("same_file");
        const byId = new Map(claim.records.map((r) => [r.id, r]));
        expect(byId.get(p2.reimbursedCopy)).toMatchObject({
          reimbursed: true,
          settled: true,
          attachmentSha256s: [p2.sharedSha256],
        });
        expect(byId.get(p2.unpaidCopy)).toMatchObject({
          reimbursed: false,
          settled: false,
          attachmentSha256s: [p2.sharedSha256],
        });
        const bill = result.groups.find((g) =>
          g.records.some((r) => r.id === p2.enteredTwice[0]),
        )!;
        expect(bill.signals).toEqual(
          expect.arrayContaining([
            "same_file",
            "same_reference",
            "amount_date_contact",
          ]),
        );
      };

      check(findDuplicateRecords(db));
      // Monthly bills of one amount stay apart at the widest window.
      check(findDuplicateRecords(db, { maxDays: 14 }));

      // The same book as before hashes were saved.
      raw.exec("UPDATE record_attachments SET sha256 = NULL");
      const result = findDuplicateRecords(db, {}, storageFiles(storageRoot));
      check(result);
      expect(result.hashedOnTheFly).toBeGreaterThan(0);
      expect(
        raw
          .query(
            "SELECT COUNT(*) AS n FROM record_attachments WHERE sha256 IS NOT NULL",
          )
          .get(),
      ).toEqual({ n: 0 });
    } finally {
      evalBook?.raw.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
