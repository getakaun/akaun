import { describe, expect, it } from "vitest";
import { GET } from "./+server.js";
import { localsFor } from "$lib/server/permissions/test-locals.js";
import { taxWorksheetEvents } from "$lib/server/application/tax-worksheets.js";
import { ledgerEvents, accountEvents } from "$lib/server/ledger/events.js";
const request = (locals: App.Locals) =>
  GET({ locals } as Parameters<typeof GET>[0]);
describe("annual tax invalidation", () => {
  it("requires tax.read independently of reports and records access", async () => {
    expect((await request({ user: null } as App.Locals)).status).toBe(403);
    expect(
      (await request(localsFor(["reports.read", "records.read"]))).status,
    ).toBe(403);
  });
  it("resynchronises on connect, sends only signals and removes listeners", async () => {
    const sources = [
      [taxWorksheetEvents, "changed"],
      [ledgerEvents, "record-update"],
      [ledgerEvents, "record-deleted"],
      [accountEvents, "account-update"],
    ] as const;
    const counts = sources.map(([emitter, name]) =>
      emitter.listenerCount(name),
    );
    const response = await request(localsFor(["tax.read"]));
    const reader = response.body!.getReader();
    try {
      expect(new TextDecoder().decode((await reader.read()).value)).toBe(
        'data: {"type":"data-changed"}\n\n',
      );
      for (const [emitter, name] of sources) {
        emitter.emit(name, {
          record: { description: "private receipt" },
          amountMinor: 1000,
          reason: "private tax reason",
        });
        expect(new TextDecoder().decode((await reader.read()).value)).toBe(
          'data: {"type":"data-changed"}\n\n',
        );
      }
    } finally {
      await reader.cancel();
    }
    sources.forEach(([emitter, name], i) =>
      expect(emitter.listenerCount(name)).toBe(counts[i]),
    );
  });
});
