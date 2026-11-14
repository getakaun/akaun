import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { EntityType } from "$lib/enums.js";
import { buildEvalBook, type EvalBook } from "../../__fixtures__/eval-book.js";
import { createServerV2 } from "../../registry.js";
import { patLocals } from "../../../tokens/pat.js";
import { issueTestToken } from "../../../permissions/test-locals.js";
import { contacts } from "../../../db/schema.js";
import { preparePaymentCorrection } from "../../../application/payment-corrections.js";
import { resolvePaymentMovement } from "../../../application/refs.js";
import { contactVersion, recordVersion } from "../../../application/version.js";
import { reviewBooks } from "../../../queries/books-review.js";
import { contactBalances } from "../../../queries/settlements.js";
import { money } from "../../format.js";
import { contactsReadTools } from "./contacts.js";

// Each test builds its own evaluation book under os.tmpdir() and drives the
// tools in-process; nothing here imports db/client.ts. Also run with the MCP
// preload to prove it:
//   bun test --preload ./scripts/mcp-test-preload.ts src/lib/server/mcp/tools/reads/contacts.spec.ts

const TODAY = "2026-11-13";
const SLOW = 60_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function open(permissions?: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "akaun-d2-contacts-"));
  const book = await buildEvalBook({ dir, variant: "A", today: TODAY });
  const token = permissions
    ? issueTestToken(book.db, book.agentUserId, permissions)
    : book.agentToken;
  const locals = patLocals(book.db, `Bearer ${token}`)!;
  const server = createServerV2({
    db: book.db,
    store: book.store,
    storageRoot: book.storageRoot,
    locals,
    tools: { reads: contactsReadTools, writes: [] },
  });
  const client = new Client({ name: "d2-contacts-spec", version: "1" });
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
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { type: string; text: string }[])[0].text;
    replies.push(text);
    return {
      isError: result.isError === true,
      body: JSON.parse(text) as Loose,
      text,
    };
  };
  return { book, client, call, replies, locals };
}

function keysOf(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) keysOf(v, out);
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysOf(v, out);
    }
  return out;
}

const noInternalIds = (replies: string[]) => {
  for (const text of replies)
    expect(
      [...keysOf(JSON.parse(text))].filter((k) =>
        /movement|settlement/i.test(k),
      ),
    ).toEqual([]);
};

const netOf = (book: EvalBook, id: number) =>
  (contactBalances(book.db, "owed-to-us", id)[0]?.outstandingMinor ?? 0) -
  (contactBalances(book.db, "we-owe", id)[0]?.outstandingMinor ?? 0);

