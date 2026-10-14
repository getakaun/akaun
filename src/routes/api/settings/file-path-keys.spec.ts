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
    hasAnyDocuments: () => false,
  };
});

const { PATCH } = await import("./+server.js");

function patch(body: Record<string, string>) {
  const request = new Request("http://localhost/api/settings", {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return PATCH({ request } as any);
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
});
