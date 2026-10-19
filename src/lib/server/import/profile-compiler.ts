/**
 * Turns a description of what to read from a document (a reading profile) into
 * the two things a reading needs:
 *
 * 1. The JSON Schema sent to the model, which fixes the shape of its answer.
 * 2. A check of the answer against that same shape, which is what the reading
 *    trusts. It drops keys the schema does not name, because Google's models
 *    ignore `additionalProperties: false` and may add their own.
 *
 * Both come from one model of the fields (`FieldSpec`), so they cannot drift
 * apart. The schema only fixes the shape. Which lines the model picks is
 * guidance (the descriptions and the prompt), and the arithmetic is done in
 * code afterwards (`document-reader.ts`), never by the model.
 *
 * The schema keeps to what every provider accepts: every property is required,
 * a value that may be missing is typed `[T, "null"]`, objects set
 * `additionalProperties: false`, and enums hold strings only. It never uses
 * minimum/maximum, pattern, $ref or anyOf. A list of choices that may be empty
 * is the one exception to `[T, "null"]`: it is sent as a plain string whose
 * enum also holds `NONE_VALUE`, and the check reads that back as null (see
 * `toWireSchema`).
 *
 * "Document with several items" is the one built-in profile (below). A saved
 * import profile (006 S2) is compiled the same way: `savedReadingProfile`
 * turns the form the user filled in into another `ReadingProfile`, with its own
 * sections and a schema id of its own, and from there both take one path.
 */

import { createHash } from "crypto";
import { jsonSchema, type JSONSchema7, type Schema } from "ai";
import {
  NONE_VALUE,
  extraFieldsOf,
  kindReadsTable,
  profileKind,
  profileSections,
  type ImportProfileDraft,
  type ProfileSectionKind,
} from "$lib/import-profile-schema.js";
import { ImportMode } from "$lib/import-reading.js";

// ── The field model ─────────────────────────────────────────────────────────

type Described = { description?: string };
type Nullable = { nullable?: boolean };

/** One field of an answer, and what the model is told about it. */
export type FieldSpec =
  | (Described & Nullable & { type: "string"; enum?: readonly string[] })
  | (Described & Nullable & { type: "number" | "integer" | "boolean" })
  | (Described & { type: "array"; items: FieldSpec })
  | (Described &
      Nullable & { type: "object"; properties: Record<string, FieldSpec> });

/** The JSON Schema for one field, as the provider receives it. */
export function toWireSchema(field: FieldSpec): JSONSchema7 {
  const described = field.description ? { description: field.description } : {};
  switch (field.type) {
    case "array":
      return { type: "array", ...described, items: toWireSchema(field.items) };
    case "object": {
      const properties: Record<string, JSONSchema7> = {};
      for (const [key, value] of Object.entries(field.properties)) {
        properties[key] = toWireSchema(value);
      }
      return {
        type: field.nullable ? ["object", "null"] : "object",
        ...described,
        properties,
        required: Object.keys(field.properties),
        additionalProperties: false,
      };
    }
    case "string":
      // A list of choices that may be empty. A strict provider (OpenAI and
      // Groq through the app's model factory) allows only the values `enum`
      // names, so `["string", "null"]` beside an enum without null still
      // cannot be null there: the model would have to pick the closest
      // choice. Google, on the other hand, refuses a null inside an enum. So
      // "none" is sent as one more choice, which every provider can express,
      // and `checkField` reads it back as null.
      if (field.enum && field.nullable) {
        const base = field.description?.trim() ?? "";
        const stop = base && !/[.!?]$/.test(base) ? "." : "";
        const none = `"${NONE_VALUE}" when none of the others applies.`;
        return {
          type: "string",
          description: base ? `${base}${stop} ${none}` : none,
          enum: [...new Set([...field.enum, NONE_VALUE])],
        };
      }
      return {
        type: field.nullable ? ["string", "null"] : "string",
        ...described,
        ...(field.enum ? { enum: [...field.enum] } : {}),
      };
    default:
      return {
        type: field.nullable ? [field.type, "null"] : field.type,
        ...described,
      };
  }
}

/**
 * Checks `value` against `field` and returns a copy that holds only the keys
 * the field names. Each problem is added to `errors` with the path to the value
 * (for example `sections.items[2].amount`), and the returned value is then not
 * to be used.
 *
 * A nullable property the answer leaves out is read as null, because a missing
 * value and an empty one mean the same here. A property that may not be null
 * must be there.
 */
