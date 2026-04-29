/**
 * Shared Yeastar P-Series OpenAPI client used by mobile-facing routes
 * (`/api/yeastar/sign`, `/api/yeastar/linkus-sign`, `/api/yeastar/register-push`).
 *
 * Why this exists: Yeastar caps active OpenAPI access tokens per PBX
 * (`errcode 60002 MAX LIMITATION EXCEEDED`). Re-issuing tokens on each
 * mobile login burns the quota in minutes. This module owns a single
 * cross-route in-memory cache + an in-flight singleflight to coalesce
 * concurrent token fetches.
 *
 * **Firestore cache:** Vercel/serverless and `next dev` reloads each get an
 * empty in-memory cache; without shared storage every cold start calls
 * `get_token` and trips Yeastar **60002**. We mirror a valid token to
 * `yeastar_internal/openapi_access_token` so all instances reuse one slot.
 */

import { FieldValue } from "firebase-admin/firestore";

import { adminDb } from "@/lib/firebaseAdmin";
import { parseYeastarErrcode, yeastarHintForErrcode } from "@/lib/yeastarHints";

/** Server-only doc; never exposed to clients (Admin SDK in API routes only). */
const TOKEN_CACHE_FS_PATH = "yeastar_internal/openapi_access_token";

const YEASTAR_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "OpenAPI",
} as const;

const TOKEN_SAFETY_MS = 60_000;

export type YeastarEnv = {
  baseUrl: string;
  accessId: string;
  accessKey: string;
  /** SDK login transport: SIP/TLS host the mobile bridge connects to. */
  linkusHost: string;
  /** SDK login transport port (RAS cloud uses 443). */
  linkusPort: number;
  configured: boolean;
};

export type LinkusSignResult = {
  sign: string;
  host: string;
  port: number;
};

export type PushPlatform = "android" | "ios";
export type PushType = "fcm" | "apns";

export type RegisterPushArgs = {
  extension: string;
  deviceToken: string;
  platform: PushPlatform;
  type: PushType;
};

export class YeastarOpenApiError extends Error {
  constructor(
    message: string,
    readonly errcode: number | null = null,
    readonly hint: string | undefined = undefined,
  ) {
    super(message);
    this.name = "YeastarOpenApiError";
  }
}

/** Prefer Linkus SDK AccessID/AccessKey; otherwise Integrations → API Client ID + Secret (full pair only). */
function resolveOpenapiCredentials(): { accessId: string; accessKey: string } {
  const linkusId =
    process.env.YEASTAR_ACCESS_ID?.trim() ||
    process.env.YEASTAR_PBX_ACCESS_ID?.trim() ||
    "";
  const linkusKey =
    process.env.YEASTAR_ACCESS_KEY?.trim() ||
    process.env.YEASTAR_PBX_ACCESS_KEY?.trim() ||
    "";
  if (linkusId && linkusKey) return { accessId: linkusId, accessKey: linkusKey };
  const clientId = process.env.YEASTAR_OPENAPI_CLIENT_ID?.trim() || "";
  const clientSecret = process.env.YEASTAR_OPENAPI_CLIENT_SECRET?.trim() || "";
  return { accessId: clientId, accessKey: clientSecret };
}

