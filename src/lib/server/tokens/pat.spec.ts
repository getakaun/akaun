import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../db/schema.js";
import { groupDelegations, personalAccessTokens, users } from "../db/schema.js";
import type { LedgerDb } from "../ledger/types.js";
import { can, loadRoleAccess } from "../permissions.js";
import { grantGroup } from "../permissions/test-locals.js";
import {
  hashToken,
  isLegacyToken,
  isWellFormedPat,
  LAST_USED_WRITE_MS,
  mintPat,
  patLocals,
} from "./pat.js";
import {
  createToken,
  regenerateToken,
  revokeAllTokens,
  revokeToken,
} from "./manage.js";

let sqlite: Database;
let db: LedgerDb;
const DAY = 24 * 60 * 60 * 1000;
/** The calendar day `days` after `now`, as the date picker sends it. */
const dayAfter = (days: number, now = Date.now()) =>
  new Date(now + days * DAY).toISOString().slice(0, 10);

beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema }) as unknown as LedgerDb;
  migrate(db as never, { migrationsFolder: "drizzle" });
  db.insert(users)
    .values({ id: 1, email: "a@test", username: "a", passwordHash: "x" })
    .run();
  grantGroup(db, {
    name: "Keepers",
    userIds: [1],
    grants: [
      "records.read",
      "records.create",
      "records.adjust",
      "contacts.read",
    ],
    delegations: ["records.read", "records.create", "contacts.read"],
  });
});
afterEach(() => sqlite.close());

function create(
  permissions: string[],
  expiresOn: string | null = dayAfter(30),
  now = Date.now(),
) {
  return createToken(
    db,
    {
      ownerId: 1,
      createdBy: 1,
      owner: loadRoleAccess(db, 1),
      input: { name: `t${Math.random()}`, permissions, expiresOn },
    },
    now,
  );
}

describe("token format", () => {
  it("mints well-formed tokens and refuses a broken checksum", () => {
    const token = mintPat();
    expect(token).toMatch(/^akp_[0-9A-Za-z]{42}$/);
    expect(isWellFormedPat(token)).toBe(true);
    const flipped = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    expect(isWellFormedPat(flipped)).toBe(false);
    expect(isWellFormedPat("akn_" + "0".repeat(48))).toBe(false);
  });

  it("recognises a revoked legacy token, to say what replaced it", () => {
    expect(isLegacyToken(`Bearer akn_${"ab".repeat(24)}`)).toBe(true);
    expect(isLegacyToken(`Bearer ${mintPat()}`)).toBe(false);
  });
});

describe("creating tokens", () => {
  it("stores only a hash, and authenticates with the role ∩ ceiling ∩ token", () => {
    const created = create(["records.read", "contacts.read"]);
    if (!created.ok) throw new Error(created.reason);
    const row = db.select().from(personalAccessTokens).get()!;
    expect(row.tokenHash).toBe(hashToken(created.value.token));
    expect(JSON.stringify(row)).not.toContain(created.value.token);

    const locals = patLocals(db, `Bearer ${created.value.token}`)!;
    expect(locals.credential).toEqual({ kind: "pat", tokenId: row.id });
    expect(can(locals, "records.read")).toBe(true);
    expect(can(locals, "records.create")).toBe(false);
  });

  it("refuses a permission the owner may not delegate", () => {
    const refused = create(["records.adjust"]);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("FORBIDDEN");
  });

  it("follows a narrowed ceiling at once, without touching the token", () => {
    const created = create(["records.read", "records.create"]);
    if (!created.ok) throw new Error(created.reason);
    db.delete(groupDelegations)
      .where(eq(groupDelegations.permission, "records.create"))
      .run();
    const locals = patLocals(db, `Bearer ${created.value.token}`)!;
    expect(can(locals, "records.create")).toBe(false);
    expect(can(locals, "records.read")).toBe(true);
  });

  it("allows no expiry, and any date after today", () => {
    expect(create(["records.read"], null).ok).toBe(true);
    expect(create(["records.read"], dayAfter(3650)).ok).toBe(true);
  });

  it("refuses a past day and anything that is not a real date", () => {
    for (const day of [dayAfter(-1), "2027-02-30", "tomorrow", ""])
      expect(create(["records.read"], day).ok).toBe(false);
    expect(db.select().from(personalAccessTokens).all()).toHaveLength(0);
  });

  it("works until the end of the chosen day, UTC", () => {
    const now = Date.parse("2026-10-15T09:00:00Z");
    const created = create(["records.read"], "2026-10-16", now);
    if (!created.ok) throw new Error(created.reason);
    expect(created.value.view.expiresAt).toBe(
      Date.parse("2026-10-16T23:59:59.999Z"),
    );
  });
});

