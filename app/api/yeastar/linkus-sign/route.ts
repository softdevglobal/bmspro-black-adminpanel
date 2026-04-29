import { NextRequest, NextResponse } from "next/server";

import { handleYeastarSignGet } from "@/lib/yeastar/handleYeastarSignGet";
import {
  annotateOpenApiError,
  createSdkSign,
  getEnv,
} from "@/lib/yeastar/openapi";
import {
  authenticateMobileRequest,
  checkMobileRateLimit,
} from "@/lib/yeastar/mobileAuth";

export const runtime = "nodejs";

const LOG_PREFIX = "[api/yeastar/linkus-sign]";

/**
 * Picks the PBX `sign/create` username from the request body. Yeastar accepts
 * either an extension email or a numeric extension. We then enforce ownership
 * against the authenticated caller's `users/{uid}.yeastarExtension`.
 */
function pickSignUsername(
  body: unknown,
): { ok: true; value: string } | { ok: false; message: string } {
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
 * POST /api/yeastar/linkus-sign — legacy mobile path (kept for backward
 * compatibility). Returns the same shape as before plus enforces Firebase
 * Bearer auth and extension ownership.
 *
 * Body: `{ "email" | "extension" | "username" }`.
 *
 * New mobile clients should prefer `GET /api/yeastar/sign?extension=...`.
 */
export async function POST(req: NextRequest) {
  const auth = await authenticateMobileRequest(req);
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { success: false, message: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const picked = pickSignUsername(body);
  if (!picked.ok) {
    return NextResponse.json({ success: false, message: picked.message }, { status: 400 });
  }

  const env = getEnv();
  if (!env.configured) {
    return NextResponse.json(
      {
        success: false,
        message: "Yeastar Linkus env not configured",
        hint:
          "Set YEASTAR_PBX_BASE_URL, YEASTAR_ACCESS_ID, YEASTAR_ACCESS_KEY, YEASTAR_LINKUS_HOST.",
      },
      { status: 503 },
    );
  }

  // Ownership check: the caller must be asking for their own extension.
  // For email-form usernames we verify against the caller's email; for
  // numeric usernames we verify against the caller's yeastarExtension.
  const requested = picked.value;
  const caller = auth.caller;
  const ownsByEmail =
    requested.includes("@") && requested === caller.email.toLowerCase();
  const ownsByExtension =
    !requested.includes("@") && requested === caller.yeastarExtension;
  if (!ownsByEmail && !ownsByExtension) {
    return NextResponse.json(
      {
        success: false,
        error: "extension does not belong to caller",
      },
      { status: 403 },
    );
  }

  const limited = checkMobileRateLimit(`linkus-sign:${caller.uid}`, 5);
  if (limited) return limited;

  try {
    const result = await createSdkSign(requested, env);
    return NextResponse.json({
      success: true,
      sign: result.sign,
      pbxOpenApiBaseUrl: env.baseUrl.replace(/\/+$/, ""),
      linkusRemoteIp: result.host,
      linkusLocaleIp: result.host,
      linkusLocalePort: env.linkusPort,
      linkusRemotePort: result.port,
    });
  } catch (e) {
    console.error(LOG_PREFIX, e);
    const ann = annotateOpenApiError(e);
    return NextResponse.json(
      {
        success: false,
        message: ann.message,
        ...(ann.errcode != null ? { errcode: ann.errcode } : {}),
        ...(ann.hint ? { hint: ann.hint } : {}),
      },
      { status: 502 },
    );
  }
}

/**
 * GET /api/yeastar/linkus-sign?extension=1001 — same contract as
 * `GET /api/yeastar/sign?extension=…` (alphanumeric path kept for integrations
 * that hard-coded `/linkus-sign`).
 */
export async function GET(req: NextRequest) {
  return handleYeastarSignGet(req, "linkus-sign-get");
}