export function checkField(
  field: FieldSpec,
  value: unknown,
  path: string,
  errors: string[],
): unknown {
  const where = path || "the answer";
  if (value === null || value === undefined) {
    if ("nullable" in field && field.nullable) return null;
    errors.push(`${where} is missing`);
    return null;
  }
  switch (field.type) {
    case "string":
      // "None of the choices", as `toWireSchema` sends a nullable enum.
      if (field.enum && field.nullable && value === NONE_VALUE) return null;
      if (typeof value !== "string") {
        errors.push(`${where} must be text`);
      } else if (field.enum && !field.enum.includes(value)) {
        errors.push(`${where} must be one of ${field.enum.join(", ")}`);
      }
      return value;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        errors.push(`${where} must be a number`);
      }
      return value;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) {
        errors.push(`${where} must be a whole number`);
      }
      return value;
    case "boolean":
      if (typeof value !== "boolean")
        errors.push(`${where} must be true or false`);
      return value;
    case "array":
      if (!Array.isArray(value)) {
        errors.push(`${where} must be a list`);
        return [];
      }
      return value.map((entry, index) =>
        checkField(field.items, entry, `${path}[${index}]`, errors),
      );
    case "object": {
      if (typeof value !== "object" || Array.isArray(value)) {
        errors.push(`${where} must be an object`);
        return {};
      }
      const source = value as Record<string, unknown>;
      const kept: Record<string, unknown> = {};
      for (const [key, property] of Object.entries(field.properties)) {
        kept[key] = checkField(
          property,
          source[key],
          path ? `${path}.${key}` : key,
          errors,
        );
      }
      return kept;
    }
  }
}

// At most this many problems are named in one error, so a reply that is wrong
// throughout does not produce a message thousands of lines long.
const ERRORS_SHOWN = 10;

// ── Reading profiles ────────────────────────────────────────────────────────

/**
 * Whether a section's lines are income or expenses (006 FR-008).
 *
 * - `document`: the whole document is one kind, which the model states in the
 *   header, as it does for a receipt. The built-in reading uses this.
 * - `income` / `expense`: every line of the section is that kind.
 * - `by_sign`: a positive amount is income and a negative one an expense.
 * - `transfer`: money moved between the profile's account and the section's
 *   other account; a negative amount left the profile's account, a positive
 *   one came into it (FR-058). Only a saved profile has one.
 */
export type SectionKind =
  | "document"
  | "income"
  | "expense"
  | "by_sign"
  | "transfer";

/** One fee type a section lists, and the category it is tied to. */
export interface FeeTypeSpec {
  key: string;
  /** What a person calls it. Absent in a spec built by hand. */
  name?: string;
  /** Tells the model which lines are this type. May be empty. */
  description: string;
  /**
   * The category every line of this type gets, whatever the model suggests
   * (FR-034). Absent or null when the type is tied to none.
   */
  categoryAccountId?: number | null;
}

/** One list of lines to read from the document. */
export interface SectionSpec {
  /** The section's key in the answer. Lower-case letters, digits and "_". */
  key: string;
  /** The section's name as the screens show it. Absent for a built-in. */
  name?: string;
  /** Tells the model which lines belong in this section. */
  description: string;
  kind: SectionKind;
  /**
   * The closed list of fee types a line of this section can be. The answer's
   * `fee_type` is one of them or null (sent as `NONE_VALUE`, see
   * `toWireSchema`), and a null is left out as an ignored line, so a stray
   * line is never forced into the closest type (FR-034).
   * Absent when the section has no fee types; the answer then has no
   * `fee_type` at all.
   */
  feeTypes?: readonly FeeTypeSpec[];
  /**
   * The category of a line with no fee type: every line of a section that
   * lists none (FR-034, US6 AS7). Absent or null when the section has none.
   */
  fixedCategoryAccountId?: number | null;
  /**
   * Whether the model picks each line's category from the user's list. False
   * when code decides the category, and the answer then has no
   * `category_account_id`.
   */
  categoryFromModel: boolean;
  /** More fields to read for each line. Flat: text, numbers or true/false. */
  extras?: Record<string, FieldSpec>;
  /**
   * A transfer section's other account (FR-058). Code uses it after the
   * reading; the model is never told of it.
   */
  counterAccountId?: number | null;
  /**
   * Other saved profiles whose records describe the same money (FR-066).
   * Code uses it after the reading, to note an item whose month records from
   * one of them already cover; the model is never told of it.
   */
  sameMoneyAs?: readonly number[];
  /**
   * True for a section of a saved profile read from a spreadsheet's table by
   * code (FR-055, FR-057). Its items take their reference only from their own
   * row, never the document's, and the AI is never asked for its lines.
   */
  fromTable?: boolean;
}

