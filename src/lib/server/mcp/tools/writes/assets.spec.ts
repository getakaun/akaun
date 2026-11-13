import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { AccountSubType, AccountType } from "$lib/enums.js";
import { buildEvalBook, type EvalBook } from "../../__fixtures__/eval-book.js";
import { createServerV2 } from "../../registry.js";
import { patLocals } from "../../../tokens/pat.js";
import { issueTestToken, localsFor } from "../../../permissions/test-locals.js";
import { createRecord } from "../../../application/records.js";
import { recordVersion } from "../../../application/version.js";
import { createAccount } from "../../../services/accounts.js";
import { getRecord } from "../../../queries/ledger.js";
import { assetsWriteTools } from "./assets.js";

// Each test builds its own evaluation book in a folder under os.tmpdir() and
// drives the tool in-process over InMemoryTransport; nothing here imports
// db/client.ts. Also run with the MCP preload to prove it:
//   bun test --preload ./scripts/mcp-test-preload.ts src/lib/server/mcp/tools/writes/assets.spec.ts

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

/** Everything an asset-and-depreciation token needs; the agent's own token has no `records.adjust`. */
const FULL = [
  "accounts.read",
  "accounts.update",
  "records.read",
  "records.create",
  "records.update",
  "records.adjust",
  "records.void",
];

async function open(
  options: { permissions?: string[]; asOwner?: boolean } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "akaun-e4-assets-"));
  const book = await buildEvalBook({ dir, variant: "A", today: TODAY });
  const token = options.permissions
    ? issueTestToken(
        book.db,
        options.asOwner ? book.ownerId : book.agentUserId,
        options.permissions,
      )
    : book.agentToken;
  const locals = patLocals(book.db, `Bearer ${token}`)!;
  const server = createServerV2({
    db: book.db,
    store: book.store,
    storageRoot: book.storageRoot,
    locals,
    tools: { reads: [], writes: [...assetsWriteTools] },
  });
  const client = new Client({ name: "e4-assets-spec", version: "1" });
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
  const replies: string[] = [];
  const call = async (
    args: Record<string, unknown>,
    name = "akaun_manage_fixed_assets",
  ): Promise<Reply> => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { type: string; text: string }[])[0].text;
    replies.push(text);
    return { isError: result.isError === true, body: JSON.parse(text), text };
  };
  return { book, client, call, replies };
}

const count = (book: EvalBook, table: string) =>
  (book.raw.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number })
    .n;

function noInternalIds(replies: string[]) {
  for (const text of replies)
    expect(text).not.toMatch(
      /"[a-zA-Z_]*(movement|settlement)[a-zA-Z_]*"\s*:/i,
    );
}

/** The accounts a depreciation schedule needs, made as the owner would. */
function depreciationAccounts(book: EvalBook) {
  const make = (name: string, type: 1 | 2 | 3 | 4 | 5, subType?: number) => {
    const made = createAccount(book.db, book.ownerId, {
      name,
      type,
      subType: subType as never,
    });
    if (!made.ok) throw new Error(made.reason);
    return made.value.id;
  };
  return {
    expense: make("Depreciation expense", AccountType.Expense),
    accumulated: make(
      "Accumulated depreciation",
      AccountType.Asset,
      AccountSubType.OtherNonCurrentAsset,
    ),
  };
}

function capitaliseArgs(book: EvalBook, extra: Record<string, unknown> = {}) {
  const m = book.manifest;
  const record = getRecord(book.db, m.records.macbook)!;
  return {
    record,
    item: {
      record: record.recordNumber,
      expected_version: recordVersion(book.db, record.id),
      to_account: m.accounts.equipment,
      asset: {
        name: record.description,
        type: "Computer equipment",
        life_months: 36,
        start: "2026-08-20",
        ...extra,
      },
    },
  };
}

