import {
  existsSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where the MCP evaluation may write and what it may delete.
 *
 * The repo's `data/` holds the maintainer's real books, and tooling has
 * deleted it twice (CLAUDE.md, Verification Policy). The evaluation therefore
 * trusts no environment variable about where "temporary" is:
 *
 * - The temp root (`os.tmpdir()`, which follows `TMPDIR`) must be absolute,
 *   exist, and on its real path be clear of every checkout and data folder:
 *   not inside, equal to or containing this checkout or a protected folder,
 *   not under any folder with a `.git` (any checkout), no path segment named
 *   `data`, and no `data` folder directly in it.
 * - Every folder the harness makes, writes or deletes in (the process
 *   sandbox, templates, trials) is strictly inside that root on its real path,
 *   with the same exclusions, so neither `..` nor a symlink carries it out.
 * - The results folder (`--out`) may be anywhere else that passes the same
 *   exclusions, but never in a checkout or a data folder.
 * - `TempDirs.remove` deletes only a folder the same object made with
 *   `mkdtemp`; anything else is refused, whatever path it is given.
 *
 * Pure apart from `TempDirs` and the filesystem reads: the preload, the
 * runner and the trial all use it, and its spec runs it against a fake
 * checkout under a temp folder.
 */

export type PathRules = {
  /** The checkout this harness runs from (its real path). */
  repoRoot: string;
  /** Other folders never to touch or enclose, such as the live checkout. */
  protectedDirs: readonly string[];
};

/** The maintainer's live checkout, whose `data/` is the real book. Named here and nowhere else. */
export const LIVE_CHECKOUT = "/Users/tanghaoquan/Code/akaun";

/** This checkout, the one the harness's own files sit in. */
export const REPO_ROOT = realpathSync(
  fileURLToPath(new URL("../..", import.meta.url)),
);

/** The rules every evaluation process applies. */
export const EVAL_PATH_RULES: PathRules = {
  repoRoot: REPO_ROOT,
  protectedDirs: [LIVE_CHECKOUT, join(LIVE_CHECKOUT, "data")],
};

export class UnsafePathError extends Error {
  override name = "UnsafePathError";
}

/** Paths compare without case: the default macOS and Windows filesystems ignore it. */
const fold = (path: string) => path.toLowerCase();

/** True when `path` is strictly below `root`. */
function below(root: string, path: string): boolean {
  const rel = relative(fold(root), fold(path));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

const same = (a: string, b: string) => fold(resolve(a)) === fold(resolve(b));

/**
 * `path` (absolute) on its real path: the nearest existing ancestor is
 * resolved through every symlink and the rest appended, so a link cannot
 * carry a folder that does not exist yet somewhere else.
 */
export function realPathOf(path: string): string {
  if (!isAbsolute(path))
    throw new UnsafePathError(`${path} is not an absolute path.`);
  let existing = resolve(path);
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    rest.unshift(basename(existing));
    existing = parent;
  }
  return join(realpathSync.native(existing), ...rest);
}

/** The folder above `path` (or `path` itself) that holds a `.git`, if any. */
function enclosingCheckout(path: string): string | null {
  let dir = path;
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Why the real path `real` is no place for the harness, or null when it is clear. */
function exclusion(real: string, rules: PathRules): string | null {
  if (real.split(/[\\/]/).some((segment) => fold(segment) === "data"))
    return "it is in or names a folder called data";
  const guarded = [rules.repoRoot, ...rules.protectedDirs].map((dir) =>
    isAbsolute(dir) ? realPathOf(dir) : resolve(dir),
  );
  for (const dir of guarded) {
    if (same(real, dir)) return `it is ${dir}`;
    if (below(dir, real)) return `it is inside ${dir}`;
    if (below(real, dir)) return `it contains ${dir}`;
  }
  const checkout = enclosingCheckout(real);
  if (checkout)
    return `it is inside the checkout ${checkout} (it holds a .git)`;
  return null;
}

/**
 * The temp root on its real path, or an `UnsafePathError`: `raw` must be
 * absolute and exist, pass every exclusion, and hold no folder named `data`.
 */
export function checkTempRoot(raw: string, rules: PathRules): string {
  const refuse = (why: string) =>
    new UnsafePathError(
      `The OS temp directory (TMPDIR) ${raw || "(empty)"} cannot hold the evaluation: ${why}. Set TMPDIR to a clean absolute folder outside every checkout.`,
    );
  if (!raw || !isAbsolute(raw)) throw refuse("it is not an absolute path");
  let real: string;
  try {
    real = realpathSync.native(raw);
  } catch {
    throw refuse("it does not exist");
  }
  if (dirname(real) === real) throw refuse("it is the filesystem root");
  const why = exclusion(real, rules);
  if (why) throw refuse(why);
  const data = readdirSync(real).find((name) => fold(name) === "data");
  if (data) throw refuse(`it contains a folder called ${data}`);
  return real;
}

/**
 * `path` on its real path when it is strictly inside the checked `tempRoot`
 * and passes every exclusion; else an `UnsafePathError` naming `what`.
 */
export function checkInsideTemp(
  path: string,
  tempRoot: string,
  rules: PathRules,
  what: string,
): string {
  const refuse = (why: string) =>
    new UnsafePathError(
      `${what} ${path} is refused: ${why}. It must be a folder strictly inside the OS temp directory ${tempRoot}.`,
    );
  if (!isAbsolute(path)) throw refuse("it is not an absolute path");
  const real = realPathOf(path);
  if (!below(tempRoot, real))
    throw refuse(`it resolves to ${real}, outside the temp directory`);
  const why = exclusion(real, rules);
  if (why) throw refuse(why);
  return real;
}

/**
 * The results folder on its real path (a relative one is taken from `cwd`):
 * anywhere that passes every exclusion, so never in a checkout or a data
 * folder. Nothing is made.
 */
export function checkOutDir(
  path: string,
  rules: PathRules,
  cwd: string = process.cwd(),
): string {
  const real = realPathOf(resolve(cwd, path));
  const why = exclusion(real, rules);
  if (why)
    throw new UnsafePathError(
      `--out ${path} is refused: ${why}. Results never go into a checkout or a data folder; pass --out <a folder outside the repo>.`,
    );
  return real;
}

/**
 * The folders one process made under the temp root, and the only ones it may
 * delete. `make` checks the parent and the new folder; `remove` refuses any
 * path this object did not make, including the temp root itself.
 */
export class TempDirs {
  readonly root: string;
  private readonly made = new Set<string>();

  constructor(
    root: string,
    readonly rules: PathRules,
  ) {
    this.root = checkTempRoot(root, rules);
  }

  /** `path` on its real path, when it is a safe place inside the temp root. */
  check(path: string, what: string): string {
    return checkInsideTemp(path, this.root, this.rules, what);
  }

  /** A new folder `<parent>/<prefix>XXXXXX`, recorded as this process's own. */
  make(parent: string, prefix: string): string {
    if (prefix.includes("/") || prefix.includes("\\") || prefix.includes(".."))
      throw new UnsafePathError(
        `A temp folder prefix is a plain name, not ${prefix}.`,
      );
    const base = same(parent, this.root)
      ? this.root
      : this.check(parent, "The parent of a temp folder");
    const dir = this.check(
      mkdtempSync(join(base, prefix)),
      "A new temp folder",
    );
    this.made.add(dir);
    return dir;
  }

  /** Whether this object made `path`. */
  owns(path: string): boolean {
    return isAbsolute(path) && this.made.has(realPathOf(path));
  }

  /** Deletes a folder this object made, and everything in it. Anything else is refused. */
  remove(path: string): void {
    const real = isAbsolute(path) ? realPathOf(path) : path;
    if (!this.made.has(real))
      throw new UnsafePathError(
        `Refusing to delete ${path}: this process did not make it with mkdtemp.`,
      );
    this.check(real, "A temp folder to delete");
    rmSync(real, { recursive: true, force: true });
    for (const dir of this.made)
      if (same(dir, real) || below(real, dir)) this.made.delete(dir);
  }
}