export function getEnv(): YeastarEnv {
  const baseUrlRaw =
    process.env.YEASTAR_BASE_URL?.trim() ||
    process.env.YEASTAR_PBX_BASE_URL?.trim() ||
    process.env.YEASTAR_PBX_URL?.trim() ||
    "";
  const baseUrl = baseUrlRaw ? canonicalPbxBaseUrl(baseUrlRaw) : "";
  const { accessId, accessKey } = resolveOpenapiCredentials();

  // Linkus SDK SIP/TLS edge — RAS host normally matches the OpenAPI host.
  let linkusHost = process.env.YEASTAR_LINKUS_HOST?.trim() || "";
  if (!linkusHost && baseUrl) {
    try {
      const href = baseUrl.includes("://") ? baseUrl : `https://${baseUrl}`;
      linkusHost = new URL(href).hostname;
    } catch {
      linkusHost = "";
    }
  }
  const linkusPort = Number(process.env.YEASTAR_LINKUS_PORT?.trim()) || 443;

  return {
    baseUrl,
    accessId,
    accessKey,
    linkusHost,
    linkusPort,
    configured: !!(baseUrl && accessId && accessKey && linkusHost),
  };
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Host-only PBX URLs (common in env UIs) must become absolute HTTPS origins for fetch(). */
function ensureHttpsOrigin(raw: string): string {
  const t = raw.trim();
  if (!t) return "";
  if (/^https?:\/\//i.test(t)) return t;
  return `https://${t}`;
}

function canonicalPbxBaseUrl(raw: string): string {
  return normalizeBaseUrl(ensureHttpsOrigin(raw));
}

/**
 * Vercel/serverless egress is often blocked by Yeastar cloud (**70087**). When
 * `YEASTAR_OPENAPI_EDGE_PROXY_URL` + `YEASTAR_OPENAPI_EDGE_PROXY_SECRET` are set,
 * all OpenAPI HTTP calls use that HTTPS origin (a tiny relay on a VPS / fixed IP)
 * instead of `env.baseUrl`.
 */
function openApiRequestOrigin(env: YeastarEnv): string {
  const relay = process.env.YEASTAR_OPENAPI_EDGE_PROXY_URL?.trim();
  const secret = process.env.YEASTAR_OPENAPI_EDGE_PROXY_SECRET?.trim();
  // Require **both** — origin-only relay would send requests without Bearer and always fail.
  if (relay && secret) return canonicalPbxBaseUrl(relay);
  return normalizeBaseUrl(env.baseUrl);
}

function openApiRequestHeaders(): HeadersInit {
  const relay = process.env.YEASTAR_OPENAPI_EDGE_PROXY_URL?.trim();
  const secret = process.env.YEASTAR_OPENAPI_EDGE_PROXY_SECRET?.trim();
  if (relay && secret) {
    return {
      ...YEASTAR_HEADERS,
      Authorization: `Bearer ${secret}`,
    };
  }
  return { ...YEASTAR_HEADERS };
}

/** Headers for OpenAPI requests (adds proxy auth when relay is configured). */
export function getYeastarOpenApiFetchHeaders(): HeadersInit {
  return openApiRequestHeaders();
}

/** Origin used for OpenAPI HTTP (PBX base URL or edge relay). Exported for diagnostics. */
export function getYeastarOpenApiHttpOrigin(env: YeastarEnv): string {
  return openApiRequestOrigin(env);
}

/** True when OpenAPI calls are routed through the edge relay. */
export function isOpenApiEdgeProxyConfigured(): boolean {
  return !!(
    process.env.YEASTAR_OPENAPI_EDGE_PROXY_URL?.trim() &&
    process.env.YEASTAR_OPENAPI_EDGE_PROXY_SECRET?.trim()
  );
}

type TokenCacheEntry = {
  token: string;
  expiresAt: number;
  baseUrl: string;
  accessId: string;
};

let cachedToken: TokenCacheEntry | null = null;
let inflightToken: Promise<string> | null = null;

async function readFirestoreTokenCache(
  env: YeastarEnv,
): Promise<TokenCacheEntry | null> {
  try {
    const snap = await adminDb().doc(TOKEN_CACHE_FS_PATH).get();
    if (!snap.exists) return null;
    const d = snap.data() ?? {};
    const token = (d.access_token as string | undefined)?.trim();
    const expiresAtMs = d.expiresAtMs as number | undefined;
    const storedBase = (d.baseUrl as string | undefined) ?? "";
    const storedId = (d.accessId as string | undefined) ?? "";
    if (!token || typeof expiresAtMs !== "number") return null;
    if (canonicalPbxBaseUrl(storedBase) !== env.baseUrl) return null;
    if (storedId !== env.accessId) return null;
    if (Date.now() + TOKEN_SAFETY_MS >= expiresAtMs) return null;
    return {
      token,
      expiresAt: expiresAtMs,
      baseUrl: env.baseUrl,
      accessId: env.accessId,
    };
  } catch (e) {
    console.warn("[yeastar/openapi] Firestore token cache read failed", e);
    return null;
  }
}

async function writeFirestoreTokenCache(
  env: YeastarEnv,
  entry: TokenCacheEntry,
): Promise<void> {
  try {
    await adminDb()
      .doc(TOKEN_CACHE_FS_PATH)
      .set(
        {
          access_token: entry.token,
          expiresAtMs: entry.expiresAt,
          baseUrl: normalizeBaseUrl(env.baseUrl),
          accessId: env.accessId,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
  } catch (e) {
    console.warn("[yeastar/openapi] Firestore token cache write failed", e);
  }
}

async function deleteFirestoreTokenCacheBestEffort(): Promise<void> {
  try {
    await adminDb().doc(TOKEN_CACHE_FS_PATH).delete();
  } catch {
    /* ignore */
  }
}

function readCachedToken(baseUrl: string, accessId: string): string | null {
  const c = cachedToken;
  if (!c) return null;
  if (c.baseUrl !== baseUrl || c.accessId !== accessId) return null;
  if (Date.now() + TOKEN_SAFETY_MS >= c.expiresAt) return null;
  return c.token;
}

export function clearAccessTokenCache(): void {
  cachedToken = null;
  void deleteFirestoreTokenCacheBestEffort();
}

export async function getAccessToken(
  env: YeastarEnv = getEnv(),
  { forceRefresh = false }: { forceRefresh?: boolean } = {},
): Promise<string> {
  if (!env.configured) {
    throw new YeastarOpenApiError("Yeastar OpenAPI env not configured");
  }
  if (!forceRefresh) {
    const hit = readCachedToken(env.baseUrl, env.accessId);
    if (hit) return hit;

    const fromFs = await readFirestoreTokenCache(env);
    if (fromFs) {
      cachedToken = {
        token: fromFs.token,
        expiresAt: fromFs.expiresAt,
        baseUrl: env.baseUrl,
        accessId: env.accessId,
      };
      return fromFs.token;
    }

    if (inflightToken) return inflightToken;
  } else if (inflightToken) {
    return inflightToken;
  }

  const fetchTokenOnce = async (): Promise<string> => {
    const uri = `${openApiRequestOrigin(env)}/openapi/v1.0/get_token`;
    const res = await fetch(uri, {
      method: "POST",
      headers: openApiRequestHeaders(),
      body: JSON.stringify({ username: env.accessId, password: env.accessKey }),
      signal: AbortSignal.timeout(25_000),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new YeastarOpenApiError(
        `get_token HTTP ${res.status}: ${text.slice(0, 400)}`,
      );
    }
    let data: {
      errcode?: number;
      errmsg?: string;
      access_token?: string;
      access_token_expire_time?: number;
    };
    try {
      data = JSON.parse(text);
    } catch {
      throw new YeastarOpenApiError(`get_token: invalid JSON ${text.slice(0, 200)}`);
    }
    if (data.errcode != null && data.errcode !== 0) {
      const hint = yeastarHintForErrcode(data.errcode);
      throw new YeastarOpenApiError(
        `get_token errcode=${data.errcode} ${data.errmsg ?? ""}`.trim(),
        data.errcode,
        hint,
      );
    }
    const t = data.access_token?.trim();
    if (!t) throw new YeastarOpenApiError("get_token: missing access_token");
    const ttlSec =
      typeof data.access_token_expire_time === "number"
        ? data.access_token_expire_time
        : 1800;
    const entry: TokenCacheEntry = {
      token: t,
      baseUrl: env.baseUrl,
      accessId: env.accessId,
      expiresAt: Date.now() + ttlSec * 1000,
    };
    cachedToken = entry;
    await writeFirestoreTokenCache(env, entry);
    return t;
  };

  const p = (async () => {
    try {
      return await fetchTokenOnce();
    } catch (e) {
      if (e instanceof YeastarOpenApiError && e.errcode === 60002) {
        const salvage = await readFirestoreTokenCache(env);
        if (salvage) {
          cachedToken = {
            token: salvage.token,
            expiresAt: salvage.expiresAt,
            baseUrl: env.baseUrl,
            accessId: env.accessId,
          };
          return salvage.token;
        }
      }
      throw e;
    }
  })();

  inflightToken = p;
  try {
    return await p;
  } finally {
    inflightToken = null;
  }
}

/**
 * Generates a fresh SDK login signature for [extension]. Yeastar accepts an
 * **email or numeric extension** as `username`; both work for `sign_type=sdk`.
 */
export async function createSdkSign(
  username: string,
  env: YeastarEnv = getEnv(),
): Promise<LinkusSignResult> {
  if (!env.configured) {
    throw new YeastarOpenApiError("Yeastar OpenAPI env not configured");
  }
  const trimmed = username.trim();
  if (!trimmed) {
    throw new YeastarOpenApiError("createSdkSign: username required");
  }

  const callOnce = async (token: string) => {
    const url = new URL(
      `${openApiRequestOrigin(env)}/openapi/v1.0/sign/create`,
    );
    url.searchParams.set("access_token", token);
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: openApiRequestHeaders(),
      body: JSON.stringify({
        username: trimmed,
        sign_type: "sdk",
        expire_time: 0,
      }),
      signal: AbortSignal.timeout(25_000),
    });
    const text = await res.text();
    let parsed: {
      errcode?: number;
      errmsg?: string;
      data?: { sign?: string };
    };
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new YeastarOpenApiError(
        `sign/create: invalid JSON ${text.slice(0, 200)}`,
      );
    }
    return { http: res.status, parsed };
  };

  let token = await getAccessToken(env);
  let { http, parsed } = await callOnce(token);

  // Yeastar often returns errcode 10004 "TOKEN EXPIRED" or HTTP 401 when the
  // cached access_token is stale; refresh once then retry.
  const errmsgUpper = (parsed.errmsg ?? "").toString().toUpperCase();
  const tokenLikelyBad =
    http === 401 ||
    http === 403 ||
    (parsed.errcode != null &&
      (parsed.errcode === 401 ||
        parsed.errcode === 10004 ||
        (parsed.errcode >= 40000 && parsed.errcode < 41000))) ||
    errmsgUpper.includes("TOKEN EXPIRED");
  if (tokenLikelyBad) {
    clearAccessTokenCache();
    token = await getAccessToken(env, { forceRefresh: true });
    ({ http, parsed } = await callOnce(token));
  }

  if (parsed.errcode != null && parsed.errcode !== 0) {
    const hint = yeastarHintForErrcode(parsed.errcode);
    throw new YeastarOpenApiError(
      `sign/create errcode=${parsed.errcode} ${parsed.errmsg ?? ""}`.trim(),
      parsed.errcode,
      hint,
    );
  }
  const sign = parsed.data?.sign?.trim();
  if (!sign) {
    throw new YeastarOpenApiError("sign/create: missing sign in response");
  }
  return { sign, host: env.linkusHost, port: env.linkusPort };
}

export type SetPushTokenResult = {
  /** False when the PBX returns 10001 / interface absent — not a server failure. */
  applied: boolean;
};

/**
 * Registers a mobile push token with the PBX so it can deliver call invites
 * when the SDK is backgrounded. Yeastar exposes this on
 * `POST /openapi/v1.0/push/set` (P-Series 37.x+); older firmwares use
 * `extension/set_push`. We try the modern path first, fall back on 404.
 *
 * Cloud / some editions return **10001 INTERFACE NOT EXISTED** — we return
 * `{ applied: false }` so the HTTP route can still **200** and the app keeps
 * working for foreground SIP.
 *
 * `device_type` per Yeastar docs: 0 = Android (FCM), 1 = iOS (APNs alert),
 * 2 = iOS (VoIP / PushKit). We don't issue `2` from this route — PushKit
 * is a separate integration phase.
 */
export async function setPushToken(
  args: RegisterPushArgs,
  env: YeastarEnv = getEnv(),
): Promise<SetPushTokenResult> {
  if (!env.configured) {
    throw new YeastarOpenApiError("Yeastar OpenAPI env not configured");
  }
  const extension = args.extension.trim();
  if (!extension) {
    throw new YeastarOpenApiError("setPushToken: extension required");
  }
  const deviceType =
    args.platform === "android"
      ? 0
      : args.type === "apns"
        ? 1
        : 1; // iOS FCM is treated as APNs alert by the PBX

  const callOnce = async (token: string, path: string) => {
    const url = new URL(`${openApiRequestOrigin(env)}${path}`);
    url.searchParams.set("access_token", token);
    const body = {
      extension,
      device_type: deviceType,
      device_token: args.deviceToken,
      // Some PBX builds key on `push_token`; include both for compat.
      push_token: args.deviceToken,
      enable: args.deviceToken.length > 0 ? 1 : 0,
    };
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: openApiRequestHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25_000),
    });
    const text = await res.text();
    let parsed: { errcode?: number; errmsg?: string };
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new YeastarOpenApiError(
        `${path}: invalid JSON ${text.slice(0, 200)}`,
      );
    }
    return { http: res.status, parsed };
  };

  let token = await getAccessToken(env);
  let result = await callOnce(token, "/openapi/v1.0/push/set");

  if (result.http === 404) {
    // Older firmware path
    result = await callOnce(token, "/openapi/v1.0/extension/set_push");
  }

  const errmsgUpper = (result.parsed.errmsg ?? "").toString().toUpperCase();
  const tokenLikelyBad =
    result.http === 401 ||
    result.http === 403 ||
    (result.parsed.errcode != null &&
      (result.parsed.errcode === 401 ||
        result.parsed.errcode === 10004)) ||
    errmsgUpper.includes("TOKEN EXPIRED");
  if (tokenLikelyBad) {
    clearAccessTokenCache();
    token = await getAccessToken(env, { forceRefresh: true });
    result = await callOnce(token, "/openapi/v1.0/push/set");
    if (result.http === 404) {
      result = await callOnce(token, "/openapi/v1.0/extension/set_push");
    }
  }

  if (result.parsed.errcode != null && result.parsed.errcode !== 0) {
    const code = result.parsed.errcode;
    const msg = (result.parsed.errmsg ?? "").toString().toUpperCase();
    if (code === 10001 || msg.includes("INTERFACE NOT EXIST")) {
      console.warn(
        "[yeastar/openapi] PBX push OpenAPI not available (10001); skipping push/set",
      );
      return { applied: false };
    }
    const hint = yeastarHintForErrcode(result.parsed.errcode);
    throw new YeastarOpenApiError(
      `push/set errcode=${result.parsed.errcode} ${result.parsed.errmsg ?? ""}`.trim(),
      result.parsed.errcode,
      hint,
    );
  }

  return { applied: true };
}

/** Convenience wrapper for the `linkus-sign` legacy POST handler. */
export function annotateOpenApiError(e: unknown): {
  message: string;
  errcode: number | null;
  hint: string | undefined;
} {
  if (e instanceof YeastarOpenApiError) {
    return { message: e.message, errcode: e.errcode, hint: e.hint };
  }
  const message = e instanceof Error ? e.message : String(e);
  const code = parseYeastarErrcode(message);
  const hint = code != null ? yeastarHintForErrcode(code) : undefined;
  return { message, errcode: code, hint };
}
