import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { monthEndFor } from "$lib/closing.js";
import { addDaysISO, localToday } from "$lib/local-date.js";
import * as schema from "../../../db/schema.js";
import { BOOKS_REVIEW_CHECKS } from "../../../queries/books-review.js";
import { localsFor } from "../../../permissions/test-locals.js";
import { patLocals } from "../../../tokens/pat.js";
import {
  buildEvalBook,
  type EvalBook,
  type EvalVariant,
} from "../../__fixtures__/eval-book.js";
import {
  createServerV2,
  MAX_DESCRIPTION_CHARS,
  toolName,
  type NamingScheme,
} from "../../registry.js";
import { TOOL_REQUIREMENTS_V2 } from "../../requirements/index.js";
import { READ_TOOLS } from "./index.js";
import { fitFindings, reviewReadTools, type PrintedFinding } from "./review.js";

/**
 * `akaun_review_books`, driven through a real MCP client over
 * `InMemoryTransport` against the evaluation book (a file database under
 * `os.tmpdir()`; nothing here imports `db/client.ts`).
 *
 * The server offers every merged read tool, so a finding's `next` can be
 * parsed (and, where the tool is merged, called) exactly as an agent would.
 */

const TODAY = localToday();
const SLOW = 60_000;

const folders: string[] = [];
const books: EvalBook[] = [];
afterAll(() => {
  for (const book of books) book.raw.close();
  for (const folder of folders)
    rmSync(folder, { recursive: true, force: true });
});

async function build(variant: EvalVariant = "A"): Promise<EvalBook> {
  const dir = mkdtempSync(join(tmpdir(), "akaun-d3-review-"));
  folders.push(dir);
  const book = await buildEvalBook({ dir, variant, today: TODAY });
  books.push(book);
  return book;
}

async function connect(
  book: EvalBook,
  locals: App.Locals,
  naming?: NamingScheme,
) {
  const server = createServerV2({
    db: book.db,
    store: book.store,
    storageRoot: book.storageRoot,
    locals,
    tools: { reads: READ_TOOLS, writes: [] },
    ...(naming ? { naming } : {}),
  });
  const client = new Client({ name: "d3-review-spec", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { type: string; text: string }[])[0].text;
    return { isError: result.isError === true, text, body: JSON.parse(text) };
  };
  const review = (args: Record<string, unknown> = {}) =>
    call(toolName("review_books", naming), args);
  return { client, server, call, review };
}

const agentLocals = (book: EvalBook) =>
  patLocals(book.db, `Bearer ${book.agentToken}`)!;

/** Every area's `read` leaf except the ones named. */
const readsExcept = (...areas: string[]) =>
  ["records", "accounts", "contacts", "invoices", "import", "reports"]
    .concat(["reconciliation"])
    .filter((area) => !areas.includes(area))
    .map((area) => `${area}.read`);

type Item = {
  ref?: { type: string; id: number | string; no?: string; name?: string };
  summary: string;
  related?: { type: string; id: number | string }[];
};
type Finding = {
  check: string;
  severity: string;
  count: number;
  items?: Item[];
  not_listed?: number;
  next?: { tool: string; args?: Record<string, unknown> };
  fix_with?: string;
  note: string;
  counts?: Record<string, number>;
};
const findingsOf = (body: { findings?: Finding[] }): Finding[] =>
  body.findings ?? [];
const find = (body: { findings?: Finding[] }, check: string) =>
  findingsOf(body).find((f) => f.check === check);
const idsOf = (finding: Finding | undefined, type: string) =>
  (finding?.items ?? []).flatMap((item) =>
    item.ref?.type === type ? [item.ref.id] : [],
  );

const REGISTERED_READS = Object.entries(TOOL_REQUIREMENTS_V2)
  .filter(([, entry]) => entry.kind === "read")
  .map(([base]) => base);
const REGISTERED_WRITES = Object.entries(TOOL_REQUIREMENTS_V2)
  .filter(([, entry]) => entry.kind === "write")
  .map(([base]) => base);

