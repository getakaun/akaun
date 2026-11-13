import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { localToday } from "$lib/local-date.js";
import * as schema from "../../../db/schema.js";
import { preparePaymentCorrection } from "../../../application/payment-corrections.js";
import { resolvePaymentMovement } from "../../../application/refs.js";
import { createRecord } from "../../../application/records.js";
import { voidRecord } from "../../../application/records.js";
import {
  recordVersion,
  statementLineVersion,
} from "../../../application/version.js";
import { recordAudit, getAuditTrail } from "../../../audit.js";
import { fromMinor, formatMinor } from "../../../ledger/money.js";
import { localsFor } from "../../../permissions/test-locals.js";
import { accountBalanceMinor } from "../../../queries/accounts.js";
import {
  getRecord,
  listRecords,
  setExtractedText,
} from "../../../queries/ledger.js";
import { patLocals } from "../../../tokens/pat.js";
import { buildEvalBook, type EvalBook } from "../../__fixtures__/eval-book.js";
import { createServerV2 } from "../../registry.js";
import { accountLabels } from "./accounts.js";
import { recordsReadTools } from "./records.js";

/**
 * `akaun_search_records`, `akaun_get_record` and `akaun_get_category_history`
 * through a real MCP client over `InMemoryTransport`, against the evaluation
 * book (a file database under `os.tmpdir()`; never `db/client.ts`).
 *
 * Two books are built. The first is only ever read, so counts can be checked
 * against the manifest. The second is changed first (a bank match, a void, a
 * part payment, long text, a long history, twin contacts) so the reads can be
 * shown on the cases a fresh book does not have.
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

async function build(): Promise<EvalBook> {
  const dir = mkdtempSync(join(tmpdir(), "akaun-d1-records-"));
  folders.push(dir);
  const book = await buildEvalBook({ dir, variant: "A", today: TODAY });
  books.push(book);
  return book;
}

async function connect(book: EvalBook, locals?: App.Locals) {
  const server = createServerV2({
    db: book.db,
    store: book.store,
    storageRoot: book.storageRoot,
    locals: locals ?? patLocals(book.db, `Bearer ${book.agentToken}`)!,
    tools: { reads: recordsReadTools, writes: [] },
  });
  const client = new Client({ name: "d1-records-spec", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({
      name: `akaun_${name}`,
      arguments: args,
    });
    const text = (result.content as { type: string; text: string }[])[0].text;
    return { isError: result.isError === true, text, body: JSON.parse(text) };
  };
  /** Every page of a search, following next_cursor. */
  const allPages = async (args: Record<string, unknown>) => {
    const rows: Record<string, unknown>[] = [];
    let cursor: string | undefined;
    let last: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) {
      const { body, isError } = await call("search_records", {
        ...args,
        limit: args.limit ?? 7,
        ...(cursor ? { cursor } : {}),
      });
      expect(isError).toBe(false);
      last = body;
      rows.push(...(body.records ?? []));
      cursor = body.next_cursor;
      if (!cursor) break;
    }
    return { rows, last };
  };
  return { client, call, allPages };
}

type Row = {
  id: number;
  no?: string;
  date: string;
  kind: string;
  description?: string;
  contact?: string;
  amount: string;
  category?: string;
  status?: string;
  outstanding?: string;
  cleared?: boolean;
  files: number;
  v: string;
  change?: string;
  balance?: string;
  sides?: { account: string; amount: string; side: string }[];
};

/** Movement and settlement ids must never reach an agent, under any name. */
function hiddenIds(value: unknown, path = ""): string[] {
  if (Array.isArray(value))
    return value.flatMap((item, i) => hiddenIds(item, `${path}[${i}]`));
  if (value && typeof value === "object")
    return Object.entries(value).flatMap(([key, child]) => [
      ...(/movement|settlement(_?id)?$/i.test(key) ? [`${path}.${key}`] : []),
      ...hiddenIds(child, `${path}.${key}`),
    ]);
  return [];
}

const minor = (text: string) => Math.round(Number(text) * 100);

// --- a book that is only read ---------------------------------------------------

