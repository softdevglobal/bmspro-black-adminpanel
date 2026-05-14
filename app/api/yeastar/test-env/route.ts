import { NextRequest, NextResponse } from "next/server";

import {
  YeastarOpenApiError,
  getAccessToken,
  getEnv,
  getYeastarOpenApiFetchHeaders,
  getYeastarOpenApiHttpOrigin,
  isOpenApiEdgeProxyConfigured,
} from "@/lib/yeastar/openapi";
import { yeastarProbeHint } from "@/lib/yeastarHints";

export const runtime = "nodejs";

/** Public IPv4 this Node runtime uses for outbound HTTPS (ignored for Yeastar when edge proxy is on). */
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
  const env = getEnv();
  const hasBaseUrl = env.baseUrl.length > 0;
  const hasAccessId = env.accessId.length > 0;
  const hasAccessKey = env.accessKey.length > 0;
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
    const { configured } = env;
    if (!configured) {
      probeResult = {
        skipped: true,
        reason:
          "Yeastar env incomplete (base URL + OpenAPI credentials + YEASTAR_LINKUS_HOST). " +
          "Set Linkus YEASTAR_PBX_ACCESS_ID/KEY or YEASTAR_OPENAPI_CLIENT_ID/SECRET pair.",
        ...(openapiCallerEgressIpv4
          ? { openapiCallerEgressIpv4 }
          : {}),
      };
    } else {
      try {
        const usesOpenApiEdgeProxy = isOpenApiEdgeProxyConfigured();
        const token = await getAccessToken(env, { forceRefresh: true });
        const out: Record<string, unknown> = {
          getTokenOk: true,
          usesOpenApiEdgeProxy,
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
            `${getYeastarOpenApiHttpOrigin(env)}/openapi/v1.0/sign/create`,
          );
          signUrl.searchParams.set("access_token", token);
          const sr = await fetch(signUrl.toString(), {
            method: "POST",
            headers: getYeastarOpenApiFetchHeaders(),
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
        const usesOpenApiEdgeProxy = isOpenApiEdgeProxyConfigured();
        let openApiRequestHost: string | undefined;
        try {
          openApiRequestHost = new URL(
            `${getYeastarOpenApiHttpOrigin(env)}/`,
          ).host;
        } catch {
          openApiRequestHost = undefined;
        }
        probeResult = {
          getTokenOk: false,
          usesOpenApiEdgeProxy,
          openApiRequestHost,
          error: errText,
          ...(openapiCallerEgressIpv4
            ? { openapiCallerEgressIpv4 }
            : {}),
          ...(hint ? { hint } : {}),
          ...(e instanceof YeastarOpenApiError && e.errcode != null
            ? { openApiErrcode: e.errcode }
            : {}),
          ...(e instanceof YeastarOpenApiError && e.hint
            ? { openApiHint: e.hint }
            : {}),
        };
        if (e instanceof YeastarOpenApiError && e.errcode === 70087) {
          probeResult.yeastar70087Action = usesOpenApiEdgeProxy
            ? "Relay is configured but Yeastar still forbids the caller. Allowlist the VPS/outbound IP used by the relay (curl ifconfig.me from the VPS). Check relay env YEASTAR_PBX_BASE_URL matches your PBX. openApiRequestHost should be your relay hostname, not *.yeastar.com."
            : "Direct Vercel→Yeastar is blocked. Add YEASTAR_OPENAPI_EDGE_PROXY_URL + YEASTAR_OPENAPI_EDGE_PROXY_SECRET on Vercel and run scripts/yeastar-openapi-relay/server.mjs on a VPS; allowlist only the VPS IP in Yeastar, redeploy.";
        }
      }
    }
  }

  const proxyUrl = process.env.YEASTAR_OPENAPI_EDGE_PROXY_URL?.trim() ?? "";
  const proxySecret =
    process.env.YEASTAR_OPENAPI_EDGE_PROXY_SECRET?.trim() ?? "";
  const openApiEdgeProxyPartial =
    (proxyUrl.length > 0) !== (proxySecret.length > 0);

  return NextResponse.json({
    hasBaseUrl,
    hasAccessId,
    hasAccessKey,
    openApiEdgeProxyConfigured: isOpenApiEdgeProxyConfigured(),
    openApiEdgeProxyPartial,
    probeRequested: req.nextUrl.searchParams.has("probe")
      ? probeRaw ?? ""
      : null,
    ...(probeResult !== undefined ? { probe: probeResult } : {}),
  });
}
