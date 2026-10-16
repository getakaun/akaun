import { describe, expect, it } from "vitest";
import {
  currentAuditScope,
  runAsSystem,
  runInAuditScope,
  scopeFromLocals,
} from "./audit-context.js";

describe("audit scope", () => {
  it("is the system, with no request, when nothing opened one", () => {
    expect(currentAuditScope()).toMatchObject({
      via: "system",
      requestId: "",
      credentialId: null,
    });
  });

  it("tells a session, a token and an app apart", () => {
    expect(scopeFromLocals({}, "GET /").via).toBe("session");
    expect(
      scopeFromLocals({ credential: { kind: "pat", tokenId: 7 } }, null),
    ).toMatchObject({ via: "pat", credentialId: "7", clientId: null });
    expect(
      scopeFromLocals(
        { credential: { kind: "oauth", grantId: "g1", clientId: "c1" } },
        "mcp:create_record",
      ),
    ).toMatchObject({
      via: "oauth",
      credentialId: "g1",
      clientId: "c1",
      operation: "mcp:create_record",
    });
  });

  it("gives each scope its own request id", () => {
    expect(scopeFromLocals({}, null).requestId).not.toBe(
      scopeFromLocals({}, null).requestId,
    );
  });

  it("carries across await and timers, and a nested scope wins", async () => {
    const outer = scopeFromLocals(
      { credential: { kind: "pat", tokenId: 1 } },
      "outer",
    );
    const inner = scopeFromLocals({}, "inner");
    await runInAuditScope(outer, async () => {
      await Promise.resolve();
      expect(currentAuditScope()).toBe(outer);
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(currentAuditScope()).toBe(outer);
      await runInAuditScope(inner, async () => {
        await Promise.resolve();
        expect(currentAuditScope()).toBe(inner);
      });
      expect(currentAuditScope()).toBe(outer);
    });
    expect(currentAuditScope().via).toBe("system");
  });

  it("runs detached work as the system, whatever started it", async () => {
    const pat = scopeFromLocals(
      { credential: { kind: "pat", tokenId: 1 } },
      null,
    );
    let detached: Promise<string> | undefined;
    runInAuditScope(pat, () => {
      detached = runAsSystem(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return currentAuditScope().via;
      });
    });
    expect(await detached).toBe("system");
  });
});
