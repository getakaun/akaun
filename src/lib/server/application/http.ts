import type { AppResult } from "./result.js";

/**
 * An operation's answer as an HTTP reply, in the shapes `api-response.ts`
 * already documents: 403/404/409 with `{ error }`, 400 with `issues`.
 *
 * A CONFLICT is a 409 like any refusal, and also carries `code` and
 * `currentVersion` so a caller that sent `expectedVersion` can tell it apart.
 */
export function failureResponse(
  result: Extract<AppResult<unknown>, { ok: false }>,
): Response {
  switch (result.code) {
    case "FORBIDDEN":
      // With the sentence, so a form can say which ability is missing.
      return Response.json({ error: result.reason }, { status: 403 });
    case "NOT_FOUND":
      return Response.json({ error: result.reason }, { status: 404 });
    case "INVALID_INPUT":
    case "RATE_UNAVAILABLE":
      return Response.json(
        { error: result.reason, reason: result.reason, issues: result.issues },
        { status: 400 },
      );
    case "CONFLICT":
      return Response.json(
        {
          error: result.reason,
          reason: result.reason,
          code: result.code,
          currentVersion: result.currentVersion,
        },
        { status: 409 },
      );
    default:
      return Response.json(
        { error: result.reason, reason: result.reason },
        { status: 409 },
      );
  }
}

export function toResponse<T>(
  result: AppResult<T>,
  status = 200,
  body: (value: T) => unknown = (value) => value,
): Response {
  if (!result.ok) return failureResponse(result);
  if (status === 204) return new Response(null, { status });
  return Response.json(body(result.value), { status });
}