describe("search_records on the evaluation book", () => {
  const shared = build();

  it(
    "lists newest first, one readable row per record, and never shows an internal id",
    async () => {
      const book = await shared;
      const { call } = await connect(book);
      const { isError, text, body } = await call("search_records", {
        limit: 10,
      });
      expect(isError).toBe(false);
      expect(body.currency).toBe("MYR");
      expect(body.total).toBe(listRecords(book.db, { limit: 1 }).total);
      const rows = body.records as Row[];
      expect(rows).toHaveLength(10);
      expect(rows.map((r) => r.date)).toEqual(
        [...rows.map((r) => r.date)].sort().reverse(),
      );
      for (const row of rows) {
        expect(typeof row.id).toBe("number");
        expect(row.amount).toMatch(/^-?\d+\.\d{2}$/);
        expect(typeof row.files).toBe("number");
        expect(row.v).toBe(recordVersion(book.db, row.id));
      }
      expect(hiddenIds(body)).toEqual([]);
      expect(text).not.toMatch(/movementId|settlementId|MovementId/);
      expect(body.next_cursor).toBeTruthy();
      expect(body.note).toMatch(/Showing 1–10 of \d+/);
    },
    SLOW,
  );

  it(
    "names the number, contact, category and status of a record",
    async () => {
      const book = await shared;
      const m = book.manifest;
      const { call } = await connect(book);
      const { body } = await call("search_records", { query: "Canva Pro" });
      const row = (body.records as Row[]).find(
        (r) => r.id === m.records.canvaPro,
      )!;
      const view = getRecord(book.db, m.records.canvaPro)!;
      const labels = accountLabels(book.db);
      expect(row.no).toBe(view.recordNumber);
      expect(row.kind).toBe("expense");
      expect(row.contact).toBe(view.contactName);
      expect(row.amount).toBe(formatMinor(view.amountMinor));
      expect(row.category).toBe(labels.get(m.accounts.software)?.label);
      expect(row.status).toBe("paid");
      expect(row.cleared).toBe(false);
      expect(row.files).toBe(1);
      // Concise: no sides, reference or remark.
      expect(row.sides).toBeUndefined();
    },
    SLOW,
  );

  it(
    "finds the records still on the uncategorised default account",
    async () => {
      const book = await shared;
      const m = book.manifest;
      const { allPages } = await connect(book);
      const { rows, last } = await allPages({ category: "uncategorised" });
      expect(new Set(rows.map((r) => r.id))).toEqual(
        new Set(m.plants.uncategorised.expected.map((e) => e.record)),
      );
      expect(last.total).toBe(rows.length);
      // The word means the default account, whatever its case.
      const again = await allPages({ category: " Uncategorised " });
      expect(again.rows).toHaveLength(rows.length);
    },
    SLOW,
  );

  it(
    "filters by period, as_at, kinds, category, account and contact",
    async () => {
      const book = await shared;
      const m = book.manifest;
      const { call, allPages } = await connect(book);

      const sept = await allPages({ period: "2026-09", kinds: ["expense"] });
      expect(sept.rows.length).toBeGreaterThan(5);
      for (const row of sept.rows as Row[]) {
        expect(row.date.startsWith("2026-09")).toBe(true);
        expect(row.kind).toBe("expense");
      }
      expect(sept.last.total).toBe(
        listRecords(book.db, {
          dateFrom: "2026-09-01",
          dateTo: "2026-09-30",
          kind: 1,
          limit: 1,
        }).total,
      );

      const upTo = await allPages({ as_at: "2026-07-31" });
      expect(upTo.rows.length).toBeGreaterThan(5);
      expect((upTo.rows as Row[]).every((r) => r.date <= "2026-07-31")).toBe(
        true,
      );

      // A category by id, by code and name, and by name give the same records.
      const labels = accountLabels(book.db);
      const travel = labels.get(m.accounts.travel)!;
      const byId = await allPages({ category: m.accounts.travel });
      const byLabel = await allPages({ category: travel.label });
      const byName = await allPages({ category: travel.name });
      const byCode = await allPages({ category: String(travel.code) });
      expect(byId.rows.length).toBeGreaterThan(2);
      for (const other of [byLabel, byName, byCode])
        expect(other.rows.map((r) => r.id)).toEqual(byId.rows.map((r) => r.id));
      for (const row of byId.rows as Row[])
        expect(row.category).toContain(travel.label);

      // Records with a side on the bank account.
      const bank = await allPages({ account: m.accounts.bank });
      expect(bank.last.total).toBe(
        listRecords(book.db, { accountId: m.accounts.bank, limit: 1 }).total,
      );

      // A contact by exact name and by id.
      const tnb = await call("search_records", { contact: "TNB", limit: 200 });
      const tnbById = await call("search_records", {
        contact: m.contacts.tnb,
        limit: 200,
      });
      expect(tnb.body.total).toBeGreaterThan(0);
      expect(tnb.body.records.map((r: Row) => r.id)).toEqual(
        tnbById.body.records.map((r: Row) => r.id),
      );
      expect(tnb.body.records.map((r: Row) => r.id)).toContain(
        m.records.tnbAug,
      );
    },
    SLOW,
  );

  it(
    "filters by status, clearance, attachment, amount, tax treatment and query, and sorts by amount",
    async () => {
      const book = await shared;
      const m = book.manifest;
      const { call, allPages } = await connect(book);

      const owed = await allPages({ status: "owed" });
      expect(owed.rows.length).toBeGreaterThan(3);
      for (const row of owed.rows as Row[]) {
        expect(row.status).toBe("owed");
        expect(row.outstanding).toBe(row.amount);
      }
      const unpaid = await allPages({ status: "unpaid" });
      expect(unpaid.rows.length).toBeGreaterThanOrEqual(owed.rows.length);
      // Credit left on a payment is not an unpaid bill.
      for (const row of unpaid.rows as Row[])
        expect(["owed", "part_paid"]).toContain(row.status);
      const paid = await call("search_records", { status: "paid", limit: 100 });
      expect(paid.body.total).toBeGreaterThan(10);
      for (const row of paid.body.records as Row[]) {
        expect(row.status).toBe("paid");
        expect(["expense", "income", "invoice_issue"]).toContain(row.kind);
      }
      // Paid and unpaid together are every bill and sale there is.
      const billable = await call("search_records", {
        kinds: ["expense", "income", "invoice_issue"],
        limit: 1,
      });
      expect(paid.body.total + unpaid.rows.length).toBe(billable.body.total);

      const none = await allPages({
        has_attachment: false,
        kinds: ["expense"],
      });
      expect(none.rows.length).toBeGreaterThan(0);
      for (const row of none.rows as Row[]) expect(row.files).toBe(0);
      const some = await call("search_records", {
        has_attachment: true,
        limit: 100,
      });
      for (const row of some.body.records as Row[])
        expect(row.files).toBeGreaterThan(0);

      const between = await allPages({ min: "300.00", max: "700.00" });
      expect(between.rows.length).toBeGreaterThan(2);
      for (const row of between.rows as Row[]) {
        const figure = minor(row.amount);
        expect(figure).toBeGreaterThanOrEqual(30000);
        expect(figure).toBeLessThanOrEqual(70000);
      }

      const unresolved = await allPages({
        tax: ["unclassified", "requires_review"],
      });
      const found = new Set(unresolved.rows.map((r) => r.id));
      for (const id of m.plants.tax.unclassifiedRecords)
        expect(found.has(id)).toBe(true);

      const text = await call("search_records", { query: "Canva" });
      expect(
        (text.body.records as Row[]).some((r) => r.id === m.records.canvaPro),
      ).toBe(true);

      const biggest = await call("search_records", {
        sort: "amount",
        limit: 5,
        kinds: ["expense"],
      });
      const amounts = (biggest.body.records as Row[]).map((r) =>
        minor(r.amount),
      );
      expect(amounts).toEqual([...amounts].sort((a, b) => b - a));

      const cleared = await call("search_records", {
        cleared: true,
        limit: 5,
      });
      expect(cleared.isError).toBe(false);
      expect(cleared.body.total ?? 0).toBe(
        listRecords(book.db, { cleared: true, limit: 1 }).total,
      );
    },
    SLOW,
  );

  it(
    "adds the sides, reference and remark with detail full, and the sides balance",
    async () => {
      const book = await shared;
      const { call } = await connect(book);
      const { body } = await call("search_records", {
        kinds: ["expense", "payment"],
        detail: "full",
        limit: 20,
      });
      for (const row of body.records as Row[]) {
        expect(row.sides!.length).toBeGreaterThanOrEqual(2);
        const debit = row
          .sides!.filter((s) => s.side === "debit")
          .reduce((sum, s) => sum + minor(s.amount), 0);
        const credit = row
          .sides!.filter((s) => s.side === "credit")
          .reduce((sum, s) => sum + minor(s.amount), 0);
        expect(debit).toBe(credit);
      }
      expect(hiddenIds(body)).toEqual([]);
    },
    SLOW,
  );

  it(
    "pages with a cursor that belongs to its filters",
    async () => {
      const book = await shared;
      const { call, allPages } = await connect(book);
      const first = await call("search_records", { limit: 4 });
      const { rows, last } = await allPages({ limit: 4 });
      expect(rows).toHaveLength(last.total as number);
      expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
      expect(rows.slice(0, 4).map((r) => r.id)).toEqual(
        first.body.records.map((r: Row) => r.id),
      );
      // The same cursor with other filters would point into another list.
      const wrong = await call("search_records", {
        kinds: ["income"],
        limit: 4,
        cursor: first.body.next_cursor,
      });
      expect(wrong.isError).toBe(true);
      expect(wrong.body.error.code).toBe("INVALID_INPUT");
      expect(wrong.body.error.fix).toMatch(/without cursor/);
      // How it is shown is not a filter.
      const fuller = await call("search_records", {
        limit: 4,
        detail: "full",
        cursor: first.body.next_cursor,
      });
      expect(fuller.isError).toBe(false);
    },
    SLOW,
  );

  it(
    "shows an account as a statement: opening, a balance on each row, closing",
    async () => {
      const book = await shared;
      const m = book.manifest;
      const { call, allPages } = await connect(book);

      // The whole history: it ends at the account's balance.
      const whole = await allPages({ account: m.accounts.bank, limit: 200 });
      const head = whole.last;
      expect(head.account).toMatch(/^1100 /);
      expect(head.opening).toBe("0.00");
      expect(head.closing).toBe(
        formatMinor(accountBalanceMinor(book.db, m.accounts.bank)),
      );
      const rows = whole.rows as Row[];
      let running = 0;
      for (const row of rows) {
        running += minor(row.change!);
        expect(minor(row.balance!)).toBe(running);
      }
      expect(running).toBe(minor(head.closing as string));
      expect(head.note).toMatch(/oldest first/);
      expect(rows.map((r) => r.date)).toEqual(
        [...rows.map((r) => r.date)].sort(),
      );

      // One month: the opening figure is what the account held before it.
      const sept = await allPages({
        account: m.accounts.bank,
        period: "2026-09",
        limit: 200,
      });
      const before = book.raw
        .query(
          `SELECT COALESCE(SUM(mv.amount_minor), 0) AS total
             FROM ledger_movements mv JOIN ledger_records r ON r.id = mv.record_id
            WHERE mv.account_id = ? AND r.date < '2026-09-01'`,
        )
        .get(m.accounts.bank) as { total: number };
      expect(sept.last.opening).toBe(formatMinor(before.total));
      const monthRows = sept.rows as Row[];
      expect(monthRows.length).toBeGreaterThan(0);
      expect(minor(monthRows[0].balance!)).toBe(
        before.total + minor(monthRows[0].change!),
      );
      expect(minor(monthRows.at(-1)!.balance!)).toBe(
        minor(sept.last.closing as string),
      );

      // By code or by name it is the same account.
      const byCode = await call("search_records", {
        account: "1100",
        period: "2026-09",
        limit: 200,
      });
      expect(byCode.body.opening).toBe(sept.last.opening);
      expect(byCode.body.records.length).toBe(monthRows.length);
    },
    SLOW,
  );

  it(
    "leaves the balance out, and says why, once another filter or sort is given",
    async () => {
      const book = await shared;
      const m = book.manifest;
      const { call } = await connect(book);
      for (const extra of [
        { kinds: ["expense"] },
        { sort: "amount" },
        { status: "paid" },
        { query: "a" },
        { voided: "only" },
      ]) {
        const { body, isError } = await call("search_records", {
          account: m.accounts.bank,
          ...extra,
        });
        expect(isError).toBe(false);
        expect(body.opening).toBeUndefined();
        expect(body.closing).toBeUndefined();
        for (const row of (body.records ?? []) as Row[])
          expect(row.balance).toBeUndefined();
        expect(body.note).toMatch(/No running balance/);
      }
      // A period alone keeps it.
      const kept = await call("search_records", {
        account: m.accounts.bank,
        period: "2026-09",
      });
      expect(kept.body.opening).toBeDefined();
      expect(kept.body.note).not.toMatch(/No running balance/);
    },
    SLOW,
  );

  for (const by of [
    "category",
    "account",
    "contact",
    "month",
    "kind",
  ] as const) {
    it(
      `totals by ${by}, each group with a drill that lists its records`,
      async () => {
        const book = await shared;
        const { call } = await connect(book);
        const { body, isError } = await call("search_records", {
          group_by: by,
          limit: 200,
        });
        expect(isError).toBe(false);
        expect(body.group_by).toBe(by);
        expect(body.currency).toBe("MYR");
        const groups = body.groups as {
          key: string;
          label: string;
          total: string;
          count: number;
          drill?: { tool: string; args: Record<string, unknown> };
        }[];
        expect(groups.length).toBe(body.group_count);
        expect(groups.length).toBeGreaterThan(1);
        // Largest first, and the grand total is the groups added up.
        const sizes = groups.map((g) => Math.abs(minor(g.total)));
        expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
        expect(groups.reduce((sum, g) => sum + minor(g.total), 0)).toBe(
          minor(body.grand_total),
        );
        expect(body.matching_records).toBe(
          listRecords(book.db, { limit: 1 }).total,
        );
        expect(hiddenIds(body)).toEqual([]);

        for (const group of groups.slice(0, 6)) {
          expect(group.label.length).toBeGreaterThan(0);
          expect(group.total).toMatch(/^-?\d+\.\d{2}$/);
          if (by === "contact" && group.key === "none") {
            expect(group.label).toBe("No contact");
            expect(group.drill).toBeUndefined();
            continue;
          }
          expect(group.drill!.tool).toBe("akaun_search_records");
          const listed = await call("search_records", {
            ...group.drill!.args,
            limit: 200,
          });
          expect(listed.isError).toBe(false);
          if (by === "contact")
            // A contact's list also holds payments that settled its bills.
            expect(listed.body.total).toBeGreaterThanOrEqual(group.count);
          else expect(listed.body.total).toBe(group.count);
        }
        if (by === "contact")
          expect(groups.some((g) => g.key === "none")).toBe(true);
        if (by === "category" || by === "account")
          expect(groups[0].label).toMatch(/^\d{4} /);
      },
      SLOW,
    );
  }

  it(
    "keeps the filters in a drill, and narrows a month to the period asked for",
    async () => {
      const book = await shared;
      const { call } = await connect(book);
      const { body } = await call("search_records", {
        group_by: "month",
        period: "2026-08-10..2026-09-20",
        kinds: ["expense"],
        limit: 200,
      });
      const byMonth = new Map<string, Record<string, unknown>>(
        body.groups.map(
          (g: { key: string; drill: { args: Record<string, unknown> } }) => [
            g.key,
            g.drill.args,
          ],
        ),
      );
      expect(byMonth.get("2026-08")).toEqual({
        kinds: ["expense"],
        period: "2026-08-10..2026-08-31",
      });
      expect(byMonth.get("2026-09")).toEqual({
        kinds: ["expense"],
        period: "2026-09-01..2026-09-20",
      });

      const spent = await call("search_records", {
        group_by: "category",
        period: "2026-09",
        kinds: ["expense"],
      });
      const meals = spent.body.groups.find((g: { label: string }) =>
        g.label.endsWith("Meals"),
      );
      // The figure comes from the ledger: the lines on that account.
      const sum = book.raw
        .query(
          `SELECT COALESCE(SUM(mv.amount_minor), 0) AS total
             FROM ledger_movements mv JOIN ledger_records r ON r.id = mv.record_id
            WHERE mv.account_id = ? AND r.kind = 1 AND r.date BETWEEN '2026-09-01' AND '2026-09-30'`,
        )
        .get(book.manifest.accounts.meals) as { total: number };
      expect(minor(meals.total)).toBe(sum.total);
    },
    SLOW,
  );

  it(
    "pages the groups with a cursor",
    async () => {
      const book = await shared;
      const { call } = await connect(book);
      const first = await call("search_records", {
        group_by: "category",
        limit: 3,
      });
      expect(first.body.groups).toHaveLength(3);
      expect(first.body.next_cursor).toBeTruthy();
      const second = await call("search_records", {
        group_by: "category",
        limit: 3,
        cursor: first.body.next_cursor,
      });
      expect(second.body.groups[0].key).not.toBe(first.body.groups[0].key);
      expect(second.body.groups).toHaveLength(3);
    },
    SLOW,
  );

  it(
    "refuses group_by with voided only, or with a status it cannot total, and says how to fix it",
    async () => {
      const book = await shared;
      const { call } = await connect(book);
      const only = await call("search_records", {
        group_by: "month",
        voided: "only",
      });
      expect(only.isError).toBe(true);
      expect(only.body.error.code).toBe("INVALID_INPUT");
      expect(only.body.error.path).toBe("voided");
      expect(only.body.error.message).toMatch(
        /voided records and their reversals/,
      );
      expect(only.body.error.fix).toMatch(/Drop group_by/);
      for (const status of ["owed", "part_paid"]) {
        const refused = await call("search_records", {
          group_by: "contact",
          status,
        });
        expect(refused.body.error.code).toBe("INVALID_INPUT");
        expect(refused.body.error.fix).toMatch(/unpaid/);
      }
      // paid is the database's own filter, so it can be totalled.
      const paid = await call("search_records", {
        group_by: "contact",
        status: "paid",
      });
      expect(paid.isError).toBe(false);
      expect(paid.body.matching_records).toBeGreaterThan(0);
      const unpaid = await call("search_records", {
        group_by: "contact",
        status: "unpaid",
      });
      expect(unpaid.isError).toBe(false);
      // Every unpaid group is one bill or sale here; none is a payment.
      expect(unpaid.body.matching_records).toBeGreaterThan(3);
    },
    SLOW,
  );

  it(
    "answers bad input with INVALID_INPUT, located and with a fix",
    async () => {
      const book = await shared;
      const { call } = await connect(book);
      const kinds = await call("search_records", { kinds: ["expence"] });
      expect(kinds.isError).toBe(true);
      expect(kinds.body.error.code).toBe("INVALID_INPUT");
      expect(kinds.body.error.issues[0].path).toBe("kinds[0]");
      expect(kinds.body.error.issues[0].message).toMatch(
        /Did you mean "expense"/,
      );

      const period = await call("search_records", { period: "2026-13" });
      expect(period.body.error.code).toBe("INVALID_INPUT");
      expect(period.body.error.path).toBe("period");
      expect(period.body.error.fix).toMatch(/2026-Q1/);

      const both = await call("search_records", {
        period: "2026-09",
        as_at: "2026-09-30",
      });
      expect(both.body.error.code).toBe("INVALID_INPUT");

      const amount = await call("search_records", { min: "twelve" });
      expect(amount.body.error.code).toBe("INVALID_INPUT");
      expect(amount.body.error.issues[0].path).toBe("min");

      const range = await call("search_records", { min: "9.00", max: "1.00" });
      expect(range.body.error.code).toBe("INVALID_INPUT");
      expect(range.body.error.fix).toMatch(/at or below max/);

      const limit = await call("search_records", { limit: 500 });
      expect(limit.body.error.code).toBe("INVALID_INPUT");

      const field = await call("search_records", { catgory: "5100" });
      expect(field.body.error.issues[0].message).toMatch(
        /Did you mean "category"/,
      );
    },
    SLOW,
  );

  it(
    "answers a reference that does not resolve with NOT_FOUND and candidates, never a guess",
    async () => {
      const book = await shared;
      const { call } = await connect(book);
      const account = await call("search_records", { account: "9999" });
      expect(account.body.error.code).toBe("NOT_FOUND");
      expect(account.body.error.path).toBe("account");
      expect(account.body.error.fix).toMatch(/akaun_list_accounts/);

      // A bank account is not a category.
      const category = await call("search_records", { category: "1100" });
      expect(category.body.error.code).toBe("NOT_FOUND");
      expect(category.body.error.path).toBe("category");
      expect(category.body.error.message).toMatch(/category/i);

      // A close name offers candidates but is never used.
      const contact = await call("search_records", { contact: "Grab" });
      expect(contact.body.error.code).toBe("NOT_FOUND");
      expect(contact.body.error.path).toBe("contact");
      expect(
        contact.body.error.candidates.map((c: { name: string }) => c.name),
      ).toEqual(expect.arrayContaining([expect.stringMatching(/grab/i)]));
      expect(contact.body.error.fix).toMatch(/Close names are never used/);
    },
    SLOW,
  );

  it(
    "is not listed to a caller who cannot read records",
    async () => {
      const book = await shared;
      const { client } = await connect(book, localsFor(["accounts.read"]));
      const { tools } = await client.listTools();
      expect(tools).toEqual([]);
    },
    SLOW,
  );
});

