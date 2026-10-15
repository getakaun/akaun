import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

/**
 * Nothing authorizes on a superuser flag. `users.manage` is a permission like
 * any other, held only by superuser groups and never by a token or an app;
 * a check on the flag itself let a superuser's API token manage users.
 */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|svelte)$/.test(name) && !name.endsWith(".spec.ts")
      ? [path]
      : [];
  });
}

describe("no superuser checks", () => {
  it("never reads a superuser flag off locals", () => {
    const offenders = [...sources("src/routes"), ...sources("src/lib")].filter(
      (path) =>
        /locals\??\.(role\??\.)?isSuperuser/.test(readFileSync(path, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
