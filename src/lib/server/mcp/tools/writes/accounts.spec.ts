import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { DefaultAccountPurpose } from "$lib/enums.js";
import {
  BOOKKEEPER_PERMISSIONS,
  buildEvalBook,
  type EvalBook,
} from "../../__fixtures__/eval-book.js";
import { createServerV2 } from "../../registry.js";
import { patLocals } from "../../../tokens/pat.js";
import { issueTestToken, localsFor } from "../../../permissions/test-locals.js";
import type { AppContext } from "../../../application/context.js";
import {
  accountDefaultVersion,
  openingBalanceVersion,
} from "../../../application/accounts.js";
import { createRecord, updateRecord } from "../../../application/records.js";
import { accountVersion } from "../../../application/version.js";
import { createAccount } from "../../../services/accounts.js";
import { accountDefaultId } from "../../../services/account-defaults.js";
import { openingBalanceFor } from "../../../queries/accounts.js";
import { accountsWriteTools } from "./accounts.js";

// Each test builds its own evaluation book in a folder under os.tmpdir() and
// drives the tool in-process over InMemoryTransport; nothing here imports
// db/client.ts. Also run with the MCP preload to prove it:
//   bun test --preload ./scripts/mcp-test-preload.ts src/lib/server/mcp/tools/writes/accounts.spec.ts

const TODAY = "2026-11-13";
const SLOW = 60_000;

