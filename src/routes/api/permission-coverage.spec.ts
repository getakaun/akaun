import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

/**
 * Every REST endpoint asks a permission. Settings, the AI providers and the
 * search rebuild once checked only that someone was signed in — and a
 * personal access token is someone signed in. A route is covered when it
 * calls `can`/`canAll` itself, or goes through an operation in `application/`
 * or the reconciliation service, which ask for it.
 */
const ALLOWED_WITHOUT_A_CHECK = new Set([
  // Public facts any signed-in user needs to fill a form.
  "src/routes/api/exchange-rate/+server.ts",
  // The company logo and letterhead, shown on every document.
  "src/routes/api/company/[image]/+server.ts",
]);

function routes(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return routes(path);
    return name === "+server.ts" ? [path] : [];
  });
}

describe("API permission coverage", () => {
  it("has a permission check in every endpoint", () => {
    const missing = routes("src/routes/api").filter(
      (path) =>
        !ALLOWED_WITHOUT_A_CHECK.has(path) &&
        !/\bcan(All)?\(|application\/|services\/reconciliation/.test(
          readFileSync(path, "utf8"),
        ),
    );
    expect(missing).toEqual([]);
  });
});