describe("get_record on the evaluation book", () => {
  const shared = build();

  it(
    "reads a settled record: header, lines with side and tax, files, what paid it, v and editable",
    async () => {
      const book = await shared;
      const m = book.manifest;
      const { call } = await connect(book);
      const { isError, body } = await call("get_record", {
        record: m.records.nandosClaimed,
      });
      expect(isError).toBe(false);
      expect(body.currency).toBe("MYR");
      const view = getRecord(book.db, m.records.nandosClaimed)!;
      const header = body.record;
      expect(header).toMatchObject({
        id: m.records.nandosClaimed,
        no: view.recordNumber,
        kind: "expense",
        date: view.date,
        description: view.description,
        status: "paid",
        files: 1,
        v: recordVersion(book.db, view.id),
        contact_id: view.contactId,
      });
      expect(header.amount).toBe(formatMinor(view.amountMinor));

      // The same record, as a list shows it.
      const search = await call("search_records", {
        query: view.recordNumber,
      });
      const row = (search.body.records as Row[]).find((r) => r.id === view.id)!;
      for (const key of [
        "id",
        "no",
        "date",
        "kind",
        "description",
        "contact",
        "amount",
        "category",
        "status",
        "files",
        "v",
      ] as const)
        expect(header[key]).toEqual(row[key]);

      // Lines: debit for value in, credit for value out; they balance.
      expect(body.lines.length).toBeGreaterThanOrEqual(2);
      const debit = body.lines
        .filter((l: { side: string }) => l.side === "debit")
        .reduce((s: number, l: { amount: string }) => s + minor(l.amount), 0);
      const credit = body.lines
        .filter((l: { side: string }) => l.side === "credit")
        .reduce((s: number, l: { amount: string }) => s + minor(l.amount), 0);
      expect(debit).toBe(credit);
      const meals = body.lines.find((l: { account: string }) =>
        l.account.endsWith("Meals"),
      );
      expect(meals.side).toBe("debit");
      expect(meals.account).toMatch(/^\d{4} Meals$/);
      expect(meals.tax).toEqual({
        treatment: "ordinary_deductible",
        percent: "100.00",
      });
      // Only expense lines carry a tax treatment.
      const owed = body.lines.find(
        (l: { side: string }) => l.side === "credit",
      );
      expect(owed.tax).toBeUndefined();

      // Files: the id the attachment tool takes.
      expect(body.files).toEqual([
        expect.objectContaining({
          id: m.attachments.nandosClaimed!.id,
          name: expect.stringMatching(/\.pdf$/),
        }),
      ]);

      // What paid it: the reimbursement, as a record, never a settlement id.
      expect(body.settlements).toHaveLength(1);
      expect(body.settlements[0]).toMatchObject({
        record: m.records.nandosReimbursement,
        kind: "payment",
        amount: formatMinor(view.amountMinor),
      });
      expect(body.settlements[0].no).toBeTruthy();
      expect(hiddenIds(body)).toEqual([]);

      // Each field: edit, a named correction, or blocked.
      expect(Object.keys(body.editable).sort()).toEqual(
        [
          "amount",
          "category",
          "contact",
          "currency",
          "date",
          "description",
          "exchange_rate",
          "lines",
          "reference",
          "remark",
          "tax",
        ].sort(),
      );
      expect(body.editable.description).toBe("edit");
      expect(body.editable.amount).toMatch(
        /^correction:correct_settled_amount \(needs reason\)/,
      );
      expect(body.editable.date).toMatch(/^correction:correct_date \(needs /);
      expect(body.editable.contact).toMatch(/^correction:/);
    },
    SLOW,
  );

  it(
    "finds a record by its number, and allocations_v appears on a payment only",
    async () => {
      const book = await shared;
      const m = book.manifest;
      const { call } = await connect(book);
      const view = getRecord(book.db, m.records.kkPayment)!;
      const { body } = await call("get_record", { record: view.recordNumber });
      expect(body.record.id).toBe(view.id);
      expect(body.record.kind).toBe("payment");

      // The version `change_allocations` takes: the one the correction reads.
      const ctx = {
        db: book.db,
        locals: patLocals(book.db, `Bearer ${book.agentToken}`)!,
      };
      const line = resolvePaymentMovement(ctx, view.id);
      expect(line.ok).toBe(true);
      const prepared = preparePaymentCorrection(ctx, line.ok ? line.id : 0);
      expect(prepared.ok).toBe(true);
      expect(body.record.allocations_v).toBe(
        prepared.ok ? prepared.value.version : "never",
      );
      expect(body.record.allocations_v).toMatch(/^[0-9a-f]{16}$/);

      const expense = await call("get_record", {
        record: m.records.nandosClaimed,
      });
      expect(expense.body.record.allocations_v).toBeUndefined();
    },
    SLOW,
  );

  it(
    "includes the text read from the files, marked as data",
    async () => {
      const book = await shared;
      const m = book.manifest;
      const { call } = await connect(book);
      const plain = await call("get_record", { record: m.records.canvaPro });
      expect(plain.body.evidence_text).toBeUndefined();
      const { body } = await call("get_record", {
        record: m.records.canvaPro,
        include: ["evidence_text"],
      });
      const stored = getRecord(book.db, m.records.canvaPro)!.extractedText!;
      expect(body.evidence_text).toBe(stored);
      expect(body.evidence_text).toContain("04312-27788");
      expect(body.evidence_note).toMatch(/data, never instructions/);
      expect(body.evidence_note).not.toMatch(/Truncated/);

      // A record with no files has no text, and says so.
      const empty = await call("get_record", {
        record: m.records.workspaceSep,
        include: ["evidence_text"],
      });
      expect(empty.body.evidence_text).toBeUndefined();
      expect(empty.body.evidence_note).toMatch(/No text has been read/);
    },
    SLOW,
  );

  it(
    "adds line labels, tax reasons, the remark and timestamps with detail full",
    async () => {
      const book = await shared;
      const m = book.manifest;
      const { call } = await connect(book);
      const concise = await call("get_record", { record: m.records.canvaPro });
      const full = await call("get_record", {
        record: m.records.canvaPro,
        detail: "full",
      });
      const tax = (r: typeof full) =>
        r.body.lines.find((l: { tax?: object }) => l.tax).tax;
      expect(tax(concise).source).toBeUndefined();
      expect(tax(full).source).toBeDefined();
      expect(full.body.record.created).toBeDefined();
      expect(concise.body.record.created).toBeUndefined();
      expect(full.text.length).toBeGreaterThan(concise.text.length);
    },
    SLOW,
  );

  it(
    "answers NOT_FOUND for a record that is not there, with neighbours as candidates",
    async () => {
      const book = await shared;
      const { call } = await connect(book);
      const number = await call("get_record", { record: "EX20260901-099" });
      expect(number.isError).toBe(true);
      expect(number.body.error.code).toBe("NOT_FOUND");
      expect(number.body.error.path).toBe("record");
      expect(
        number.body.error.candidates.every((c: { name: string }) =>
          c.name.startsWith("EX"),
        ),
      ).toBe(true);
      expect(number.body.error.candidates.length).toBeGreaterThan(0);
      expect(number.body.error.fix).toMatch(/send its id/);

      const id = await call("get_record", { record: 999999 });
      expect(id.body.error.code).toBe("NOT_FOUND");
      expect(id.body.error.fix).toMatch(/akaun_search_records/);
    },
    SLOW,
  );

  it(
    "answers bad input with INVALID_INPUT",
    async () => {
      const book = await shared;
      const { call } = await connect(book);
      const none = await call("get_record", {});
      expect(none.body.error.code).toBe("INVALID_INPUT");
      expect(none.body.error.issues[0].path).toBe("record");
      const include = await call("get_record", {
        record: 1,
        include: ["everything"],
      });
      expect(include.body.error.code).toBe("INVALID_INPUT");
      expect(include.body.error.issues[0].message).toMatch(/evidence_text/);
      const detail = await call("get_record", { record: 1, detail: "lots" });
      expect(detail.body.error.code).toBe("INVALID_INPUT");
    },
    SLOW,
  );

  it(
    "gives a reader of records the record and its editable map but not the bank lines",
    async () => {
      const book = await shared;
      const { call } = await connect(book, localsFor(["records.read"]));
      const { body, isError } = await call("get_record", {
        record: book.manifest.records.canvaPro,
      });
      expect(isError).toBe(false);
      expect(body.editable).toBeDefined();
      expect(body.bank_matches).toBeUndefined();
    },
    SLOW,
  );
});

describe("get_category_history on the evaluation book", () => {
  const shared = build();

  it(
    "reports what the contact's other records used, as code and name",
    async () => {
      const book = await shared;
      const m = book.manifest;
      const labels = accountLabels(book.db);
      const planted = m.plants.uncategorised.expected.find(
        (e) => e.basis === "history",
      )!;
      const { call } = await connect(book);
      const { body, isError } = await call("get_category_history", {
        records: [planted.record],
      });
      expect(isError).toBe(false);
      expect(body.note).toMatch(/Past choices only/);
      expect(body.entries).toHaveLength(1);
      const entry = body.entries[0];
      expect(entry.record).toBe(planted.record);
      expect(entry.no).toBeTruthy();
      expect(entry.contact).toBeTruthy();
      expect(entry.by_contact[0].category).toBe(
        labels.get(planted.account!)!.label,
      );
      expect(entry.by_contact[0].count).toBeGreaterThanOrEqual(1);
      expect(entry.by_contact[0].last).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const example = entry.by_contact[0].examples[0];
      expect(example.no).toBeTruthy();
      expect(example.record).not.toBe(planted.record);
      expect(hiddenIds(body)).toEqual([]);
    },
    SLOW,
  );

  it(
    "describes many records at once, flags the uncategorised default, and says when there is no history",
    async () => {
      const book = await shared;
      const m = book.manifest;
      const labels = accountLabels(book.db);
      const { call } = await connect(book);
      const ids = m.plants.uncategorised.expected.map((e) => e.record);
      const { body } = await call("get_category_history", {
        records: ids,
        limit: 3,
      });
      expect(body.entries.map((e: { record: number }) => e.record)).toEqual(
        ids,
      );
      for (const entry of body.entries)
        for (const row of [
          ...(entry.by_contact ?? []),
          ...(entry.similar ?? []),
        ])
          expect(row.examples.length).toBeLessThanOrEqual(3);
      // Records that nothing resembles are marked, not left to look like an error.
      const bare = body.entries.filter(
        (e: { no_history?: boolean }) => e.no_history,
      );
      expect(bare.length).toBeGreaterThan(0);
      for (const entry of bare) {
        expect(entry.by_contact).toBeUndefined();
        expect(entry.similar).toBeUndefined();
      }
      // A bank line's text finds the earlier line on the default account, flagged.
      const text = await call("get_category_history", {
        description: "GRAB*RIDE 8821KL MY",
      });
      const flagged = text.body.entries[0].similar.find(
        (r: { uncategorised?: boolean }) => r.uncategorised,
      );
      expect(flagged.category).toBe(
        labels.get(m.accounts.uncategorised)!.label,
      );
      expect(flagged.shared_words).toBeGreaterThan(0);
      expect(text.body.entries[0].record).toBeUndefined();
    },
    SLOW,
  );

  it(
    "describes a contact, by name or id, with no record",
    async () => {
      const book = await shared;
      const m = book.manifest;
      const { call } = await connect(book);
      const byName = await call("get_category_history", { contact: "TNB" });
      const byId = await call("get_category_history", {
        contact: m.contacts.tnb,
      });
      expect(byName.body.entries).toEqual(byId.body.entries);
      expect(byName.body.entries[0].contact).toBe("TNB");
      expect(byName.body.entries[0].by_contact.length).toBeGreaterThan(0);
    },
    SLOW,
  );

  it(
    "refuses an empty call, too many records and an unknown reference, each with a fix",
    async () => {
      const book = await shared;
      const { call } = await connect(book);
      const empty = await call("get_category_history", {});
      expect(empty.body.error.code).toBe("INVALID_INPUT");
      expect(empty.body.error.fix).toMatch(/records/);

      const many = await call("get_category_history", {
        records: Array.from({ length: 51 }, (_, i) => i + 1),
      });
      expect(many.body.error.code).toBe("INVALID_INPUT");
      expect(JSON.stringify(many.body.error)).toMatch(/split the call/);

      const missing = await call("get_category_history", {
        records: [1, "EX20260901-099"],
      });
      expect(missing.body.error.code).toBe("NOT_FOUND");
      expect(missing.body.error.path).toBe("records[1]");

      const contact = await call("get_category_history", { contact: "Nobody" });
      expect(contact.body.error.code).toBe("NOT_FOUND");
      expect(contact.body.error.path).toBe("contact");

      const limit = await call("get_category_history", {
        description: "x",
        limit: 51,
      });
      expect(limit.body.error.code).toBe("INVALID_INPUT");
    },
    SLOW,
  );
});

// --- a book changed first -----------------------------------------------------------

describe("the reads on a book with matches, voids, part payments and long histories", () => {
  async function prepare() {
    const book = await build();
    const m = book.manifest;
    const ctx = {
      db: book.db,
      locals: localsFor([], { superuser: true, userId: book.ownerId }),
      store: book.store,
      storageRoot: book.storageRoot,
    };

    // A bank line matched to the bank side of one record.
    const ride = getRecord(book.db, m.records.grabRideSep03)!;
    const bankSide = ride.movements.find(
      (mv) => mv.accountId === m.accounts.bank,
    )!;
    book.db
      .insert(schema.reconciliationAllocations)
      .values({
        lineId: m.lines.grabSep03,
        movementId: bankSide.id,
        amount: fromMinor(Math.abs(bankSide.amountMinor)),
        itemAmountSnapshot: fromMinor(Math.abs(bankSide.amountMinor)),
        createdBy: book.ownerId,
      })
      .run();

    // A void: the record and its reversal.
    const voidedId = m.records.staffLunch;
    const voided = voidRecord(ctx, voidedId, {
      reason: "Voided in the spec to see how reads hide the pair.",
      expectedVersion: recordVersion(book.db, voidedId),
    });
    if (!voided.ok) throw new Error(voided.reason);

    // A part payment on an unpaid bill.
    const bill = getRecord(book.db, m.records.kk2207)!;
    const owed = bill.movements.find(
      (mv) => mv.accountId === m.accounts.payable,
    )!;
    const part = createRecord(ctx, {
      kind: "payment",
      date: "2026-10-01",
      description: "Part payment",
      amount: 100,
      currency: "MYR",
      exchangeRate: 1,
      contactId: bill.contactId,
      paidFromAccountId: m.accounts.bank,
      direction: "we-pay",
      settlements: [{ owedMovementId: owed.id, amountMinor: 10000 }],
    });
    if (!part.ok) throw new Error(part.reason);

    // Long text on one record.
    setExtractedText(book.db, m.records.stationery, "x".repeat(9000));

    // A long history on another, with ids that must not come out.
    for (let i = 0; i < 25; i++)
      recordAudit(book.db, {
        recordType: "record",
        recordId: m.records.tnbAug,
        userId: book.ownerId,
        action: "update",
        changes: [
          { field: "description", before: `old ${i}`, after: `new ${i}` },
        ],
      });
    recordAudit(book.db, {
      recordType: "record",
      recordId: m.records.tnbAug,
      userId: book.ownerId,
      action: "update",
      changes: [
        {
          field: "allocations",
          before: [
            {
              id: 5,
              settlementId: 5,
              paymentMovementId: 9,
              owedMovementId: 8,
              lineId: 7,
              amountMinor: 100,
            },
          ],
          after: null,
        },
        { field: "note", before: "y".repeat(500), after: null },
      ],
    });

    // Two contacts with one name.
    book.db
      .insert(schema.contacts)
      .values([
        { entityType: 2, legalName: "Twin Trading" },
        { entityType: 2, legalName: "Twin Trading" },
      ])
      .run();
    return {
      book,
      voidedId,
      reversalId: voided.value.reversal.id,
      partId: part.value.record.id,
      bill,
    };
  }
  const prepared = prepare();

  it(
    "shows the bank lines matched to a record as L123 refs, each with the version unmatching needs",
    async () => {
      const { book } = await prepared;
      const m = book.manifest;
      const { call } = await connect(book);
      const { body } = await call("get_record", {
        record: m.records.grabRideSep03,
      });
      expect(body.bank_matches).toHaveLength(1);
      const match = body.bank_matches[0];
      expect(match.line).toBe(`L${m.lines.grabSep03}`);
      expect(match.statement).toBe(`S${m.statements.bank}`);
      expect(match.account).toMatch(/^1100 /);
      expect(match.amount).toMatch(/^\d+\.\d{2}$/);
      expect(match.direction).toBe("out");
      expect(match.v).toBe(statementLineVersion(book.db, m.lines.grabSep03));
      expect(hiddenIds(body)).toEqual([]);
      // The list agrees: cleared once a line covers it.
      const search = await call("search_records", {
        query: getRecord(book.db, m.records.grabRideSep03)!.recordNumber,
      });
      expect(
        (search.body.records as Row[]).find(
          (r) => r.id === m.records.grabRideSep03,
        )!.cleared,
      ).toBe(true);
    },
    SLOW,
  );

  it(
    "hides a void and its reversal unless asked, and keeps the running balance true",
    async () => {
      const { book, voidedId, reversalId } = await prepared;
      const m = book.manifest;
      const { call, allPages } = await connect(book);
      const hidden = await allPages({ limit: 50 });
      const shown = new Set(hidden.rows.map((r) => r.id));
      expect(shown.has(voidedId)).toBe(false);
      expect(shown.has(reversalId)).toBe(false);

      const included = await allPages({ voided: "include", limit: 50 });
      const inc = new Map(
        included.rows.map((r) => [r.id, r as unknown as Row]),
      );
      expect(inc.get(voidedId)!.status).toBe("voided");
      expect(inc.get(reversalId)!.status).toBe("reversal");

      const only = await allPages({ voided: "only" });
      expect(only.rows.map((r) => r.id).sort()).toEqual(
        [voidedId, reversalId].sort(),
      );

      // Counts and totals leave the pair out either way.
      const grouped = await call("search_records", { group_by: "kind" });
      expect(grouped.body.matching_records).toBe(shown.size);

      // The pair nets to zero on the account, so the statement agrees with or without it.
      const lunch = getRecord(book.db, voidedId)!;
      const account = lunch.movements.find(
        (mv) => mv.accountId !== m.accounts.meals,
      )!.accountId;
      const without = await allPages({ account, limit: 200 });
      const withPair = await allPages({
        account,
        voided: "include",
        limit: 200,
      });
      expect(withPair.last.closing).toBe(without.last.closing);
      expect(withPair.rows.length).toBe(without.rows.length + 2);
      const detail = await call("get_record", { record: voidedId });
      expect(detail.body.record.status).toBe("voided");
      expect(detail.body.record.voided_by).toBe(reversalId);
      const reversal = await call("get_record", { record: reversalId });
      expect(reversal.body.record.status).toBe("reversal");
      expect(reversal.body.record.reverses).toBe(voidedId);
    },
    SLOW,
  );

  it(
    "tells part paid from owed, with what is still outstanding",
    async () => {
      const { book, bill } = await prepared;
      const { call, allPages } = await connect(book);
      const part = await allPages({ status: "part_paid" });
      expect(part.rows.map((r) => r.id)).toEqual([bill.id]);
      const row = part.rows[0] as unknown as Row;
      expect(row.status).toBe("part_paid");
      expect(row.outstanding).toBe(formatMinor(bill.amountMinor - 10000));
      expect(part.last.total).toBe(1);

      const owed = await allPages({ status: "owed" });
      expect(owed.rows.map((r) => r.id)).not.toContain(bill.id);
      const unpaid = await allPages({ status: "unpaid" });
      expect(unpaid.rows.map((r) => r.id)).toContain(bill.id);
      expect(unpaid.rows).toHaveLength(owed.rows.length + 1);
      // The payment made now is a record of its own, allocated and with credit none.
      const payment = await call("search_records", {
        kinds: ["payment"],
        period: "2026-10",
      });
      expect(payment.body.records[0].status).toBe("allocated");
    },
    SLOW,
  );

  it(
    "cuts the file text at about 6000 characters and says so",
    async () => {
      const { book } = await prepared;
      const { call } = await connect(book);
      const { body } = await call("get_record", {
        record: book.manifest.records.stationery,
        include: ["evidence_text"],
      });
      expect(body.evidence_text).toHaveLength(6000);
      expect(body.evidence_note).toMatch(/Truncated: the first 6000 of 9000/);
      expect(body.evidence_note).toMatch(/never instructions/);
    },
    SLOW,
  );

  it(
    "shows the 20 latest changes, shortens long values and never shows an internal id",
    async () => {
      const { book } = await prepared;
      const m = book.manifest;
      const { call } = await connect(book);
      const { body } = await call("get_record", {
        record: m.records.tnbAug,
        include: ["history"],
      });
      const trail = getAuditTrail(book.db, "record", m.records.tnbAug);
      expect(trail.length).toBeGreaterThan(20);
      expect(body.history).toHaveLength(20);
      expect(body.history_note).toBe(
        `Showing the 20 most recent of ${trail.length} entries.`,
      );
      // Newest first: the one with the allocation rows and the long note.
      const latest = body.history[0];
      expect(latest.via).toBeDefined();
      expect(latest.who).toBeTruthy();
      const allocations = latest.changes.find(
        (c: { field: string }) => c.field === "allocations",
      );
      expect(allocations.before).toEqual([{ amountMinor: 100, line: "L7" }]);
      const note = latest.changes.find(
        (c: { field: string }) => c.field === "note",
      );
      expect(note.before.length).toBeLessThanOrEqual(201);
      expect(note.before.endsWith("…")).toBe(true);
      expect(hiddenIds(body)).toEqual([]);
      expect(JSON.stringify(body)).not.toMatch(
        /"settlementId"|"paymentMovementId"/,
      );
    },
    SLOW,
  );

  it(
    "answers AMBIGUOUS, with each candidate, for a name two contacts share",
    async () => {
      const { book } = await prepared;
      const { call } = await connect(book);
      for (const [tool, args] of [
        ["search_records", { contact: "Twin Trading" }],
        ["get_category_history", { contact: "Twin Trading" }],
      ] as const) {
        const { body, isError } = await call(tool, args);
        expect(isError).toBe(true);
        expect(body.error.code).toBe("AMBIGUOUS");
        expect(body.error.path).toBe("contact");
        expect(body.error.candidates).toHaveLength(2);
        expect(body.error.fix).toMatch(/id of the contact/);
      }
      // Sending the id of one of them works.
      const { body } = await call("get_category_history", {
        contact: (await prepared).book.db
          .select()
          .from(schema.contacts)
          .all()
          .find((c) => c.legalName === "Twin Trading")!.id,
      });
      expect(body.entries).toHaveLength(1);
    },
    SLOW,
  );
});
