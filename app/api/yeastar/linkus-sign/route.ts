import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const LOG_PREFIX = "[api/yeastar/linkus-sign]";

const YEASTAR_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "OpenAPI",
} as const;

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
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

async function fetchYeastarToken(
  baseUrl: string,
  accessId: string,
  accessKey: string
): Promise<string> {
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
  };
  if (data.errcode != null && data.errcode !== 0) {
    throw new Error(`get_token errcode=${data.errcode} ${data.errmsg ?? ""}`);
  }
  const t = data.access_token?.trim();
  if (!t) throw new Error("get_token: missing access_token");
  return t;
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
    const token = await fetchYeastarToken(baseUrl, accessId, accessKey);
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
    return NextResponse.json({ success: true, sign });
  } catch (e) {
    console.error(LOG_PREFIX, e);
    return NextResponse.json(
      { success: false, message: e instanceof Error ? e.message : String(e) },
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