describe("using and ending tokens", () => {
  it("refuses an expired, revoked or unknown token", () => {
    const now = Date.now();
    const created = create(["records.read"], dayAfter(1, now), now);
    if (!created.ok) throw new Error(created.reason);
    const header = `Bearer ${created.value.token}`;
    expect(patLocals(db, header, now + 3 * DAY)).toBeNull();
    expect(patLocals(db, header, now)).not.toBeNull();
    revokeToken(db, 1, created.value.view.id);
    expect(patLocals(db, header, now)).toBeNull();
    expect(patLocals(db, `Bearer ${mintPat()}`)).toBeNull();
  });

  it("writes last-used at most once a minute", () => {
    const now = Date.now();
    const created = create(["records.read"], dayAfter(30, now), now);
    if (!created.ok) throw new Error(created.reason);
    const header = `Bearer ${created.value.token}`;
    patLocals(db, header, now);
    patLocals(db, header, now + 1000);
    expect(db.select().from(personalAccessTokens).get()!.lastUsedAt).toBe(now);
    patLocals(db, header, now + LAST_USED_WRITE_MS);
    expect(db.select().from(personalAccessTokens).get()!.lastUsedAt).toBe(
      now + LAST_USED_WRITE_MS,
    );
  });

  it("regenerates a secret: the old one stops working, the expiry stays", () => {
    const created = create(["records.read"]);
    if (!created.ok) throw new Error(created.reason);
    const again = regenerateToken(db, {
      ownerId: 1,
      tokenId: created.value.view.id,
      owner: loadRoleAccess(db, 1),
    });
    if (!again.ok) throw new Error(again.reason);
    expect(again.value.view.expiresAt).toBe(created.value.view.expiresAt);
    expect(patLocals(db, `Bearer ${created.value.token}`)).toBeNull();
    expect(patLocals(db, `Bearer ${again.value.token}`)).not.toBeNull();
  });

  it("revokes every token of a user at once", () => {
    create(["records.read"]);
    create(["contacts.read"]);
    expect(revokeAllTokens(db, 1)).toBe(2);
  });

  it("does not bring an expired token back by regenerating it", () => {
    const now = Date.now();
    const created = create(["records.read"], dayAfter(1, now), now);
    if (!created.ok) throw new Error(created.reason);
    const again = regenerateToken(
      db,
      {
        ownerId: 1,
        tokenId: created.value.view.id,
        owner: loadRoleAccess(db, 1),
      },
      now + 3 * DAY,
    );
    expect(again.ok).toBe(false);
    expect(db.select().from(personalAccessTokens).get()!.tokenHash).toBe(
      hashToken(created.value.token),
    );
  });

  it("gives a token whose stored permissions cannot be read no access at all", () => {
    const created = create(["records.read"]);
    if (!created.ok) throw new Error(created.reason);
    db.update(personalAccessTokens).set({ permissions: "null" }).run();
    const locals = patLocals(db, `Bearer ${created.value.token}`)!;
    expect(locals.permissions?.size).toBe(0);
  });
});
