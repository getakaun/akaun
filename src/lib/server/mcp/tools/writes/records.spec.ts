import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { AccountType, DefaultAccountPurpose } from "$lib/enums.js";
import { localToday } from "$lib/local-date.js";
import * as schema from "../../../db/schema.js";
import type { LedgerDb, RecordView } from "../../../ledger/types.js";
import { formatMinor } from "../../../ledger/money.js";
import { LocalBlobStore } from "../../../storage/blob-store.js";
import { localsFor } from "../../../permissions/test-locals.js";
import { patLocals } from "../../../tokens/pat.js";
import { reset } from "../../../rate-limit.js";
import { getRecord } from "../../../queries/ledger.js";
import { contactBalances } from "../../../queries/settlements.js";
import { accountDefaultId } from "../../../services/account-defaults.js";
import { createAccount } from "../../../services/accounts.js";
import {
  releaseBook,
  resultValue,
} from "../../../application/__fixtures__/release-book.js";
import { createRecord } from "../../../application/records.js";
import { recordVersion } from "../../../application/version.js";
import { buildEvalBook, type EvalBook } from "../../__fixtures__/eval-book.js";
import { createServerV2, MAX_DESCRIPTION_CHARS } from "../../registry.js";
import { recordsWriteTools, splitByLargestRemainder } from "./records.js";

/**
 * The records write tools driven end to end: `createServerV2` over an
 * in-process transport, on `releaseBook` (in memory) or the evaluation book
 * (a file under `os.tmpdir()`), with files in a temp folder. Nothing here
 * imports `db/client.ts`; run under the MCP preload to prove it:
 *   bun test --preload ./scripts/mcp-test-preload.ts src/lib/server/mcp/tools/writes/records.spec.ts
 */

type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A personal access token with these permissions, for a user who has them all. */
const token = (permissions: string[]): App.Locals => ({
  ...localsFor([], { superuser: true, credential: permissions }),
  credential: { kind: "pat", tokenId: 1 },
});
const OWNER = () => localsFor([], { superuser: true });

async function serve(
  db: LedgerDb,
  locals: App.Locals,
  storageRoot = mkdtempSync(join(tmpdir(), "akaun-records-writes-")),
) {
  const server = createServerV2({
    db,
    store: new LocalBlobStore(storageRoot),
    storageRoot,
    locals,
    tools: { reads: [], writes: recordsWriteTools },
  });
  const client = new Client({ name: "records-writes-spec", version: "1" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  await client.connect(clientSide);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { type: string; text: string }[])[0].text;
    return {
      isError: result.isError === true,
      body: JSON.parse(text) as Body,
      structured: result.structuredContent as Body | undefined,
    };
  };
  return { client, call, storageRoot };
}

function seed() {
  const b = releaseBook();
  cleanups.push(() => b.raw.close());
  const { db, ctx, bank, expense } = b;
  const account = (name: string, type: 1 | 2 | 3 | 4 | 5) =>
    resultValue(createAccount(db, 1, { name, type })).id;
  const freight = account("Freight", AccountType.Expense);
  const sales = account("Sales", AccountType.Revenue);
  const contact = (legalName: string) =>
    db
      .insert(schema.contacts)
      .values({ legalName, entityType: 2 })
      .returning()
      .get()!.id;
  const acme = contact("Acme Sdn Bhd");
  const other = contact("Other Sdn Bhd");
  const payable = accountDefaultId(db, DefaultAccountPurpose.Payable)!;
  const owedSide = (record: RecordView) =>
    record.movements.find((m) => m.accountId === payable)!;

  function bankExpense(description = "Paid from the bank", amount = 40) {
    return resultValue(
      createRecord(ctx, {
        kind: "expense",
        date: "2026-09-02",
        amount,
        currency: "MYR",
        exchangeRate: 1,
        description,
        categoryAccountId: expense,
        paidFromAccountId: bank,
      }),
    ).record;
  }
  /** 1,200.00 owed to Acme, and a 1,285.00 payment allocated 1,200.00 to it. */
  function settledBill() {
    const bill = resultValue(
      createRecord(ctx, {
        kind: "expense",
        date: "2026-09-02",
        amount: 1200,
        currency: "MYR",
        exchangeRate: 1,
        description: "Acme goods",
        categoryAccountId: expense,
        paidFromAccountId: null,
        contactId: acme,
      }),
    ).record;
    const payment = resultValue(
      createRecord(ctx, {
        kind: "payment",
        date: "2026-09-02",
        amount: 1285,
        currency: "MYR",
        exchangeRate: 1,
        description: "Acme payment",
        paidFromAccountId: bank,
        contactId: acme,
        direction: "we-pay",
        settlements: [
          { owedMovementId: owedSide(bill).id, amountMinor: 120_000 },
        ],
      }),
    ).record;
    return {
      bill: getRecord(db, bill.id)!,
      payment: getRecord(db, payment.id)!,
    };
  }
  const count = (table: string) =>
    (b.raw.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number })
      .n;
  return {
    ...b,
    freight,
    sales,
    acme,
    other,
    bankExpense,
    settledBill,
    count,
    v: (id: number) => recordVersion(db, id),
  };
}

const CREATE = "akaun_create_records";
const CHANGE = "akaun_change_records";
const ATTACH = "akaun_attach_file";

const expense = (extra: Record<string, unknown> = {}) => ({
  type: "expense",
  date: "2026-09-02",
  description: "Printer paper",
  amount: "45.90",
  paid_from: "Bank",
  category: "Ordinary expenses",
  ...extra,
});

// ---------------------------------------------------------------------------

