import { readFileSync } from "node:fs";

// Explicit compatible manifest; the preload refuses the configured DB client.
const files = readFileSync(
  new URL(
    "../specs/014-release-readiness/validation-files.txt",
    import.meta.url,
  ),
  "utf8",
)
  .split(/\r?\n/)
  .filter(Boolean);
if (
  !files.length ||
  files.some((file) => !/^\.?\/?src\/[\w/.-]+\.spec\.ts$/.test(file))
)
  throw Error("Invalid release test manifest");
const child = Bun.spawn(
  [
    process.execPath,
    "test",
    "--timeout",
    "20000",
    "--preload",
    "./scripts/mcp-test-preload.ts",
    ...files,
  ],
  {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  },
);
process.exitCode = await child.exited;
