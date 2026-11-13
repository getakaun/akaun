import { z } from "zod";
import {
  checked,
  formatPath,
  rejected,
  type Checked,
  type ToolIssue,
} from "./envelope.js";
import { closestMatch } from "./format.js";

/**
 * Tool input: shown as zod's JSON schema, but checked by us.
 *
 * SDK 2.3.1 validates `tools/call` arguments against the registered schema
 * itself and turns a failure into the plain text "Input validation error:
 * ..." — not our error shape, and with no fix. So the registry registers a
 * **pass-through Standard Schema** (`listedSchema`): its `jsonSchema` is
 * zod's, so `tools/list` shows the real schema, but its `validate` accepts
 * anything. The handler wrapper then parses with zod (`parseToolInput`) and
 * reports failures as `INVALID_INPUT` with `issues: [{path, message}]`,
 * adding "did you mean" for a near-miss enum value or unknown field.
 */

type StandardJsonOptions = {
  target: string;
  libraryOptions?: Record<string, unknown>;
};

const JSON_TARGETS = new Set(["draft-2020-12", "draft-07", "openapi-3.0"]);

function jsonSchemaOf(
  schema: z.ZodType,
  io: "input" | "output",
  options: StandardJsonOptions,
) {
  const target = JSON_TARGETS.has(options.target)
    ? (options.target as "draft-2020-12" | "draft-07" | "openapi-3.0")
    : "draft-2020-12";
  return z.toJSONSchema(schema, {
    target,
    io,
    unrepresentable: "any",
  }) as Record<string, unknown>;
}

/**
 * The Standard Schema the SDK sees for a tool's input: lists as `schema`'s
 * JSON schema, validates nothing (the handler parses).
 */
export function listedSchema(schema: z.ZodType) {
  return {
    "~standard": {
      version: 1 as const,
      vendor: "akaun",
      validate: (value: unknown) => ({ value }),
      jsonSchema: {
        input: (options: StandardJsonOptions) =>
          jsonSchemaOf(schema, "input", options),
        output: (options: StandardJsonOptions) =>
          jsonSchemaOf(schema, "output", options),
      },
    },
  };
}

type ZodDef = { type: string; [key: string]: unknown };
const defOf = (schema: unknown): ZodDef | undefined =>
  (schema as { _zod?: { def?: ZodDef } } | undefined)?._zod?.def;

/** Wrappers whose inner schema decides the shape. */
const WRAPPERS = new Set([
  "optional",
  "nullable",
  "default",
  "prefault",
  "readonly",
  "catch",
  "nonoptional",
  "lazy",
]);

function unwrapSchema(schema: unknown): unknown {
  let current = schema;
  for (let i = 0; i < 20; i++) {
    const def = defOf(current);
    if (!def) return current;
    if (WRAPPERS.has(def.type))
      current =
        def.type === "lazy" ? (def.getter as () => unknown)() : def.innerType;
    else if (def.type === "pipe") current = def.in;
    else return current;
  }
  return current;
}

/** The schema at `path` inside `schema`, best effort (objects, arrays, records, wrappers). */
function schemaAt(schema: unknown, path: readonly PropertyKey[]): unknown {
  let current = unwrapSchema(schema);
  for (const key of path) {
    const def = defOf(current);
    if (!def) return undefined;
    if (def.type === "object")
      current = (def.shape as Record<string, unknown>)[String(key)];
    else if (def.type === "array") current = def.element;
    else if (def.type === "record") current = def.valueType;
    else return undefined;
    current = unwrapSchema(current);
  }
  return current;
}

/** The value at `path` inside the raw arguments, if there is one. */
function valueAt(value: unknown, path: readonly PropertyKey[]): unknown {
  let current = value;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<PropertyKey, unknown>)[key as string];
  }
  return current;
}

type RawIssue = z.core.$ZodIssue;

/** One zod issue as `{path, message}` issues, with hints. An unknown-keys issue becomes one per key. */
function describeIssue(
  schema: z.ZodType,
  raw: unknown,
  issue: RawIssue,
): ToolIssue[] {
  const path = issue.path;
  if (issue.code === "unrecognized_keys") {
    const shape = defOf(schemaAt(schema, path))?.shape as
      | Record<string, unknown>
      | undefined;
    const known = shape ? Object.keys(shape) : [];
    return issue.keys.map((key) => {
      const near = closestMatch(key, known);
      return {
        path: formatPath([...path, key]),
        message: `Unknown field "${key}".${near ? ` Did you mean "${near}"?` : ""}${
          known.length ? ` Fields here: ${known.join(", ")}.` : ""
        }`,
      };
    });
  }
  if (issue.code === "invalid_value" && issue.values.length > 1) {
    const sent = valueAt(raw, path);
    const allowed = issue.values.map(String);
    const near =
      typeof sent === "string" ? closestMatch(sent, allowed) : undefined;
    return [
      {
        path: formatPath(path),
        message: `${sent === undefined ? "Value" : JSON.stringify(sent)} is not allowed.${
          near ? ` Did you mean "${near}"?` : ""
        } Use one of: ${allowed.join(", ")}.`,
      },
    ];
  }
  if (issue.code === "invalid_type" && valueAt(raw, path) === undefined)
    return [
      { path: formatPath(path), message: `Required (${issue.expected}).` },
    ];
  return [{ path: formatPath(path), message: issue.message }];
}

/** A zod error on `raw` as `{path, message}` issues with hints. */
export function describeZodError(
  schema: z.ZodType,
  raw: unknown,
  error: z.ZodError,
): ToolIssue[] {
  return error.issues.flatMap((issue) => describeIssue(schema, raw, issue));
}

/**
 * Parses a tool's raw `arguments` (undefined counts as `{}`) with its zod
 * schema. On failure: `INVALID_INPUT` with every issue located and hinted.
 */
export function parseToolInput<S extends z.ZodType>(
  schema: S,
  raw: unknown,
): Checked<z.output<S>> {
  const value = raw ?? {};
  const result = schema.safeParse(value);
  if (result.success) return checked(result.data);
  const issues = describeZodError(schema, value, result.error);
  return rejected({
    code: "INVALID_INPUT",
    message:
      issues.length === 1
        ? `The input is not valid: ${issues[0].path ? `${issues[0].path}: ` : ""}${issues[0].message}`
        : `The input has ${issues.length} problems; see issues.`,
    fix: "Correct the fields named in issues and call again. Nothing was done.",
    issues,
  });
}