/** Everything a reading needs to know about what to read. */
export interface ReadingProfile {
  /**
   * Names the compiled schema for the provider's unsupported cache, with a
   * version (see `StructuredSpec.schemaId`). Change the version whenever the
   * schema this profile compiles to changes. A saved profile's id carries a
   * hash of its schema instead, so every edit is a new id by itself.
   */
  schemaId: string;
  /**
   * The rules for picking lines, as prompt lines starting with "- ". They sit
   * under the prompt's opening and above the user's own guidance.
   */
  instructions: string;
  /**
   * The user's own guidance for this reading, when it has its own: a saved
   * profile's instructions. They take the place of the general import
   * instructions from Settings, even when empty (FR-036). Absent for a
   * built-in reading, which takes the general ones.
   */
  guidance?: string;
  /**
   * Which printed total `stated_total` is, for this profile. Null when the
   * profile names none: the answer still has the field, so every reading has
   * one shape, but its value is not used and no control total is shown.
   */
  statedTotalDescription: string | null;
  /**
   * True when a provider's refusal of this schema must fail the document
   * instead of reading it without a schema (FR-037). Set for a saved profile:
   * its schema is the user's, and reading without it would quietly drop the
   * fee type list that decides which lines count.
   */
  schemaRequired?: boolean;
  /**
   * The account the document is about, when a saved profile names one
   * (FR-008, FR-058): every item starts on it, and it is one side of every
   * transfer. Code uses it after the reading; it is not part of the schema.
   */
  documentAccountId?: number | null;
  /**
   * True in Every transaction mode: an item takes its reference only from its
   * own row, never the document's (FR-062). Code uses it after the reading.
   */
  ownReferencesOnly?: boolean;
  sections: readonly SectionSpec[];
}

/** One line of the document as the model read it. */
export interface ReadItem {
  description: string;
  /** As printed on the line, with its sign. Never added up by the model. */
  amount: number;
  date: string | null;
  reference: string | null;
  /** The number of the line the amount is printed on (the "L0012" prefix). */
  source_line: number | null;
  /** Present only when the section has fee types. Null when it is none. */
  fee_type?: string | null;
  /** Present only when the model picks the category. */
  category_account_id?: number | null;
  /** Present only when the section has extra fields. */
  extras?: Record<string, unknown>;
  /**
   * Set only by code that reads a table from its columns (`table-reader.ts`),
   * never by the model: the check of an answer keeps only the keys the schema
   * names, and the schema names neither of these.
   *
   * - `amount_minor`: the amount in whole cents, read from the cell's text, so
   *   no figure goes through a binary number on its way in. Wins over
   *   `amount`.
   * - `review_note`: what the reviewer is to check on this item, from its
   *   section's flag rule (FR-061).
   */
  amount_minor?: number;
  review_note?: string;
}

/** The model's whole answer, after the check. */
export interface ReadEnvelope {
  header: {
    /** Present only when a section takes its kind from the document. */
    document_type?: "expense" | "income";
    counterparty: string | null;
    date: string | null;
    reference: string | null;
    currency: string | null;
  };
  /** The printed total for exactly the lines read, as printed. */
  stated_total: number | null;
  /**
   * The same total in whole cents, set only by code that reads a table from
   * its columns (see `ReadItem.amount_minor`). Wins over `stated_total`.
   */
  stated_total_minor?: number | null;
  sections: Record<string, ReadItem[]>;
  ignored: string[];
}

const SLUG = /^[a-z][a-z0-9_]*$/;

