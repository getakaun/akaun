import { describe, expect, it } from "vitest";
import { GET as dashboardGET } from "../../dashboard/stream/+server.js";
import { GET } from "./+server.js";
import { localsFor } from "$lib/server/permissions/test-locals.js";
import { ledgerEvents, accountEvents } from "$lib/server/ledger/events.js";
import { contactEvents } from "$lib/server/finance/events.js";
const request = (locals: App.Locals) =>
  GET({ locals } as Parameters<typeof GET>[0]);

describe("live report invalidation", () => {
  it("requires a signed-in reports reader", async () => {
    expect((await request({} as App.Locals)).status).toBe(401);
    expect((await request(localsFor(["records.read"]))).status).toBe(403);
  });
  it("refreshes for posting, account classification and partner changes without exposing directory data", async () => {
    const sources = [
      [ledgerEvents, "record-update"],
      [accountEvents, "account-update"],
      [contactEvents, "contact-update"],
    ] as const;
    const counts = sources.map(([emitter, name]) =>
      emitter.listenerCount(name),
    );
    const response = await request(localsFor(["reports.read"]));
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    try {
      expect(new TextDecoder().decode((await reader.read()).value)).toBe(
        'data: {"type":"data-changed"}\n\n',
      );
      for (const [emitter, name] of sources) {
        emitter.emit(name, {
          record: { description: "private journal" },
          account: { name: "private account" },
          item: { legalName: "private contact" },
        });
        const frame = new TextDecoder().decode((await reader.read()).value);
        expect(frame).toBe('data: {"type":"data-changed"}\n\n');
      }
    } finally {
      await reader.cancel();
    }
    sources.forEach(([emitter, name], i) =>
      expect(emitter.listenerCount(name)).toBe(counts[i]),
    );
  });
  it("resynchronizes dashboard totals on connect and reconnect", async () => {
    for (let i = 0; i < 2; i++) {
      const response = await dashboardGET({
        locals: localsFor(["dashboard.read"]),
      } as Parameters<typeof dashboardGET>[0]);
      const reader = response.body!.getReader();
      try {
        expect(new TextDecoder().decode((await reader.read()).value)).toBe(
          'data: {"type":"data-changed"}\n\n',
        );
      } finally {
        await reader.cancel();
      }
    }
  });
});
