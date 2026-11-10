import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { env } from "$env/dynamic/private";
import { env as publicEnv } from "$env/dynamic/public";
import { z } from "zod";
import { eq, lt } from "drizzle-orm";
import { mcpFileLinkUses, users } from "../db/schema.js";
import type { LedgerDb } from "../ledger/types.js";
import type { BlobStore } from "../storage/blob-store.js";
import { can, resolveAccess } from "../permissions.js";
import { permissionForKind } from "../ledger/record-permissions.js";
import { getAttachment, getRecord } from "../queries/ledger.js";
import { getStatement } from "../queries/reconciliation.js";
import { storedFileResponse } from "../stored-file-response.js";
import { createLogger } from "../logger.js";
import { hit } from "../rate-limit.js";
import { FILE_READ_LIMIT, MAX_FILE_BYTES } from "./file-read-policy.js";

const log = createLogger("mcp-files");
// A process-local development key avoids a publicly known fallback secret.
const developmentSecret = randomBytes(32).toString("hex");

export function fileLinkConfig(
  values: Record<string, string | undefined> = env,
) {
  const secret = values.MCP_FILE_LINK_SECRET;
  if (
    (values.NODE_ENV ?? process.env.NODE_ENV) === "production" &&
    (!secret || secret.length < 32)
  )
    throw new Error(
      "Production requires MCP_FILE_LINK_SECRET (at least 32 characters)",
    );
  const ttl = Number(values.MCP_FILE_LINK_TTL_SECONDS ?? 120);
  if (!Number.isSafeInteger(ttl) || ttl <= 0)
    throw new Error("MCP_FILE_LINK_TTL_SECONDS must be a positive integer");
  return { secret: secret || developmentSecret, ttl };
}

const commonClaims = {
  userId: z.number().int().positive(),
  exp: z.number().int().positive(),
  jti: z.uuid(),
};
// Keep existing attachment tokens valid; strict alternatives prevent a token
// from naming both an attachment and a statement.
const claimsSchema = z.union([
  z
    .object({
      ...commonClaims,
      recordId: z.number().int().positive(),
      attachmentId: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      ...commonClaims,
      statementId: z.number().int().positive(),
    })
    .strict(),
]);
type Claims = z.infer<typeof claimsSchema>;

export const attachmentLinkSchema = z.object({
  recordId: z.number().int().positive(),
  attachmentId: z.number().int().positive(),
  filename: z.string(),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  downloadUrl: z.url(),
  expiresAt: z.iso.datetime(),
});

export const statementLinkSchema = attachmentLinkSchema
  .omit({ recordId: true, attachmentId: true })
  .extend({ statementId: z.number().int().positive() });