function itemField(section: SectionSpec): FieldSpec {
  const properties: Record<string, FieldSpec> = {
    description: {
      type: "string",
      description:
        "A short label for this line in a few words (under 60 characters), taken from the line's own wording.",
    },
    amount: {
      type: "number",
      description:
        "The amount on this line exactly as printed, as a number with no currency symbol and no thousands separators. Keep the minus sign when the line prints one, or prints the amount in brackets. Never work out or add up a figure yourself.",
    },
    date: {
      type: "string",
      nullable: true,
      description:
        "This line's own date as YYYY-MM-DD, only when the line prints a date of its own. Otherwise null.",
    },
    reference: {
      type: "string",
      nullable: true,
      description:
        "This line's own reference number, only when the line prints one of its own. Otherwise null.",
    },
    source_line: {
      type: "integer",
      nullable: true,
      description:
        "The number after L at the start of the line where this amount is printed, for example 12 for L0012.",
    },
  };
  if (section.feeTypes?.length) {
    // Nullable: the wire sends "none" as one more choice (`toWireSchema`).
    properties.fee_type = {
      type: "string",
      nullable: true,
      enum: section.feeTypes.map((feeType) => feeType.key),
      description: `Which fee type this line is. ${section.feeTypes
        .map(
          (feeType) =>
            `${feeType.key}${feeType.name ? ` (${feeType.name})` : ""}: ${feeType.description}`,
        )
        .join("; ")}`,
    };
  }
  if (section.categoryFromModel) {
    properties.category_account_id = {
      type: "integer",
      nullable: true,
      description:
        "The id of the best matching account from the lists in the instructions. Null when the line does not say enough to choose one. Never invent an id.",
    };
  }
  if (section.extras && Object.keys(section.extras).length > 0) {
    properties.extras = { type: "object", properties: section.extras };
  }
  return {
    type: "array",
    description: section.description,
    items: { type: "object", properties },
  };
}

/** The header fields of a profile's answer: who, when, which and in what. */
function headerField(profile: ReadingProfile): FieldSpec {
  const header: Record<string, FieldSpec> = {};
  if (profile.sections.some((section) => section.kind === "document")) {
    header.document_type = {
      type: "string",
      enum: ["expense", "income"],
      description:
        "expense when the document is money the user pays out, income when it is money the user receives. The whole document is one kind.",
    };
  }
  header.counterparty = {
    type: "string",
    nullable: true,
    description:
      "The other party's name exactly as printed on the document (the full legal or business name): the supplier for an expense, the customer for income. Never shortened, abbreviated or paraphrased. Null when none is printed.",
  };
  header.date = {
    type: "string",
    nullable: true,
    description:
      "The date this document is for, as YYYY-MM-DD. For a statement or any document that covers a period, the statement or issue date printed on it, else the last day of the period. Never a range. Null only when the document prints no date at all.",
  };
  header.reference = {
    type: "string",
    nullable: true,
    description:
      "The document's own invoice, statement or reference number. Null when there is none.",
  };
  header.currency = {
    type: "string",
    nullable: true,
    description:
      "The ISO-4217 code the amounts are in (for example USD, MYR, SGD, EUR), from any symbol or code on the document. Null when none is shown.",
  };
  return { type: "object", properties: header };
}

function statedTotalField(profile: ReadingProfile): FieldSpec {
  return {
    type: "number",
    nullable: true,
    description:
      profile.statedTotalDescription ??
      "Always null: this reading compares the lines with no printed total.",
  };
}

/** The sections of a profile's answer, one list of lines each. */
function sectionsField(profile: ReadingProfile): FieldSpec {
  if (profile.sections.length === 0) {
    throw new Error("A reading profile needs at least one section");
  }
  const sections: Record<string, FieldSpec> = {};
  for (const section of profile.sections) {
    if (!SLUG.test(section.key) || section.key in sections) {
      throw new Error(`Section key "${section.key}" is not a unique slug`);
    }
    if (section.feeTypes?.some((feeType) => feeType.key === NONE_VALUE)) {
      throw new Error(
        `Section "${section.key}" has a fee type keyed "${NONE_VALUE}", which marks a line that is none of them`,
      );
    }
    for (const [key, extra] of Object.entries(section.extras ?? {})) {
      if (
        !SLUG.test(key) ||
        extra.type === "array" ||
        extra.type === "object"
      ) {
        throw new Error(
          `Extra field "${key}" of section "${section.key}" must be a slug holding text, a number or true/false`,
        );
      }
    }
    sections[section.key] = itemField(section);
  }
  return { type: "object", properties: sections };
}

const IGNORED_FIELD: FieldSpec = {
  type: "array",
  description:
    'A short piece of text for each line left out on purpose, such as "Subtotal 1,230.00". At most 20.',
  items: { type: "string" },
};

