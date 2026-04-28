import { NextRequest, NextResponse } from "next/server";

import {
  parseYeastarErrcode,
  yeastarHintForErrcode,
} from "@/lib/yeastarHints";

export const runtime = "nodejs";

const LOG_PREFIX = "[api/yeastar/linkus-sign]";

const YEASTAR_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "OpenAPI",
} as const;

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Match Flutter [normalizeYeastarPbxOpenApiBaseUrl] — strip `/openapi` suffix. */
function normalizeOpenApiBaseUrl(raw: string): string {
  let s = raw.trim().replace(/\/+$/, "");
  const lower = s.toLowerCase();
  if (lower.endsWith("/openapi")) {
    s = s.slice(0, -"/openapi".length).replace(/\/+$/, "");
  }
  return s;
}

/**
 * Linkus SDK needs SIP/TLS hosts; derive from PBX OpenAPI base (same rules as the app).
 */
function linkusConnFromPbxBaseUrl(rawBase: string): {
  pbxOpenApiBaseUrl: string;
  linkusRemoteIp: string;
  linkusLocaleIp: string;
} {
  const pbxOpenApiBaseUrl = normalizeOpenApiBaseUrl(rawBase);
  if (!pbxOpenApiBaseUrl) {
    return { pbxOpenApiBaseUrl: "", linkusRemoteIp: "", linkusLocaleIp: "" };
  }
  const href = pbxOpenApiBaseUrl.includes("://")
    ? pbxOpenApiBaseUrl
    : `https://${pbxOpenApiBaseUrl}`;
  let host = "";
  try {
    host = new URL(href).hostname;
  } catch {
    return { pbxOpenApiBaseUrl, linkusRemoteIp: "", linkusLocaleIp: "" };
  }
  if (!host) {
    return { pbxOpenApiBaseUrl, linkusRemoteIp: "", linkusLocaleIp: "" };
  }
  const isRas = host.toLowerCase().includes(".ras.yeastar.com");
  return {
    pbxOpenApiBaseUrl,
    linkusRemoteIp: host,
    linkusLocaleIp: isRas ? host : "",
  };
}

function resolveYeastarEnv(): {
  baseUrl: string;
  accessId: string;
  accessKey: string;
  configured: boolean;
} {
  const baseUrl =
    process.env.YEASTAR_BASE_URL?.trim() ||
    process.env.YEASTAR_PBX_BASE_URL?.trim() ||
    process.env.YEASTAR_PBX_URL?.trim() ||
    "";
  const accessId =
    process.env.YEASTAR_ACCESS_ID?.trim() ||
    process.env.YEASTAR_PBX_ACCESS_ID?.trim() ||
    "";
  const accessKey =
    process.env.YEASTAR_ACCESS_KEY?.trim() ||
    process.env.YEASTAR_PBX_ACCESS_KEY?.trim() ||
    "";
  return {
    baseUrl,
    accessId,
    accessKey,
    configured: !!(baseUrl && accessId && accessKey),
  };
}

/**
 * Module-level cache so repeated `linkus-sign` calls from the app reuse one
 * Yeastar OpenAPI access token. Yeastar caps the number of active tokens per
 * PBX (`errcode 60002 MAX LIMITATION EXCEEDED`); each `get_token` issues a new
 * one without invalidating old ones, so caching is essential.
 */
type TokenCacheEntry = {
  token: string;
  expiresAt: number;
  baseUrl: string;
  accessId: string;
};
let cachedToken: TokenCacheEntry | null = null;
let inflightToken: Promise<string> | null = null;
const TOKEN_SAFETY_MS = 60_000;

function readCachedToken(baseUrl: string, accessId: string): string | null {
  const c = cachedToken;
  if (!c) return null;
  if (c.baseUrl !== baseUrl || c.accessId !== accessId) return null;
  if (Date.now() + TOKEN_SAFETY_MS >= c.expiresAt) return null;
  return c.token;
}

async function fetchYeastarToken(
  baseUrl: string,
  accessId: string,
  accessKey: string,
  { forceRefresh = false }: { forceRefresh?: boolean } = {}
): Promise<string> {
  if (!forceRefresh) {
    const hit = readCachedToken(baseUrl, accessId);
    if (hit) return hit;
  }
  if (!forceRefresh && inflightToken) return inflightToken;

  const p = (async () => {
    const uri = `${normalizeBaseUrl(baseUrl)}/openapi/v1.0/get_token`;
    const res = await fetch(uri, {
      method: "POST",
      headers: { ...YEASTAR_HEADERS },
      body: JSON.stringify({ username: accessId, password: accessKey }),
      signal: AbortSignal.timeout(25_000),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`get_token HTTP ${res.status}: ${text.slice(0, 400)}`);
    }
    const data = JSON.parse(text) as {
      errcode?: number;
      errmsg?: string;
      access_token?: string;
      access_token_expire_time?: number;
    };
    if (data.errcode != null && data.errcode !== 0) {
      throw new Error(`get_token errcode=${data.errcode} ${data.errmsg ?? ""}`);
    }
    const t = data.access_token?.trim();
    if (!t) throw new Error("get_token: missing access_token");
    const ttlSec =
      typeof data.access_token_expire_time === "number"
        ? data.access_token_expire_time
        : 1800;
    cachedToken = {
      token: t,
      baseUrl,
      accessId,
      expiresAt: Date.now() + ttlSec * 1000,
    };
    return t;
  })();
  inflightToken = p;
  try {
    return await p;
  } finally {
    inflightToken = null;
  }
}