export function signFileToken(claims: Claims): string {
  const payload = Buffer.from(
    JSON.stringify(claimsSchema.parse(claims)),
  ).toString("base64url");
  const signature = createHmac("sha256", fileLinkConfig().secret)
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

export function issueFileLink(
  userId: number,
  recordId: number,
  attachmentId: number,
  requestOrigin?: string,
) {
  return issueLink(userId, { recordId, attachmentId }, requestOrigin);
}

export function issueStatementFileLink(
  userId: number,
  statementId: number,
  requestOrigin?: string,
) {
  return issueLink(userId, { statementId }, requestOrigin);
}

function issueLink(
  userId: number,
  target: { recordId: number; attachmentId: number } | { statementId: number },
  requestOrigin?: string,
) {
  const exp = Math.floor(Date.now() / 1000) + fileLinkConfig().ttl;
  const token = signFileToken({ userId, ...target, exp, jti: randomUUID() });
  const base = publicEnv.PUBLIC_BASE_URL || env.ORIGIN || requestOrigin;
  if (!base) throw new Error("File links require a request origin");
  return {
    downloadUrl: new URL(`/api/mcp-files/${token}`, base).href,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

function verifyFileToken(token: string): Claims | null {
  if (token.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))
    return null;
  const [payload, signature] = token.split(".");
  const expected = createHmac("sha256", fileLinkConfig().secret)
    .update(payload)
    .digest();
  const actual = Buffer.from(signature, "base64url");
  if (
    actual.toString("base64url") !== signature ||
    actual.length !== expected.length ||
    !timingSafeEqual(actual, expected)
  )
    return null;
  try {
    return claimsSchema.parse(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );
  } catch {
    return null;
  }
}

/** Token-authenticated route logic; dependencies never open the configured DB. */
export async function downloadMcpFile(
  db: LedgerDb,
  store: BlobStore,
  token: string,
  request: Request,
): Promise<Response> {
  const headers = {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
  const refused = (status: number) =>
    new Response(
      status === 410 ? "Gone" : status === 404 ? "Not found" : "Forbidden",
      { status, headers },
    );
  try {
    const claims = verifyFileToken(token);
    if (!claims) return refused(403);
    const { userId, exp, jti } = claims;
    const target =
      "statementId" in claims
        ? { statementId: claims.statementId }
        : { recordId: claims.recordId, attachmentId: claims.attachmentId };
    const outcome = (result: string) =>
      log.info({ userId, ...target, outcome: result }, "MCP file download");
    if (exp <= Math.floor(Date.now() / 1000)) {
      outcome("expired");
      return refused(410);
    }
    if (
      hit(
        `mcp-file-download:${userId}`,
        FILE_READ_LIMIT.max,
        FILE_READ_LIMIT.windowMs,
      ).limited
    ) {
      outcome("rate-limited");
      return refused(403);
    }
    // There is no disabled/active column: only existing users can authenticate.
    const user = db.select().from(users).where(eq(users.id, userId)).get();
    if (!user) {
      outcome("forbidden");
      return refused(403);
    }
    const locals = { user, ...resolveAccess(db, userId) };
    let filename: string;
    let displayName: string;
    if ("statementId" in claims) {
      if (!can(locals, "reconciliation.read")) {
        outcome("forbidden");
        return refused(403);
      }
      const statement = getStatement(db, claims.statementId);
      if (!statement?.storedFilePath) {
        outcome("missing");
        return refused(404);
      }
      filename = statement.storedFilePath;
      displayName = statement.originalFilename;
    } else {
      const record = getRecord(db, claims.recordId);
      if (!record) {
        outcome("missing");
        return refused(404);
      }
      if (!can(locals, permissionForKind(record.kind, "read"))) {
        outcome("forbidden");
        return refused(403);
      }
      const attachment = getAttachment(db, claims.attachmentId);
      if (!attachment || attachment.recordId !== claims.recordId) {
        outcome("missing");
        return refused(404);
      }
      filename = attachment.filename;
      displayName = attachment.displayName;
    }
    const stat = await store.stat(filename);
    if (exp <= Math.floor(Date.now() / 1000)) {
      outcome("expired");
      return refused(410);
    }
    if (!stat || stat.size > MAX_FILE_BYTES) {
      outcome("missing");
      return refused(404);
    }
    // A unique insert wins once, even for concurrent requests/processes. Only
    // expired entries can be pruned: their tokens can never pass verification.
    db.delete(mcpFileLinkUses)
      .where(lt(mcpFileLinkUses.expiresAt, Math.floor(Date.now() / 1000)))
      .run();
    const consumed = db
      .insert(mcpFileLinkUses)
      .values({ jti, expiresAt: exp })
      .onConflictDoNothing()
      .returning()
      .get();
    if (!consumed) {
      outcome("used");
      return refused(410);
    }
    const response = await storedFileResponse(
      store,
      request,
      filename,
      displayName,
      { download: true },
    );
    for (const [key, value] of Object.entries(headers))
      response.headers.set(key, value);
    outcome(response.status === 200 ? "ok" : "missing");
    return response;
  } catch (error) {
    // Avoid framework error reporting that could include the capability URL.
    log.error(
      { errorName: error instanceof Error ? error.name : typeof error },
      "MCP file download failed",
    );
    return refused(403);
  }
}