describe("review_books", () => {
  const shared = build();

  it(
    "finds the planted problems in one call over every check",
    async () => {
      const book = await shared;
      const { plants, records } = book.manifest;
      const { review } = await connect(book, agentLocals(book));
      const { isError, body } = await review({ per_check: 50 });
      expect(isError).toBe(false);
      expect(body.today).toBe(TODAY);
      expect(body.note).toMatch(/suggestions to discuss with the user/);
      expect(body.period.to).toBe(TODAY);
      expect(body.period.from).toBeUndefined();

      // The shape every finding has.
      expect(findingsOf(body).length).toBeGreaterThan(8);
      for (const f of findingsOf(body)) {
        expect(BOOKS_REVIEW_CHECKS).toContain(f.check);
        expect(["high", "medium", "low"]).toContain(f.severity);
        expect(f.count).toBeGreaterThan(0);
        expect(typeof f.note).toBe("string");
        for (const item of f.items ?? [])
          expect(typeof item.summary).toBe("string");
      }
      // Most severe first, then the largest count.
      const rank: Record<string, number> = { high: 0, medium: 1, low: 2 };
      const order = findingsOf(body).map((f) => [rank[f.severity], -f.count]);
      expect(order).toEqual(
        [...order].sort((a, b) => a[0] - b[0] || a[1] - b[1]),
      );

      // Duplicates: the double claim and the bill entered twice.
      const duplicates = find(body, "duplicate_records")!;
      expect(duplicates).toMatchObject({ severity: "high", count: 2 });
      const claim = duplicates.items!.find((item) =>
        item.related?.some((r) => r.id === plants.doubleClaims.reimbursedCopy),
      )!;
      expect(claim.ref!.id).toBe(plants.doubleClaims.unpaidCopy);
      expect(claim.summary).toContain("same_file");

      // Contacts, the bank, equipment, descriptions, tax, invoices, bills.
      expect(find(body, "duplicate_contacts")!.count).toBeGreaterThanOrEqual(2);
      expect(find(body, "unmatched_bank")).toMatchObject({
        severity: "medium",
        count: Object.keys(book.manifest.lines).length,
      });
      expect(idsOf(find(body, "capitalisation"), "record")).toEqual([
        plants.expensedEquipment.record,
      ]);
      expect(new Set(idsOf(find(body, "descriptions"), "record"))).toEqual(
        new Set(plants.messyDescriptions),
      );
      expect(find(body, "tax_unresolved")!.severity).toBe("high");
      expect(new Set(idsOf(find(body, "tax_unresolved"), "record"))).toEqual(
        new Set(plants.tax.unclassifiedRecords),
      );
      expect(idsOf(find(body, "overdue_invoices"), "invoice")).toEqual([
        plants.receivables.overdue,
      ]);
      expect(idsOf(find(body, "unpaid_bills"), "record")).toContain(
        plants.misallocatedPayment.intendedBill,
      );
      expect(idsOf(find(body, "unallocated_credits"), "record")).toEqual([
        plants.freightLeftOut.payment,
      ]);
      expect(new Set(idsOf(find(body, "uncategorised"), "record"))).toEqual(
        new Set(plants.uncategorised.expected.map((e) => e.record)),
      );
      // The closed June receipt is not offered; the open July one is.
      const missing = idsOf(find(body, "missing_evidence"), "record");
      expect(missing).toContain(records.workspaceJul);
      expect(missing).not.toContain(records.workspaceJun);

      // Every other check ran: what found nothing is said to be clean.
      expect(body.clean).toEqual(["depreciation_due"]);
      expect(body.skipped).toBeUndefined();
    },
    SLOW,
  );

  it(
    "prints refs the way the other tools take them back",
    async () => {
      const book = await shared;
      const { plants } = book.manifest;
      const { review } = await connect(book, agentLocals(book));
      const { body } = await review({ per_check: 50 });

      // A record: its id and its number, which resolves to the same record.
      const equipment = find(body, "capitalisation")!.items![0];
      const [row] = book.db
        .select({
          id: schema.ledgerRecords.id,
          no: schema.ledgerRecords.recordNumber,
        })
        .from(schema.ledgerRecords)
        .where(eq(schema.ledgerRecords.id, plants.expensedEquipment.record))
        .all();
      expect(equipment.ref).toEqual({
        type: "record",
        id: row.id,
        ...(row.no ? { no: row.no } : {}),
      });
      expect(equipment.summary.startsWith(row.no ?? `#${row.id}`)).toBe(true);

      // A bank line is L123, never a bare number.
      const lines = idsOf(find(body, "unmatched_bank"), "bank_line");
      expect(lines.length).toBeGreaterThan(0);
      for (const id of lines) expect(String(id)).toMatch(/^L\d+$/);
      expect(lines).toContain(`L${plants.bankStatement.matches[0].line}`);

      // A contact is named, in a group and among those it may duplicate.
      const group = find(body, "duplicate_contacts")!.items!.find((item) =>
        plants.duplicateContacts.grab.includes(Number(item.ref!.id)),
      )!;
      const legalName = (id: number | string) =>
        book.db
          .select({ name: schema.contacts.legalName })
          .from(schema.contacts)
          .where(eq(schema.contacts.id, Number(id)))
          .get()!.name;
      expect(group.ref).toEqual({
        type: "contact",
        id: group.ref!.id,
        name: legalName(group.ref!.id),
      });
      expect(group.related!.length).toBeGreaterThan(0);
      for (const related of group.related!) {
        expect(related.type).toBe("contact");
        expect(related).toHaveProperty("name", legalName(related.id));
      }

      // A duplicate group points at every copy, each with its number.
      const duplicates = find(body, "duplicate_records")!;
      for (const item of duplicates.items!)
        for (const ref of [item.ref!, ...item.related!]) {
          // Plain checks: bun's toMatchObject overwrites the received value
          // with an asymmetric matcher.
          expect(ref.type).toBe("record");
          expect(typeof ref.id).toBe("number");
        }
      const copy = duplicates.items!.find((item) =>
        item.related!.some((r) => r.id === plants.doubleClaims.reimbursedCopy),
      )!;
      expect(copy.related!.map((r) => r.id)).toContain(
        plants.doubleClaims.reimbursedCopy,
      );

      // An invoice is its id and its number.
      const overdue = find(body, "overdue_invoices")!.items![0];
      const invoice = book.db
        .select({ no: schema.invoices.invoiceNumber })
        .from(schema.invoices)
        .where(eq(schema.invoices.id, plants.receivables.overdue))
        .get()!;
      expect(overdue.ref).toEqual({
        type: "invoice",
        id: plants.receivables.overdue,
        no: invoice.no,
      });

      // Movements and settlements stay hidden: a ref is only these types.
      const types = new Set(
        findingsOf(body).flatMap((f) =>
          (f.items ?? []).flatMap((item) =>
            [item.ref, ...(item.related ?? [])].flatMap((r) =>
              r ? [r.type] : [],
            ),
          ),
        ),
      );
      for (const type of types)
        expect([
          "record",
          "contact",
          "bank_line",
          "account",
          "invoice",
          "fixed_asset",
          "import_job",
        ]).toContain(type);
    },
    SLOW,
  );

  it(
    "names registered tools in next and fix_with, and next's args are accepted as they are",
    async () => {
      const book = await shared;
      const { review, call } = await connect(book, agentLocals(book));
      const audit = book.manifest.plants.audit.month;
      // Open-ended, one month, and a balances date: each shapes the args.
      const bodies = [
        (await review({ per_check: 50 })).body,
        (await review({ period: audit, per_check: 3 })).body,
        (await review({ as_at: TODAY, per_check: 3 })).body,
        (await review({ checks: ["month_end", "depreciation_due"] })).body,
      ];
      const reads = new Set(REGISTERED_READS.map((b) => toolName(b)));
      const writes = new Set(REGISTERED_WRITES.map((b) => toolName(b)));
      const parsed = new Set<string>();
      const unchecked = new Set<string>();
      let ran = 0;
      for (const body of bodies)
        for (const f of findingsOf(body)) {
          if (f.fix_with) expect(writes).toContain(f.fix_with);
          if (!f.next) continue;
          expect(reads).toContain(f.next.tool);
          const base = REGISTERED_READS.find(
            (b) => toolName(b) === f.next!.tool,
          )!;
          const tool = READ_TOOLS.find((t) => t.base === base);
          if (!tool) {
            unchecked.add(base);
            continue;
          }
          const args = f.next.args ?? {};
          const result = tool.input.safeParse(args);
          expect(
            [base, args, result.success ? "" : result.error.message],
            `${f.check}: ${base} refused its own next args`,
          ).toEqual([base, args, ""]);
          parsed.add(base);
          // And the call itself works.
          const answer = await call(f.next.tool, args);
          expect(answer.isError, `${f.check}: ${answer.text}`).toBe(false);
          ran += 1;
        }
      expect(ran).toBeGreaterThan(8);
      expect(parsed).toContain("search_records");
      expect(parsed).toContain("get_record");
      // Every read tool a finding can point at is merged, so every `next`
      // above was parsed and called, not just named.
      expect([...unchecked]).toEqual([]);
      for (const base of [
        "find_contacts",
        "get_contact",
        "get_report",
        "get_bank_reconciliation",
        "get_sales_documents",
      ])
        expect(parsed).toContain(base);
    },
    SLOW,
  );

  it(
    "gives next lists that match the count they sit under",
    async () => {
      const book = await shared;
      const { review, call } = await connect(book, agentLocals(book));
      const { body } = await review({ per_check: 1 });
      for (const check of ["uncategorised", "missing_evidence"]) {
        const f = find(body, check)!;
        const listed = await call(f.next!.tool, { ...f.next!.args, limit: 1 });
        expect(listed.body.total, check).toBe(f.count);
      }
    },
    SLOW,
  );

  it(
    "follows the naming scheme in next and fix_with",
    async () => {
      const book = await shared;
      for (const scheme of ["plain", "akaun_noun_verb"] as const) {
        const { review } = await connect(book, agentLocals(book), scheme);
        const { body } = await review({
          per_check: 1,
          checks: ["uncategorised", "duplicate_records", "unmatched_bank"],
        });
        const calls = findingsOf(body).flatMap((f) => [f.next, f.fix_with]);
        expect(calls.length).toBeGreaterThan(3);
        expect(find(body, "uncategorised")!.next!.tool).toBe(
          toolName("search_records", scheme),
        );
        expect(find(body, "uncategorised")!.fix_with).toBe(
          toolName("change_records", scheme),
        );
        expect(find(body, "unmatched_bank")!.fix_with).toBe(
          toolName("match_bank_lines", scheme),
        );
      }
    },
    SLOW,
  );

  it(
    "gives a token without reconciliation access no unmatched_bank finding, and says it was skipped",
    async () => {
      const book = await shared;
      const { review } = await connect(
        book,
        localsFor(readsExcept("reconciliation")),
      );
      const { isError, text, body } = await review({ per_check: 50 });
      expect(isError).toBe(false);
      expect(findingsOf(body).map((f) => f.check)).not.toContain(
        "unmatched_bank",
      );
      expect(body.clean ?? []).not.toContain("unmatched_bank");
      expect(body.skipped).toHaveLength(1);
      expect(body.skipped[0].check).toBe("unmatched_bank");
      expect(body.skipped[0].reason).toMatch(/reconcil/i);
      // Not even a count from the month-end sum-up, and no bank line anywhere.
      expect(find(body, "month_end")?.counts).not.toHaveProperty(
        "unmatched_bank",
      );
      expect(text).not.toContain('"bank_line"');
      // The rest of the review is intact.
      expect(find(body, "duplicate_records")).toBeDefined();
      expect(find(body, "overdue_invoices")).toBeDefined();
    },
    SLOW,
  );

  it(
    "shows a records-only token the records checks, and skips the others without calling them clean",
    async () => {
      const book = await shared;
      const { review } = await connect(book, localsFor(["records.read"]));
      const { body } = await review({ per_check: 0 });
      const ran = [
        ...findingsOf(body).map((f) => f.check),
        ...(body.clean ?? []),
      ];
      const skipped = (body.skipped as { check: string }[]).map((s) => s.check);
      expect(skipped.sort()).toEqual(
        [
          "duplicate_contacts",
          "unmatched_bank",
          "overdue_invoices",
          "depreciation_due",
          "month_end",
        ].sort(),
      );
      expect(ran.sort()).toEqual(
        BOOKS_REVIEW_CHECKS.filter((c) => !skipped.includes(c)).sort(),
      );
    },
    SLOW,
  );

  it(
    "is not listed to a caller who can read nothing",
    async () => {
      const book = await shared;
      const { client } = await connect(book, localsFor([]));
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).not.toContain("akaun_review_books");
    },
    SLOW,
  );

  it(
    "limits what is dated in a period, and carries the period into next",
    async () => {
      const book = await shared;
      const { audit } = book.manifest.plants;
      const { review } = await connect(book, agentLocals(book));
      const { body } = await review({
        period: audit.month,
        checks: ["missing_evidence"],
      });
      expect(findingsOf(body)).toHaveLength(1);
      const f = find(body, "missing_evidence")!;
      expect(idsOf(f, "record")).toEqual([audit.missingReceipt]);
      expect(body.period).toEqual({
        from: `${audit.month}-01`,
        to: monthEndFor(audit.month),
      });
      expect(f.next).toEqual({
        tool: "akaun_search_records",
        args: {
          kinds: ["expense", "income"],
          has_attachment: false,
          min: "10.00",
          period: `${audit.month}-01..${monthEndFor(audit.month)}`,
        },
      });
    },
    SLOW,
  );

  it(
    "takes as_at as everything through that date",
    async () => {
      const book = await shared;
      const { review } = await connect(book, agentLocals(book));
      const asAt = `${book.manifest.auditMonth}-15`;
      const { isError, body } = await review({
        as_at: asAt,
        checks: ["uncategorised"],
        per_check: 50,
      });
      expect(isError).toBe(false);
      expect(body.period).toEqual({ to: asAt });
      // This check leaves the closed months out, so next names the open part.
      expect(find(body, "uncategorised")!.next!.args).toEqual({
        category: "uncategorised",
        period: `${addDaysISO(book.manifest.closedThrough, 1)}..${asAt}`,
      });
    },
    SLOW,
  );

  it(
    "names only the account for the bank tool, which takes no as_at",
    async () => {
      const book = await shared;
      const { review } = await connect(book, agentLocals(book));
      const account = book.manifest.plants.bankStatement.account;
      const asAt = await review({
        as_at: TODAY,
        checks: ["unmatched_bank"],
        per_check: 1,
      });
      expect(find(asAt.body, "unmatched_bank")!.next).toEqual({
        tool: "akaun_get_bank_reconciliation",
        args: { account },
      });
      // A period is passed on: the bank tool takes it.
      const month = book.manifest.statementMonth;
      const period = await review({
        period: month,
        checks: ["unmatched_bank"],
        per_check: 1,
      });
      expect(find(period.body, "unmatched_bank")!.next).toEqual({
        tool: "akaun_get_bank_reconciliation",
        args: { account, period: `${month}-01..${monthEndFor(month)}` },
      });
    },
    SLOW,
  );

  it(
    "keeps every count whatever per_check says, and tells how many are not listed",
    async () => {
      const book = await shared;
      const { review } = await connect(book, agentLocals(book));
      const all = (await review({ per_check: 50 })).body;
      const one = (await review({ per_check: 1 })).body;
      const none = (await review({ per_check: 0 })).body;
      const counts = (b: { findings?: Finding[] }) =>
        findingsOf(b).map((f) => [f.check, f.count]);
      expect(counts(one)).toEqual(counts(all));
      expect(counts(none)).toEqual(counts(all));

      for (const f of findingsOf(one)) {
        expect(f.items!.length).toBe(1);
        expect(f.not_listed ?? 0).toBe(f.count - 1);
      }
      expect(findingsOf(one).some((f) => f.count > 1)).toBe(true);
      for (const f of findingsOf(none)) {
        expect(f.items).toBeUndefined();
        expect(f.not_listed).toBeUndefined();
      }
      // The default is ten.
      const dflt = (await review()).body;
      for (const f of findingsOf(dflt))
        expect(f.items!.length).toBe(Math.min(f.count, 10));
    },
    SLOW,
  );

  it(
    "month_end: what blocks the next close, then what the other checks count",
    async () => {
      const book = await shared;
      const { review } = await connect(book, agentLocals(book));
      const { body } = await review({ checks: ["month_end"] });
      const f = find(body, "month_end")!;
      expect(f.severity).toBe("high");
      expect(f.items![0].ref).toMatchObject({
        type: "record",
        id: book.manifest.records.membershipJul,
      });
      expect(f.items![0].summary).toMatch(/^Blocks the close/);
      expect(f.counts!.tax_unresolved).toBeGreaterThan(0);
      expect(f.next).toMatchObject({
        tool: "akaun_get_report",
        args: { report: "trial_balance" },
      });
      expect(f.fix_with).toBeUndefined();
    },
    SLOW,
  );

  it(
    "rejects bad input with a hint and does nothing",
    async () => {
      const book = await shared;
      const { review } = await connect(book, agentLocals(book));

      const unknownCheck = await review({ checks: ["uncategorized"] });
      expect(unknownCheck.isError).toBe(true);
      expect(unknownCheck.body.error.code).toBe("INVALID_INPUT");
      expect(unknownCheck.body.error.issues[0].path).toBe("checks[0]");

      const noChecks = await review({ checks: [] });
      expect(noChecks.body.error.code).toBe("INVALID_INPUT");

      const tooMany = await review({ per_check: 51 });
      expect(tooMany.body.error.code).toBe("INVALID_INPUT");
      expect(tooMany.body.error.issues[0].path).toBe("per_check");
      expect((await review({ per_check: -1 })).body.error.code).toBe(
        "INVALID_INPUT",
      );
      expect((await review({ per_check: 2.5 })).body.error.code).toBe(
        "INVALID_INPUT",
      );

      const both = await review({ period: "2026-03", as_at: "2026-03-31" });
      expect(both.body.error).toMatchObject({
        code: "INVALID_INPUT",
        path: "as_at",
      });

      const badPeriod = await review({ period: "last month" });
      expect(badPeriod.body.error).toMatchObject({
        code: "INVALID_INPUT",
        path: "period",
      });
      expect(badPeriod.body.error.fix).toMatch(/2026-Q1/);

      const badDate = await review({ as_at: "2026-02-30" });
      expect(badDate.body.error).toMatchObject({
        code: "INVALID_INPUT",
        path: "as_at",
      });

      const unknown = await review({ checks: ["uncategorised"], limit: 5 });
      expect(unknown.body.error.code).toBe("INVALID_INPUT");
      expect(unknown.body.error.issues[0].path).toBe("limit");
    },
    SLOW,
  );

  it(
    "writes nothing: the books are byte for byte as they were",
    async () => {
      const book = await shared;
      const { review } = await connect(book, agentLocals(book));
      const fingerprint = () =>
        createHash("sha256").update(book.raw.serialize()).digest("hex");
      const before = fingerprint();
      await review({ per_check: 50 });
      await review({ period: book.manifest.auditMonth });
      await review({ as_at: TODAY, per_check: 0 });
      await review({ checks: ["duplicate_records", "month_end"] });
      expect(fingerprint()).toBe(before);
    },
    SLOW,
  );
});

