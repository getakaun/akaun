import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import {
  BOOKKEEPER_PERMISSIONS,
  buildEvalBook,
  type EvalBook,
} from "../../__fixtures__/eval-book.js";
import { createServerV2 } from "../../registry.js";
import { patLocals } from "../../../tokens/pat.js";
import { issueTestToken } from "../../../permissions/test-locals.js";
import { contactVersion } from "../../../application/version.js";
import { getContact } from "../../../queries/contacts.js";
import { contactsWriteTools } from "./contacts.js";

// Each test builds its own evaluation book in a folder under os.tmpdir() and
// drives the tool in-process over InMemoryTransport; nothing here imports
// db/client.ts. Also run with the MCP preload to prove it:
//   bun test --preload ./scripts/mcp-test-preload.ts src/lib/server/mcp/tools/writes/contacts.spec.ts

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

async function open(permissions?: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "akaun-e3-contacts-"));
  const book = await buildEvalBook({ dir, variant: "A", today: TODAY });
  const token = permissions
    ? issueTestToken(book.db, book.agentUserId, permissions)
    : book.agentToken;
  const server = createServerV2({
    db: book.db,
    store: book.store,
    storageRoot: book.storageRoot,
    locals: patLocals(book.db, `Bearer ${token}`)!,
    tools: { reads: [], writes: contactsWriteTools },
  });
  const client = new Client({ name: "e3-contacts-spec", version: "1" });
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
      name: "akaun_change_contacts",
      arguments: args,
    });
    const text = (result.content as { type: string; text: string }[])[0].text;
    return { isError: result.isError === true, body: JSON.parse(text), text };
  };
  return { book, client, call };
}

const count = (book: EvalBook, table: string) =>
  (book.raw.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number })
    .n;

/** The contact each of these records names, and its supplier. */
function contactsOf(book: EvalBook, recordIds: number[]) {
  return recordIds.map(
    (id) =>
      book.raw
        .query(
          "SELECT contact_id AS contactId, supplier_contact_id AS supplierId FROM ledger_records WHERE id = ?",
        )
        .get(id) as { contactId: number | null; supplierId: number | null },
  );
}

const exists = (book: EvalBook, id: number) => getContact(book.db, id) !== null;