/** The field model of a profile's whole answer. */
export function envelopeField(profile: ReadingProfile): FieldSpec {
  const sections = sectionsField(profile);
  return {
    type: "object",
    properties: {
      header: headerField(profile),
      stated_total: statedTotalField(profile),
      sections,
      ignored: IGNORED_FIELD,
    },
  };
}

/**
 * A reading of a long document in pieces (006 FR-043) asks for its answer in
 * two parts: the header and the stated total once, from the start and the end
 * of the document, and the lines once for each piece. Each part's schema is
 * the matching part of the whole answer's, so the two cannot drift apart.
 */
export type ReadEnvelopeHeader = Pick<ReadEnvelope, "header" | "stated_total">;
export type ReadEnvelopeLines = Pick<ReadEnvelope, "sections" | "ignored">;

/** A schema sent, and the check of the answer to it. */
export interface CompiledPart<T> {
  schemaId: string;
  /** The JSON Schema the provider receives. */
  wire: JSONSchema7;
  /** `wire` with its check attached, for `Output.object`. */
  schema: Schema<T>;
  /** Checks a value read from reply text. Throws, naming each problem. */
  parse: (raw: unknown) => T;
}

/** A profile ready to send: its schema, and the check of the answer. */
export type CompiledProfile = CompiledPart<ReadEnvelope>;

function compileField<T>(field: FieldSpec, schemaId: string): CompiledPart<T> {
  const wire = toWireSchema(field);

  const check = (raw: unknown) => {
    const errors: string[] = [];
    const value = checkField(field, raw, "", errors) as T;
    if (errors.length === 0) return { success: true as const, value };
    const shown = errors.slice(0, ERRORS_SHOWN).join("; ");
    const more =
      errors.length > ERRORS_SHOWN
        ? ` (and ${errors.length - ERRORS_SHOWN} more)`
        : "";
    return {
      success: false as const,
      error: new Error(`The answer does not fit the schema: ${shown}${more}`),
    };
  };

  return {
    schemaId,
    wire,
    schema: jsonSchema<T>(wire, { validate: check }),
    parse: (raw) => {
      const result = check(raw);
      if (!result.success) throw result.error;
      return result.value;
    },
  };
}

/** Compiles a profile into the schema sent and the check of the answer. */
export function compileProfile(profile: ReadingProfile): CompiledProfile {
  return compileField<ReadEnvelope>(envelopeField(profile), profile.schemaId);
}

/**
 * The header part of a reading in pieces: the header and the stated total,
 * with no lines. Its schema id is the profile's with "#header" after it.
 */
export function compileHeaderPart(
  profile: ReadingProfile,
): CompiledPart<ReadEnvelopeHeader> {
  // The sections are checked here too, so a profile that could not be read
  // whole is refused before any part of it is sent.
  sectionsField(profile);
  return compileField<ReadEnvelopeHeader>(
    {
      type: "object",
      properties: {
        header: headerField(profile),
        stated_total: statedTotalField(profile),
      },
    },
    `${profile.schemaId}#header`,
  );
}

/**
 * The lines part of a reading in pieces: the sections and the ignored lines,
 * with no header. Its schema id is the profile's with "#lines" after it.
 */
export function compileLinesPart(
  profile: ReadingProfile,
): CompiledPart<ReadEnvelopeLines> {
  return compileField<ReadEnvelopeLines>(
    {
      type: "object",
      properties: { sections: sectionsField(profile), ignored: IGNORED_FIELD },
    },
    `${profile.schemaId}#lines`,
  );
}

// ── The built-in profile ────────────────────────────────────────────────────

/**
 * "Multiple records": every charge line on the
 * document becomes its own record, and the whole document is one kind, expense
 * or income, as a receipt is (006 US1-3, FR-005, FR-008, FR-015).
 */