describe("fitFindings", () => {
  const finding = (
    check: PrintedFinding["check"],
    n: number,
    count = n,
  ): PrintedFinding => ({
    check,
    severity: "low",
    count,
    items: Array.from({ length: n }, (_, i) => ({
      ref: { type: "record", id: i + 1 },
      summary: `${check} item ${i + 1} ${"x".repeat(80)}`,
    })),
    note: "what it looked for",
  });
  const head = { note: "suggestions", today: TODAY, clean: [] };

  it("sends everything when it fits", () => {
    const findings = [finding("uncategorised", 3), finding("descriptions", 2)];
    const out = fitFindings(head, findings) as {
      findings: PrintedFinding[];
      note: string;
    };
    expect(out.findings.map((f) => f.items.length)).toEqual([3, 2]);
    expect(out.note).toBe("suggestions");
    expect(out.findings[0].not_listed).toBeUndefined();
  });

  it("over budget, drops items a round at a time across the findings and keeps every count", () => {
    const findings = [
      finding("uncategorised", 20, 31),
      finding("descriptions", 20),
      finding("capitalisation", 4),
    ];
    const out = fitFindings(head, findings, 3_000) as {
      findings: PrintedFinding[];
      note: string;
    };
    const sizes = out.findings.map((f) => f.items.length);
    expect(sizes.reduce((a, b) => a + b, 0)).toBeLessThan(44);
    expect(sizes.every((n) => n >= 1)).toBe(true);
    // Fair: no finding is more than one item ahead of another that had more.
    expect(
      Math.max(...sizes) - Math.min(sizes[0], sizes[1]),
    ).toBeLessThanOrEqual(1);
    // Counts are whole; what is kept is each finding's own first items.
    expect(out.findings.map((f) => f.count)).toEqual([31, 20, 4]);
    for (const f of out.findings)
      expect(f.items.map((i) => i.ref!.id)).toEqual(
        f.items.map((_, i) => i + 1),
      );
    expect(out.findings[0].not_listed).toBe(31 - sizes[0]);
    expect(out.findings[2].not_listed).toBe(
      sizes[2] < 4 ? 4 - sizes[2] : undefined,
    );
    expect(out.note).toMatch(/^suggestions /);
    expect(out.note).toMatch(/every count is complete/);
  });

  it("leaves a counts-only answer alone", () => {
    const counts: PrintedFinding = { ...finding("uncategorised", 0, 9) };
    const out = fitFindings(head, [counts]) as { findings: PrintedFinding[] };
    expect(out.findings[0].items).toEqual([]);
    expect(out.findings[0].not_listed).toBeUndefined();
  });
});