// Replies are JSON read loosely in assertions.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;
type Reply = { isError: boolean; body: Loose; text: string };

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function open(permissions?: readonly string[]) {
  const dir = mkdtempSync(join(tmpdir(), "akaun-e3-accounts-"));
  const book = await buildEvalBook({ dir, variant: "A", today: TODAY });
  const token = permissions
    ? issueTestToken(book.db, book.agentUserId, [...permissions])
    : book.agentToken;
  const server = createServerV2({
    db: book.db,
    store: book.store,
    storageRoot: book.storageRoot,
    locals: patLocals(book.db, `Bearer ${token}`)!,
    tools: { reads: [], writes: accountsWriteTools },
  });
  const client = new Client({ name: "e3-accounts-spec", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(async () => {
    await client.close();
    await server.close();
    book.raw.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const call = async (args: Record<string, unknown>): Promise<Reply> => {
    const result = await client.callTool({
      name: "akaun_change_accounts",
      arguments: args,
    });
    const text = (result.content as { type: string; text: string }[])[0].text;
    return { isError: result.isError === true, body: JSON.parse(text), text };
  };
  const owner: AppContext = {
    db: book.db,
    locals: localsFor([], { superuser: true, userId: book.ownerId }),
  };
  return { book, client, call, owner };
}

const count = (book: EvalBook, table: string) =>
  (book.raw.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number })
    .n;

type MovementTax = { id: number; account_id: number; tax: string | null };
/** Every movement's saved tax classification: what a default must not rewrite. */
function taxSnapshot(book: EvalBook): MovementTax[] {
  return book.raw
    .query(
      "SELECT id, account_id, tax_classification AS tax FROM ledger_movements ORDER BY id",
    )
    .all() as MovementTax[];
}

function changedIds(before: MovementTax[], after: MovementTax[]) {
  const was = new Map(before.map((row) => [row.id, row.tax]));
  return after.filter((row) => was.get(row.id) !== row.tax).map((r) => r.id);
}

/** The movements on an account, with their amounts, oldest record first. */
function linesOn(book: EvalBook, accountId: number) {
  return book.raw
    .query(
      `SELECT m.id AS id, m.record_id AS recordId, m.amount_minor AS amountMinor, m.tax_classification AS tax
       FROM ledger_movements m JOIN ledger_records r ON r.id = m.record_id
       WHERE m.account_id = ? ORDER BY r.date, r.id, m.sort_order, m.id`,
    )
    .all(accountId) as {
    id: number;
    recordId: number;
    amountMinor: number;
    tax: string | null;
  }[];
}

const tax = (json: string | null) =>
  json ? (JSON.parse(json) as Record<string, unknown>) : null;

const REVISION = /^[a-f0-9]{64}$/;
const REASON = "Apply the reviewed policy to untouched membership entries";

describe("change_accounts", () => {
  it(
    "lists the tool as destructive; its description says a default reaches only new lines",
    async () => {
      const { book, client } = await open();
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === "akaun_change_accounts")!;
      expect(tool).toBeTruthy();
      expect(tool.annotations?.destructiveHint).toBe(true);
      expect(tool.description!.length).toBeLessThanOrEqual(1500);
      for (const noun of book.manifest.nouns)
        expect(tool.description!.toLowerCase()).not.toContain(
          noun.toLowerCase(),
        );
      expect(tool.description).toMatch(/sets only what NEW lines/);
      expect(tool.description).toMatch(/saved entries do not change/);
      expect(tool.description).toMatch(/dry_run: true/);
    },
    SLOW,
  );

  it(
    "creates, updates and deletes an account, each checked against its version",
    async () => {
      const { book, call } = await open();
      const before = count(book, "accounts");

      const dry = await call({
        create: [
          {
            name: "Staff Training",
            type: "expense",
            sub_type: "operating_expense",
            tax_default: { treatment: "partial", percent: "50" },
          },
        ],
        dry_run: true,
      });
      expect(dry.isError).toBe(false);
      expect(dry.body).toMatchObject({ saved: false, dry_run: true });
      expect(count(book, "accounts")).toBe(before);

      const created = await call({
        create: [
          {
            name: "Staff Training",
            type: "expense",
            sub_type: "operating_expense",
            tax_default: { treatment: "partial", percent: "50" },
          },
        ],
      });
      expect(created.isError).toBe(false);
      expect(created.body.saved).toBe(true);
      expect(created.body.request_id).toBeTruthy();
      const made = created.body.items[0];
      expect(made).toMatchObject({
        n: 1,
        action: "create",
        type: "expense",
        sub_type: "operating_expense",
        tax_default: { treatment: "partial", percent: "50.00" },
      });
      expect(made.account).toMatch(/^\d+ Staff Training$/);
      expect(made.v).toBe(accountVersion(book.db, made.id));
      expect(count(book, "accounts")).toBe(before + 1);
      expect(
        book.raw
          .query(
            "SELECT default_tax_percentage_bps AS bps, default_tax_treatment AS t FROM accounts WHERE id = ?",
          )
          .get(made.id),
      ).toEqual({ bps: 5000, t: "partial" });

      const updated = await call({
        update: [
          {
            account: made.id,
            expected_version: made.v,
            set: { name: "Training & Courses", archived: true },
          },
        ],
      });
      expect(updated.isError).toBe(false);
      const item = updated.body.items[0];
      expect(item.account).toMatch(/^\d+ Training & Courses$/);
      expect(item.changes.name).toEqual({
        from: "Staff Training",
        to: "Training & Courses",
      });
      expect(item.changes.archived).toEqual({ from: false, to: true });
      expect(item.changes.tax_default).toBeUndefined();
      expect(item.v).toBe(accountVersion(book.db, made.id));

      // The old version is stale now, and the answer carries the current one.
      const stale = await call({
        update: [
          {
            account: made.id,
            expected_version: made.v,
            set: { archived: false },
          },
        ],
      });
      expect(stale.isError).toBe(true);
      expect(stale.body.error.items[0].error).toMatchObject({
        code: "CONFLICT",
        current_version: item.v,
      });

      const gone = await call({
        delete: [{ account: made.id, expected_version: item.v }],
      });
      expect(gone.isError).toBe(false);
      expect(gone.body.items[0]).toMatchObject({
        action: "delete",
        id: made.id,
      });
      expect(count(book, "accounts")).toBe(before);
    },
    SLOW,
  );

  it(
    "refuses to delete an account that has movements, with the app's sentence",
    async () => {
      const { book, call } = await open();
      const id = book.manifest.accounts.receivable;
      const reply = await call({
        delete: [
          { account: id, expected_version: accountVersion(book.db, id) },
        ],
      });
      expect(reply.isError).toBe(true);
      expect(reply.body.error.code).toBe("REFUSED");
      expect(reply.body.error.items[0].error.message).toMatch(
        /has movements and must be deactivated instead/,
      );
    },
    SLOW,
  );

  it(
    "answers bad input with INVALID_INPUT, and unknown accounts with NOT_FOUND or AMBIGUOUS",
    async () => {
      const { book, call, owner } = await open();
      const m = book.manifest;
      const v = accountVersion(book.db, m.accounts.advertising);

      const badType = await call({
        create: [{ name: "X", type: "income" }],
      });
      expect(badType.body.error.code).toBe("INVALID_INPUT");
      expect(badType.body.error.issues[0].path).toBe("create[0].type");

      const noType = await call({
        update: [
          {
            account: m.accounts.advertising,
            expected_version: v,
            set: { type: "asset" },
          },
        ],
      });
      expect(noType.body.error.code).toBe("INVALID_INPUT");
      expect(noType.body.error.issues[0].message).toMatch(/Unknown field/);

      const badPurpose = await call({
        set_default: [{ purpose: "bank", account: m.accounts.bank }],
      });
      expect(badPurpose.body.error.code).toBe("INVALID_INPUT");
      expect(badPurpose.body.error.issues[0].path).toBe(
        "set_default[0].purpose",
      );
      expect(badPurpose.body.error.issues[0].message).toMatch(
        /uncategorised_expense/,
      );

      const noPartial = await call({
        update: [
          {
            account: m.accounts.advertising,
            expected_version: v,
            set: { tax_default: { treatment: "partial" } },
          },
        ],
      });
      expect(noPartial.body.error.code).toBe("INVALID_INPUT");
      expect(noPartial.text).toMatch(/needs its percent/);

      const sillyPercent = await call({
        update: [
          {
            account: m.accounts.advertising,
            expected_version: v,
            set: {
              tax_default: { treatment: "ordinary_deductible", percent: "40" },
            },
          },
        ],
      });
      expect(sillyPercent.body.error.code).toBe("INVALID_INPUT");
      expect(sillyPercent.text).toMatch(/only with partial/);

      const empty = await call({
        update: [
          { account: m.accounts.advertising, expected_version: v, set: {} },
        ],
      });
      expect(empty.body.error.code).toBe("INVALID_INPUT");
      expect(empty.text).toMatch(/Nothing to change/);

      const nothing = await call({});
      expect(nothing.body.error.code).toBe("INVALID_INPUT");
      expect(nothing.body.error.fix).toMatch(
        /set_default or apply_tax_default/,
      );

      // A near name is only ever a candidate.
      const near = await call({
        delete: [{ account: "Advertisin", expected_version: v }],
      });
      expect(near.isError).toBe(true);
      expect(near.body.error.code).toBe("NOT_FOUND");
      expect(near.body.error.path).toBe("delete[0].account");
      expect(near.body.error.candidates[0].name).toBe("5100 Advertising");

      // Two accounts of one name: AMBIGUOUS, and every miss in the call is told.
      for (const code of [5710, 5711])
        expect(
          createAccount(book.db, book.ownerId, {
            name: "Twin",
            type: 5,
            code,
          }).ok,
        ).toBe(true);
      void owner;
      const twin = await call({
        update: [
          { account: "Twin", expected_version: v, set: { name: "Other" } },
          { account: 999_999, expected_version: v, set: { name: "Other" } },
        ],
      });
      expect(twin.isError).toBe(true);
      expect(twin.body.error.errors).toHaveLength(2);
      expect(twin.body.error.errors[0].code).toBe("AMBIGUOUS");
      expect(twin.body.error.errors[0].candidates).toHaveLength(2);
      expect(twin.body.error.errors[1].code).toBe("NOT_FOUND");
    },
    SLOW,
  );

  it(
    "changing a tax default writes only the account: no saved line changes",
    async () => {
      const { book, call } = await open();
      const m = book.manifest;
      const id = m.accounts.memberships;
      const lines = linesOn(book, id);
      expect(lines).toHaveLength(3);
      expect(lines.every((l) => tax(l.tax)?.treatment === "unclassified")).toBe(
        true,
      );
      const before = taxSnapshot(book);
      const movements = count(book, "ledger_movements");

      const reply = await call({
        update: [
          {
            account: id,
            expected_version: accountVersion(book.db, id),
            set: { tax_default: { treatment: "ordinary_deductible" } },
          },
        ],
      });
      expect(reply.isError).toBe(false);
      const item = reply.body.items[0];
      expect(item.changes.tax_default.to).toEqual({
        treatment: "ordinary_deductible",
        percent: "100.00",
      });
      expect(item.note).toMatch(/Only new lines/);
      expect(item.note).toMatch(/Saved entries are unchanged/);
      // The three unclassified entries are named, not filled.
      expect(item.unclassified_fillable).toBe(3);
      expect(item.note).toMatch(/apply_tax_default/);

      // The default is saved, the saved lines are byte for byte as they were.
      expect(
        book.raw
          .query(
            "SELECT default_tax_treatment AS t, default_tax_percentage_bps AS bps FROM accounts WHERE id = ?",
          )
          .get(id),
      ).toEqual({ t: "ordinary_deductible", bps: 10_000 });
      expect(taxSnapshot(book)).toEqual(before);
      expect(count(book, "ledger_movements")).toBe(movements);

      // Switching it to another treatment leaves them alone too.
      const partial = await call({
        update: [
          {
            account: id,
            expected_version: item.v,
            set: { tax_default: { treatment: "partial", percent: "33.33" } },
          },
        ],
      });
      expect(partial.isError).toBe(false);
      expect(partial.body.items[0].changes.tax_default.to).toEqual({
        treatment: "partial",
        percent: "33.33",
      });
      expect(taxSnapshot(book)).toEqual(before);

      // A default on an account that is not an expense account is refused.
      const income = await call({
        update: [
          {
            account: m.accounts.sales,
            expected_version: accountVersion(book.db, m.accounts.sales),
            set: { tax_default: { treatment: "non_deductible" } },
          },
        ],
      });
      expect(income.isError).toBe(true);
      expect(income.body.error.items[0].error.message).toMatch(
        /only to Expense accounts/,
      );
    },
    SLOW,
  );

  it(
    "applies a default to unclassified entries only with a dry run's revision, and only fills what the app would",
    async () => {
      const { book, call, owner } = await open();
      const m = book.manifest;
      const id = m.accounts.memberships;
      const [first, second, third] = linesOn(book, id);

      // No resolved default yet: even the preview says so.
      const early = await call({
        apply_tax_default: [{ account: id, reason: REASON }],
        dry_run: true,
      });
      expect(early.isError).toBe(true);
      expect(early.body.error.items[0].error.message).toMatch(
        /Save a resolved account default/,
      );

      const saved = await call({
        update: [
          {
            account: id,
            expected_version: accountVersion(book.db, id),
            set: { tax_default: { treatment: "ordinary_deductible" } },
          },
        ],
      });
      expect(saved.isError).toBe(false);

      // Two entries already have decisions of their own: one resolved, one
      // deliberately left for review. The default must keep out of both.
      expect(
        updateRecord(owner, second.recordId, {
          taxOverrides: [
            {
              accountId: id,
              occurrence: 0,
              treatment: "non_deductible",
              percentageBps: 0,
              reason: "A personal subscription, checked against the receipt",
            },
          ],
        }).ok,
      ).toBe(true);
      expect(
        updateRecord(owner, third.recordId, {
          taxOverrides: [
            {
              accountId: id,
              occurrence: 0,
              treatment: "requires_review",
              percentageBps: null,
              reason: "Waiting for the accountant to say",
            },
          ],
        }).ok,
      ).toBe(true);
      const decided = taxSnapshot(book);

      // Writing without a revision is refused, with the way to get one.
      const noRevision = await call({
        apply_tax_default: [{ account: id, reason: REASON }],
      });
      expect(noRevision.isError).toBe(true);
      expect(noRevision.body.error.code).toBe("INVALID_INPUT");
      expect(noRevision.body.error.path).toBe("apply_tax_default[0].revision");
      expect(noRevision.body.error.fix).toMatch(/dry_run: true/);
      expect(taxSnapshot(book)).toEqual(decided);

      // A dry run previews, returns the revision, and saves nothing.
      const dry = await call({
        apply_tax_default: [{ account: id, reason: REASON }],
        dry_run: true,
      });
      expect(dry.isError).toBe(false);
      expect(dry.body).toMatchObject({ saved: false, dry_run: true });
      const preview = dry.body.items[0];
      expect(preview).toMatchObject({
        action: "apply_tax_default",
        currency: "MYR",
        default: { treatment: "ordinary_deductible", percent: "100.00" },
        eligible: 1,
        protected: { already_classified: 1, individual_decisions: 1 },
        remaining: 0,
      });
      expect(preview.revision).toMatch(REVISION);
      expect(preview.this_call.lines).toBe(1);
      expect(preview.this_call.records).toBe(1);
      const amounts = first.amountMinor;
      expect(preview.this_call.expense).toBe((amounts / 100).toFixed(2));
      expect(preview.this_call.deductible).toBe((amounts / 100).toFixed(2));
      expect(preview.this_call.add_back).toBe("0.00");
      expect(preview.apply).toEqual({
        tool: "akaun_change_accounts",
        args: {
          apply_tax_default: [
            { account: id, reason: REASON, revision: preview.revision },
          ],
        },
      });
      expect(taxSnapshot(book)).toEqual(decided);

      // The same call with the revision fills those two lines and nothing else.
      const applied = await call({
        apply_tax_default: [
          { account: id, reason: REASON, revision: preview.revision },
        ],
      });
      expect(applied.isError).toBe(false);
      expect(applied.body.saved).toBe(true);
      expect(applied.body.items[0]).toMatchObject({
        action: "apply_tax_default",
        updated_lines: 1,
        updated_records: 1,
        remaining: 0,
      });
      const after = taxSnapshot(book);
      expect(changedIds(decided, after)).toEqual([first.id]);
      expect(tax(after.find((r) => r.id === first.id)!.tax)).toMatchObject({
        treatment: "ordinary_deductible",
        percentageBps: 10_000,
        source: "account_default",
        reason: REASON,
      });
      // The two decisions are exactly as they were.
      for (const line of [second, third])
        expect(after.find((r) => r.id === line.id)).toEqual(
          decided.find((r) => r.id === line.id),
        );
      expect(tax(after.find((r) => r.id === second.id)!.tax)).toMatchObject({
        treatment: "non_deductible",
        source: "override",
      });
      expect(tax(after.find((r) => r.id === third.id)!.tax)).toMatchObject({
        treatment: "requires_review",
        source: "override",
      });

      // Nothing is left to fill, so another dry run says so and offers no apply.
      const again = await call({
        apply_tax_default: [{ account: id, reason: REASON }],
        dry_run: true,
      });
      expect(again.body.items[0].eligible).toBe(0);
      expect(again.body.items[0].apply).toBeUndefined();
      expect(again.body.items[0].note).toMatch(/Nothing to apply/);
    },
    SLOW,
  );

  it(
    "gives CONFLICT for a stale revision, and leaves every line as it was",
    async () => {
      const { book, call } = await open();
      const id = book.manifest.accounts.memberships;
      const first = await call({
        update: [
          {
            account: id,
            expected_version: accountVersion(book.db, id),
            set: { tax_default: { treatment: "ordinary_deductible" } },
          },
        ],
      });
      const dry = await call({
        apply_tax_default: [{ account: id, reason: REASON }],
        dry_run: true,
      });
      const { revision } = dry.body.items[0];
      expect(revision).toMatch(REVISION);

      // Someone changes the default after the dry run: the revision is stale.
      const changed = await call({
        update: [
          {
            account: id,
            expected_version: first.body.items[0].v,
            set: { tax_default: { treatment: "partial", percent: "50" } },
          },
        ],
      });
      expect(changed.isError).toBe(false);
      const snapshot = taxSnapshot(book);

      const stale = await call({
        apply_tax_default: [{ account: id, reason: REASON, revision }],
      });
      expect(stale.isError).toBe(true);
      expect(stale.body.error.code).toBe("CONFLICT");
      const conflict = stale.body.error.items[0].error;
      expect(conflict.fix).toBe(
        "Run it again with dry_run to get the current revision.",
      );
      // The way out is the fix, not a sentence added to the operation's own.
      expect(conflict.message).not.toMatch(/dry_run/);
      expect(conflict.current_version).toBeUndefined();
      expect(taxSnapshot(book)).toEqual(snapshot);

      // A dry run with the old revision says it is no longer current.
      const check = await call({
        apply_tax_default: [{ account: id, reason: REASON, revision }],
        dry_run: true,
      });
      expect(check.body.items[0].revision_current).toBe(false);
      expect(check.body.items[0].revision).not.toBe(revision);
      expect(check.body.items[0].default).toEqual({
        treatment: "partial",
        percent: "50.00",
      });

      // The new revision applies.
      const fresh = await call({
        apply_tax_default: [
          {
            account: id,
            reason: REASON,
            revision: check.body.items[0].revision,
          },
        ],
      });
      expect(fresh.body.saved).toBe(true);
      expect(fresh.body.items[0].updated_lines).toBe(3);
    },
    SLOW,
  );

  it(
    "applies at most 200 lines per call and reports what remains",
    async () => {
      const { book, call, owner } = await open();
      const id = book.manifest.accounts.memberships;
      // 203 more unclassified lines on the account: the default is saved last.
      for (let i = 0; i < 203; i++) {
        const made = createRecord(owner, {
          kind: "expense",
          date: "2026-10-01",
          description: `Bulk ${i}`,
          amount: 1,
          currency: "MYR",
          exchangeRate: 1,
          categoryAccountId: id,
          paidFromAccountId: book.manifest.accounts.bank,
        });
        expect(made.ok).toBe(true);
      }
      const saved = await call({
        update: [
          {
            account: id,
            expected_version: accountVersion(book.db, id),
            set: { tax_default: { treatment: "ordinary_deductible" } },
          },
        ],
      });
      expect(saved.isError).toBe(false);

      const dry = await call({
        apply_tax_default: [{ account: id, reason: REASON }],
        dry_run: true,
      });
      expect(dry.isError).toBe(false);
      const preview = dry.body.items[0];
      expect(preview.eligible).toBe(206);
      expect(preview.this_call.lines).toBe(200);
      expect(preview.remaining).toBe(6);

      const applied = await call({
        apply_tax_default: [
          { account: id, reason: REASON, revision: preview.revision },
        ],
      });
      expect(applied.isError).toBe(false);
      expect(applied.body.items[0]).toMatchObject({
        updated_lines: 200,
        remaining: 6,
      });
      expect(applied.body.items[0].note).toMatch(
        /6 unclassified entries remain/,
      );
      const left = linesOn(book, id).filter(
        (l) => tax(l.tax)?.treatment === "unclassified",
      );
      expect(left).toHaveLength(6);
    },
    SLOW,
  );

  it(
    "sets a default account after a dry run, and refuses an account that does not suit the purpose",
    async () => {
      const { book, call } = await open();
      const m = book.manifest;
      const purpose = DefaultAccountPurpose.UncategorisedExpense;
      const was = accountDefaultId(book.db, purpose);
      expect(was).toBe(m.accounts.uncategorised);

      const dry = await call({
        set_default: [{ purpose: "uncategorised_expense", account: "5100" }],
        dry_run: true,
      });
      expect(dry.isError).toBe(false);
      expect(dry.body.dry_run).toBe(true);
      expect(accountDefaultId(book.db, purpose)).toBe(was);

      const saved = await call({
        set_default: [
          { purpose: "uncategorised_expense", account: "5100 Advertising" },
        ],
      });
      expect(saved.isError).toBe(false);
      const item = saved.body.items[0];
      expect(item).toMatchObject({
        action: "set_default",
        purpose: "uncategorised_expense",
        account: "5100 Advertising",
      });
      expect(item.previous).toMatch(/^\d+ /);
      expect(item.v).toBe(accountDefaultVersion(book.db, purpose));
      expect(accountDefaultId(book.db, purpose)).toBe(m.accounts.advertising);

      // Setting it to what it already is saves nothing and says so.
      const same = await call({
        set_default: [
          { purpose: "uncategorised_expense", account: m.accounts.advertising },
        ],
      });
      expect(same.isError).toBe(false);
      expect(same.body.items[0].unchanged).toBe(true);

      // An expense account cannot be the sales revenue default.
      const wrong = await call({
        set_default: [
          { purpose: "sales_revenue", account: m.accounts.freight },
        ],
      });
      expect(wrong.isError).toBe(true);
      expect(wrong.body.error.code).toBe("REFUSED");
      expect(wrong.body.error.items[0].error.message).toMatch(
        /cannot be the Sales revenue default/,
      );

      // An optional version guards the change.
      const stale = await call({
        set_default: [
          {
            purpose: "uncategorised_expense",
            account: m.accounts.freight,
            expected_version: "0000000000000000",
          },
        ],
      });
      expect(stale.isError).toBe(true);
      expect(stale.body.error.items[0].error).toMatchObject({
        code: "CONFLICT",
        current_version: accountDefaultVersion(book.db, purpose),
      });
      expect(accountDefaultId(book.db, purpose)).toBe(m.accounts.advertising);
    },
    SLOW,
  );

  it(
    "sets, replaces and clears an opening balance, with its own version and abilities",
    async () => {
      const { book, call } = await open();
      const made = await call({
        create: [{ name: "Savings", type: "asset", sub_type: "bank" }],
      });
      expect(made.isError).toBe(false);
      const id = made.body.items[0].id as number;
      const records = count(book, "ledger_records");

      const dry = await call({
        set_opening_balance: [
          { account: "Savings", date: "2026-07-01", amount: "1500.00" },
        ],
        dry_run: true,
      });
      expect(dry.isError).toBe(false);
      expect(dry.body.items[0]).toMatchObject({
        amount: "1500.00",
        currency: "MYR",
      });
      expect(count(book, "ledger_records")).toBe(records);
      expect(openingBalanceFor(book.db, id)).toBeNull();

      const first = await call({
        set_opening_balance: [
          { account: id, date: "2026-07-01", amount: "1500.00" },
        ],
      });
      expect(first.isError).toBe(false);
      const set = first.body.items[0];
      expect(set).toMatchObject({
        action: "set_opening_balance",
        date: "2026-07-01",
        amount: "1500.00",
        currency: "MYR",
      });
      expect(set.record.no).toBeTruthy();
      expect(set.v).toBe(openingBalanceVersion(book.db, id));
      expect(openingBalanceFor(book.db, id)).toMatchObject({
        amountMinor: 150_000,
        date: "2026-07-01",
      });

      // Replacing it without the record's version is a CONFLICT that says what is there.
      const blind = await call({
        set_opening_balance: [
          { account: id, date: "2026-07-01", amount: "1800.00" },
        ],
      });
      expect(blind.isError).toBe(true);
      expect(blind.body.error.items[0].error).toMatchObject({
        code: "CONFLICT",
        current_version: set.v,
      });
      expect(blind.body.error.items[0].error.message).toMatch(
        /already has an opening balance of 1500\.00 dated 2026-07-01/,
      );

      const replaced = await call({
        set_opening_balance: [
          {
            account: id,
            date: "2026-07-02",
            amount: "-200.00",
            expected_version: set.v,
          },
        ],
      });
      expect(replaced.isError).toBe(false);
      expect(replaced.body.items[0]).toMatchObject({
        amount: "-200.00",
        previous: { date: "2026-07-01", amount: "1500.00" },
      });
      expect(openingBalanceFor(book.db, id)!.amountMinor).toBe(-20_000);

      const cleared = await call({
        set_opening_balance: [
          {
            account: id,
            date: "2026-07-02",
            amount: "0",
            expected_version: replaced.body.items[0].v,
          },
        ],
      });
      expect(cleared.isError).toBe(false);
      expect(cleared.body.items[0]).toMatchObject({ removed: true });
      expect(openingBalanceFor(book.db, id)).toBeNull();
    },
    SLOW,
  );

  it(
    "refuses to clear an opening balance for a token without records.delete, and keeps it",
    async () => {
      const { book, call } = await open(
        BOOKKEEPER_PERMISSIONS.filter((p) => p !== "records.delete"),
      );
      const id = book.manifest.accounts.cash;
      const existing = openingBalanceFor(book.db, id);
      expect(existing).not.toBeNull();
      const reply = await call({
        set_opening_balance: [
          {
            account: id,
            date: existing!.date,
            amount: "0",
            expected_version: openingBalanceVersion(book.db, id),
          },
        ],
      });
      expect(reply.isError).toBe(true);
      expect(reply.body.error.code).toBe("FORBIDDEN");
      expect(reply.body.error.items[0].error.message).toMatch(
        /opening_balance_clear/,
      );
      expect(openingBalanceFor(book.db, id)).not.toBeNull();
    },
    SLOW,
  );

  it(
    "gives FORBIDDEN, per action, to a token that may only create accounts",
    async () => {
      const { book, call } = await open(["accounts.read", "accounts.create"]);
      const m = book.manifest;
      const v = accountVersion(book.db, m.accounts.advertising);
      const update = await call({
        update: [
          {
            account: m.accounts.advertising,
            expected_version: v,
            set: { name: "Ads" },
          },
        ],
      });
      expect(update.isError).toBe(true);
      expect(update.body.error.code).toBe("FORBIDDEN");
      expect(update.body.error.message).toMatch(/update/);
      for (const rejected of [
        { delete: [{ account: m.accounts.advertising, expected_version: v }] },
        {
          set_default: [
            { purpose: "uncategorised_expense", account: m.accounts.freight },
          ],
        },
        {
          apply_tax_default: [
            { account: m.accounts.memberships, reason: REASON },
          ],
          dry_run: true,
        },
      ]) {
        const reply = await call(rejected);
        expect(reply.isError).toBe(true);
        expect(reply.body.error.code).toBe("FORBIDDEN");
      }
      const made = await call({
        create: [{ name: "Allowed Account", type: "revenue" }],
      });
      expect(made.body.saved).toBe(true);
      expect(
        book.raw
          .query("SELECT name FROM accounts WHERE id = ?")
          .get(m.accounts.advertising),
      ).toEqual({ name: "Advertising" });
    },
    SLOW,
  );

  it(
    "returns the first result for a retried call with the same idempotency_key",
    async () => {
      const { book, call } = await open();
      const before = count(book, "accounts");
      const input = {
        create: [{ name: "Once Only", type: "expense" }],
        idempotency_key: "e3-accounts-once",
      };
      const first = await call(input);
      expect(first.body.saved).toBe(true);
      const second = await call(input);
      expect(second.body.replayed).toBe(true);
      expect(second.body.request_id).toBe(first.body.request_id);
      expect(second.body.items[0].id).toBe(first.body.items[0].id);
      expect(count(book, "accounts")).toBe(before + 1);

      // A delete by name replays too, though the name no longer resolves.
      const { id, v } = first.body.items[0];
      const remove = {
        delete: [{ account: "Once Only", expected_version: v }],
        idempotency_key: "f0-accounts-delete",
      };
      const deleted = await call(remove);
      expect(deleted.body.saved).toBe(true);
      const retried = await call(remove);
      expect(retried.isError).toBe(false);
      expect(retried.body).toEqual({ ...deleted.body, replayed: true });
      expect(retried.body.items[0].id).toBe(id);
      expect(count(book, "accounts")).toBe(before);
    },
    SLOW,
  );
});