describe("change_contacts", () => {
  it(
    "lists the tool as destructive, with a short description free of the book's names",
    async () => {
      const { book, client } = await open();
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === "akaun_change_contacts")!;
      expect(tool).toBeTruthy();
      expect(tool.annotations?.destructiveHint).toBe(true);
      expect(tool.description!.length).toBeLessThanOrEqual(1500);
      for (const noun of book.manifest.nouns)
        expect(tool.description!.toLowerCase()).not.toContain(
          noun.toLowerCase(),
        );
      // The two warnings an agent must not miss.
      expect(tool.description).toMatch(/CANNOT BE UNDONE/);
      expect(tool.description).toMatch(/dry_run: true first/);
      expect(tool.description).toMatch(/REPLACES the whole list/);
    },
    SLOW,
  );

  it(
    "creates a contact (dry run first), refuses a repeated name, and updates and deletes it",
    async () => {
      const { book, call } = await open();
      const before = count(book, "contacts");
      const input = {
        name: "Fresh Supplies Sdn Bhd",
        entity: "company",
        roles: ["supplier"],
        email: "hello@fresh.example",
        phone: "03-1234 5678",
      };

      const dry = await call({ create: [input], dry_run: true });
      expect(dry.isError).toBe(false);
      expect(dry.body.saved).toBe(false);
      expect(dry.body.dry_run).toBe(true);
      expect(dry.body.items[0]).toMatchObject({
        n: 1,
        action: "create",
        name: "Fresh Supplies Sdn Bhd",
        entity: "business",
        roles: ["supplier"],
      });
      expect(count(book, "contacts")).toBe(before);

      const saved = await call({ create: [input] });
      expect(saved.isError).toBe(false);
      expect(saved.body.saved).toBe(true);
      expect(saved.body.request_id).toBeTruthy();
      const made = saved.body.items[0];
      expect(made).toMatchObject({
        n: 1,
        action: "create",
        name: "Fresh Supplies Sdn Bhd",
        entity: "business",
        roles: ["supplier"],
      });
      expect(made.v).toBe(contactVersion(book.db, made.id));
      expect(count(book, "contacts")).toBe(before + 1);
      expect(getContact(book.db, made.id)).toMatchObject({
        email: "hello@fresh.example",
        phone: "03-1234 5678",
      });

      // The same name again is AMBIGUOUS, with the existing contact as a candidate.
      const again = await call({
        create: [{ ...input, name: "fresh supplies sdn. bhd." }],
      });
      expect(again.isError).toBe(true);
      expect(again.body.error.code).toBe("AMBIGUOUS");
      const refusal = again.body.error.items[0].error;
      expect(refusal).toEqual({
        code: "AMBIGUOUS",
        message: 'A contact named "fresh supplies sdn. bhd." already exists.',
        path: "create[0].name",
        candidates: [
          { id: made.id, name: "Fresh Supplies Sdn Bhd", detail: "supplier" },
        ],
        fix: "Use the existing contact, or resend with force_new: true.",
      });
      expect(count(book, "contacts")).toBe(before + 1);
      const forced = await call({
        create: [{ ...input, name: "Fresh Supplies Sdn Bhd", force_new: true }],
      });
      expect(forced.body.saved).toBe(true);
      expect(count(book, "contacts")).toBe(before + 2);

      // Update: roles replace the whole list, an empty string clears a field.
      const updated = await call({
        update: [
          {
            contact: made.id,
            expected_version: made.v,
            set: {
              name: "Fresh Supplies Berhad",
              roles: ["supplier", "customer"],
              phone: "",
              remark: "Pays on 30 days",
            },
          },
        ],
      });
      expect(updated.isError).toBe(false);
      const item = updated.body.items[0];
      expect(item.name).toBe("Fresh Supplies Berhad");
      expect(item.changes.name).toEqual({
        from: "Fresh Supplies Sdn Bhd",
        to: "Fresh Supplies Berhad",
      });
      expect(item.changes.roles.to).toEqual(["customer", "supplier"]);
      expect(item.changes.phone).toEqual({ from: "03-1234 5678" });
      expect(item.v).toBe(contactVersion(book.db, made.id));
      expect(getContact(book.db, made.id)).toMatchObject({
        legalName: "Fresh Supplies Berhad",
        phone: null,
        remark: "Pays on 30 days",
      });

      // A stale version is a CONFLICT that carries the current one.
      const stale = await call({
        update: [
          {
            contact: made.id,
            expected_version: made.v,
            set: { email: "other@fresh.example" },
          },
        ],
      });
      expect(stale.isError).toBe(true);
      expect(stale.body.error.items[0].error.code).toBe("CONFLICT");
      expect(stale.body.error.items[0].error.current_version).toBe(item.v);
      expect(getContact(book.db, made.id)!.email).toBe("hello@fresh.example");

      // Delete needs the version too, and works for a contact nothing names.
      const gone = await call({
        delete: [{ contact: made.id, expected_version: item.v }],
      });
      expect(gone.isError).toBe(false);
      expect(gone.body.items[0]).toMatchObject({
        action: "delete",
        id: made.id,
        name: "Fresh Supplies Berhad",
      });
      expect(exists(book, made.id)).toBe(false);
    },
    SLOW,
  );

  it(
    "refuses to delete a contact a record names, with the screen's sentence",
    async () => {
      const { book, call } = await open();
      const id = book.manifest.contacts.spotify;
      const reply = await call({
        delete: [
          { contact: id, expected_version: contactVersion(book.db, id) },
        ],
      });
      expect(reply.isError).toBe(true);
      expect(reply.body.error.code).toBe("REFUSED");
      expect(reply.body.error.items[0].error.message).toMatch(
        /refer to this contact/,
      );
      expect(exists(book, id)).toBe(true);
    },
    SLOW,
  );

  it(
    "answers bad input with INVALID_INPUT and issues, and an empty call with a fix",
    async () => {
      const { book, call } = await open();
      const before = count(book, "contacts");

      const badEntity = await call({
        create: [{ name: "Some Firm", entity: "firm", roles: ["supplier"] }],
      });
      expect(badEntity.isError).toBe(true);
      expect(badEntity.body.error.code).toBe("INVALID_INPUT");
      expect(badEntity.body.error.issues[0].path).toBe("create[0].entity");
      expect(badEntity.body.error.issues[0].message).toMatch(/business/);

      const noRole = await call({
        create: [{ name: "Some Firm", entity: "business", roles: [] }],
      });
      expect(noRole.body.error.code).toBe("INVALID_INPUT");
      expect(noRole.body.error.issues[0].path).toBe("create[0].roles");

      const unknown = await call({
        update: [
          {
            contact: 1,
            expected_version: "x",
            set: { legal_name: "Nope" },
          },
        ],
      });
      expect(unknown.body.error.code).toBe("INVALID_INPUT");
      expect(unknown.body.error.issues[0].message).toMatch(/Unknown field/);

      const emptySet = await call({
        update: [
          {
            contact: book.manifest.contacts.spotify,
            expected_version: "x",
            set: {},
          },
        ],
      });
      expect(emptySet.body.error.code).toBe("INVALID_INPUT");
      expect(emptySet.body.error.issues ?? emptySet.text).toBeTruthy();
      expect(emptySet.text).toMatch(/Nothing to change/);

      const nothing = await call({});
      expect(nothing.body.error.code).toBe("INVALID_INPUT");
      expect(nothing.body.error.fix).toMatch(/create, update, merge or delete/);

      const tooMany = await call({
        delete: Array.from({ length: 51 }, () => ({
          contact: 1,
          expected_version: "x",
        })),
      });
      expect(tooMany.body.error.code).toBe("INVALID_INPUT");
      expect(tooMany.text).toMatch(/Split the work into several calls/);
      expect(count(book, "contacts")).toBe(before);
    },
    SLOW,
  );

  it(
    "reports every contact that cannot be found, together, with candidates",
    async () => {
      const { book, call } = await open();
      const spotify = book.manifest.contacts.spotify;
      const reply = await call({
        update: [
          {
            contact: "Spotifi",
            expected_version: "x",
            set: { email: "a@b.example" },
          },
          {
            contact: 999_999,
            expected_version: "x",
            set: { email: "a@b.example" },
          },
          {
            contact: spotify,
            expected_version: contactVersion(book.db, spotify),
            set: { email: "ok@b.example" },
          },
        ],
      });
      expect(reply.isError).toBe(true);
      expect(reply.body.error.code).toBe("NOT_FOUND");
      expect(reply.body.error.errors).toHaveLength(2);
      const [near, missing] = reply.body.error.errors;
      expect(near.path).toBe("update[0].contact");
      expect(near.candidates[0].name).toBe("Spotify");
      expect(missing.path).toBe("update[1].contact");
      // The valid item was not run either.
      expect(getContact(book.db, spotify)!.email).not.toBe("ok@b.example");
    },
    SLOW,
  );

  it(
    "merges the three Grab contacts after a dry run: the records move, the Shopee decoy is untouched",
    async () => {
      const { book, call } = await open();
      const m = book.manifest;
      const grab = m.plants.duplicateContacts.grab;
      expect(grab).toHaveLength(3);
      const [keep, ...merged] = grab;
      const records = m.plants.duplicateContacts.grabRecords;
      const decoys = m.plants.duplicateContacts.lookalikesNotDuplicates;
      expect(decoys).toContain(m.contacts.shopee);
      const decoyBefore = decoys.map((id) => contactVersion(book.db, id));
      const decoyRecords = [
        m.records.shopeeJul,
        m.records.shopeeExpressJul,
        m.records.shopeeExpressAug,
      ];
      const decoyOwners = contactsOf(book, decoyRecords);
      const versions = Object.fromEntries(
        grab.map((id) => [String(id), contactVersion(book.db, id)]),
      );
      const input = { keep, merge: merged, expected_versions: versions };

      const dry = await call({ merge: [input], dry_run: true });
      expect(dry.isError).toBe(false);
      expect(dry.body.saved).toBe(false);
      expect(dry.body.dry_run).toBe(true);
      const preview = dry.body.items[0];
      expect(preview.action).toBe("merge");
      expect(preview.note).toMatch(/cannot be undone/);
      expect(preview.merged.map((c: Loose) => c.id)).toEqual(merged);
      const listed = preview.merged.flatMap((c: Loose) =>
        c.records.map((r: Loose) => r.id),
      );
      // Every record of the merged contacts is listed, by id and number.
      const movedBefore = records.filter(
        (id) => !contactsOf(book, [id]).every((o) => o.contactId === keep),
      );
      expect(listed.length).toBeGreaterThan(0);
      expect(movedBefore.length).toBeGreaterThanOrEqual(listed.length);
      for (const row of preview.merged.flatMap((c: Loose) => c.records))
        expect(row.no).toMatch(/^[A-Z]+\d+-\d+$/);
      // Nothing changed: all three contacts exist, the records are as they were.
      for (const id of grab) expect(exists(book, id)).toBe(true);
      expect(contactsOf(book, listed).some((o) => o.contactId !== keep)).toBe(
        true,
      );

      const saved = await call({ merge: [input] });
      expect(saved.isError).toBe(false);
      expect(saved.body.saved).toBe(true);
      const done = saved.body.items[0];
      expect(done.kept.id).toBe(keep);
      expect(done.kept.v).toBe(contactVersion(book.db, keep));
      expect(done.merged.map((c: Loose) => c.id)).toEqual(merged);
      expect(
        done.merged.flatMap((c: Loose) => c.records.map((r: Loose) => r.id)),
      ).toEqual(listed);
      expect(done.note).toMatch(/cannot be undone/);

      // The merged contacts are gone and every record names the kept one.
      expect(exists(book, keep)).toBe(true);
      for (const id of merged) expect(exists(book, id)).toBe(false);
      for (const id of listed)
        expect(
          contactsOf(book, [id]).every(
            (o) =>
              (o.contactId === null || o.contactId === keep) &&
              (o.supplierId === null || o.supplierId === keep),
          ),
        ).toBe(true);

      // The lookalikes were not named, so they are exactly as they were.
      expect(decoys.map((id) => contactVersion(book.db, id))).toEqual(
        decoyBefore,
      );
      expect(contactsOf(book, decoyRecords)).toEqual(decoyOwners);
    },
    SLOW,
  );

  it(
    "refuses a merge with a stale or missing version, or a contact named twice, and merges nothing",
    async () => {
      const { book, call } = await open();
      const [keep, a, b] = book.manifest.plants.duplicateContacts.grab;
      const versions = Object.fromEntries(
        [keep, a, b].map((id) => [String(id), contactVersion(book.db, id)]),
      );
      const everyoneThere = () => [keep, a, b].every((id) => exists(book, id));

      const stale = await call({
        merge: [
          {
            keep,
            merge: [a, b],
            expected_versions: { ...versions, [String(a)]: "0000000000000000" },
          },
        ],
      });
      expect(stale.isError).toBe(true);
      expect(stale.body.error.code).toBe("CONFLICT");
      expect(stale.body.error.items[0].error.current_version).toBe(
        versions[String(a)],
      );
      expect(stale.body.error.items[0].error.message).toContain(`#${a}`);

      const missing = await call({
        merge: [
          {
            keep,
            merge: [a, b],
            expected_versions: { [String(keep)]: versions[String(keep)] },
          },
        ],
      });
      expect(missing.isError).toBe(true);
      expect(missing.body.error.code).toBe("INVALID_INPUT");
      expect(missing.body.error.errors ?? [missing.body.error]).toBeTruthy();
      expect(missing.text).toMatch(/version of/);

      const sameAsKeep = await call({
        merge: [{ keep, merge: [keep, a], expected_versions: versions }],
      });
      expect(sameAsKeep.body.error.code).toBe("INVALID_INPUT");
      expect(sameAsKeep.text).toMatch(/more than once/);

      const twoItems = await call({
        merge: [
          { keep, merge: [a], expected_versions: versions },
          { keep, merge: [b], expected_versions: versions },
        ],
      });
      expect(twoItems.body.error.code).toBe("INVALID_INPUT");
      expect(twoItems.text).toMatch(/one merge item per kept contact/i);
      expect(everyoneThere()).toBe(true);
    },
    SLOW,
  );

  it(
    "gives FORBIDDEN on merge to a token without the merge permission, while its other actions work",
    async () => {
      const { book, client, call } = await open(
        BOOKKEEPER_PERMISSIONS.filter((p) => p !== "contacts.merge"),
      );
      const [keep, a] = book.manifest.plants.duplicateContacts.grab;
      const reply = await call({
        merge: [
          {
            keep,
            merge: [a],
            expected_versions: {
              [String(keep)]: contactVersion(book.db, keep),
              [String(a)]: contactVersion(book.db, a),
            },
          },
        ],
      });
      expect(reply.isError).toBe(true);
      expect(reply.body.error.code).toBe("FORBIDDEN");
      expect(reply.body.error.message).toMatch(/merge/);
      expect(reply.body.error.message).toMatch(/contacts\.merge/);
      expect(exists(book, a)).toBe(true);

      // The tool is still there for what the token may do.
      expect((await client.listTools()).tools.map((t) => t.name)).toContain(
        "akaun_change_contacts",
      );
      const made = await call({
        create: [
          {
            name: "Allowed Trading",
            entity: "individual",
            roles: ["customer"],
          },
        ],
      });
      expect(made.body.saved).toBe(true);
    },
    SLOW,
  );

  it(
    "gives FORBIDDEN to a token that may only create, for update and delete",
    async () => {
      const { book, call } = await open(["contacts.read", "contacts.create"]);
      const id = book.manifest.contacts.spotify;
      const v = contactVersion(book.db, id);
      const update = await call({
        update: [
          { contact: id, expected_version: v, set: { email: "x@y.example" } },
        ],
      });
      expect(update.isError).toBe(true);
      expect(update.body.error.code).toBe("FORBIDDEN");
      const del = await call({
        delete: [{ contact: id, expected_version: v }],
      });
      expect(del.body.error.code).toBe("FORBIDDEN");
      expect(getContact(book.db, id)!.email).not.toBe("x@y.example");
    },
    SLOW,
  );

  it(
    "tells a caller who cannot read contacts nothing about existing names",
    async () => {
      const { book, call } = await open(["contacts.update"]);
      const reply = await call({
        update: [
          {
            contact: "Spotifi",
            expected_version: "x",
            set: { email: "a@b.example" },
          },
        ],
      });
      expect(reply.isError).toBe(true);
      expect(reply.body.error.code).toBe("NOT_FOUND");
      expect(reply.body.error.candidates).toBeUndefined();
      expect(reply.text).not.toContain("Spotify");
      expect(exists(book, book.manifest.contacts.spotify)).toBe(true);

      // A create is not told that the name is taken, so it lists no one.
      const { book: other, call: create } = await open(["contacts.create"]);
      const before = count(other, "contacts");
      const made = await create({
        create: [{ name: "Spotify", entity: "business", roles: ["supplier"] }],
      });
      expect(made.isError).toBe(false);
      expect(made.body.items[0].name).toBe("Spotify");
      expect(made.body.items[0].id).not.toBe(other.manifest.contacts.spotify);
      expect(count(other, "contacts")).toBe(before + 1);
    },
    SLOW,
  );

  it(
    "replays a retried delete by name instead of answering NOT_FOUND",
    async () => {
      const { book, call } = await open();
      const made = await call({
        create: [
          {
            name: "Short Lived Trading",
            entity: "business",
            roles: ["supplier"],
          },
        ],
      });
      const { id, v } = made.body.items[0];
      const input = {
        delete: [{ contact: "Short Lived Trading", expected_version: v }],
        idempotency_key: "f0-delete-by-name",
      };
      const first = await call(input);
      expect(first.isError).toBe(false);
      expect(first.body.saved).toBe(true);
      expect(exists(book, id)).toBe(false);
      const before = count(book, "contacts");

      const again = await call(input);
      expect(again.isError).toBe(false);
      expect(again.body).toEqual({ ...first.body, replayed: true });
      expect(count(book, "contacts")).toBe(before);

      // What the replay spares the agent: unkeyed, the name no longer resolves.
      const unkeyed = await call({ delete: input.delete });
      expect(unkeyed.body.error.code).toBe("NOT_FOUND");

      // The key with other input is refused before any name is looked up.
      const other = await call({
        ...input,
        delete: [{ contact: "No Such Trading", expected_version: v }],
      });
      expect(other.body.error.code).toBe("IDEMPOTENCY_MISMATCH");
    },
    SLOW,
  );

  it(
    "returns the first result for a retried call with the same idempotency_key",
    async () => {
      const { book, call } = await open();
      const before = count(book, "contacts");
      const input = {
        create: [
          {
            name: "Once Only Trading",
            entity: "business",
            roles: ["supplier"],
          },
        ],
        idempotency_key: "e3-contacts-once",
      };
      const first = await call(input);
      expect(first.body.saved).toBe(true);
      const second = await call(input);
      expect(second.body.replayed).toBe(true);
      expect(second.body.request_id).toBe(first.body.request_id);
      expect(second.body.items[0].id).toBe(first.body.items[0].id);
      expect(count(book, "contacts")).toBe(before + 1);
      const other = await call({
        ...input,
        create: [
          {
            name: "Different Trading",
            entity: "business",
            roles: ["supplier"],
          },
        ],
      });
      expect(other.body.error.code).toBe("IDEMPOTENCY_MISMATCH");
    },
    SLOW,
  );
});
