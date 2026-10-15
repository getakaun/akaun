import { describe, it, expect, vi } from "vitest";

// The stored-file keys must never be writable here: `/api/company/[image]` serves whatever
// file they name. The real database is never opened — the 400 comes before any
// write, and a stub stands in for the client module.
const written: string[] = [];
vi.mock("$lib/server/db/client.js", () => ({ db: {} }));
vi.mock("$lib/server/settings.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("$lib/server/settings.js")>();
  return {
    ...real,
    setSetting: (_db: unknown, key: string) => written.push(key),
    getSetting: (_db: unknown, key: string) =>
      key === "autoImport.apiKey" ? "sk-very-secret" : "value",
    hasAnyDocuments: () => false,
  };
});

const { GET, PATCH } = await import("./+server.js");
const { localsFor } = await import("$lib/server/permissions/test-locals.js");

function patch(body: Record<string, string>, permissions = ["settings.manage"]) {
  const request = new Request("http://localhost/api/settings", {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return PATCH({ request, locals: localsFor(permissions) } as any);
}

describe("PATCH /api/settings", () => {
  it.each(["company.logoPath", "company.letterheadPath"])(
    "rejects %s",
    async (key) => {
      const res = await patch({ [key]: "records/someone-else.pdf" });
      expect(res.status).toBe(400);
      expect(written).toEqual([]);
    },
  );

  it.each([
    "ledger_upgrade_state",
    "permissions.recordsMerged",
    "ledger_default_account_id",
  ])("rejects the internal key %s", async (key) => {
    const res = await patch({ [key]: "1" });
    expect(res.status).toBe(400);
    expect(written).toEqual([]);
  });

  it("refuses a caller without settings.manage before reading the body", async () => {
    const res = await patch({ "company.name": "x" }, ["settings.read"]);
    expect(res.status).toBe(403);
    expect(written).toEqual([]);
  });

  it("never returns a secret, only whether it is set", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await GET({ locals: localsFor(["settings.read"]) } as any);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("sk-very-secret");
    expect(body["autoImport.apiKey"]).toEqual({ set: true });
    expect(body).not.toHaveProperty("ledger_upgrade_state");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((await GET({ locals: localsFor([]) } as any)).status).toBe(403);
  });
});
