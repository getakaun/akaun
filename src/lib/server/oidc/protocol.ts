import * as oidc from "openid-client";
import {
  createRemoteJWKSet,
  customFetch,
  jwtVerify,
  type JWTPayload,
} from "jose";
import {
  allowedProviderUrl,
  clientSecret,
  publicOrigin,
  scopes,
  type AuthenticationSnapshot,
} from "./settings.js";

export const SSO_PATH = "/api/v1/auth/sso";
export const CALLBACK_PATH = SSO_PATH + "/callback";
export const AUTH_COMPLETE_PATH = "/auth/complete";
export const SSO_ERROR = { ssoError: "unavailable" };
export const LOGOUT_EVENT =
  "http://schemas.openid.net/event/backchannel-logout";
const algorithms = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
];

const providerFetch: NonNullable<
  oidc.Configuration[typeof oidc.customFetch]
> = (input, init) => {
  allowedProviderUrl(input);
  const headers = new Headers(init?.headers);
  headers.set("User-Agent", "Akaun");
  const body =
    init.body instanceof Uint8Array
      ? Uint8Array.from(init.body).buffer
      : init.body;
  return fetch(input, { ...init, body, headers, redirect: "error" });
};

async function loadProvider(
  settings: AuthenticationSnapshot,
  env: NodeJS.ProcessEnv,
) {
  const authority = allowedProviderUrl(settings.stored.authority);
  const secret = clientSecret(settings, env);
  const config = await oidc.discovery(
    authority,
    settings.stored.clientId,
    secret,
    undefined,
    {
      [oidc.customFetch]: providerFetch,
      execute:
        authority.protocol === "http:" ? [oidc.allowInsecureRequests] : [],
    },
  );
  const metadata = config.serverMetadata();
  if (
    metadata.issuer !== settings.stored.authority ||
    !metadata.jwks_uri ||
    !metadata.authorization_endpoint ||
    !metadata.token_endpoint
  ) {
    throw new Error("Invalid OIDC discovery document or issuer mismatch.");
  }
  const jwks = createRemoteJWKSet(allowedProviderUrl(metadata.jwks_uri), {
    [customFetch]: (url, init) =>
      providerFetch(url, {
        ...init,
        body: undefined,
        headers: Object.fromEntries(init.headers),
      }),
    cooldownDuration: 1000,
  });
  allowedProviderUrl(metadata.authorization_endpoint);
  allowedProviderUrl(metadata.token_endpoint);
  const methods = metadata.token_endpoint_auth_methods_supported;
  if (
    methods?.includes("client_secret_basic") &&
    !methods.includes("client_secret_post")
  ) {
    const basicConfig = new oidc.Configuration(
      metadata,
      settings.stored.clientId,
      secret,
      oidc.ClientSecretBasic(secret),
    );
    basicConfig[oidc.customFetch] = providerFetch;
    if (authority.protocol === "http:") oidc.allowInsecureRequests(basicConfig);
    return { config: basicConfig, jwks };
  }
  return { config, jwks };
}

let cached:
  | {
      revision: string;
      expires: number;
      value: ReturnType<typeof loadProvider>;
    }
  | undefined;

function provider(settings: AuthenticationSnapshot, env: NodeJS.ProcessEnv) {
  if (cached?.revision === settings.revision && cached.expires > Date.now())
    return cached.value;
  const value = loadProvider(settings, env);
  cached = {
    revision: settings.revision,
    expires: Date.now() + 5 * 60_000,
    value,
  };
  void value.catch(() => {
    if (cached?.value === value) cached = undefined;
  });
  return value;
}

export function localReturnTo(value: string | null): string {
  if (
    !value ||
    value.length > 2048 ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\p{Cc}]/u.test(value)
  )
    return "/";
  const target = new URL(value, "https://akaun.invalid");
  if (
    target.origin !== "https://akaun.invalid" ||
    /^\/(api|auth\/complete)/i.test(target.pathname)
  )
    return "/";
  return target.pathname + target.search + target.hash;
}