describe("manage_fixed_assets", () => {
  it(
    "is listed with a short description free of the book's names",
    async () => {
      const { book, client } = await open();
      const { tools } = await client.listTools();
      const mine = tools.find((t) => t.name === "akaun_manage_fixed_assets");
      expect(mine).toBeDefined();
      expect(mine!.description!.length).toBeLessThanOrEqual(1500);
      for (const noun of book.manifest.nouns)
        expect(mine!.description!.toLowerCase()).not.toContain(
          noun.toLowerCase(),
        );
      expect(mine!.annotations?.destructiveHint).toBe(true);
    },
    SLOW,
  );

  it(
    "capitalises the laptop: the line moves to the asset account and the asset is registered at its cost",
    async () => {
      const { book, call, replies } = await open();
      const m = book.manifest;
      const { record, item } = capitaliseArgs(book);
      const before = {
        records: count(book, "ledger_records"),
        assets: count(book, "fixed_assets"),
      };

      const dry = await call({ capitalise: [item], dry_run: true });
      expect(dry.isError).toBe(false);
      expect(dry.body).toMatchObject({ saved: false, dry_run: true });
      expect(dry.body.items[0].asset).toMatchObject({
        no: "FA-0001",
        cost: "4999.00",
        life_months: 36,
      });
      expect(dry.body.items[0].asset.account).toContain("Office Equipment");
      expect(dry.body.items[0].moved.to).toContain("Office Equipment");
      expect(count(book, "fixed_assets")).toBe(before.assets);
      expect(
        getRecord(book.db, record.id)!.movements.some(
          (x) => x.accountId === m.accounts.equipment,
        ),
      ).toBe(false);

      const saved = await call({ capitalise: [item] });
      expect(saved.isError).toBe(false);
      expect(saved.body.saved).toBe(true);
      expect(saved.body.request_id).toBeTruthy();
      expect(saved.body.currency).toBe("MYR");
      const out = saved.body.items[0];
      expect(out).toMatchObject({ n: 1, action: "capitalise" });
      expect(out.asset).toMatchObject({
        cost: "4999.00",
        acquired: record.date,
        in_service: "2026-08-20",
        type: "Computer equipment",
      });
      expect(typeof out.asset.v).toBe("string");
      expect(out.record).toMatchObject({
        id: record.id,
        no: record.recordNumber,
      });

      expect(count(book, "fixed_assets")).toBe(before.assets + 1);
      expect(count(book, "ledger_records")).toBe(before.records);
      const after = getRecord(book.db, record.id)!;
      const line = after.movements.find(
        (x) => x.accountId === m.accounts.equipment,
      );
      expect(line?.amountMinor).toBe(499_900);
      expect(
        after.movements.some((x) => x.accountId === m.accounts.officeSupplies),
      ).toBe(false);
      noInternalIds(replies);
    },
    SLOW,
  );

  it(
    "refuses bad input and references that do not resolve, all at once",
    async () => {
      const { book, call } = await open();
      const m = book.manifest;
      const { item } = capitaliseArgs(book);

      const bad = await call({
        capitalise: [
          { ...item, asset: { name: "Laptop", type: "Computer equipment" } },
        ],
      });
      expect(bad.isError).toBe(true);
      expect(bad.body.error.code).toBe("INVALID_INPUT");
      expect(bad.body.error.issues[0].path).toBe(
        "capitalise[0].asset.life_months",
      );

      const nothing = await call({});
      expect(nothing.body.error.code).toBe("INVALID_INPUT");

      const missing = await call({
        capitalise: [
          { ...item, record: "EXP-2026-9999", to_account: m.accounts.travel },
        ],
      });
      expect(missing.isError).toBe(true);
      expect(missing.body.error.errors.map((e: Loose) => e.code)).toEqual([
        "NOT_FOUND",
        "NOT_FOUND",
      ]);
      expect(missing.body.error.errors.map((e: Loose) => e.path)).toEqual([
        "capitalise[0].record",
        "capitalise[0].to_account",
      ]);
      expect(count(book, "fixed_assets")).toBe(0);

      const unknownAsset = await call({
        update: [
          {
            asset: "FA-0042",
            expected_version: "1",
            reason: "Fix the name",
            set: { name: "Renamed" },
          },
        ],
      });
      expect(unknownAsset.body.error.code).toBe("NOT_FOUND");
      expect(unknownAsset.body.error.path).toBe("update[0].asset");
    },
    SLOW,
  );

  it(
    "answers CONFLICT with the current version for a stale record version",
    async () => {
      const { book, call } = await open();
      const { record, item } = capitaliseArgs(book);
      const stale = await call({
        capitalise: [{ ...item, expected_version: "0000000000000000" }],
      });
      expect(stale.isError).toBe(true);
      expect(stale.body.error.code).toBe("CONFLICT");
      expect(stale.body.error.items[0].error.current_version).toBe(
        recordVersion(book.db, record.id),
      );
      expect(count(book, "fixed_assets")).toBe(0);
    },
    SLOW,
  );

  it(
    "refuses an action the token lacks, naming what to grant",
    async () => {
      const { book, call } = await open({
        permissions: ["accounts.read", "records.read", "accounts.update"],
      });
      const { item } = capitaliseArgs(book);
      // register and update are allowed; capitalise needs records.update too,
      // and depreciation needs the adjust permission.
      const post = await call({ post_depreciation: [{ month: "2026-08" }] });
      expect(post.isError).toBe(true);
      expect(post.body.error.code).toBe("FORBIDDEN");
      expect(post.body.error.message).toContain("records.adjust");

      const capitalise = await call({ capitalise: [item] });
      expect(capitalise.body.error.code).toBe("FORBIDDEN");
      expect(capitalise.body.error.message).toContain("records.update");
      expect(count(book, "fixed_assets")).toBe(0);
    },
    SLOW,
  );

  it(
    "approves a schedule, posts a month, reverses the run, and a dry run saves nothing",
    async () => {
      const { book, call, replies } = await open({
        permissions: FULL,
        asOwner: true,
      });
      const accounts = depreciationAccounts(book);
      const { item } = capitaliseArgs(book, {
        expense_account: accounts.expense,
        accumulated_account: accounts.accumulated,
      });
      const registered = await call({ capitalise: [item] });
      expect(registered.isError).toBe(false);
      const asset = registered.body.items[0].asset;
      expect(asset.expense_account).toContain("Depreciation expense");

      // approve: the dry run reports the schedule and the v that confirms it.
      const approveDry = await call({
        approve: [
          { asset: asset.no, reason: "Straight line over three years" },
        ],
        dry_run: true,
      });
      expect(approveDry.isError).toBe(false);
      expect(approveDry.body.items[0].schedule).toMatchObject({
        start_month: "2026-08",
        months: 36,
        monthly: "138.86",
        base: "4999.00",
      });
      expect(count(book, "depreciation_profiles")).toBe(0);
      const stale = await call({
        approve: [
          {
            asset: asset.no,
            reason: "Straight line over three years",
            expected_version: "stale",
          },
        ],
      });
      expect(stale.isError).toBe(true);
      expect(stale.body.error.items[0].error.message).toContain("changed");
      const approved = await call({
        approve: [
          {
            asset: asset.no,
            reason: "Straight line over three years",
            expected_version: approveDry.body.items[0].v,
          },
        ],
      });
      expect(approved.isError).toBe(false);
      expect(count(book, "depreciation_profiles")).toBe(1);

      // post_depreciation: a month for every asset due.
      const journals = count(book, "ledger_records");
      const postDry = await call({
        post_depreciation: [{ month: "2026-08" }],
        dry_run: true,
      });
      expect(postDry.isError).toBe(false);
      expect(postDry.body.items[0]).toMatchObject({
        month: "2026-08",
        posted: 1,
        total: "138.86",
      });
      expect(postDry.body.items[0].assets[0]).toMatchObject({
        no: asset.no,
        amount: "138.86",
      });
      expect(count(book, "depreciation_runs")).toBe(0);
      expect(count(book, "ledger_records")).toBe(journals);

      const posted = await call({ post_depreciation: [{ month: "2026-08" }] });
      expect(posted.isError).toBe(false);
      expect(posted.body.saved).toBe(true);
      const journal = posted.body.items[0].record;
      expect(journal.date).toBe("2026-08-31");
      expect(count(book, "depreciation_runs")).toBe(1);
      expect(count(book, "ledger_records")).toBe(journals + 1);
      const run = getRecord(book.db, journal.id)!;
      expect(run.movements.reduce((sum, x) => sum + x.amountMinor, 0)).toBe(0);
      expect(
        run.movements.find((x) => x.accountId === accounts.expense)
          ?.amountMinor,
      ).toBe(13_886);

      // The same month again has nothing due.
      const again = await call({ post_depreciation: [{ month: "2026-08" }] });
      expect(again.body.items[0].posted).toBe(0);
      expect(again.body.items[0].note).toContain("Nothing was due");

      // reverse_run names the journal, not an internal run id.
      const notARun = await call({
        reverse_run: [
          {
            record: book.manifest.records.macbook,
            reason: "Not a depreciation run",
          },
        ],
      });
      expect(notARun.isError).toBe(true);
      expect(notARun.body.error.items[0].error.message).toContain(
        "not a depreciation run",
      );
      const reversed = await call({
        reverse_run: [
          { record: journal.no, reason: "Posted before the asset was in use." },
        ],
      });
      expect(reversed.isError).toBe(false);
      expect(reversed.body.items[0].reversal.date).toBe("2026-08-31");
      expect(count(book, "ledger_records")).toBe(journals + 2);
      noInternalIds(replies);
    },
    SLOW,
  );

  it(
    "capitalises a bill that is already settled: a category move is allowed on it",
    async () => {
      const { book, call } = await open();
      const m = book.manifest;
      const bill = getRecord(book.db, m.plants.freightLeftOut.bill)!;
      expect(bill.locked).toBe(true);
      const saved = await call({
        capitalise: [
          {
            record: bill.recordNumber,
            expected_version: recordVersion(book.db, bill.id),
            to_account: "Office Equipment",
            asset: { name: "Shelving", life_months: 60 },
          },
        ],
      });
      expect(saved.isError).toBe(false);
      expect(saved.body.items[0].asset).toMatchObject({
        cost: (bill.amountMinor / 100).toFixed(2),
        life_months: 60,
      });
      expect(
        getRecord(book.db, bill.id)!.movements.some(
          (x) => x.accountId === m.accounts.equipment,
        ),
      ).toBe(true);
    },
    SLOW,
  );

  it(
    "capitalises one line of a split bill, and asks which when it is not said",
    async () => {
      const { book, call } = await open({ permissions: FULL, asOwner: true });
      const m = book.manifest;
      const made = createRecord(
        {
          db: book.db,
          locals: localsFor([], { superuser: true, userId: book.ownerId }),
        },
        {
          expectedKind: "expense",
          date: "2026-09-12",
          description: "Desk and stationery",
          amount: 1500,
          currency: "MYR",
          exchangeRate: 1,
          fromAccountId: m.accounts.bank,
          toAccountId: m.accounts.officeSupplies,
          extraSides: [
            { accountId: m.accounts.packaging, amountMinor: 100_000 },
          ],
        },
      );
      if (!made.ok) throw new Error(made.reason);
      const record = made.value.record;
      const item = {
        record: record.recordNumber,
        expected_version: recordVersion(book.db, record.id),
        to_account: m.accounts.equipment,
        asset: { name: "Desk", life_months: 60 },
      };

      const unsaid = await call({ capitalise: [item] });
      expect(unsaid.isError).toBe(true);
      expect(unsaid.body.error.items[0].error.code).toBe("INVALID_INPUT");
      expect(unsaid.body.error.items[0].error.message).toContain("line");
      const outOfRange = await call({ capitalise: [{ ...item, line: 5 }] });
      expect(outOfRange.body.error.items[0].error.code).toBe("INVALID_INPUT");

      const saved = await call({ capitalise: [{ ...item, line: 1 }] });
      expect(saved.isError).toBe(false);
      expect(saved.body.items[0].asset.cost).toBe("1000.00");
      const after = getRecord(book.db, record.id)!;
      expect(
        after.movements
          .filter((x) => x.accountId === m.accounts.equipment)
          .map((x) => x.amountMinor),
      ).toEqual([100_000]);
      expect(
        after.movements
          .filter((x) => x.accountId === m.accounts.officeSupplies)
          .map((x) => x.amountMinor),
      ).toEqual([50_000]);
    },
    SLOW,
  );

  it(
    "stops depreciation after the posted months",
    async () => {
      const { book, call } = await open({ permissions: FULL, asOwner: true });
      const accounts = depreciationAccounts(book);
      const { item } = capitaliseArgs(book, {
        expense_account: accounts.expense,
        accumulated_account: accounts.accumulated,
      });
      const registered = await call({ capitalise: [item] });
      const asset = registered.body.items[0].asset;
      await call({
        approve: [
          { asset: asset.no, reason: "Straight line over three years" },
        ],
      });
      const stopped = await call({
        stop: [
          { asset: asset.no, month: "2026-10", reason: "Sold the laptop" },
        ],
      });
      expect(stopped.isError).toBe(false);
      expect(stopped.body.items[0]).toMatchObject({
        action: "stop",
        stopped_from: "2026-10",
      });
      expect(
        (
          book.raw
            .query("SELECT stopped_from AS s FROM depreciation_profiles")
            .get() as { s: string }
        ).s,
      ).toBe("2026-10");
    },
    SLOW,
  );

  it(
    "registers a purchase already booked to an asset account, then updates it with its version",
    async () => {
      const { book, call } = await open({ permissions: FULL, asOwner: true });
      const m = book.manifest;
      // Book the purchase straight to the asset account, as a person would.
      const made = createRecord(
        {
          db: book.db,
          locals: localsFor([], { superuser: true, userId: book.ownerId }),
        },
        {
          kind: "expense",
          date: "2026-09-10",
          description: "Standing desk",
          amount: 1800,
          currency: "MYR",
          exchangeRate: 1,
          categoryAccountId: m.accounts.equipment,
          paidFromAccountId: m.accounts.bank,
        },
      );
      if (!made.ok) throw new Error(made.reason);

      const both = await call({
        register: [
          {
            record: made.value.record.recordNumber,
            existing: {
              account: m.accounts.equipment,
              acquired: "2026-01-01",
              cost: "100.00",
              opening_as_at: "2026-06-30",
            },
            asset: { name: "Standing desk" },
          },
        ],
      });
      expect(both.body.error.code).toBe("INVALID_INPUT");
      expect(both.body.error.path).toBe("register[0]");

      // An asset owned before the books began needs its supporting document.
      const existing = {
        account: m.accounts.equipment,
        acquired: "2025-01-01",
        cost: "2000.00",
        opening_as_at: "2026-06-30",
      };
      const noEvidence = await call({
        register: [{ existing, asset: { name: "Old printer" } }],
      });
      expect(noEvidence.isError).toBe(true);
      expect(noEvidence.body.error.items[0].error.code).toBe("INVALID_INPUT");
      const legacy = await call({
        register: [
          {
            existing,
            asset: {
              name: "Old printer",
              type: "Office equipment",
              document_reference: "Invoice 8841, 2025-01-01",
            },
          },
        ],
      });
      expect(legacy.isError).toBe(false);
      expect(legacy.body.items[0].asset).toMatchObject({
        cost: "2000.00",
        acquired: "2025-01-01",
        type: "Office equipment",
      });

      const registered = await call({
        register: [
          {
            record: made.value.record.recordNumber,
            asset: {
              name: "Standing desk",
              type: "Furniture",
              life_months: 60,
            },
          },
        ],
      });
      expect(registered.isError).toBe(false);
      const asset = registered.body.items[0].asset;
      expect(asset).toMatchObject({
        cost: "1800.00",
        type: "Furniture",
        acquired: "2026-09-10",
        life_months: 60,
      });

      const renamed = await call({
        update: [
          {
            asset: "Standing desk",
            expected_version: asset.v,
            reason: "Use the supplier's name",
            set: { name: "Height-adjustable desk", serial_number: "HD-100" },
          },
        ],
      });
      expect(renamed.isError).toBe(false);
      expect(renamed.body.items[0]).toMatchObject({
        changed: ["name", "serial_number"],
        asset: { name: "Height-adjustable desk", life_months: 60 },
      });
      expect(renamed.body.items[0].asset.v).not.toBe(asset.v);

      const stale = await call({
        update: [
          {
            asset: asset.no,
            expected_version: asset.v,
            reason: "Using the old version",
            set: { name: "Another name" },
          },
        ],
      });
      expect(stale.isError).toBe(true);
      expect(stale.body.error.code).toBe("CONFLICT");
      expect(stale.body.error.items[0].error.current_version).toBe(
        renamed.body.items[0].asset.v,
      );
    },
    SLOW,
  );
});
