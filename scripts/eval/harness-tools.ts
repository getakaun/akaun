import type Anthropic from "@anthropic-ai/sdk";
import {
  EVAL_INBOX,
  type EvalVariant,
} from "../../src/lib/server/mcp/__fixtures__/eval-book.ts";
import { downloadMcpFile } from "../../src/lib/server/mcp/file-links.ts";
import { sniffAllowedType } from "../../src/lib/server/storage/file-type.ts";
import type { LedgerDb } from "../../src/lib/server/ledger/types.ts";
import type { BlobStore } from "../../src/lib/server/storage/blob-store.ts";
import type { ToolExecutor, ToolOutcome } from "./agent.ts";

/**
 * The two tools the harness adds next to the surface's, standing in for what
 * a real agent's client would have:
 *
 * - `fetch_url` opens the signed file links Akaun's tools hand out
 *   (`/api/mcp-files/<token>`), resolved in-process by `downloadMcpFile` — the
 *   same code the app's route runs. Nothing else is fetched: there is no
 *   network in a trial.
 * - `read_inbox` is the owner's mailbox: the fixture's emails, each PDF both
 *   as a readable document and as base64 to pass to the attach tool.
 */

export const HARNESS_TOOL_NAMES = ["fetch_url", "read_inbox"] as const;

export const HARNESS_TOOLS: readonly Anthropic.Tool[] = [
  {
    name: "fetch_url",
    description:
      "Download a file from a link that Akaun gave you, such as an attachment's or a bank statement's downloadUrl. Returns the file itself: a PDF as a document you can read, an image, or text. Links are single-use and expire after a few minutes; ask Akaun for a fresh link if one has expired. Only Akaun file links can be opened.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The downloadUrl Akaun returned." },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "read_inbox",
    description:
      "Read the business owner's email inbox. Returns each email's id, sender, recipient, date, subject and body. Each attachment comes back twice: as a document you can read, and as { filename, content_type, content_base64 } that can be passed unchanged to Akaun's attach tool. Optionally filter by a word or phrase in the sender, subject or body.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Only emails whose sender, subject or body contain this text (case-insensitive).",
        },
      },
      additionalProperties: false,
    },
  },
];

function refusal(message: string): ToolOutcome {
  return {
    content: message,
    isError: true,
    errorCode: "REFUSED",
    traceText: message,
    outputBytes: Buffer.byteLength(message),
  };
}

/** `fetch_url`: a signed Akaun file link, resolved in-process; anything else is refused. */
export async function fetchUrl(
  options: { db: LedgerDb; store: BlobStore; origin: string },
  input: unknown,
): Promise<ToolOutcome> {
  const raw = (input as { url?: unknown } | null)?.url;
  if (typeof raw !== "string" || !raw.trim())
    return refusal("Give the url to fetch.");
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return refusal(`${raw} is not a URL.`);
  }
  const token = url.pathname.match(/^\/api\/mcp-files\/([^/]+)$/)?.[1];
  if (url.origin !== new URL(options.origin).origin || !token)
    return refusal(
      "Only file links that Akaun returned (a downloadUrl) can be fetched here.",
    );
  const response = await downloadMcpFile(
    options.db,
    options.store,
    token,
    new Request(url.href),
  );
  if (response.status !== 200) {
    const reason =
      response.status === 410
        ? "The link has expired or was already used; ask Akaun for a new one."
        : response.status === 404
          ? "The file behind this link no longer exists."
          : "Akaun refused this link.";
    return { ...refusal(reason), errorCode: `HTTP_${response.status}` };
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const kind = sniffAllowedType(bytes);
  const data = bytes.toString("base64");
  if (kind === "pdf")
    return {
      content: [
        {
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data },
        },
      ],
      isError: false,
      traceText: `[PDF document, ${bytes.length} bytes]`,
      outputBytes: bytes.length,
    };
  if (kind === "png" || kind === "jpeg")
    return {
      content: [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: kind === "png" ? "image/png" : "image/jpeg",
            data,
          },
        },
      ],
      isError: false,
      traceText: `[${kind} image, ${bytes.length} bytes]`,
      outputBytes: bytes.length,
    };
  const text = bytes.toString("utf8");
  if (text.includes("\uFFFD"))
    return refusal("The file is neither a PDF, an image nor text.");
  return {
    content: [{ type: "text", text }],
    isError: false,
    traceText: text,
    outputBytes: bytes.length,
  };
}

/** `read_inbox`: the variant's emails, optionally filtered. */
export function readInbox(variant: EvalVariant, input: unknown): ToolOutcome {
  const query = (input as { query?: unknown } | null)?.query;
  const needle = typeof query === "string" ? query.trim().toLowerCase() : "";
  const emails = EVAL_INBOX[variant].filter(
    (mail) =>
      !needle ||
      [mail.from, mail.subject, mail.text].some((field) =>
        field.toLowerCase().includes(needle),
      ),
  );
  const listing = emails.map((mail) => ({
    id: mail.id,
    from: mail.from,
    to: mail.to,
    date: mail.date,
    subject: mail.subject,
    body: mail.text,
    attachments: mail.attachments.map((file) => ({
      filename: file.filename,
      content_type: file.contentType,
      content_base64: file.contentBase64,
    })),
  }));
  const text = JSON.stringify({ emails: listing }, null, 2);
  const documents: Anthropic.DocumentBlockParam[] = emails.flatMap((mail) =>
    mail.attachments.map((file) => ({
      type: "document" as const,
      title: `${mail.id}: ${file.filename}`,
      source: {
        type: "base64" as const,
        media_type: "application/pdf" as const,
        data: file.contentBase64,
      },
    })),
  );
  return {
    content: [{ type: "text", text }, ...documents],
    isError: false,
    traceText:
      text + documents.map((doc) => `\n[PDF document: ${doc.title}]`).join(""),
    outputBytes: Buffer.byteLength(text),
  };
}

/** The harness tools of one trial. */
export function harnessToolExecutor(options: {
  variant: EvalVariant;
  db: LedgerDb;
  store: BlobStore;
  origin: string;
}): ToolExecutor {
  return {
    definitions: [...HARNESS_TOOLS],
    async call(name, input) {
      if (name === "fetch_url") return fetchUrl(options, input);
      if (name === "read_inbox") return readInbox(options.variant, input);
      return refusal(`There is no tool named ${name}.`);
    },
  };
}

/** The surface's tools (already sorted) followed by the harness tools. */
export function combineExecutors(
  surface: ToolExecutor,
  harness: ToolExecutor,
): ToolExecutor {
  const harnessNames = new Set(harness.definitions.map((tool) => tool.name));
  const clash = surface.definitions.find((tool) => harnessNames.has(tool.name));
  if (clash)
    throw new Error(
      `The surface lists a tool named ${clash.name}, which is a harness tool.`,
    );
  return {
    definitions: [...surface.definitions, ...harness.definitions],
    call: (name, input) =>
      harnessNames.has(name)
        ? harness.call(name, input)
        : surface.call(name, input),
  };
}