describe("find_contacts", () => {
  it(
    "lists both tools with short descriptions free of the book's names",
    async () => {
      const { book, client } = await open();
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual([
        "akaun_find_contacts",
        "akaun_get_contact",
      ]);
      for (const tool of tools) {
        expect(tool.annotations?.readOnlyHint).toBe(true);
        expect(tool.description!.length).toBeLessThanOrEqual(1500);
        for (const noun of book.manifest.nouns)
          expect(tool.description!.toLowerCase()).not.toContain(
            noun.toLowerCase(),
          );
      }
    },
    SLOW,
  );

  it(
    "finds contacts by query and role, with usage, version and the net balance",
    async () => {
      const { book, call, replies } = await open();
      const found = await call("akaun_find_contacts", { query: "Acme" });
      expect(found.isError).toBe(false);
      const acme = found.body.contacts.find(
        (c: Loose) => c.id === book.manifest.contacts.acme,
      );
      expect(acme).toMatchObject({
        id: book.manifest.contacts.acme,
        v: contactVersion(book.db, book.manifest.contacts.acme),
      });
      expect(acme.roles.length).toBeGreaterThan(0);
      expect(acme.usage).toBeGreaterThan(0);
      expect(found.body.currency).toBe("MYR");
      const net = netOf(book, book.manifest.contacts.acme);
      if (net !== 0) expect(acme.balance).toBe(money(net));
      else expect(acme.balance).toBeUndefined();
      // Concise rows carry no directory details.
      expect(acme.email).toBeUndefined();

      const full = await call("akaun_find_contacts", {
        query: "Acme",
        detail: "full",
      });
      expect(full.body.contacts[0].entity).toBeTypeOf("string");

      const partners = await call("akaun_find_contacts", { role: "partner" });
      expect(partners.body.contacts.map((c: Loose) => c.id)).toEqual([
        book.manifest.contacts.partner,
      ]);
      noInternalIds(replies);
    },
    SLOW,
  );

  it(
    "filters by whether anything is open, and pages with a cursor",
    async () => {
      const { book, call } = await open();
      const owing = await call("akaun_find_contacts", { has_balance: true });
      expect(owing.body.contacts.length).toBeGreaterThan(0);
      for (const c of owing.body.contacts)
        expect(
          contactBalances(book.db, "owed-to-us", c.id).length +
            contactBalances(book.db, "we-owe", c.id).length,
        ).toBeGreaterThan(0);
      const quiet = await call("akaun_find_contacts", { has_balance: false });
      const ids = new Set(owing.body.contacts.map((c: Loose) => c.id));
      for (const c of quiet.body.contacts) expect(ids.has(c.id)).toBe(false);
      expect(owing.body.total + quiet.body.total).toBe(
        (await call("akaun_find_contacts", { limit: 1 })).body.total,
      );

      const first = await call("akaun_find_contacts", { limit: 2 });
      expect(first.body.contacts).toHaveLength(2);
      expect(first.body.next_cursor).toBeTypeOf("string");
      expect(first.body.note).toMatch(/^Showing 1–2 of /);
      const second = await call("akaun_find_contacts", {
        limit: 2,
        cursor: first.body.next_cursor,
      });
      expect(second.body.contacts[0].id).not.toBe(first.body.contacts[0].id);
      const wrong = await call("akaun_find_contacts", {
        limit: 2,
        query: "x",
        cursor: first.body.next_cursor,
      });
      expect(wrong.body.error.code).toBe("INVALID_INPUT");
    },
    SLOW,
  );

  it(
    "lists the books review's duplicate groups: the three names of one supplier together, the lookalikes apart",
    async () => {
      const { book, call, replies } = await open();
      const plants = book.manifest.plants.duplicateContacts;
      const { isError, body } = await call("akaun_find_contacts", {
        duplicates: true,
      });
      expect(isError).toBe(false);

      // The groups review_books' duplicate_contacts reports, in its order:
      // its next call is this one, and must show the same groups.
      const review = reviewBooks(book.db, {
        checks: ["duplicate_contacts"],
        perCheck: 50,
        can: () => true,
        today: TODAY,
      });
      const finding = review.findings.find(
        (f) => f.check === "duplicate_contacts",
      )!;
      expect(finding.next).toEqual({
        tool: "find_contacts",
        args: { duplicates: true },
      });
      expect(body.total).toBe(finding.count);
      expect(
        body.groups.map((g: Loose) => g.contacts.map((c: Loose) => c.id)),
      ).toEqual(
        finding.items.map((item) => [
          item.ref!.id,
          ...(item.related ?? []).map((r) => r.id),
        ]),
      );

      const groupOf = (ids: number[]) =>
        body.groups.find((g: Loose) =>
          ids.some((id) => g.contacts.some((c: Loose) => c.id === id)),
        );
      // P1: one supplier under three names is one group, kept by the
      // contact with the registration number.
      const grab = groupOf(plants.grab);
      expect(
        grab.contacts
          .map((c: Loose) => c.id)
          .sort((a: number, b: number) => a - b),
      ).toEqual([...plants.grab].sort((a, b) => a - b));
      expect(grab.matched_on).toEqual(
        expect.arrayContaining([
          "registration_no_in_documents",
          "name_without_suffix",
        ]),
      );
      expect(grab.keep_hint).toEqual({
        id: book.manifest.contacts.grabCompany,
        name: grab.contacts[0].name,
        why: "it has a registration number",
      });
      expect(grab.contacts[0]).toMatchObject({
        id: book.manifest.contacts.grabCompany,
        roles: expect.any(Array),
        usage: expect.any(Number),
        v: contactVersion(book.db, book.manifest.contacts.grabCompany),
      });
      // Two contacts that only look alike are never grouped, together or apart.
      const [shopee, express] = plants.lookalikesNotDuplicates;
      expect(groupOf([shopee])).toBeUndefined();
      expect(groupOf([express])).toBeUndefined();
      expect(body.total).toBe(body.groups.length);

      const narrowed = await call("akaun_find_contacts", {
        duplicates: true,
        query: "grab",
      });
      expect(narrowed.body.groups.length).toBeGreaterThan(0);
      for (const g of narrowed.body.groups)
        expect(g.contacts.some((c: Loose) => /grab/i.test(c.name))).toBe(true);
      const none = await call("akaun_find_contacts", {
        duplicates: true,
        query: "no such supplier",
      });
      expect(none.body.groups).toBeUndefined();
      noInternalIds(replies);
    },
    SLOW,
  );

  it(
    "groups names that differ only by a company suffix, and says so",
    async () => {
      const { book, call } = await open();
      const insert = (legalName: string) =>
        book.db
          .insert(contacts)
          .values({
            entityType: EntityType.Business,
            legalName,
            createdBy: 1,
            updatedBy: 1,
          })
          .returning({ id: contacts.id })
          .get().id;
      const a = insert("Zenith Packaging Sdn Bhd");
      const b = insert("Zenith Packaging");
      const { body } = await call("akaun_find_contacts", { duplicates: true });
      const group = body.groups.find((g: Loose) =>
        [a, b].every((id) => g.contacts.some((c: Loose) => c.id === id)),
      );
      expect(group.matched_on).toEqual(["name_without_suffix"]);
      expect(group.contacts.map((c: Loose) => c.id)).toEqual([a, b]);
      expect(group.keep_hint).toEqual({
        id: a,
        name: "Zenith Packaging Sdn Bhd",
        why: "its name reads as a registered company name",
      });
    },
    SLOW,
  );

  it(
    "refuses a balance filter without records read, and bad input",
    async () => {
      const directory = await open(["contacts.read"]);
      const plain = await directory.call("akaun_find_contacts", {});
      expect(plain.isError).toBe(false);
      expect(plain.body.contacts[0].balance).toBeUndefined();
      const refused = await directory.call("akaun_find_contacts", {
        has_balance: true,
      });
      expect(refused.isError).toBe(true);
      expect(refused.body.error.code).toBe("FORBIDDEN");
      expect(refused.body.error.message).toContain("records.read");

      const { call } = await open();
      const bad = await call("akaun_find_contacts", { role: "plumber" });
      expect(bad.body.error.code).toBe("INVALID_INPUT");
      expect(JSON.stringify(bad.body.error.issues)).toContain("customer");
      const mixed = await call("akaun_find_contacts", {
        duplicates: true,
        role: "supplier",
      });
      expect(mixed.body.error.code).toBe("INVALID_INPUT");
      expect(
        (await call("akaun_find_contacts", { limit: 500 })).body.error.code,
      ).toBe("INVALID_INPUT");
    },
    SLOW,
  );
});

