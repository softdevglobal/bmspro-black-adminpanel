import { NextRequest, NextResponse } from "next/server";

import { yeastarProbeHint } from "@/lib/yeastarHints";

export const runtime = "nodejs";

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

/** Public IPv4 this Node runtime uses for outbound HTTPS (same path as `get_token` → Yeastar). */
async function fetchOpenapiCallerEgressIpv4(): Promise<string | null> {
  try {
    const res = await fetch("https://api.ipify.org?format=json", {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { ip?: string };
    const ip = data.ip?.trim();
    return ip && ip.length > 0 ? ip : null;
  } catch {
    return null;
  }
}

/**
 * GET /api/yeastar/test-env — env flags only
 * GET /api/yeastar/test-env?probe=1 — get_token + optional sign/create (Linkus SDK flow)
 *
 * For full probe add **probeEmail** = an extension email that exists on PBX:
 * `?probe=1&probeEmail=user@example.com`
 *
 * With `probe=1`, the JSON includes **openapiCallerEgressIpv4** — add this exact address
 * under Yeastar **OpenAPI IP restriction** (errcode 70087). This is the hosting egress IP,
 * not the mobile client IP and not `YEASTAR_LINKUS_HOST`.
 */
export async function GET(req: NextRequest) {
  const hasBaseUrl = !!(
    process.env.YEASTAR_BASE_URL?.trim() ||
    process.env.YEASTAR_PBX_BASE_URL?.trim() ||
    process.env.YEASTAR_PBX_URL?.trim()
  );
  const hasAccessId = !!(
    process.env.YEASTAR_ACCESS_ID?.trim() ||
    process.env.YEASTAR_PBX_ACCESS_ID?.trim()
  );
  const hasAccessKey = !!(
    process.env.YEASTAR_ACCESS_KEY?.trim() ||
    process.env.YEASTAR_PBX_ACCESS_KEY?.trim()
  );
  const probeRaw = req.nextUrl.searchParams.get("probe");
  const probe =
    probeRaw === "1" ||
    probeRaw === "true" ||
    probeRaw === "yes" ||
    req.nextUrl.searchParams.has("probe");
  let probeResult: Record<string, unknown> | undefined;

  if (probe) {
    const openapiCallerEgressIpv4 = await fetchOpenapiCallerEgressIpv4();
    const probeEmail =
      req.nextUrl.searchParams.get("probeEmail")?.trim().toLowerCase() ?? "";
    const { baseUrl, accessId, accessKey, configured } = resolveYeastarEnv();
    if (!configured) {
      probeResult = {
        skipped: true,
        reason: "Yeastar env incomplete (base URL + Access ID + Access Key)",
        ...(openapiCallerEgressIpv4
          ? { openapiCallerEgressIpv4 }
          : {}),
      };
    } else {
      try {
        const token = await fetchYeastarToken(baseUrl, accessId, accessKey);
        const out: Record<string, unknown> = {
          getTokenOk: true,
          ...(openapiCallerEgressIpv4
            ? { openapiCallerEgressIpv4 }
            : {}),
          signCreateTested: false,
          hint:
            probeEmail.length > 0
              ? "If signCreateOk is true, Linkus SDK login path (get_token + sign/create) works for that email."
              : "Add &probeEmail=user@example.com to also test POST …/sign/create (same as mobile Linkus SDK).",
        };

        if (probeEmail.includes("@")) {
          const signUrl = new URL(
            `${normalizeBaseUrl(baseUrl)}/openapi/v1.0/sign/create`
          );
          signUrl.searchParams.set("access_token", token);
          const sr = await fetch(signUrl.toString(), {
            method: "POST",
            headers: { ...YEASTAR_HEADERS },
            body: JSON.stringify({
              username: probeEmail,
              sign_type: "sdk",
              expire_time: 0,
            }),
            signal: AbortSignal.timeout(25_000),
          });
          const st = await sr.text();
          let parsed: {
            errcode?: number;
            errmsg?: string;
            data?: unknown;
          };
          try {
            parsed = JSON.parse(st) as typeof parsed;
          } catch {
            throw new Error(`sign/create: invalid JSON ${st.slice(0, 200)}`);
          }
          const err = parsed.errcode ?? 0;
          out.signCreateTested = true;
          out.signCreateErrcode = err;
          out.signCreateErrmsg = parsed.errmsg ?? null;
          out.signCreateOk = err === 0;
          if (err === 10005) {
            out.hint =
              "ACCESS DENIED on sign/create — unusual if Linkus SDK is enabled; check Integrations → Linkus SDK AccessID/Key.";
          }
        }

        probeResult = out;
      } catch (e) {
        const errText = String(e).slice(0, 500);
        const hint = yeastarProbeHint(errText);
        probeResult = {
          getTokenOk: false,
          error: errText,
          ...(openapiCallerEgressIpv4
            ? { openapiCallerEgressIpv4 }
            : {}),
          ...(hint ? { hint } : {}),
        };
      }
    }
  }

  return NextResponse.json({
    hasBaseUrl,
    hasAccessId,
    hasAccessKey,
    probeRequested: req.nextUrl.searchParams.has("probe")
      ? probeRaw ?? ""
      : null,
    ...(probeResult !== undefined ? { probe: probeResult } : {}),
  });
}
