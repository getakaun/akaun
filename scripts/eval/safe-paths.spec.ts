import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkInsideTemp,
  checkOutDir,
  checkTempRoot,
  TempDirs,
  type PathRules,
} from "./safe-paths.ts";

// Every path here is under a fresh folder made for the spec in os.tmpdir().
// The "repo" is a FAKE checkout built there, with a `.git` and a `data/`
// holding a sentinel book: nothing points at the real checkout or its data.

let root: string;
let repo: string;
let rules: PathRules;
/** A clean folder that may stand in for the OS temp directory. */
let temp: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "akaun-safe-paths-spec-")));
  repo = join(root, "checkout");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(repo, "data"), { recursive: true });
  writeFileSync(join(repo, "data", "akaun.db"), "the real book");
  writeFileSync(join(repo, "package.json"), "{}");
  temp = join(root, "temp");
  mkdirSync(temp);
  rules = { repoRoot: repo, protectedDirs: [join(root, "live-checkout")] };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const sentinelSurvives = () =>
  expect(readdirSync(join(repo, "data"))).toEqual(["akaun.db"]);

describe("the temp root", () => {
  it("is accepted when it is a clean absolute folder, on its real path", () => {
    expect(checkTempRoot(temp, rules)).toBe(temp);
    symlinkSync(temp, join(root, "temp-link"));
    expect(checkTempRoot(join(root, "temp-link"), rules)).toBe(temp);
  });

  it("refuses a relative, missing or root temp directory", () => {
    expect(() => checkTempRoot("relative/tmp", rules)).toThrow(/absolute/);
    expect(() => checkTempRoot(join(root, "missing"), rules)).toThrow();
    expect(() => checkTempRoot("/", rules)).toThrow();
  });

  it("refuses the checkout, a folder inside it, its data, and one that contains it", () => {
    for (const dir of [
      repo,
      join(repo, "data"),
      root, // contains the checkout
    ])
      expect(() => checkTempRoot(dir, rules), dir).toThrow();
    mkdirSync(join(repo, "work"));
    expect(() => checkTempRoot(join(repo, "work"), rules)).toThrow();
  });

  it("refuses any checkout (a .git above it) and any data folder, whatever repoRoot says", () => {
    const other = join(root, "other-checkout");
    mkdirSync(join(other, ".git"), { recursive: true });
    mkdirSync(join(other, "tmp"));
    expect(() => checkTempRoot(other, rules)).toThrow(/checkout/);
    expect(() => checkTempRoot(join(other, "tmp"), rules)).toThrow(/checkout/);
    mkdirSync(join(temp, "Data"));
    expect(() => checkTempRoot(temp, rules)).toThrow(/data/i);
    mkdirSync(join(root, "data", "tmp"), { recursive: true });
    expect(() => checkTempRoot(join(root, "data", "tmp"), rules)).toThrow(
      /data/,
    );
  });

  it("refuses a protected folder and anything around it", () => {
    mkdirSync(join(root, "live-checkout", "tmp"), { recursive: true });
    expect(() =>
      checkTempRoot(join(root, "live-checkout", "tmp"), rules),
    ).toThrow();
  });
});

describe("folders inside the temp root", () => {
  it("must be strictly inside it, on their real paths", () => {
    expect(checkInsideTemp(join(temp, "a", "b"), temp, rules, "x")).toBe(
      join(temp, "a", "b"),
    );
    for (const dir of [temp, root, join(temp, "..", "elsewhere"), "rel/a"])
      expect(() => checkInsideTemp(dir, temp, rules, "x"), dir).toThrow();
  });

  it("cannot be carried out of it by a symlink, into the data folder or the checkout", () => {
    symlinkSync(join(repo, "data"), join(temp, "to-data"));
    symlinkSync(repo, join(temp, "to-repo"));
    expect(() =>
      checkInsideTemp(join(temp, "to-data", "trial"), temp, rules, "x"),
    ).toThrow();
    expect(() =>
      checkInsideTemp(join(temp, "to-repo", "work"), temp, rules, "x"),
    ).toThrow();
  });

  it("may not be named data anywhere below it", () => {
    expect(() =>
      checkInsideTemp(join(temp, "data", "trial"), temp, rules, "x"),
    ).toThrow(/data/);
  });
});

describe("the results folder (--out)", () => {
  it("may be a safe folder outside the checkout, resolved from the working directory", () => {
    expect(checkOutDir(join(root, "results", "eval"), rules, root)).toBe(
      join(root, "results", "eval"),
    );
    expect(checkOutDir("results", rules, root)).toBe(join(root, "results"));
    expect(existsSync(join(root, "results"))).toBe(false);
  });

  it("is refused in the checkout, its data, any data folder, or a folder that contains them", () => {
    for (const out of [
      join(repo, "data"),
      join(repo, "data", "eval"),
      join(repo, "work", "eval-mcp"),
      repo,
      root,
      "/",
      join(root, "elsewhere", "DATA", "eval"),
      join(root, "live-checkout", "eval"),
    ])
      expect(() => checkOutDir(out, rules, root), out).toThrow();
    // Relative to a working directory inside the checkout.
    expect(() => checkOutDir("data", rules, repo)).toThrow();
    expect(() => checkOutDir("work/eval-mcp", rules, repo)).toThrow();
    sentinelSurvives();
  });

  it("is refused through a symlink into the data folder", () => {
    symlinkSync(join(repo, "data"), join(root, "innocent"));
    expect(() =>
      checkOutDir(join(root, "innocent", "v1"), rules, root),
    ).toThrow();
  });
});

describe("TempDirs", () => {
  it("makes folders inside the temp root and deletes only those", () => {
    const dirs = new TempDirs(temp, rules);
    const made = dirs.make(temp, "akaun-eval-process-");
    const child = dirs.make(made, "trial-");
    expect(made.startsWith(`${temp}/akaun-eval-process-`)).toBe(true);
    writeFileSync(join(child, "file"), "x");
    dirs.remove(child);
    expect(existsSync(child)).toBe(false);
    dirs.remove(made);
    expect(existsSync(made)).toBe(false);
  });

  it("refuses to delete anything it did not make: the data folder, the temp root, a folder it only found", () => {
    const dirs = new TempDirs(temp, rules);
    const found = join(temp, "found");
    mkdirSync(found);
    for (const dir of [join(repo, "data"), repo, temp, found, root])
      expect(() => dirs.remove(dir), dir).toThrow(/did not make/);
    sentinelSurvives();
    expect(existsSync(found)).toBe(true);
  });

  it("refuses to make a folder outside the temp root, or in a data folder", () => {
    const dirs = new TempDirs(temp, rules);
    expect(() => dirs.make(join(repo, "data"), "trial-")).toThrow();
    expect(() => dirs.make(root, "trial-")).toThrow();
    mkdirSync(join(temp, "data"));
    expect(() => dirs.make(join(temp, "data"), "trial-")).toThrow();
    sentinelSurvives();
  });

  it("refuses a temp root that fails the checks", () => {
    expect(() => new TempDirs(repo, rules)).toThrow();
    expect(() => new TempDirs(join(repo, "data"), rules)).toThrow();
  });
});