export const SEVERAL_ITEMS_PROFILE: ReadingProfile = {
  schemaId: "builtin:items@1",
  instructions: `- The document lists several charges, and each one becomes its own record. Put one entry in
  sections.items for each charge line: a line that states one amount for one thing, such as a fee,
  a commission, a service or a product.
- Never list a subtotal, a total, an amount due, a balance or a balance brought forward, a payment
  received, a tax summary, an account or reference number, or any figure that adds up other lines.
- Never list the rows of another table on the document, such as a list of orders or transactions.
- Credits, discounts and refunds are not charges. Do not list them in sections.items; add them to
  ignored.
- Every item shares the document's other party, date, reference and currency, given once in the
  header. Give an item its own date or reference only when its line prints one of its own.
- Copy every amount exactly as printed. Never add up, subtract or work out a figure yourself.`,
  statedTotalDescription:
    "The total the document prints for exactly the lines listed in sections.items, as printed, with no currency symbol, for example the total of charges. Never an amount due, a balance, or a grand total that includes other charges. Null when the document prints no such total.",
  sections: [
    {
      key: "items",
      description: "One entry for each charge line on the document.",
      kind: "document",
      categoryFromModel: true,
    },
  ],
};

// ── Saved import profiles ───────────────────────────────────────────────────

/** A saved import profile, as `services/import-profiles.ts` reads it. */
export interface SavedProfile extends ImportProfileDraft {
  id: number;
}

/**
 * The rules every saved profile is read by. They are the code's, not the
 * user's: the user's own instructions go under them as guidance (FR-036), and
 * the sections, fee types and stated total are described in the schema.
 */
const SAVED_PROFILE_RULES = `- Read only the sections the schema names under sections. Each section's description says which
  lines belong in it, and where on the document they are. A line that fits no section is not read.
- Put one entry in a section for each line that states one amount for one thing.
- Never list a subtotal, a total, an amount due, a balance or a balance brought forward, or any
  figure that adds up other lines. Add such lines to ignored.
- The one exception is a line a section's fee type names. A fee type may be a total, such as
  "Total Fees": the user chose to import that total as one line, so list it under that fee type,
  and add the lines it adds up to ignored, so that no amount is read twice.
- When a section lists fee types, give each line the fee type it is. When a line is none of them,
  set its fee_type to "${NONE_VALUE}": never choose the closest type for a line that is not one.
- An extra field the line does not print is null (or "${NONE_VALUE}" for a field with a list of
  choices). Never make up a value for it.
- Every item shares the document's other party, date, reference and currency, given once in the
  header. Give an item its own date or reference only when its line prints one of its own.
- The header date is one day as YYYY-MM-DD, never a range. For a statement or any document that
  covers a period, use the statement or issue date printed on it, else the last day of the period.
- Copy every amount exactly as printed, with its sign. Never add up, subtract or work out a figure
  yourself.`;

const KIND_GUIDANCE: Record<ProfileSectionKind, string> = {
  income: "Every line of this section is money the user receives.",
  expense: "Every line of this section is money the user pays out.",
  by_sign:
    "A line printed as a deduction (with a minus sign or in brackets) is money the user pays out; any other line is money the user receives. Keep each amount's sign as printed.",
  transfer:
    "Every line of this section is money moved between this document's account and another account of the user's own, such as a withdrawal to the bank. It is neither income nor an expense. Keep each amount's sign as printed: a minus sign or brackets means the money left this document's account.",
};

/** What the model is told about one section's lines. */
function sectionDescription(
  name: string,
  description: string,
  kind: ProfileSectionKind,
): string {
  return `${name}: ${description} ${KIND_GUIDANCE[kind]}`;
}

/**
 * An extra field of a section, in the field model. It is always sent as
 * nullable, and always required (as every field is): one line may not print a
 * value another does, such as an order number on a fee line, and the model
 * only copies what is printed. A field the fragment calls required but that
 * could not be null would leave the model two choices, both wrong: make the
 * value up, or answer null and fail the whole document's check. The
 * fragment's own `required` therefore does not reject an answer.
 */
function extraSpec(field: ReturnType<typeof extraFieldsOf>[number]): FieldSpec {
  const described = field.description ? { description: field.description } : {};
  if (field.type === "string") {
    return {
      type: "string",
      nullable: true,
      ...described,
      ...(field.enum ? { enum: field.enum } : {}),
    };
  }
  return { type: field.type, nullable: true, ...described };
}

/**
 * The rows of a spreadsheet's table, read by code, are cut from the text the
 * AI reads (FR-057); one line says where they were. `withoutTableRows` in
 * `table-reader.ts` writes it.
 */
const TABLE_ROWS_RULE = `- The rows of this spreadsheet's table were read already, by code, and are left out of the text. A
  line in square brackets marks where they were. Never list a line for them.`;