export async function authorizationUrl(
  settings: AuthenticationSnapshot,
  env: NodeJS.ProcessEnv,
  attempt: {
    state: string;
    nonce: string;
    verifier: string;
    linkSessionId: string | null;
  },
) {
  const { config } = await provider(settings, env);
  return oidc.buildAuthorizationUrl(config, {
    scope: scopes(settings.stored.additionalScopes).join(" "),
    response_type: "code",
    response_mode: "query",
    redirect_uri: new URL(CALLBACK_PATH, publicOrigin(env)).href,
    state: attempt.state,
    nonce: attempt.nonce,
    code_challenge: await oidc.calculatePKCECodeChallenge(attempt.verifier),
    code_challenge_method: "S256",
    ...(attempt.linkSessionId ? { prompt: "login", max_age: "0" } : {}),
  });
}

// Reject ambiguous JWT claims, including repeated back-channel logout events.
function uniqueClaims(token: string) {
  const payload = Buffer.from(token.split(".")[1], "base64url").toString(
    "utf8",
  );
  const containers: (Set<string> | null)[] = [];
  for (const match of payload.matchAll(/"(?:[^"\\]|\\.)*"(\s*:)?|[{}[\]]/g)) {
    const text = match[0];
    if (text === "{") containers.push(new Set());
    else if (text === "[") containers.push(null);
    else if (text === "}" || text === "]") containers.pop();
    else if (match[1]) {
      const keys = containers.at(-1);
      const name: string = JSON.parse(text.slice(0, -match[1].length));
      if (keys?.has(name)) throw new Error("duplicate_claim");
      keys?.add(name);
    }
  }
}

async function verifiedClaims(
  settings: AuthenticationSnapshot,
  env: NodeJS.ProcessEnv,
  token: string,
) {
  const { jwks } = await provider(settings, env);
  const { payload } = await jwtVerify(token, jwks, {
    issuer: settings.stored.authority,
    audience: settings.stored.clientId,
    algorithms,
    clockTolerance: 60,
  });
  uniqueClaims(token);
  return payload;
}

export async function exchangeCode(
  settings: AuthenticationSnapshot,
  env: NodeJS.ProcessEnv,
  search: string,
  attempt: {
    state: string;
    nonce: string;
    verifier: string;
    linkSessionId: string | null;
    startedAt: number;
  },
) {
  const callback = new URL(CALLBACK_PATH, publicOrigin(env));
  callback.search = search;
  const { config } = await provider(settings, env);
  const result = await oidc.authorizationCodeGrant(config, callback, {
    pkceCodeVerifier: attempt.verifier,
    expectedState: attempt.state,
    expectedNonce: attempt.nonce,
  });
  if (!result.id_token) throw new Error("no_id_token");
  const claims = await verifiedClaims(settings, env, result.id_token);
  if (
    attempt.linkSessionId &&
    (!Number.isSafeInteger(claims.auth_time) ||
      Number(claims.auth_time) * 1000 < attempt.startedAt - 60_000 ||
      Number(claims.auth_time) * 1000 > Date.now() + 60_000)
  ) {
    throw new Error("fresh_authentication");
  }
  return claims;
}

export function identifier(claims: JWTPayload, key: string, required = false) {
  const value = claims[key];
  if (value === undefined && !required) return null;
  if (typeof value !== "string" || !value.trim() || value.length > 255)
    throw new Error("invalid_subject_or_session");
  return value;
}

export async function verifyLogout(
  settings: AuthenticationSnapshot,
  env: NodeJS.ProcessEnv,
  token: string,
) {
  const claims = await verifiedClaims(settings, env, token);
  const events = claims.events;
  const logout =
    events && typeof events === "object" && Object.hasOwn(events, LOGOUT_EVENT)
      ? (events as Record<string, unknown>)[LOGOUT_EVENT]
      : undefined;
  const now = Math.floor(Date.now() / 1000);
  if (
    "nonce" in claims ||
    !logout ||
    typeof logout !== "object" ||
    Array.isArray(logout) ||
    typeof claims.iat !== "number" ||
    !Number.isSafeInteger(claims.iat) ||
    claims.iat < now - 300 ||
    claims.iat > now + 60
  )
    throw new Error("invalid_logout_claims");
  const jti = identifier(claims, "jti", true)!;
  const subject = identifier(claims, "sub");
  const sid = identifier(claims, "sid");
  if (!subject && !sid) throw new Error("invalid_logout_claims");
  return { jti, subject, sid };
}