/**
 * POST /api/yeastar/linkus-sign
 * Body: `{ "email": "user@example.com" }` — must match Extension Email on PBX.
 * Returns `{ success, sign }` for Linkus SDK login (server holds Linkus SDK AccessID/Key).
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { success: false, message: "Invalid JSON body" },
      { status: 400 }
    );
  }
  const emailRaw =
    typeof body === "object" &&
    body !== null &&
    "email" in body &&
    (body as { email?: unknown }).email != null
      ? String((body as { email: unknown }).email).trim()
      : "";

  if (!emailRaw || !emailRaw.includes("@")) {
    return NextResponse.json(
      { success: false, message: "Valid email is required" },
      { status: 400 }
    );
  }

  const email = emailRaw.toLowerCase();
  const { baseUrl, accessId, accessKey, configured } = resolveYeastarEnv();
  if (!configured) {
    return NextResponse.json(
      {
        success: false,
        message: "Yeastar Linkus env not configured",
        hint:
          "Set YEASTAR_PBX_URL (or YEASTAR_PBX_BASE_URL), YEASTAR_PBX_ACCESS_ID, YEASTAR_PBX_ACCESS_KEY (Linkus SDK credentials from Integrations → Linkus SDK).",
      },
      { status: 503 }
    );
  }

  try {
    const callSignCreate = async (token: string) => {
      const signUrl = new URL(
        `${normalizeBaseUrl(baseUrl)}/openapi/v1.0/sign/create`
      );
      signUrl.searchParams.set("access_token", token);
      const sr = await fetch(signUrl.toString(), {
        method: "POST",
        headers: { ...YEASTAR_HEADERS },
        body: JSON.stringify({
          username: email,
          sign_type: "sdk",
          expire_time: 0,
        }),
        signal: AbortSignal.timeout(25_000),
      });
      const st = await sr.text();
      let parsed: {
        errcode?: number;
        errmsg?: string;
        data?: { sign?: string };
      };
      try {
        parsed = JSON.parse(st) as typeof parsed;
      } catch {
        throw new Error(`sign/create: invalid JSON ${st.slice(0, 200)}`);
      }
      return { http: sr.status, parsed };
    };

    let token = await fetchYeastarToken(baseUrl, accessId, accessKey);
    let { http, parsed } = await callSignCreate(token);

    // If the cached token was rejected, drop it and try once with a fresh one.
    const tokenLikelyBad =
      http === 401 ||
      http === 403 ||
      (parsed.errcode != null &&
        (parsed.errcode === 401 ||
          (parsed.errcode >= 40000 && parsed.errcode < 41000)));
    if (tokenLikelyBad) {
      console.warn(
        `${LOG_PREFIX} cached token rejected (http=${http} errcode=${parsed.errcode}) — refreshing`
      );
      cachedToken = null;
      token = await fetchYeastarToken(baseUrl, accessId, accessKey, {
        forceRefresh: true,
      });
      ({ http, parsed } = await callSignCreate(token));
    }

    if (parsed.errcode != null && parsed.errcode !== 0) {
      console.warn(
        `${LOG_PREFIX} sign/create errcode=${parsed.errcode} email=${email}`
      );
      return NextResponse.json(
        {
          success: false,
          message: "sign/create failed",
          errcode: parsed.errcode,
          errmsg: parsed.errmsg ?? null,
        },
        { status: 502 }
      );
    }
    const sign = parsed.data?.sign?.trim();
    if (!sign) {
      return NextResponse.json(
        { success: false, message: "sign/create: missing sign in response" },
        { status: 502 }
      );
    }
    const conn = linkusConnFromPbxBaseUrl(baseUrl);
    const linkusLocalePort =
      Number(process.env.YEASTAR_PBX_LOCALE_PORT?.trim()) || 443;
    const linkusRemotePort =
      Number(process.env.YEASTAR_PBX_REMOTE_PORT?.trim()) || 5061;
    return NextResponse.json({
      success: true,
      sign,
      ...conn,
      linkusLocalePort,
      linkusRemotePort,
    });
  } catch (e) {
    console.error(LOG_PREFIX, e);
    const message = e instanceof Error ? e.message : String(e);
    const code = parseYeastarErrcode(message);
    const hint =
      code != null ? yeastarHintForErrcode(code) : undefined;
    return NextResponse.json(
      {
        success: false,
        message,
        ...(code != null ? { errcode: code } : {}),
        ...(hint ? { hint } : {}),
      },
      { status: 502 }
    );
  }
}

export async function GET() {
  return NextResponse.json(
    { success: false, message: "Method Not Allowed" },
    {
      status: 405,
      headers: { Allow: "POST" },
    }
  );
}