describe("the listing", () => {
  it("offers the three tools with their annotations and short descriptions", async () => {
    const s = seed();
    const { client } = await serve(s.db, OWNER());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([ATTACH, CREATE, CHANGE]);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName[CREATE].annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    });
    expect(byName[CHANGE].annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    });
    expect(byName[ATTACH].annotations).toMatchObject({
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(byName[ATTACH].outputSchema).toBeDefined();
    expect(byName[CREATE].outputSchema).toBeUndefined();
    for (const tool of tools)
      expect(tool.description!.length).toBeLessThanOrEqual(
        MAX_DESCRIPTION_CHARS,
      );
  });

  it("lists only the tools a token can use", async () => {
    const s = seed();
    const { client } = await serve(
      s.db,
      token(["records.read", "records.update"]),
    );
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([ATTACH, CHANGE]);
  });
});

describe("akaun_create_records", () => {
  it("records an expense paid from a bank account", async () => {
    const s = seed();
    const { call } = await serve(s.db, OWNER());
    const { isError, body } = await call(CREATE, {
      records: [expense({ contact: "Acme Sdn Bhd" })],
    });
    expect(isError).toBe(false);
    expect(body).toMatchObject({ saved: true, currency: "MYR" });
    expect(body.request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.items).toEqual([
      {
        n: 1,
        action: "records",
        label: "records[0]",
        record: expect.any(Number),
        no: expect.any(String),
        kind: "expense",
        date: "2026-09-02",
        amount: "45.90",
        contact: "Acme Sdn Bhd",
        v: expect.any(String),
      },
    ]);
    const saved = getRecord(s.db, body.items[0].record)!;
    expect(saved.amountMinor).toBe(4590);
    expect(saved.contactId).toBe(s.acme);
    expect(body.items[0].v).toBe(s.v(saved.id));
  });

  it("records income, and adds the sides with detail full", async () => {
    const s = seed();
    const { call } = await serve(s.db, OWNER());
    const { body } = await call(CREATE, {
      records: [
        {
          type: "income",
          date: "2026-09-03",
          description: "Consulting fee",
          amount: "300",
          received_into: s.bank,
          category: "Sales",
        },
      ],
      detail: "full",
    });
    expect(body.saved).toBe(true);
    const item = body.items[0];
    expect(item).toMatchObject({ kind: "income", amount: "300.00" });
    expect(item.sides).toHaveLength(2);
    expect(item.sides.map((side: Body) => side.amount).sort()).toEqual([
      "-300.00",
      "300.00",
    ]);
  });

  it("splits an expense over two categories", async () => {
    const s = seed();
    const { call } = await serve(s.db, OWNER());
    const { body } = await call(CREATE, {
      records: [
        expense({
          description: "Goods and delivery",
          amount: "120.00",
          category: undefined,
          lines: [
            { category: "Ordinary expenses", amount: "100.00" },
            { category: "Freight", amount: "20.00", label: "Delivery" },
          ],
        }),
      ],
      detail: "full",
    });
    expect(body.saved).toBe(true);
    expect(body.items[0].kind).toBe("expense");
    const record = getRecord(s.db, body.items[0].record)!;
    const byAccount = Object.fromEntries(
      record.movements.map((m) => [m.accountId, m.amountMinor]),
    );
    expect(byAccount).toEqual({
      [s.bank]: -12_000,
      [s.expense]: 10_000,
      [s.freight]: 2_000,
    });
    expect(body.items[0].sides).toContainEqual(
      expect.objectContaining({ amount: "20.00", label: "Delivery" }),
    );
  });

  it("refuses a journal to a token without records.adjust, and records it for one with it", async () => {
    const s = seed();
    const journal = {
      type: "journal",
      date: "2026-09-04",
      description: "Owner put cash in",
      lines: [
        { category: "Bank", amount: "50.00" },
        { category: "Opening equity", amount: "-50.00" },
      ],
    };
    const { call } = await serve(
      s.db,
      token(["records.read", "records.create"]),
    );
    const refused = await call(CREATE, { records: [journal] });
    expect(refused.isError).toBe(true);
    expect(refused.body.error.code).toBe("FORBIDDEN");
    expect(refused.body.error.message).toContain("records_adjust");
    expect(s.count("ledger_records")).toBe(0);

    const owner = await serve(s.db, OWNER());
    const saved = await owner.call(CREATE, { records: [journal] });
    expect(saved.body.items[0]).toMatchObject({
      kind: "journal",
      amount: "50.00",
    });
  });

  it("answers a near-match new_contact with AMBIGUOUS, and creates it with force_new", async () => {
    const s = seed();
    const { call } = await serve(s.db, OWNER());
    const newContact = { name: "Acme Sdn Bhd (KL)" };
    const item = expense({
      owed: true,
      paid_from: undefined,
      new_contact: newContact,
    });
    const near = await call(CREATE, { records: [item] });
    expect(near.isError).toBe(true);
    expect(near.body.error.code).toBe("AMBIGUOUS");
    const error = near.body.error.items[0].error;
    expect(error).toMatchObject({
      code: "AMBIGUOUS",
      path: "records[0].new_contact",
    });
    expect(error.candidates[0]).toMatchObject({
      id: s.acme,
      name: "Acme Sdn Bhd",
    });
    expect(error.fix).toContain("force_new");
    const contacts = s.count("contacts");

    const made = await call(CREATE, {
      records: [{ ...item, new_contact: { ...newContact, force_new: true } }],
    });
    expect(made.body.saved).toBe(true);
    expect(made.body.items[0].contact_created).toEqual({
      id: expect.any(Number),
      name: "Acme Sdn Bhd (KL)",
    });
    expect(made.body.items[0].contact).toBe("Acme Sdn Bhd (KL)");
    expect(s.count("contacts")).toBe(contacts + 1);
  });

  it("tells a caller who cannot read contacts nothing about existing names on a new_contact", async () => {
    const s = seed();
    const item = (name: string) =>
      expense({
        owed: true,
        paid_from: undefined,
        new_contact: { name },
      });

    // May create contacts but not read them: the near-name check is skipped,
    // as change_contacts create does, and the reply names no other contact.
    const { call } = await serve(
      s.db,
      token(["records.create", "contacts.create"]),
    );
    const before = s.count("contacts");
    const near = await call(CREATE, { records: [item("Acme Sdn Bhd (KL)")] });
    expect(near.isError).toBe(false);
    expect(near.body.saved).toBe(true);
    expect(near.body.items[0].contact_created).toEqual({
      id: expect.any(Number),
      name: "Acme Sdn Bhd (KL)",
    });
    expect(near.body.items[0].contact_created.id).not.toBe(s.acme);
    expect(s.count("contacts")).toBe(before + 1);

    // An exact name is not reported as taken either: it makes a second contact.
    const exact = await call(CREATE, { records: [item("Acme Sdn Bhd")] });
    expect(exact.body.saved).toBe(true);
    expect(exact.body.items[0].contact_created.id).not.toBe(s.acme);
    expect(s.count("contacts")).toBe(before + 2);
    for (const reply of [near, exact]) {
      const text = JSON.stringify(reply.body);
      expect(text).not.toContain("candidates");
      expect(text).not.toContain("AMBIGUOUS");
      expect(text).not.toContain("Other Sdn Bhd");
    }

    // Not allowed to create either: refused, still without any name.
    const { call: bare } = await serve(s.db, token(["records.create"]));
    const refused = await bare(CREATE, {
      records: [item("Acme Sdn Bhd (HQ)")],
    });
    expect(refused.isError).toBe(true);
    const text = JSON.stringify(refused.body);
    expect(text).not.toContain("candidates");
    expect(text).not.toContain("AMBIGUOUS");
    expect(text).not.toContain("Other Sdn Bhd");
    expect(s.count("contacts")).toBe(before + 2);

    // A reader of contacts is still warned, with the candidates.
    const { call: reader } = await serve(
      s.db,
      token(["records.create", "contacts.create", "contacts.read"]),
    );
    const warned = await reader(CREATE, {
      records: [item("Acme Sdn Bhd (HQ)")],
    });
    expect(warned.body.error.items[0].error).toMatchObject({
      code: "AMBIGUOUS",
      candidates: expect.arrayContaining([
        expect.objectContaining({ id: s.acme }),
      ]),
    });
  });

  it("looks up and freezes the day's rate for a foreign currency", async () => {
    const s = seed();
    // The cached daily rate stands in for the provider: no network.
    s.db
      .insert(schema.exchangeRates)
      .values({ date: "2026-09-02", base: "USD", quote: "MYR", rate: 4.5 })
      .run();
    const { call } = await serve(s.db, OWNER());
    const { body } = await call(CREATE, {
      records: [expense({ amount: "10.00", currency: "usd" })],
    });
    expect(body.saved).toBe(true);
    expect(body.items[0]).toMatchObject({
      amount: "10.00",
      currency: "USD",
      rate: 4.5,
      amount_main: "45.00",
      rate_looked_up: { rate: 4.5, source: "cache" },
    });
    const record = getRecord(s.db, body.items[0].record)!;
    expect(record.exchangeRate).toBe(4.5);
    expect(record.amountMinor).toBe(4500);

    const byMainAmount = await call(CREATE, {
      records: [
        expense({ amount: "10.00", currency: "USD", main_amount: "44.20" }),
      ],
    });
    expect(byMainAmount.body.items[0]).toMatchObject({
      amount_main: "44.20",
    });
  });

  it("lists a near-identical expense as a duplicate suspect, in a dry run too", async () => {
    const s = seed();
    const earlier = resultValue(
      createRecord(s.ctx, {
        kind: "expense",
        date: "2026-09-02",
        amount: 45.9,
        currency: "MYR",
        exchangeRate: 1,
        description: "Printer paper",
        categoryAccountId: s.expense,
        paidFromAccountId: s.bank,
        contactId: s.acme,
      }),
    ).record;
    const { call } = await serve(s.db, OWNER());
    const again = expense({ date: "2026-09-03", contact: "Acme Sdn Bhd" });
    const suspect = {
      record: earlier.id,
      no: earlier.recordNumber,
      date: "2026-09-02",
      amount: "45.90",
      signals: expect.arrayContaining(["amount_date_contact"]),
    };

    const dry = await call(CREATE, { records: [again], dry_run: true });
    expect(dry.body.items[0].duplicate_suspects).toEqual([suspect]);
    expect(s.count("ledger_records")).toBe(1);

    const { body } = await call(CREATE, { records: [again] });
    expect(body.saved).toBe(true);
    expect(body.items[0].duplicate_suspects).toEqual([suspect]);

    // Within one call too: the second copy finds the first, not yet saved.
    const pair = await call(CREATE, {
      records: [expense({ amount: "77.00" }), expense({ amount: "77.00" })],
      dry_run: true,
    });
    expect(pair.body.items[0].duplicate_suspects).toBeUndefined();
    expect(pair.body.items[1].duplicate_suspects).toEqual([
      expect.objectContaining({
        record: pair.body.items[0].record,
        amount: "77.00",
      }),
    ]);
  });

  it("lists no suspect for a distinct expense, and at most three for one", async () => {
    const s = seed();
    s.bankExpense("Paid from the bank", 40);
    const { call } = await serve(s.db, OWNER());
    const distinct = await call(CREATE, {
      records: [expense({ contact: "Acme Sdn Bhd" })],
    });
    expect(distinct.body.saved).toBe(true);
    expect(distinct.body.items[0].duplicate_suspects).toBeUndefined();

    for (let i = 0; i < 4; i++) s.bankExpense("Printer paper", 45.9);
    const copied = await call(CREATE, { records: [expense()] });
    expect(copied.body.items[0].duplicate_suspects).toHaveLength(3);
  });

  it("creates a new contact whose name shares only its legal form with others", async () => {
    const s = seed();
    const { call } = await serve(s.db, OWNER());
    const { body } = await call(CREATE, {
      records: [
        expense({
          owed: true,
          paid_from: undefined,
          new_contact: { name: "Zenith Trading Sdn Bhd" },
        }),
      ],
    });
    expect(body.saved).toBe(true);
    expect(body.items[0].contact_created).toEqual({
      id: expect.any(Number),
      name: "Zenith Trading Sdn Bhd",
    });
  });

  it("saves nothing on a dry run, and replays an idempotent call", async () => {
    const s = seed();
    const { call } = await serve(s.db, OWNER());
    const dry = await call(CREATE, { records: [expense()], dry_run: true });
    expect(dry.body).toMatchObject({ saved: false, dry_run: true });
    expect(dry.body.items[0].kind).toBe("expense");
    expect(s.count("ledger_records")).toBe(0);

    const first = await call(CREATE, {
      records: [expense()],
      idempotency_key: "spec-create",
    });
    const again = await call(CREATE, {
      records: [expense()],
      idempotency_key: "spec-create",
    });
    expect(again.body).toEqual({ ...first.body, replayed: true });
    expect(s.count("ledger_records")).toBe(1);
  });

  it("replays a retry before anything is resolved: the same record, nothing saved twice", async () => {
    const s = seed();
    const { call } = await serve(s.db, OWNER());
    const input = {
      records: [
        expense({
          owed: true,
          paid_from: undefined,
          new_contact: { name: "Retry Trading Sdn Bhd" },
        }),
      ],
      idempotency_key: "f0-create-retry",
    };
    const first = await call(CREATE, input);
    expect(first.body.saved).toBe(true);
    const records = s.count("ledger_records");
    const contacts = s.count("contacts");

    const again = await call(CREATE, input);
    expect(again.isError).toBe(false);
    expect(again.body).toEqual({ ...first.body, replayed: true });
    expect(again.body.items[0].record).toBe(first.body.items[0].record);
    expect(s.count("ledger_records")).toBe(records);
    expect(s.count("contacts")).toBe(contacts);

    // Without the key, the same item meets the contact it created.
    const unreplayed = await call(CREATE, { records: input.records });
    expect(unreplayed.body.error.items[0].error.code).toBe("AMBIGUOUS");

    // The key with other input is refused, and saves nothing either.
    const other = await call(CREATE, {
      ...input,
      records: [expense({ amount: "99.00" })],
    });
    expect(other.body.error.code).toBe("IDEMPOTENCY_MISMATCH");
    expect(s.count("ledger_records")).toBe(records);
  });

  it("answers bad input with INVALID_INPUT and located issues", async () => {
    const s = seed();
    const { call } = await serve(s.db, OWNER());
    const grouped = await call(CREATE, {
      records: [expense({ amount: "1,285.00" })],
    });
    expect(grouped.body.error.code).toBe("INVALID_INPUT");
    expect(grouped.body.error.issues[0].path).toBe("records[0].amount");

    const noMoneySide = await call(CREATE, {
      records: [expense({ paid_from: undefined }), expense({ owed: true })],
    });
    expect(noMoneySide.body.error.code).toBe("INVALID_INPUT");
    expect(noMoneySide.body.error.issues.map((i: Body) => i.path)).toEqual([
      "records[0].paid_from",
      "records[1].owed",
      "records[1].contact",
    ]);

    const tooMany = await call(CREATE, {
      records: Array.from({ length: 51 }, () => expense()),
    });
    expect(tooMany.body.error.code).toBe("INVALID_INPUT");
    expect(tooMany.body.error.message).toContain("Split");
    expect(s.count("ledger_records")).toBe(0);
  });

  it("answers an unknown category with NOT_FOUND and candidates, and saves no item", async () => {
    const s = seed();
    const { call } = await serve(s.db, OWNER());
    const { isError, body } = await call(CREATE, {
      records: [expense(), expense({ category: "Freigth" })],
    });
    expect(isError).toBe(true);
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.items[0]).toMatchObject({ n: 1, ok: true });
    expect(body.error.items[1].error).toMatchObject({
      code: "NOT_FOUND",
      path: "records[1].category",
    });
    expect(body.error.items[1].error.candidates[0].id).toBe(s.freight);
    expect(s.count("ledger_records")).toBe(0);
  });

  it("shows no candidates to a token that may not read accounts", async () => {
    // Candidates name other accounts; the payment tools hide them the same way.
    const s = seed();
    const { call } = await serve(s.db, token(["records.create"]));
    const { isError, body } = await call(CREATE, {
      records: [expense({ category: "Freigth" })],
    });
    expect(isError).toBe(true);
    const failure = body.error.items[0].error;
    expect(failure.code).toBe("NOT_FOUND");
    expect(failure.candidates ?? []).toEqual([]);
    expect(JSON.stringify(failure)).not.toMatch(/freight/i);
    expect(s.count("ledger_records")).toBe(0);
  });

  it("is not offered to a token without records.create", async () => {
    const s = seed();
    const { client } = await serve(
      s.db,
      token(["records.read", "records.update", "records.void"]),
    );
    await expect(
      client.callTool({ name: CREATE, arguments: { records: [expense()] } }),
    ).rejects.toThrow(/not found/);
    expect(s.count("ledger_records")).toBe(0);
  });
});

