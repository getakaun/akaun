import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "./db/schema.js";
import { userGrants, users } from "./db/schema.js";
import type { LedgerDb } from "./ledger/types.js";
import {
  can,
  effectivePermissions,
  loadRoleAccess,
  type RoleAccess,
} from "./permissions.js";
import { grantGroup, localsFor } from "./permissions/test-locals.js";
import { trimDelegations } from "./admin/access.js";

let sqlite: Database;
let db: LedgerDb;

beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema }) as unknown as LedgerDb;
  migrate(db as never, { migrationsFolder: "drizzle" });
  db.insert(users)
    .values([
      { id: 1, email: "a@test", username: "a", passwordHash: "x" },
      { id: 2, email: "b@test", username: "b", passwordHash: "x" },
    ])
    .run();
});
afterEach(() => sqlite.close());

const role = (leaves: string[], delegable: string[] = leaves): RoleAccess => ({
  isSuperuser: false,
  leaves: new Set(leaves) as RoleAccess["leaves"],
  delegable: new Set(delegable) as RoleAccess["delegable"],
});

describe("effectivePermissions", () => {
  it("gives a session the whole role", () => {
    expect([
      ...effectivePermissions(role(["records.read", "records.adjust"])),
    ]).toEqual(["records.read", "records.adjust"]);
  });

  it("bounds a credential by what the role may delegate", () => {
    const r = role(
      ["records.read", "records.create", "records.adjust"],
      ["records.read"],
    );
    expect([
      ...effectivePermissions(r, [
        "records.read",
        "records.create",
        "records.adjust",
      ]),
    ]).toEqual(["records.read"]);
  });

  it("expands a credential's root, never to an explicit leaf", () => {
    const r = role(["records.read", "records.create", "records.adjust"]);
    expect([...effectivePermissions(r, ["records"])].sort()).toEqual([
      "records.create",
      "records.read",
    ]);
  });

  it("bounds a superuser's token by the token", () => {
    const locals = localsFor([], {
      superuser: true,
      credential: ["contacts.read"],
    });
    expect(can(locals, "contacts.read")).toBe(true);
    expect(can(locals, "records.adjust")).toBe(false);
    expect(can(locals, "users.manage")).toBe(false);
  });

  it("never lets a token hold users.manage", () => {
    const locals = localsFor([], {
      superuser: true,
      credential: ["users.manage"],
    });
    expect(can(locals, "users.manage")).toBe(false);
  });
});

describe("loadRoleAccess", () => {
  it("unions groups and adds the user's own grants, which are never delegable", () => {
    grantGroup(db, { name: "A", userIds: [1], grants: ["records.read"] });
    grantGroup(db, {
      name: "B",
      userIds: [1],
      grants: ["contacts.read"],
      delegations: [],
    });
    db.insert(userGrants)
      .values({ userId: 1, permission: "reports.read" })
      .run();
    const access = loadRoleAccess(db, 1);
    expect([...access.leaves].sort()).toEqual([
      "contacts.read",
      "records.read",
      "reports.read",
    ]);
    expect([...access.delegable]).toEqual(["records.read"]);
  });

  it("lets a group delegate only what that same group grants", () => {
    // B tries to delegate what only A grants.
    grantGroup(db, {
      name: "A",
      userIds: [1],
      grants: ["records.update"],
      delegations: [],
    });
    grantGroup(db, {
      name: "B",
      userIds: [1],
      grants: ["records.read"],
      delegations: ["records.read", "records.update"],
    });
    expect([...loadRoleAccess(db, 1).delegable]).toEqual(["records.read"]);
  });

  it("gives a superuser group everything, and every delegable leaf", () => {
    grantGroup(db, {
      name: "Admins",
      userIds: [2],
      grants: [],
      superuser: true,
    });
    const access = loadRoleAccess(db, 2);
    expect(access.isSuperuser).toBe(true);
    expect(access.leaves.has("users.manage")).toBe(true);
    expect(access.delegable.has("users.manage")).toBe(false);
    expect(access.delegable.has("records.adjust")).toBe(true);
  });

  it("never grants a superuser-only leaf through an ordinary group", () => {
    grantGroup(db, {
      name: "Sneaky",
      userIds: [1],
      grants: ["users.manage", "users"],
    });
    expect(loadRoleAccess(db, 1).leaves.has("users.manage")).toBe(false);
  });

  it("gives nobody anything without a group or a grant", () => {
    expect(loadRoleAccess(db, 1).leaves.size).toBe(0);
  });
});

describe("trimDelegations", () => {
  it("keeps only what the group grants and what may be delegated", () => {
    expect(
      trimDelegations(
        ["records.read", "records.update", "users.manage"],
        ["records.read", "records.delete", "users.manage"],
      ),
    ).toEqual(["records.read"]);
  });
});
