import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  AccountSubType,
  InvoiceStatus,
  LedgerRecordKind,
  StatementDirection,
} from "$lib/enums.js";
import { addDaysISO, localToday } from "$lib/local-date.js";
import * as schema from "../../db/schema.js";
import { checkIntegrity } from "../../ledger/integrity.js";
import { closedThrough } from "../../closing/policy.js";
import {
  getRecord,
  integrityInputs,
  listAttachments,
} from "../../queries/ledger.js";
import { listOutstanding } from "../../queries/settlements.js";
import { unresolvedTaxLines } from "../../queries/tax-review.js";
import { getInvoice } from "../../queries/invoices.js";
import { patLocals } from "../../tokens/pat.js";
import {
  BOOKKEEPER_PERMISSIONS,
  buildEvalBook,
  EVAL_CONTACT_KEYS,
  EVAL_INBOX,
  EVAL_LINE_KEYS,
  EVAL_RECORD_KEYS,
  EVAL_RULES_TEXT,
  EVAL_VARIANTS,
  type EvalBook,
  type EvalVariant,
} from "./eval-book.js";
import { textPdf, textPdfLines } from "./pdf.js";

// Each book is a file database in its own folder under os.tmpdir(), built
// through the application operations; nothing here imports db/client.ts. Run
// with the MCP preload to prove it:
//   bun test --preload ./scripts/mcp-test-preload.ts src/lib/server/mcp/__fixtures__/eval-book.spec.ts

/** The real clock: the app reads it to say what is overdue. */
const TODAY = localToday();
const SLOW = 60_000;

function newFolder(): string {
  return mkdtempSync(join(tmpdir(), "akaun-eval-book-spec-"));
}

function build(variant: EvalVariant): Promise<EvalBook> {
  return buildEvalBook({ dir: newFolder(), variant, today: TODAY });
}

function release(book: EvalBook): void {
  book.raw.close();
  rmSync(book.dir, { recursive: true, force: true });
}

/**
 * Registers tests that share one expensive build. The build runs when the
 * first of them starts and is released when the last of them finishes, so a
 * full run leaves nothing behind. (A run filtered to some of them leaves its
 * folder in the OS temp directory.)
 */
function sharing<T>(make: () => Promise<T>, done: (value: T) => void) {
  let value: Promise<T> | undefined;
  let pending = 0;
  return (name: string, check: (value: T) => void) => {
    pending += 1;
    it(
      name,
      async () => {
        const current = (value ??= make());
        try {
          check(await current);
        } finally {
          pending -= 1;
          if (pending === 0) await current.then(done, () => undefined);
        }
      },
      SLOW,
    );
  };
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function filesUnder(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? filesUnder(join(folder, entry.name))
      : [join(folder, entry.name)],
  );
}

function record(book: EvalBook, id: number) {
  const view = getRecord(book.db, id);
  if (!view) throw new Error(`record ${id} is missing`);
  return view;
}

/** Accounts the record's category side (value in) is on. */
function categoryOf(book: EvalBook, id: number): number[] {
  return record(book, id)
    .movements.filter((m) => m.amountMinor > 0)
    .map((m) => m.accountId);
}

/** "RM 1,285.00", from whole cents. */
function rm(minor: number): string {
  const cents = minor % 100;
  const whole = String((minor - cents) / 100).replace(
    /\B(?=(\d{3})+(?!\d))/g,
    ",",
  );
  return `RM ${whole}.${String(cents).padStart(2, "0")}`;
}

function dayLabel(iso: string): string {
  const months = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
  const [year, month, day] = iso.split("-").map(Number);
  return `${day} ${months[month - 1]} ${year}`;
}

const MESSY: Record<EvalVariant, string[]> = {
  A: [
    "GRAB*RIDE 8821KL MY",
    "POS 4411 SHOPEE*KEDAI",
    "pymt",
    "",
    "Misc",
    "TRF 00012 JNT",
    "CARD 5521 CANVA* 1029384",
    "IBG TNB 2209",
  ],
  B: [
    "TUMPANG*RIDE 4410PJ MY",
    "POS 7720 PASARNET*KEDAI",
    "trf",
    "",
    "Others",
    "TRF 00031 KLTX",
    "CARD 7731 LAKAR* 5512093",
    "IBG ENB 1009",
  ],
};