describe("akaun_change_records", () => {
  it("corrects a settled bill's date into another month only once acknowledged", async () => {
    const s = seed();
    const { bill } = s.settledBill();
    const { call } = await serve(s.db, OWNER());
    const ask = (extra: Record<string, unknown>) =>
      call(CHANGE, {
        update: [
          {
            record: bill.recordNumber,
            expected_version: s.v(bill.id),
            set: { date: "2026-08-28" },
            reason: "The supplier invoice is dated 28 August.",
            ...extra,
          },
        ],
      });
    const unacknowledged = await ask({});
    expect(unacknowledged.body.error.code).toBe("INVALID_INPUT");
    expect(unacknowledged.body.error.items[0].error.message).toContain(
      "acknowledge_period_change",
    );
    const { body } = await ask({ acknowledge_period_change: true });
    expect(body.saved).toBe(true);
    expect(body.items[0]).toMatchObject({
      record: bill.id,
      no: bill.recordNumber,
      paths: ["correct_date"],
      changed: { date: { before: "2026-09-02", after: "2026-08-28" } },
      v: s.v(bill.id),
    });
    expect(getRecord(s.db, bill.id)!.date).toBe("2026-08-28");
  });

  it("updates the descriptions of 8 records in one call", async () => {
    const s = seed();
    const records = Array.from({ length: 8 }, (_, i) =>
      s.bankExpense(`misc ${i}`),
    );
    const { call } = await serve(s.db, OWNER());
    const { body } = await call(CHANGE, {
      update: records.map((r, i) => ({
        record: r.id,
        expected_version: s.v(r.id),
        set: { description: `Office supplies, receipt ${i + 1}` },
      })),
    });
    expect(body.saved).toBe(true);
    expect(body.items).toHaveLength(8);
    body.items.forEach((item: Body, i: number) => {
      expect(item).toMatchObject({
        n: i + 1,
        action: "update",
        label: `update[${i}]`,
        paths: ["update"],
        changed: {
          description: {
            before: `misc ${i}`,
            after: `Office supplies, receipt ${i + 1}`,
          },
        },
      });
      expect(getRecord(s.db, records[i].id)!.description).toBe(
        `Office supplies, receipt ${i + 1}`,
      );
    });
  });

  it("voids a settled bill with release allocations, and suggests it when it is missing", async () => {
    const s = seed();
    const { bill, payment } = s.settledBill();
    const { call } = await serve(s.db, OWNER());
    const item = {
      record: bill.id,
      expected_version: s.v(bill.id),
      reason: "The bill was a duplicate of another one.",
    };
    const refused = await call(CHANGE, { void: [item] });
    expect(refused.body.error.code).toBe("REFUSED");
    const error = refused.body.error.items[0].error;
    expect(error.fix).toContain('release: "allocations"');
    expect(error.release_preview).toEqual({
      allocations: [
        { record: payment.recordNumber, side: "owed", amount: "1200.00" },
      ],
    });

    const { body } = await call(CHANGE, {
      void: [{ ...item, release: "allocations" }],
    });
    expect(body.saved).toBe(true);
    expect(body.items[0]).toMatchObject({
      record: bill.id,
      path: "void",
      reversal: expect.any(String),
      released: {
        allocations: [
          { record: payment.recordNumber, side: "owed", amount: "1200.00" },
        ],
      },
    });
    expect(getRecord(s.db, bill.id)!.voidedByRecordId).not.toBeNull();
    // The payment's whole amount is its credit again.
    expect(contactBalances(s.db, "we-owe", s.acme)[0]?.creditsMinor).toBe(
      128_500,
    );
  });

  it("refuses to delete a settled bill and suggests a void", async () => {
    const s = seed();
    const { bill } = s.settledBill();
    const { call } = await serve(s.db, OWNER());
    const { isError, body } = await call(CHANGE, {
      delete: [{ record: bill.id, expected_version: s.v(bill.id) }],
    });
    expect(isError).toBe(true);
    const error = body.error.items[0].error;
    expect(error.code).toBe("REFUSED");
    expect(error.fix).toContain("void[]");
    expect(error.fix).toContain('release: "allocations"');
    expect(getRecord(s.db, bill.id)).not.toBeNull();

    const loose = s.bankExpense();
    const deleted = await call(CHANGE, {
      delete: [{ record: loose.id, expected_version: s.v(loose.id) }],
    });
    expect(deleted.body.items[0]).toMatchObject({
      record: loose.id,
      deleted: true,
    });
    expect(getRecord(s.db, loose.id)).toBeNull();
  });

  it("answers a stale version with CONFLICT and the current one", async () => {
    const s = seed();
    const record = s.bankExpense();
    const { call } = await serve(s.db, OWNER());
    const { body } = await call(CHANGE, {
      update: [
        {
          record: record.id,
          expected_version: "stale",
          set: { description: "Too late" },
        },
      ],
    });
    expect(body.error.code).toBe("CONFLICT");
    expect(body.error.items[0].error).toMatchObject({
      code: "CONFLICT",
      current_version: s.v(record.id),
    });
  });

  it("refuses void[] from a token without records.void, saving nothing", async () => {
    const s = seed();
    const record = s.bankExpense();
    const { call } = await serve(
      s.db,
      token(["records.read", "records.update"]),
    );
    const { body } = await call(CHANGE, {
      update: [
        {
          record: record.id,
          expected_version: s.v(record.id),
          set: { description: "Changed" },
        },
      ],
      void: [
        {
          record: record.id,
          expected_version: s.v(record.id),
          reason: "Entered by mistake twice.",
        },
      ],
    });
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).toContain("void");
    expect(getRecord(s.db, record.id)!.description).toBe("Paid from the bank");
  });

  it("lists a blocked field with why and what to undo first", async () => {
    const s = seed();
    const { payment } = s.settledBill();
    const { call } = await serve(s.db, OWNER());
    const { body } = await call(CHANGE, {
      update: [
        {
          record: payment.id,
          expected_version: s.v(payment.id),
          set: { date: "2026-09-05" },
          reason: "The payment left the bank on the fifth.",
        },
      ],
    });
    const error = body.error.items[0].error;
    expect(error.code).toBe("REFUSED");
    expect(error.blocked).toEqual([
      { field: "date", why: expect.any(String), fix: expect.any(String) },
    ]);
  });

  const splitInto = (ordinary: string, freight: string) => [
    { category: "Ordinary expenses", amount: ordinary },
    { category: "Freight", amount: freight },
  ];

  /** 100.00 USD at 4.4567, 445.67 in the main currency, from Acme: paid from the bank, or owed (`null`). */
  function usdExpense(
    s: ReturnType<typeof seed>,
    paidFromAccountId: number | null = s.bank,
  ) {
    return resultValue(
      createRecord(s.ctx, {
        kind: "expense",
        date: "2026-09-02",
        amount: 100,
        currency: "USD",
        exchangeRate: 4.4567,
        description: "Imported goods",
        categoryAccountId: s.expense,
        paidFromAccountId,
        contactId: s.acme,
      }),
    ).record;
  }

  it("stores rate 1 when a record moves back to the main currency", async () => {
    const s = seed();
    const record = usdExpense(s);
    const { call } = await serve(s.db, OWNER());
    const { body } = await call(CHANGE, {
      update: [
        {
          record: record.id,
          expected_version: s.v(record.id),
          set: { currency: "MYR", amount: "445.67" },
        },
      ],
    });
    expect(body.saved).toBe(true);
    const after = getRecord(s.db, record.id)!;
    expect(after.currency).toBe("MYR");
    expect(after.exchangeRate).toBe(1);
  });

  it("keeps a main-currency split as sent", async () => {
    const s = seed();
    const record = s.bankExpense("Goods and delivery", 120);
    const { call } = await serve(s.db, OWNER());
    const { body } = await call(CHANGE, {
      update: [
        {
          record: record.id,
          expected_version: s.v(record.id),
          set: { lines: splitInto("70.00", "50.00") },
        },
      ],
    });
    expect(body.saved).toBe(true);
    expect(body.items[0].paths).toEqual(["update"]);
    expect(byAccount(getRecord(s.db, record.id)!)).toEqual({
      [s.bank]: -12_000,
      [s.expense]: 7_000,
      [s.freight]: 5_000,
    });
    expect(
      body.items[0].changed.lines.after.map((line: Body) => line.amount),
    ).toEqual(["70.00", "50.00"]);
  });

  it("reads a foreign-currency record's lines in its own currency", async () => {
    const s = seed();
    const usd = usdExpense(s);
    const { call } = await serve(s.db, OWNER());
    const { body } = await call(CHANGE, {
      update: [
        {
          record: usd.id,
          expected_version: s.v(usd.id),
          set: { lines: [{ category: "Freight", amount: "100.00" }] },
        },
      ],
    });
    expect(body.saved).toBe(true);
    expect(body.items[0].paths).toEqual(["update"]);
    expect(byAccount(getRecord(s.db, usd.id)!)).toEqual({
      [s.bank]: -44_567,
      [s.freight]: 44_567,
    });
    // A line's own figure is kept in the main currency only, and says so.
    expect(body.items[0].changed.lines.after).toEqual([
      { category: expect.stringContaining("Freight"), amount_main: "445.67" },
    ]);
  });

  it("corrects a settled foreign-currency bill with a split in its currency, adding up exactly to its total", async () => {
    const s = seed();
    const payable = accountDefaultId(s.db, DefaultAccountPurpose.Payable)!;
    const bill = usdExpense(s, null);
    resultValue(
      createRecord(s.ctx, {
        kind: "payment",
        date: "2026-09-03",
        amount: 445.67,
        currency: "MYR",
        exchangeRate: 1,
        description: "Imported goods paid",
        paidFromAccountId: s.bank,
        contactId: s.acme,
        direction: "we-pay",
        settlements: [
          {
            owedMovementId: bill.movements.find((m) => m.accountId === payable)!
              .id,
            amountMinor: 44_567,
          },
        ],
      }),
    );
    const { call } = await serve(s.db, OWNER());
    const { body } = await call(CHANGE, {
      update: [
        {
          record: bill.id,
          expected_version: s.v(bill.id),
          // 120.00 USD is 534.80, shared 70 to 50: 311.966... and 222.833...
          set: { amount: "120.00", lines: splitInto("70.00", "50.00") },
          reason: "The supplier invoice adds freight to the goods.",
        },
      ],
    });
    expect(body.saved).toBe(true);
    expect(body.items[0].paths).toEqual(["correct_settled_amount"]);
    const after = getRecord(s.db, bill.id)!;
    expect(after.amountMinor).toBe(53_480);
    expect(byAccount(after)).toEqual({
      [payable]: -53_480,
      [s.expense]: 31_197,
      [s.freight]: 22_283,
    });
    expect(
      body.items[0].changed.lines.after.map((line: Body) => line.amount_main),
    ).toEqual(["311.97", "222.83"]);
  });

  it("checks a foreign-currency split against the amount in the record's currency", async () => {
    const s = seed();
    const usd = usdExpense(s);
    const { call } = await serve(s.db, OWNER());
    const update = (set: Record<string, unknown>) =>
      call(CHANGE, {
        update: [{ record: usd.id, expected_version: s.v(usd.id), set }],
      });

    const short = await update({ lines: splitInto("60.00", "30.00") });
    expect(short.body.error.code).toBe("REFUSED");
    expect(short.body.error.items[0].error.blocked).toEqual([
      {
        field: "lines",
        why: "The lines add up to 90.00 USD, but the record's amount is 100.00 USD.",
        fix: "Send the new amount with the lines, or make the lines add up to the amount.",
      },
    ]);

    const unequal = await update({
      amount: "120.00",
      lines: splitInto("60.00", "30.00"),
    });
    expect(unequal.body.error.code).toBe("INVALID_INPUT");
    expect(unequal.body.error.issues).toEqual([
      {
        path: "update[0].set.lines",
        message: "The lines add up to 90.00, but the amount is 120.00.",
      },
    ]);

    // At 0.0001 the whole 100.00 is one cent: a 0.01 line comes to nothing.
    const tiny = await update({
      exchange_rate: 0.0001,
      lines: splitInto("99.99", "0.01"),
    });
    expect(tiny.body.error.code).toBe("INVALID_INPUT");
    expect(tiny.body.error.items[0].error.path).toBe(
      "update[0].set.lines[1].amount",
    );
    expect(getRecord(s.db, usd.id)!.amountMinor).toBe(44_567);
  });

  it("answers an unknown record with NOT_FOUND, and bad input with INVALID_INPUT", async () => {
    const s = seed();
    const record = s.bankExpense();
    const { call } = await serve(s.db, OWNER());
    const missing = await call(CHANGE, {
      update: [
        {
          record: "EXP-1999-0001",
          expected_version: "x",
          set: { remark: "?" },
        },
      ],
    });
    expect(missing.body.error.code).toBe("NOT_FOUND");
    expect(missing.body.error.items[0].error.path).toBe("update[0].record");

    const empty = await call(CHANGE, {
      update: [
        { record: record.id, expected_version: s.v(record.id), set: {} },
      ],
    });
    expect(empty.body.error).toMatchObject({
      code: "INVALID_INPUT",
      issues: [{ path: "update[0].set", message: expect.any(String) }],
    });
    const unknown = await call(CHANGE, {
      update: [
        {
          record: record.id,
          expected_version: s.v(record.id),
          set: { colour: "red" },
        },
      ],
    });
    expect(unknown.body.error.code).toBe("INVALID_INPUT");
    const nothing = await call(CHANGE, {});
    expect(nothing.body.error.code).toBe("INVALID_INPUT");
  });
});