describe("get_contact", () => {
  it(
    "reads balances, open items, credits, category usage and recent records",
    async () => {
      const { book, call, replies, locals } = await open();
      const supplier = book.manifest.plants.freightLeftOut.supplier;
      const { isError, body } = await call("akaun_get_contact", {
        contact: supplier,
      });
      expect(isError).toBe(false);
      expect(body).toMatchObject({
        id: supplier,
        currency: "MYR",
        v: contactVersion(book.db, supplier),
      });
      expect(body.name).toBeTypeOf("string");
      const net = netOf(book, supplier);
      expect(body.balances.net).toBe(money(net));
      expect(body.balances.receivable).toBe(
        money(
          contactBalances(book.db, "owed-to-us", supplier)[0]
            ?.outstandingMinor ?? 0,
        ),
      );
      expect(body.balances.payable).toBe(
        money(
          contactBalances(book.db, "we-owe", supplier)[0]?.outstandingMinor ??
            0,
        ),
      );

      // P7: the full payment left credit: a payment in credits with its allocations_v.
      const freight = book.manifest.plants.freightLeftOut;
      const credit = body.credits.find((c: Loose) => c.id === freight.payment);
      expect(credit).toBeTruthy();
      expect(credit.direction).toBe("we_owe");
      expect(credit.outstanding).toBe(money(freight.creditMinor));
      const movement = resolvePaymentMovement(
        { db: book.db, locals },
        freight.payment,
      );
      expect(movement.ok).toBe(true);
      const prepared = preparePaymentCorrection(
        { db: book.db, locals },
        (movement as Loose).value.movementId,
      );
      expect(credit.allocations_v).toBe((prepared as Loose).value.version);
      expect(body.balances.credit).toBe(money(freight.creditMinor));

      expect(body.recent.length).toBeGreaterThan(0);
      expect(body.recent.length).toBeLessThanOrEqual(10);
      for (const row of body.recent)
        expect(row.v).toBe(recordVersion(book.db, row.id));
      expect(body.recent[0]).toMatchObject({ kind: expect.any(String) });
      expect(body.category_usage.length).toBeLessThanOrEqual(5);
      expect(body.category_usage[0]).toMatchObject({
        category: expect.any(String),
        count: expect.any(Number),
      });
      expect(body.recent_drill.tool).toBe("akaun_search_records");
      noInternalIds(replies);
    },
    SLOW,
  );

  it(
    "lists open items oldest first with direction, outstanding and age",
    async () => {
      const { book, call } = await open();
      const { body } = await call("akaun_get_contact", {
        contact: contactBalances(book.db, "we-owe")[0].contactId,
      });
      expect(body.open_items.length).toBeGreaterThan(0);
      const dates = body.open_items.map((i: Loose) => i.date);
      expect([...dates].sort()).toEqual(dates);
      for (const item of body.open_items) {
        expect(item).toMatchObject({
          no: expect.any(String),
          direction: expect.stringMatching(/^(owed_to_us|we_owe)$/),
          outstanding: expect.stringMatching(/^-?\d+\.\d{2}$/),
          days_overdue: expect.any(Number),
        });
      }
    },
    SLOW,
  );

  it(
    "takes an id or exact name, and answers NOT_FOUND, AMBIGUOUS and INVALID_INPUT",
    async () => {
      const { book, call } = await open();
      const id = book.manifest.contacts.acme;
      const byId = await call("akaun_get_contact", { contact: id });
      const byName = await call("akaun_get_contact", {
        contact: byId.body.name.toLowerCase(),
      });
      expect(byName.body.id).toBe(id);

      const missing = await call("akaun_get_contact", {
        contact: "Acme Tradng",
      });
      expect(missing.isError).toBe(true);
      expect(missing.body.error.code).toBe("NOT_FOUND");
      expect(missing.body.error.candidates[0].id).toBe(id);

      book.db
        .insert(contacts)
        .values({
          entityType: EntityType.Business,
          legalName: byId.body.name,
          createdBy: 1,
          updatedBy: 1,
        })
        .run();
      const twin = await call("akaun_get_contact", { contact: byId.body.name });
      expect(twin.body.error.code).toBe("AMBIGUOUS");
      expect(twin.body.error.candidates.length).toBe(2);

      const bad = await call("akaun_get_contact", {});
      expect(bad.body.error.code).toBe("INVALID_INPUT");
      expect(bad.body.error.issues[0].path).toBe("contact");
    },
    SLOW,
  );

  it(
    "is offered only to a caller who may read contacts and records",
    async () => {
      const directory = await open(["contacts.read"]);
      expect(
        (await directory.client.listTools()).tools.map((t) => t.name),
      ).toEqual(["akaun_find_contacts"]);
    },
    SLOW,
  );
});