/**
 * Turns a saved profile into its reading, in the profile's own import mode,
 * ready to compile (006 S2, FR-032). Only the sections the profile reads are
 * kept (`profileSections`): a section saved in the other mode, on a profile
 * from when each section had its own, is never read. Every profile has at
 * least one section in its own mode, so a profile with none is a damaged row
 * and throws; the caller checks first.
 *
 * What code decides is never asked of the model. A section whose fee types
 * are all tied to a category, or that lists no fee types and has a fixed
 * category, gets no `category_account_id`; the categories are applied after
 * the reading (`document-reader.ts`).
 *
 * The schema id is `profile:<id>:<hash of the schema sent>`. A provider's
 * refusal of one profile's schema is then about that schema only, and never
 * changes how another schema is read (FR-037).
 *
 * The stated total is the profile's label, kept under its mode. An Every
 * transaction reading by the AI is read in pieces (`piece-reader.ts`, FR-043) with the parts of this
 * same schema (`compileHeaderPart`, `compileLinesPart`).
 *
 * `part` is "ai" for the part of a spreadsheet the AI reads when the profile
 * reads its table by code (FR-057): only the sections with no row rules, and
 * the rule that the table's rows are not in the text. With "all", a section
 * read from the table is marked `fromTable`.
 */
export function savedReadingProfile(
  saved: SavedProfile,
  part: "all" | "ai" = "all",
): ReadingProfile {
  const mode = saved.mode;
  const hasTable = Boolean(saved.layout) && kindReadsTable(profileKind(saved));
  const fromTable = (section: { rows?: unknown }) =>
    hasTable && Boolean(section.rows);
  const read = profileSections(saved).filter(
    (section) => part === "all" || !fromTable(section),
  );
  const sections: SectionSpec[] = read.map((section) => {
    const feeTypes = section.feeTypes.map((feeType) => ({
      key: feeType.key,
      name: feeType.name,
      description: feeType.description,
      categoryAccountId: feeType.categoryAccountId,
    }));
    // A transfer has no category, so the model is never asked for one.
    const categoryFromModel =
      section.kind !== "transfer" &&
      (feeTypes.length
        ? feeTypes.some((feeType) => feeType.categoryAccountId == null)
        : section.fixedCategoryAccountId == null);
    const extras: Record<string, FieldSpec> = {};
    for (const field of extraFieldsOf(section.extras)) {
      extras[field.key] = extraSpec(field);
    }
    return {
      key: section.key,
      name: section.name,
      description: sectionDescription(
        section.name,
        section.description,
        section.kind,
      ),
      kind: section.kind,
      ...(feeTypes.length ? { feeTypes } : {}),
      fixedCategoryAccountId: section.fixedCategoryAccountId,
      categoryFromModel,
      ...(Object.keys(extras).length ? { extras } : {}),
      ...(section.kind === "transfer"
        ? { counterAccountId: section.counterAccountId ?? null }
        : {}),
      ...(section.sameMoneyAs?.length
        ? { sameMoneyAs: [...section.sameMoneyAs] }
        : {}),
      ...(fromTable(section) ? { fromTable: true } : {}),
    };
  });
  if (sections.length === 0) {
    throw new Error(
      `The import profile "${saved.name}" has no section to read.`,
    );
  }

  const label = saved.statedTotalLabels[mode];
  // The AI's part of a spreadsheet whose table code reads: the total covers
  // the table's rows too, which the AI is not shown.
  const withTable =
    part === "ai" && read.length < profileSections(saved).length;
  const totals = withTable
    ? "It is the total of the lines read under sections and of the table's rows left out of the text."
    : "It is the total of exactly the lines read under sections.";
  const profile: ReadingProfile = {
    schemaId: "",
    instructions: withTable
      ? `${SAVED_PROFILE_RULES}\n${TABLE_ROWS_RULE}`
      : SAVED_PROFILE_RULES,
    guidance: saved.instructions,
    statedTotalDescription: label
      ? `The figure the document prints for: ${label}. ${totals} Copy it exactly as printed, with its sign and with no currency symbol. Null when the document does not print it.`
      : null,
    schemaRequired: true,
    documentAccountId: saved.accountId ?? null,
    ...(mode === ImportMode.EveryTransaction
      ? { ownReferencesOnly: true }
      : {}),
    sections,
  };
  const wire = toWireSchema(envelopeField(profile));
  const hash = createHash("sha256").update(JSON.stringify(wire)).digest("hex");
  return { ...profile, schemaId: `profile:${saved.id}:${hash}` };
}