describe("akaun_attach_file", () => {
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(64),
  ]);
  afterEach(() => reset("mcp-attach:1"));

  async function setup() {
    const s = seed();
    const storageRoot = mkdtempSync(join(tmpdir(), "akaun-attach-v2-"));
    cleanups.push(() => rmSync(storageRoot, { recursive: true, force: true }));
    const served = await serve(s.db, OWNER(), storageRoot);
    return { s, record: s.bankExpense(), ...served };
  }

  it("attaches a file into the temp store, answering v1's shape", async () => {
    const { s, record, call, storageRoot } = await setup();
    const { isError, body, structured } = await call(ATTACH, {
      recordId: record.id,
      filename: "receipt.png",
      contentBase64: png.toString("base64"),
    });
    expect(isError).toBe(false);
    expect(structured).toEqual(body);
    expect(body.meta).toMatchObject({
      mainCurrency: "MYR",
      minorUnitScale: 100,
    });
    expect(body.data).toMatchObject({
      attachment: { id: expect.any(Number), displayName: "receipt.png" },
      recordId: record.id,
      version: s.v(record.id),
    });
    const stored = s.db.select().from(schema.recordAttachments).get()!;
    expect(existsSync(join(storageRoot, stored.filename))).toBe(true);
  });

  it("refuses a file whose bytes are not PDF, JPEG or PNG, and stores nothing", async () => {
    const { record, call, storageRoot } = await setup();
    const { isError, body } = await call(ATTACH, {
      recordId: record.id,
      filename: "receipt.pdf",
      contentBase64: Buffer.from("MZ not a pdf").toString("base64"),
    });
    expect(isError).toBe(true);
    expect(body.error.code).toBe("UNSUPPORTED_MEDIA_TYPE");
    expect(readdirSync(storageRoot)).toHaveLength(0);
  });

  it("accepts a file larger than the ordinary request limit", async () => {
    const { record, call } = await setup();
    const pdf = Buffer.concat([
      Buffer.from("%PDF-1.4\n"),
      Buffer.alloc(300 * 1024, 0x20),
    ]);
    const { body } = await call(ATTACH, {
      recordId: record.id,
      filename: "big.pdf",
      contentBase64: pdf.toString("base64"),
    });
    expect(body.data.attachment.id).toBeGreaterThan(0);
  });

  it("answers an unknown record with NOT_FOUND and bad input with INVALID_INPUT", async () => {
    const { call } = await setup();
    const missing = await call(ATTACH, {
      recordId: 99_999,
      filename: "receipt.png",
      contentBase64: png.toString("base64"),
    });
    expect(missing.body.error.code).toBe("NOT_FOUND");
    const bad = await call(ATTACH, { recordId: 1, filename: "x.png" });
    expect(bad.body.error.code).toBe("INVALID_INPUT");
  });
});

