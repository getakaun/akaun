import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { AccountType } from "$lib/enums.js";
import { localToday } from "$lib/local-date.js";
import * as schema from "../../../db/schema.js";
import { accountTaxOverview } from "../../../application/account-tax-classification.js";
import { accountVersion } from "../../../application/version.js";
import { formatMinor } from "../../../ledger/money.js";
import { localsFor } from "../../../permissions/test-locals.js";
import { listAccounts } from "../../../queries/accounts.js";
import { createAccount } from "../../../services/accounts.js";
import { patLocals } from "../../../tokens/pat.js";
import { buildEvalBook, type EvalBook } from "../../__fixtures__/eval-book.js";
import { createServerV2 } from "../../registry.js";
import { accountKindOf, accountLabels, accountsReadTools } from "./accounts.js";

/**
 * `akaun_list_accounts` through a real MCP client over `InMemoryTransport`,
 * against the evaluation book (a file database under `os.tmpdir()`; never
 * `db/client.ts`).
 */

const SLOW = 60_000;
const folders: string[] = [];
const books: EvalBook[] = [];
afterAll(() => {
  for (const book of books) book.raw.close();
  for (const folder of folders)
    rmSync(folder, { recursive: true, force: true });
});

async function build(): Promise<EvalBook> {
  const dir = mkdtempSync(join(tmpdir(), "akaun-d1-accounts-"));
  folders.push(dir);
  const book = await buildEvalBook({
    dir,
    variant: "A",
    today: localToday(),
  });
  books.push(book);
  return book;
}