describe("buildEvalBook guards", () => {
  it("refuses a folder outside the OS temp directory and creates nothing", async () => {
    const outside = join(
      process.cwd(),
      `eval-book-must-not-exist-${process.pid}`,
    );
    await expect(
      buildEvalBook({ dir: outside, variant: "A", today: TODAY }),
    ).rejects.toThrow(/temp/i);
    expect(existsSync(outside)).toBe(false);
  });

  it("refuses a today that falls inside the book's months", async () => {
    const folder = newFolder();
    try {
      await expect(
        buildEvalBook({ dir: folder, variant: "B", today: "2026-10-15" }),
      ).rejects.toThrow(/today/);
      expect(readdirSync(folder)).toEqual([]);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe("the text PDF", () => {
  it("is the same bytes every time and reads back as its lines", () => {
    const lines = ["Receipt (copy)", "Total: RM 1,285.00", "back\\slash"];
    const first = textPdf(lines);
    expect(Buffer.from(first).toString("latin1").startsWith("%PDF-1.4")).toBe(
      true,
    );
    expect(Buffer.from(textPdf(lines)).equals(Buffer.from(first))).toBe(true);
    expect(textPdfLines(first)).toEqual(lines);
    expect(() => textPdf(["Café"])).toThrow(/ASCII/);
  });
});

for (const variant of EVAL_VARIANTS) {
  describe(`evaluation book ${variant}`, () => {
    const test = sharing(() => build(variant), release);

    test("is written only inside its own temporary folder", (book) => {
      const temp = realpathSync(tmpdir());
      expect(inside(temp, book.dir)).toBe(true);
      expect(inside(book.dir, book.databasePath)).toBe(true);
      expect(inside(book.dir, book.storageRoot)).toBe(true);
      expect(inside(book.dir, book.store.root)).toBe(true);
      const stored = filesUnder(book.storageRoot);
      expect(stored.length).toBe(
        Object.keys(book.manifest.attachments).length + 1,
      );
      for (const file of stored) expect(inside(book.dir, file)).toBe(true);
      expect(readdirSync(book.dir).sort()).toEqual([
        "akaun-eval.db",
        "storage",
      ]);
    });

    test("balances, and is closed through its first month", (book) => {
      expect(checkIntegrity(integrityInputs(book.db)).ok).toBe(true);
      expect(closedThrough(book.db)).toBe(book.manifest.closedThrough);
      expect(book.manifest.closedThrough).toBe(
        variant === "A" ? "2026-06-30" : "2026-07-31",
      );
      expect(
        unresolvedTaxLines(book.db, null, book.manifest.closedThrough),
      ).toEqual([]);
    });

    test("has a row for every id in the manifest", (book) => {
      const { db, manifest } = book;
      const exists = (
        table:
          | typeof schema.accounts
          | typeof schema.contacts
          | typeof schema.ledgerRecords
          | typeof schema.invoices
          | typeof schema.bankStatements
          | typeof schema.bankStatementLines
          | typeof schema.recordAttachments
          | typeof schema.users
          | typeof schema.groups,
        ids: number[],
      ) =>
        db
          .select({ id: table.id })
          .from(table)
          .where(inArray(table.id, ids))
          .all().length;
      const unique = (ids: number[]) => [...new Set(ids)];
      expect(Object.keys(manifest.records).sort()).toEqual(
        [...EVAL_RECORD_KEYS].sort(),
      );
      expect(Object.keys(manifest.lines).sort()).toEqual(
        [...EVAL_LINE_KEYS].sort(),
      );
      for (const key of EVAL_CONTACT_KEYS)
        expect(manifest.contacts[key]).toBeGreaterThan(0);
      const accounts = Object.values(manifest.accounts);
      const contacts = Object.values(manifest.contacts).flat();
      const records = Object.values(manifest.records);
      expect(exists(schema.accounts, accounts)).toBe(unique(accounts).length);
      expect(exists(schema.contacts, contacts)).toBe(unique(contacts).length);
      expect(exists(schema.ledgerRecords, records)).toBe(records.length);
      expect(unique(records)).toHaveLength(records.length);
      expect(
        exists(
          schema.invoices,
          Object.values(manifest.invoices).map((i) => i.id),
        ),
      ).toBe(3);
      expect(exists(schema.bankStatements, [manifest.statements.bank])).toBe(1);
      expect(
        exists(schema.bankStatementLines, Object.values(manifest.lines)),
      ).toBe(10);
      const attachments = Object.values(manifest.attachments);
      expect(
        exists(
          schema.recordAttachments,
          attachments.map((a) => a!.id),
        ),
      ).toBe(attachments.length);
      expect(
        exists(schema.users, [manifest.users.owner, manifest.users.agent]),
      ).toBe(2);
      expect(
        exists(schema.groups, [
          manifest.groups.owners,
          manifest.groups.bookkeeper,
        ]),
      ).toBe(2);
      for (const invoice of Object.values(manifest.invoices))
        expect(record(book, invoice.recordId).kind).toBe(
          LedgerRecordKind.InvoiceIssue,
        );
    });

    test("gives the agent a token with the bookkeeper's abilities and no adjustments", (book) => {
      const locals = patLocals(book.db, `Bearer ${book.agentToken}`);
      expect(locals?.user?.id).toBe(book.agentUserId);
      const held = [...(locals?.permissions ?? [])].sort();
      expect(held).toEqual([...BOOKKEEPER_PERMISSIONS].sort());
      expect(held).toContain("contacts.merge");
      expect(held).toContain("records.correctAllocations");
      expect(held).toContain("records.void");
      expect(held).not.toContain("records.adjust");
      expect(held.some((leaf) => leaf.startsWith("closing."))).toBe(false);
    });

    test("stores receipts whose searchable text is exactly what they show", (book) => {
      for (const [key, file] of Object.entries(book.manifest.attachments)) {
        const bytes = readFileSync(book.store.pathOf(file!.storedKey));
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(
          file!.sha256,
        );
        const view = record(
          book,
          book.manifest.records[key as keyof typeof book.manifest.records],
        );
        expect(view.extractedText).toBe(textPdfLines(bytes).join("\n"));
      }
      const statement = book.db
        .select()
        .from(schema.bankStatements)
        .where(eq(schema.bankStatements.id, book.manifest.statements.bank))
        .get()!;
      const statementText = textPdfLines(
        readFileSync(book.store.pathOf(statement.storedFilePath)),
      ).join("\n");
      expect(statementText).toContain(variant === "A" ? "Maybank" : "CIMB");
    });

    test("P1: one supplier under three names, one under two, and a lookalike pair", (book) => {
      const plant = book.manifest.plants.duplicateContacts;
      expect(new Set(plant.grab).size).toBe(3);
      const byContact = plant.grabRecords.map(
        (id) => record(book, id).contactId,
      );
      expect(byContact).toHaveLength(6);
      for (const id of plant.grab)
        expect(byContact.filter((c) => c === id)).toHaveLength(2);
      for (const id of plant.grabRecords)
        expect(record(book, id).extractedText).toContain(
          plant.grabRegistrationNo,
        );
      expect(
        new Set(plant.tnbRecords.map((id) => record(book, id).contactId)),
      ).toEqual(new Set(plant.tnb));
      const [market, courier] = plant.lookalikesNotDuplicates;
      expect(market).not.toBe(courier);
    });

    test("P2: one receipt on two claims, one reimbursed; one bill entered twice", (book) => {
      const { manifest } = book;
      const plant = manifest.plants.doubleClaims;
      expect(manifest.attachments.nandosClaimed!.sha256).toBe(
        plant.sharedSha256,
      );
      expect(manifest.attachments.nandosDuplicate!.sha256).toBe(
        plant.sharedSha256,
      );
      expect(record(book, plant.reimbursedCopy).paid).toBe(true);
      const unpaid = record(book, plant.unpaidCopy);
      expect(unpaid.paid).toBe(false);
      expect(unpaid.outstandingMinor).toBe(unpaid.amountMinor);
      expect(record(book, plant.reimbursement).contactId).toBe(
        manifest.contacts.partner,
      );
      const [first, second] = plant.enteredTwice.map((id) => record(book, id));
      expect([second.date, second.amountMinor, second.contactId]).toEqual([
        first.date,
        first.amountMinor,
        first.contactId,
      ]);
      expect(manifest.attachments.unifiAugA!.sha256).toBe(
        manifest.attachments.unifiAugB!.sha256,
      );
    });

    test("P3: a statement whose lines are all unmatched, with a decoy pair and gaps", (book) => {
      const plant = book.manifest.plants.bankStatement;
      const lines = book.db
        .select()
        .from(schema.bankStatementLines)
        .where(eq(schema.bankStatementLines.statementId, plant.statement))
        .all();
      expect(lines).toHaveLength(10);
      expect(
        book.db.select().from(schema.reconciliationAllocations).all(),
      ).toEqual([]);
      const line = (id: number) => lines.find((l) => l.id === id)!;
      for (const { line: id, record: recordId } of plant.matches) {
        const view = record(book, recordId);
        expect(Math.round(line(id).amount * 100)).toBe(
          Math.abs(view.amountMinor),
        );
        expect(view.movements.some((m) => m.accountId === plant.account)).toBe(
          true,
        );
      }
      const [early, late] = plant.decoyPair;
      expect(line(early.line).amount).toBe(line(late.line).amount);
      expect(line(early.line).date).toBe(record(book, early.record).date);
      expect(line(late.line).date).toBe(record(book, late.record).date);
      expect(line(plant.dateGap.line).date).toBe(
        addDaysISO(record(book, plant.dateGap.record).date, plant.dateGap.days),
      );
      const statementMonth = book.manifest.statementMonth;
      for (const missing of plant.noRecord) {
        const { amount, direction } = line(missing.line);
        expect(direction).toBe(
          missing.kind === "income"
            ? StatementDirection.In
            : StatementDirection.Out,
        );
        const sameAmountThisMonth = book.db
          .select()
          .from(schema.ledgerRecords)
          .where(eq(schema.ledgerRecords.amount, amount))
          .all()
          .filter((r) => r.date.startsWith(statementMonth));
        expect(sameAmountThisMonth).toEqual([]);
      }
    });

    test("P4: a record dated later than its receipt", (book) => {
      const plant = book.manifest.plants.wrongDate;
      const view = record(book, plant.record);
      expect(view.date).toBe(plant.recordedDate);
      expect(plant.receiptDate < plant.recordedDate).toBe(true);
      expect(view.extractedText).toContain(
        `Invoice date: ${dayLabel(plant.receiptDate)}`,
      );
    });

    test("P5: equipment over the threshold expensed, a cheaper decoy beside it", (book) => {
      const plant = book.manifest.plants.expensedEquipment;
      expect(categoryOf(book, plant.record)).toEqual([plant.bookedTo]);
      expect(record(book, plant.record).amountMinor).toBeGreaterThan(
        plant.thresholdMinor,
      );
      const decoy = record(book, plant.belowThreshold);
      expect(categoryOf(book, decoy.id)).toEqual([plant.bookedTo]);
      expect(decoy.amountMinor).toBeLessThan(plant.thresholdMinor);
      const asset = book.db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.id, plant.assetAccount))
        .get()!;
      expect(asset.subType).toBe(AccountSubType.FixedAsset);
    });

    test("P6: a payment naming one bill and allocated to the other", (book) => {
      const plant = book.manifest.plants.misallocatedPayment;
      const payable = book.manifest.accounts.payable;
      const payment = record(book, plant.payment);
      expect(payment.reference).toBe(plant.reference);
      const side = payment.movements.find((m) => m.accountId === payable)!;
      const allocated = book.db
        .select({ recordId: schema.ledgerMovements.recordId })
        .from(schema.settlements)
        .innerJoin(
          schema.ledgerMovements,
          eq(schema.ledgerMovements.id, schema.settlements.owedMovementId),
        )
        .where(eq(schema.settlements.paymentMovementId, side.id))
        .all();
      expect(allocated).toEqual([{ recordId: plant.allocatedBill }]);
      expect(record(book, plant.allocatedBill).paid).toBe(true);
      expect(record(book, plant.intendedBill).outstandingMinor).toBe(
        plant.amountMinor,
      );
      expect(record(book, plant.intendedBill).reference).toBe(plant.reference);
    });

    test("P7: a bill recorded without its freight, overpaid into credit", (book) => {
      const plant = book.manifest.plants.freightLeftOut;
      const bill = record(book, plant.bill);
      expect(bill.amountMinor).toBe(plant.recordedMinor);
      expect(bill.paid).toBe(true);
      expect(plant.goodsMinor + plant.freightMinor).toBe(plant.totalMinor);
      expect(record(book, plant.payment).amountMinor).toBe(plant.totalMinor);
      expect(bill.extractedText).toContain(`Total: ${rm(plant.totalMinor)}`);
      const credit = listOutstanding(book.db, {
        direction: "we-owe",
        contactId: plant.supplier,
        openOnly: true,
      }).items;
      expect(
        credit.map((item) => [item.position, item.outstandingMinor]),
      ).toEqual([["credit", plant.creditMinor]]);
      expect(plant.creditMinor).toBe(plant.freightMinor);
    });

    test("P9: messy descriptions, all waiting on the uncategorised default", (book) => {
      const { plants } = book.manifest;
      const descriptions = plants.messyDescriptions.map(
        (id) => record(book, id).description,
      );
      expect([...descriptions].sort()).toEqual([...MESSY[variant]].sort());
      const waiting = book.db
        .select({ recordId: schema.ledgerMovements.recordId })
        .from(schema.ledgerMovements)
        .where(
          eq(schema.ledgerMovements.accountId, plants.uncategorised.account),
        )
        .all()
        .map((m) => m.recordId)
        .sort((a, b) => a - b);
      expect(waiting).toEqual(
        plants.uncategorised.expected
          .map((e) => e.record)
          .sort((a, b) => a - b),
      );
      expect([...waiting]).toEqual(
        [...plants.messyDescriptions].sort((a, b) => a - b),
      );
    });

    test("P10: four records against the rules, each with a decoy booked right", (book) => {
      const { plants, accounts, records } = book.manifest;
      expect(plants.ruleBreaking).toHaveLength(4);
      for (const wrong of plants.ruleBreaking) {
        expect(categoryOf(book, wrong.record)).toEqual([wrong.bookedTo]);
        expect(wrong.bookedTo).not.toBe(wrong.ruleAccount);
      }
      expect(categoryOf(book, records.grabFoodJul)).toEqual([accounts.meals]);
      expect(categoryOf(book, records.jntSep)).toEqual([accounts.postage]);
      expect(categoryOf(book, records.workspaceJul)).toEqual([
        accounts.software,
      ]);
      expect(categoryOf(book, records.unifiAugA)).toEqual([accounts.telecom]);
      expect(EVAL_RULES_TEXT[variant].split("\n").slice(1)).toHaveLength(8);
    });

    test("P11: one account's lines unclassified, client meals at the staff rate, claims that are not claimable", (book) => {
      const { plants, accounts } = book.manifest;
      const unresolved = unresolvedTaxLines(book.db, null, "9999-12-31");
      expect(unresolved.map((l) => l.accountId)).toEqual([
        plants.tax.unclassifiedAccount,
        plants.tax.unclassifiedAccount,
        plants.tax.unclassifiedAccount,
      ]);
      expect(unresolved.map((l) => l.recordId)).toEqual(
        plants.tax.unclassifiedRecords,
      );
      const memberships = book.db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.id, plants.tax.unclassifiedAccount))
        .get()!;
      expect(memberships.defaultTaxPercentageBps).toBeNull();
      for (const id of [...plants.tax.clientMeals, ...plants.tax.staffMeals]) {
        const meal = record(book, id).movements.find(
          (m) => m.accountId === accounts.meals,
        )!;
        expect(meal.taxClassification?.percentageBps).toBe(10_000);
      }
      expect(plants.tax.clientMeals).toHaveLength(2);
      expect(plants.tax.clientMealBps).toBe(5_000);
      for (const id of [
        ...plants.tax.notClaimable,
        plants.tax.claimableDecoy,
      ]) {
        const claim = record(book, id);
        expect(claim.paid).toBe(false);
        expect(claim.remark).toMatch(/^Claimed by /);
      }
    });

    test("P12: receivables and the audited month", (book) => {
      const { plants, invoices } = book.manifest;
      const overdue = getInvoice(book.db, plants.receivables.overdue)!;
      expect(overdue.status).toBe(InvoiceStatus.Sent);
      expect(overdue.dueDate).toBe(
        variant === "A" ? "2026-08-14" : "2026-09-14",
      );
      expect(overdue.isOverdue).toBe(true);
      expect(overdue.outstandingMinor).toBe(invoices.overdue.totalMinor);
      const paid = getInvoice(book.db, plants.receivables.paid)!;
      expect(paid.paid).toBe(true);
      const upcoming = getInvoice(book.db, plants.receivables.upcoming)!;
      expect(upcoming.dueDate).toBe(addDaysISO(TODAY, 30));
      expect(upcoming.isOverdue).toBe(false);

      const audit = plants.audit;
      const mismatch = record(book, audit.amountMismatch.record);
      expect(mismatch.amountMinor).toBe(audit.amountMismatch.recordedMinor);
      expect(mismatch.paid).toBe(false);
      expect(mismatch.extractedText).toContain(
        `Total: ${rm(audit.amountMismatch.receiptMinor)}`,
      );
      const monthExpenses = book.db
        .select()
        .from(schema.ledgerRecords)
        .where(eq(schema.ledgerRecords.kind, LedgerRecordKind.Expense))
        .all()
        .filter((r) => r.date.startsWith(audit.month));
      expect(monthExpenses.length).toBeGreaterThan(10);
      expect(
        monthExpenses
          .filter((r) => listAttachments(book.db, r.id).length === 0)
          .map((r) => r.id),
      ).toEqual([audit.missingReceipt]);
    });

    test("carries the rules and an inbox for this variant", (book) => {
      const [invoiceMail, ...decoys] = EVAL_INBOX[variant];
      expect(decoys).toHaveLength(2);
      const pdf = Buffer.from(
        invoiceMail.attachments[0].contentBase64,
        "base64",
      );
      const workspace = record(book, book.manifest.records.workspaceSep);
      expect(workspace.attachmentCount).toBe(0);
      expect(textPdfLines(pdf).join("\n")).toContain(workspace.reference);
      expect(textPdfLines(pdf).join("\n")).toContain(
        `Total: ${rm(workspace.amountMinor)}`,
      );
      for (const noun of book.manifest.nouns)
        expect(noun.length).toBeGreaterThan(1);
      const other = variant === "A" ? "B" : "A";
      expect(EVAL_RULES_TEXT[variant]).not.toBe(EVAL_RULES_TEXT[other]);
    });
  });
}

/** Every piece of text a variant puts in front of an agent. */
function everyText(book: EvalBook, variant: EvalVariant): string {
  const rows = (sql: string) =>
    (book.raw.query(sql).all() as Record<string, unknown>[]).flatMap((row) =>
      Object.values(row).map(String),
    );
  return [
    ...rows("SELECT legal_name, coalesce(registration_no, '') FROM contacts"),
    ...rows("SELECT name FROM accounts"),
    ...rows(
      "SELECT description, reference, remark, coalesce(extracted_text, '') FROM ledger_records",
    ),
    ...rows("SELECT display_name, filename FROM record_attachments"),
    ...rows("SELECT original_filename, stored_file_path FROM bank_statements"),
    ...rows("SELECT description FROM bank_statement_lines"),
    ...rows("SELECT description FROM invoice_lines"),
    ...rows("SELECT value FROM settings"),
    ...rows("SELECT coalesce(name, ''), email FROM users"),
    ...filesUnder(book.storageRoot).flatMap((file) =>
      textPdfLines(readFileSync(file)),
    ),
    EVAL_RULES_TEXT[variant],
    ...EVAL_INBOX[variant].flatMap((mail) => [
      mail.from,
      mail.to,
      mail.subject,
      mail.text,
      ...mail.attachments.flatMap((file) => [
        file.filename,
        ...textPdfLines(Buffer.from(file.contentBase64, "base64")),
      ]),
    ]),
  ].join("\n");
}

describe("across builds", () => {
  const test = sharing(
    async () => {
      // One after the other: every build acts as the same owner, whose
      // attach rate limit is process-wide.
      const first = await build("A");
      const again = await build("A");
      const other = await build("B");
      return { first, again, other };
    },
    (books) => Object.values(books).forEach(release),
  );

  const hashes = (book: EvalBook) =>
    Object.fromEntries(
      Object.entries(book.manifest.attachments).map(([key, file]) => [
        key,
        file!.sha256,
      ]),
    );
  const statementSha = (book: EvalBook) => {
    const statement = book.db.select().from(schema.bankStatements).get()!;
    return createHash("sha256")
      .update(readFileSync(book.store.pathOf(statement.storedFilePath)))
      .digest("hex");
  };

  test("rebuilding gives every receipt the same sha256, and the same ids", ({
    first,
    again,
    other,
  }) => {
    expect(Object.keys(hashes(first)).length).toBeGreaterThan(20);
    expect(hashes(again)).toEqual(hashes(first));
    expect(again.manifest.records).toEqual(first.manifest.records);
    expect(again.manifest.lines).toEqual(first.manifest.lines);
    expect(statementSha(again)).toBe(statementSha(first));
    expect(hashes(other)).not.toEqual(hashes(first));
  });

  test("the two variants share no proper noun, and each uses every noun it lists", ({
    first: a,
    other: b,
  }) => {
    const textA = everyText(a, "A");
    const textB = everyText(b, "B");
    expect(a.manifest.nouns.length).toBeGreaterThan(40);
    expect(a.manifest.nouns.filter((noun) => textB.includes(noun))).toEqual([]);
    expect(b.manifest.nouns.filter((noun) => textA.includes(noun))).toEqual([]);
    expect(a.manifest.nouns.filter((noun) => !textA.includes(noun))).toEqual(
      [],
    );
    expect(b.manifest.nouns.filter((noun) => !textB.includes(noun))).toEqual(
      [],
    );
  });
});
