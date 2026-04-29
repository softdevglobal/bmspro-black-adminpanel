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

function pickSignUsername(body: unknown): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof body !== "object" || body === null) {
    return { ok: false, message: "Invalid JSON body" };
  }
  const o = body as Record<string, unknown>;
  const username =
    o.username != null && String(o.username).trim() !== ""
      ? String(o.username).trim()
      : "";
  const email =
    o.email != null && String(o.email).trim() !== ""
      ? String(o.email).trim()
      : "";
  const extension =
    o.extension != null && String(o.extension).trim() !== ""
      ? String(o.extension).trim()
      : "";
  const primary = username || email || extension;
  if (!primary) {
    return {
      ok: false,
      message: "Provide email, extension, or username (PBX sign/create identity)",
    };
  }
  if (primary.includes("@")) {
    const lower = primary.toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lower)) {
      return { ok: false, message: "Invalid email" };
    }
    return { ok: true, value: lower };
  }
  if (/^\d{1,15}$/.test(primary)) {
    return { ok: true, value: primary };
  }
  return {
    ok: false,
    message: "Use extension email (with @) or numeric PBX extension (e.g. 1500)",
  };
}

/**
 * POST /api/yeastar/linkus-sign
 * Body: `{ "email": "ext@domain.com" }` **or** `{ "extension": "1500" }` or `{ "username": "…" }` —
 * must match what Yeastar `sign/create` expects for that extension (email or number).
 * Returns `{ success, sign, … }` for Linkus SDK login.
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

  const picked = pickSignUsername(body);
  if (!picked.ok) {
    return NextResponse.json({ success: false, message: picked.message }, { status: 400 });
  }

  const signUsername = picked.value;
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
          username: signUsername,
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

    const errmsgUpper = (parsed.errmsg ?? "").toString().toUpperCase();
    // Yeastar often returns errcode 10004 "TOKEN EXPIRED" on sign/create when the OpenAPI
    // access_token is stale — same fix as HTTP 401: drop cache and get_token again.
    const tokenLikelyBad =
      http === 401 ||
      http === 403 ||
      (parsed.errcode != null &&
        (parsed.errcode === 401 ||
          parsed.errcode === 10004 ||
          (parsed.errcode >= 40000 && parsed.errcode < 41000))) ||
      errmsgUpper.includes("TOKEN EXPIRED");
    if (tokenLikelyBad) {
      console.warn(
        `${LOG_PREFIX} access token rejected (http=${http} errcode=${parsed.errcode} errmsg=${parsed.errmsg ?? ""}) — clearing cache and refreshing get_token`
      );
      cachedToken = null;
      token = await fetchYeastarToken(baseUrl, accessId, accessKey, {
        forceRefresh: true,
      });
      ({ http, parsed } = await callSignCreate(token));
    }

    if (parsed.errcode != null && parsed.errcode !== 0) {
      console.warn(
        `${LOG_PREFIX} sign/create errcode=${parsed.errcode} username=${signUsername}`
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
    // Cloud RAS: match OpenAPI TLS edge (443). 5060 often blocked from mobile networks.
    const linkusRemotePort =
      Number(process.env.YEASTAR_PBX_REMOTE_PORT?.trim()) || 443;
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