async function connect(book: EvalBook, locals?: App.Locals) {
  const server = createServerV2({
    db: book.db,
    store: book.store,
    storageRoot: book.storageRoot,
    locals: locals ?? patLocals(book.db, `Bearer ${book.agentToken}`)!,
    tools: { reads: accountsReadTools, writes: [] },
  });
  const client = new Client({ name: "d1-accounts-spec", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (args: Record<string, unknown> = {}) => {
    const result = await client.callTool({
      name: "akaun_list_accounts",
      arguments: args,
    });
    const text = (result.content as { type: string; text: string }[])[0].text;
    return { isError: result.isError === true, text, body: JSON.parse(text) };
  };
  return { client, call };
}

type Row = {
  id: number;
  account: string;
  type: string;
  sub_type?: string;
  balance: string;
  archived?: boolean;
  tax_default?: { treatment: string; percent?: string };
  unclassified_fillable?: number;
  v: string;
};

describe("list_accounts on the evaluation book", () => {
  const shared = build();

  it(
    "lists every account as code and name with type, balance and version",
    async () => {
      const book = await shared;
      const { call } = await connect(book);
      const { isError, body, text } = await call();
      expect(isError).toBe(false);
      expect(body.currency).toBe("MYR");
      const views = listAccounts(book.db);
      const rows = body.accounts as Row[];
      expect(rows.map((r) => r.id).sort()).toEqual(
        views.map((v) => v.id).sort(),
      );
      const labels = accountLabels(book.db);
      for (const row of rows) {
        const view = views.find((v) => v.id === row.id)!;
        expect(row.account).toBe(labels.get(row.id)!.label);
        expect(row.account).toMatch(/^\d{4} \S/);
        expect(row.balance).toBe(formatMinor(view.balanceMinor));
        expect(row.v).toBe(accountVersion(book.db, row.id));
        expect(row.v).toMatch(/^[0-9a-f]{16}$/);
        expect([
          "asset",
          "liability",
          "equity",
          "revenue",
          "expense",
        ]).toContain(row.type);
      }
      const bank = rows.find((r) => r.id === book.manifest.accounts.bank)!;
      expect(bank).toMatchObject({ type: "asset", sub_type: "bank" });
      // Credit balances are negative: money owed, equity and income.
      const payable = rows.find(
        (r) => r.id === book.manifest.accounts.payable,
      )!;
      expect(Number(payable.balance)).toBeLessThanOrEqual(0);
      // Compact and free of internal ids.
      expect(text).not.toMatch(/movement|settlement/i);
    },
    SLOW,
  );

  it(
    "splits the chart into money, category, owed and equity, with nothing in two groups or none",
    async () => {
      const book = await shared;
      const m = book.manifest;
      const { call } = await connect(book);
      const all = ((await call()).body.accounts as Row[]).map((r) => r.id);
      const kinds = new Map<string, number[]>();
      for (const kind of ["money", "category", "owed", "equity"]) {
        const { body, isError } = await call({ kind });
        expect(isError).toBe(false);
        kinds.set(
          kind,
          (body.accounts as Row[]).map((r) => r.id),
        );
      }
      const union = [...kinds.values()].flat();
      expect(new Set(union).size).toBe(union.length);
      expect([...union].sort()).toEqual([...all].sort());

      expect(kinds.get("money")).toEqual(
        expect.arrayContaining([
          m.accounts.bank,
          m.accounts.cash,
          m.accounts.card,
        ]),
      );
      expect(kinds.get("money")).not.toContain(m.accounts.receivable);
      expect(kinds.get("category")).toEqual(
        expect.arrayContaining([
          m.accounts.travel,
          m.accounts.sales,
          m.accounts.interestIncome,
          // Equipment is bought and kept, but chosen as a category.
          m.accounts.equipment,
        ]),
      );
      expect(kinds.get("owed")).toEqual(
        expect.arrayContaining([m.accounts.receivable, m.accounts.payable]),
      );
      expect(kinds.get("equity")).toEqual([
        m.accounts.openingBalances,
        expect.any(Number),
      ]);
      // The grouping is the one `accountKindOf` makes.
      for (const view of listAccounts(book.db))
        expect([...kinds].find(([, ids]) => ids.includes(view.id))![0]).toBe(
          accountKindOf(view),
        );
    },
    SLOW,
  );

  it(
    "finds accounts by code or part of a name",
    async () => {
      const book = await shared;
      const m = book.manifest;
      const { call } = await connect(book);
      const labels = accountLabels(book.db);
      const advertising = labels.get(m.accounts.advertising)!;
      const byName = await call({ query: "advert" });
      expect(byName.body.accounts.map((r: Row) => r.id)).toEqual([
        m.accounts.advertising,
      ]);
      const byCode = await call({ query: String(advertising.code) });
      expect(byCode.body.accounts.map((r: Row) => r.id)).toEqual([
        m.accounts.advertising,
      ]);
      const none = await call({ query: "zzzz" });
      expect(none.isError).toBe(false);
      expect(none.body.accounts).toBeUndefined();
      expect(none.body.note).toBe("No account matches.");
      // Together with a kind.
      const both = await call({ query: "5", kind: "equity" });
      expect(both.body.accounts).toBeUndefined();
    },
    SLOW,
  );

  it(
    "shows the tax default of expense accounts and how many entries it could fill",
    async () => {
      const book = await shared;
      const m = book.manifest;
      const agent = patLocals(book.db, `Bearer ${book.agentToken}`)!;
      const { call } = await connect(book, agent);
      const rows = (await call()).body.accounts as Row[];
      const views = listAccounts(book.db);

      // Only expense accounts have a tax default, and it is as saved.
      for (const row of rows) {
        const view = views.find((v) => v.id === row.id)!;
        if (view.type !== AccountType.Expense) {
          expect(row.tax_default).toBeUndefined();
          expect(row.unclassified_fillable).toBeUndefined();
        }
      }
      const travel = rows.find((r) => r.id === m.accounts.travel)!;
      expect(travel.tax_default).toEqual({
        treatment: "ordinary_deductible",
        percent: "100.00",
      });

      // The count is `accountTaxOverview`'s, shown only above zero.
      const unclassified = rows.find(
        (r) => r.id === m.plants.tax.unclassifiedAccount,
      )!;
      expect(unclassified.tax_default).toBeUndefined();
      const ctx = { db: book.db, locals: agent };
      const overview = accountTaxOverview(ctx, unclassified.id);
      expect(overview.ok && overview.value.eligibleCount).toBeGreaterThan(0);
      expect(unclassified.unclassified_fillable).toBe(
        overview.ok ? overview.value.eligibleCount : -1,
      );
      for (const view of views.filter((v) => v.type === AccountType.Expense)) {
        const counted = accountTaxOverview(ctx, view.id);
        const expected =
          counted.ok && counted.value.eligibleCount > 0
            ? counted.value.eligibleCount
            : undefined;
        expect(rows.find((r) => r.id === view.id)!.unclassified_fillable).toBe(
          expected,
        );
      }
    },
    SLOW,
  );

  it(
    "leaves the fillable count out for a caller who may not apply tax defaults",
    async () => {
      const book = await shared;
      const m = book.manifest;
      const { call } = await connect(book, localsFor(["accounts.read"]));
      const { body } = await call();
      const rows = body.accounts as Row[];
      expect(rows.length).toBeGreaterThan(10);
      expect(rows.every((r) => r.unclassified_fillable === undefined)).toBe(
        true,
      );
      // The default itself is still shown.
      expect(rows.find((r) => r.id === m.accounts.travel)!.tax_default).toEqual(
        {
          treatment: "ordinary_deductible",
          percent: "100.00",
        },
      );
    },
    SLOW,
  );

  it(
    "answers bad input with INVALID_INPUT, located and with the allowed values",
    async () => {
      const book = await shared;
      const { call } = await connect(book);
      const kind = await call({ kind: "cash" });
      expect(kind.isError).toBe(true);
      expect(kind.body.error.code).toBe("INVALID_INPUT");
      expect(kind.body.error.issues[0].path).toBe("kind");
      expect(kind.body.error.issues[0].message).toMatch(
        /Use one of: money, category, owed, equity/,
      );
      const field = await call({ type: "asset" });
      expect(field.body.error.issues[0].message).toMatch(
        /Unknown field "type"/,
      );
      const archived = await call({ include_archived: "yes" });
      expect(archived.body.error.code).toBe("INVALID_INPUT");
      expect(archived.body.error.fix).toMatch(/Nothing was done/);
    },
    SLOW,
  );

  it(
    "is not listed to a caller who cannot read accounts",
    async () => {
      const book = await shared;
      const { client } = await connect(book, localsFor(["records.read"]));
      expect((await client.listTools()).tools).toEqual([]);
    },
    SLOW,
  );
});

describe("list_accounts on a book changed first", () => {
  async function prepare() {
    const book = await build();
    const m = book.manifest;
    // An archived account, and a default of half.
    book.db
      .update(schema.accounts)
      .set({ archivedAt: "2026-10-01T00:00:00.000Z" })
      .where(eq(schema.accounts.id, m.accounts.packaging))
      .run();
    book.db
      .update(schema.accounts)
      .set({ defaultTaxPercentageBps: 5000, defaultTaxTreatment: "partial" })
      .where(eq(schema.accounts.id, m.accounts.meals))
      .run();
    // A chart too long for one answer.
    for (let i = 0; i < 700; i++) {
      const made = createAccount(book.db, book.ownerId, {
        name: `Generated expense category number ${i} with a long descriptive name`,
        type: AccountType.Expense,
      });
      if (!made.ok) throw new Error(made.reason);
    }
    return book;
  }
  const prepared = prepare();

  it(
    "hides an archived account unless asked, and marks it",
    async () => {
      const book = await prepared;
      const id = book.manifest.accounts.packaging;
      const { call } = await connect(book);
      const hidden = await call({ kind: "category", query: "Packaging" });
      expect(hidden.body.accounts).toBeUndefined();
      const shown = await call({
        kind: "category",
        query: "Packaging",
        include_archived: true,
      });
      expect(shown.body.accounts).toHaveLength(1);
      expect(shown.body.accounts[0]).toMatchObject({ id, archived: true });
    },
    SLOW,
  );

  it(
    "shows a partial default with its percent",
    async () => {
      const book = await prepared;
      const { call } = await connect(book);
      const { body } = await call({ query: "Meals" });
      const meals = (body.accounts as Row[]).find(
        (r) => r.id === book.manifest.accounts.meals,
      )!;
      expect(meals.tax_default).toEqual({
        treatment: "partial",
        percent: "50.00",
      });
    },
    SLOW,
  );

  it(
    "cuts a long chart to the response budget and says how to see the rest",
    async () => {
      const book = await prepared;
      const { call } = await connect(book);
      const { body, text } = await call();
      expect(text.length).toBeLessThanOrEqual(48 * 1024);
      expect(body.accounts.length).toBeLessThan(700);
      expect(body.count).toBeGreaterThanOrEqual(700);
      expect(body.note).toMatch(/Narrow with kind or query/);
      // Narrowing gets there.
      const narrowed = await call({ query: "number 699 " });
      expect(narrowed.body.accounts).toHaveLength(1);
    },
    SLOW,
  );
});