describe("the review_books description", () => {
  it(
    "fits the limit, names no fixture noun and says what an agent needs to know",
    async () => {
      const a = await build("A");
      const b = await build("B");
      const nouns = [...a.manifest.nouns, ...b.manifest.nouns];
      expect(nouns.length).toBeGreaterThan(40);
      const { client } = await connect(a, agentLocals(a));
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === "akaun_review_books")!;
      const text = tool.description ?? "";
      expect(text.length).toBeGreaterThan(300);
      expect(text.length).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS);
      for (const noun of nouns)
        expect(text.toLowerCase()).not.toContain(noun.toLowerCase());
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(JSON.stringify(tool.inputSchema)).not.toMatch(/Minor/);
      // Every check is named, so an agent can ask for one.
      for (const check of BOOKS_REVIEW_CHECKS) expect(text).toContain(check);
      // Suggestions, not instructions; a fix through the write tool, after a dry run.
      expect(text).toMatch(/suggestions to discuss with the user/);
      expect(text).toMatch(/not instructions/);
      expect(text).toMatch(/fix_with/);
      expect(text).toMatch(/dry run/);
      // It names no other tool, so the naming scheme cannot make it wrong.
      expect(text).not.toMatch(/akaun_/);
      // Listed with the other reads, last.
      expect(reviewReadTools.map((t) => t.base)).toEqual(["review_books"]);
      expect(READ_TOOLS.at(-1)?.base).toBe("review_books");
    },
    SLOW,
  );
});