describe("splitByLargestRemainder", () => {
  it("shares a total out exactly, the cents left over to the largest remainders", () => {
    // 445.67 over two equal lines: 222.835 each, the odd cent to the first.
    expect(splitByLargestRemainder(44_567, [5_000, 5_000])).toEqual([
      22_284, 22_283,
    ]);
    expect(splitByLargestRemainder(44_567, [3_333, 6_667])).toEqual([
      14_854, 29_713,
    ]);
    expect(splitByLargestRemainder(100, [1, 1, 1])).toEqual([34, 33, 33]);
    // A total the weights already add up to: the weights themselves.
    expect(splitByLargestRemainder(12_000, [7_000, 5_000])).toEqual([
      7_000, 5_000,
    ]);
    // No product loses a digit, however large.
    expect(splitByLargestRemainder(9_000_000_000_000, [3, 7])).toEqual([
      2_700_000_000_000, 6_300_000_000_000,
    ]);
  });

  it("keeps every part within a cent of its share, and the sum exact", () => {
    const weights = Array.from({ length: 50 }, (_, i) => 101 + i * 37);
    const weightSum = weights.reduce((sum, w) => sum + w, 0);
    for (const total of [1, 987_654, 1_234_567_891]) {
      const parts = splitByLargestRemainder(total, weights);
      expect(parts.reduce((sum, part) => sum + part, 0)).toBe(total);
      parts.forEach((part, i) =>
        expect(Math.abs(part - (total * weights[i]) / weightSum)).toBeLessThan(
          1,
        ),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The evaluation book: the realistic cases
// ---------------------------------------------------------------------------

const SLOW = 120_000;
let evalBook: Promise<EvalBook> | undefined;
let evalUsers = 0;

/** Tests that share one evaluation book, built on first use and removed after the last. */
function withEvalBook(name: string, check: (book: EvalBook) => Promise<void>) {
  evalUsers += 1;
  it(
    name,
    async () => {
      evalBook ??= buildEvalBook({
        dir: mkdtempSync(join(tmpdir(), "akaun-records-writes-eval-")),
        variant: "A",
        today: localToday(),
      });
      const book = await evalBook;
      try {
        await check(book);
      } finally {
        evalUsers -= 1;
        if (evalUsers === 0) {
          book.raw.close();
          rmSync(book.dir, { recursive: true, force: true });
        }
      }
    },
    SLOW,
  );
}

describe("the evaluation book", () => {
  withEvalBook("keeps fixture nouns out of every description", async (book) => {
    const text = recordsWriteTools
      .map((tool) => tool.description)
      .join("\n")
      .toLowerCase();
    for (const noun of book.manifest.nouns)
      expect(text.includes(noun.toLowerCase()), noun).toBe(false);
  });

  withEvalBook(
    "corrects the freight case end to end: dry run, then save",
    async (book) => {
      const plant = book.manifest.plants.freightLeftOut;
      const { call } = await serve(
        book.db,
        patLocals(book.db, `Bearer ${book.agentToken}`)!,
        book.storageRoot,
      );
      const bill = getRecord(book.db, plant.bill)!;
      const update = {
        record: bill.recordNumber,
        expected_version: recordVersion(book.db, plant.bill),
        set: {
          amount: money(plant.totalMinor),
          lines: [
            { category: plant.goodsAccount, amount: money(plant.goodsMinor) },
            {
              category: plant.freightAccount,
              amount: money(plant.freightMinor),
            },
          ],
        },
        reason: "The supplier invoice adds freight to the goods.",
      };
      const before = recordVersion(book.db, plant.bill);

      const dry = await call(CHANGE, { update: [update], dry_run: true });
      expect(dry.isError).toBe(false);
      expect(dry.body).toMatchObject({ saved: false, dry_run: true });
      expect(dry.body.items[0]).toMatchObject({
        paths: ["correct_settled_amount"],
        changed: {
          amount: {
            before: money(plant.recordedMinor),
            after: money(plant.totalMinor),
          },
        },
        reversed: [{ amount: money(plant.recordedMinor) }],
        reapplied: [{ amount: money(plant.totalMinor) }],
      });
      expect(recordVersion(book.db, plant.bill)).toBe(before);

      const { body } = await call(CHANGE, { update: [update] });
      expect(body.saved).toBe(true);
      expect(body.items[0].paths).toEqual(["correct_settled_amount"]);
      const after = getRecord(book.db, plant.bill)!;
      expect(after.amountMinor).toBe(plant.totalMinor);
      expect(after.paid).toBe(true);
      const balance = contactBalances(book.db, "we-owe", plant.supplier)[0];
      expect(balance?.outstandingMinor ?? 0).toBe(0);
      expect(balance?.creditsMinor ?? 0).toBe(0);
    },
  );

  withEvalBook(
    "moves a record to its receipt's date in another month",
    async (book) => {
      const plant = book.manifest.plants.wrongDate;
      const { call } = await serve(
        book.db,
        patLocals(book.db, `Bearer ${book.agentToken}`)!,
        book.storageRoot,
      );
      const { body } = await call(CHANGE, {
        update: [
          {
            record: plant.record,
            expected_version: recordVersion(book.db, plant.record),
            set: { date: plant.receiptDate },
            reason: "The receipt is dated earlier than the record.",
            acknowledge_period_change: true,
          },
        ],
      });
      expect(body.saved).toBe(true);
      // Paid from the card, neither settled nor bank-matched: the router
      // picks a plain edit. The correction path is covered above on a
      // settled bill.
      expect(body.items[0].paths).toEqual(["update"]);
      expect(body.items[0].changed.date).toEqual({
        before: plant.recordedDate,
        after: plant.receiptDate,
      });
      expect(getRecord(book.db, plant.record)!.date).toBe(plant.receiptDate);
    },
  );
});

const money = (minor: number) => formatMinor(minor);

/** A record's sides as `{ accountId: amountMinor }`. */
const byAccount = (record: RecordView) =>
  Object.fromEntries(record.movements.map((m) => [m.accountId, m.amountMinor]));
