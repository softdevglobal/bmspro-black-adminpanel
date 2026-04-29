import { NextRequest, NextResponse } from "next/server";

import {
  annotateOpenApiError,
  createSdkSign,
  getEnv,
} from "@/lib/yeastar/openapi";
import {
  assertCallerOwnsExtension,
  authenticateMobileRequest,
  checkMobileRateLimit,
} from "@/lib/yeastar/mobileAuth";

const LOG_PREFIX = "[yeastar/sign-get]";

/** Per-user cap — aligns with /api/yeastar/linkus-sign brute-force deterrence. */
export const YEASTAR_SIGN_RATE_PER_MIN = 5;

/**
 * Shared GET handler for `/api/yeastar/sign` and `/api/yeastar/linkus-sign`.
 * `rateLimitKeyPrefix` keeps buckets independent per route.
 */
export async function handleYeastarSignGet(
  req: NextRequest,
  rateLimitKeyPrefix: string,
): Promise<NextResponse> {
  const auth = await authenticateMobileRequest(req);
  if (!auth.ok) return auth.response;

  const extension = (req.nextUrl.searchParams.get("extension") ?? "").trim();
  const ownership = assertCallerOwnsExtension(auth.caller, extension);
  if (ownership) return ownership;

  const limited = checkMobileRateLimit(
    `${rateLimitKeyPrefix}:${auth.caller.uid}`,
    YEASTAR_SIGN_RATE_PER_MIN,
  );
  if (limited) return limited;

  const env = getEnv();
  if (!env.configured) {
    return NextResponse.json(
      {
        success: false,
        error: "yeastar_not_configured",
        hint:
          "Set YEASTAR_PBX_BASE_URL, YEASTAR_ACCESS_ID, YEASTAR_ACCESS_KEY, YEASTAR_LINKUS_HOST.",
      },
      { status: 503 },
    );
  }

  try {
    const result = await createSdkSign(extension, env);
    return NextResponse.json(
      {
        sign: result.sign,
        host: result.host,
        port: result.port,
      },
      {
        headers: {
          "Cache-Control": "no-store, max-age=0",
        },
      },
    );
  } catch (e) {
    console.error(LOG_PREFIX, e);
    const ann = annotateOpenApiError(e);
    return NextResponse.json(
      {
        success: false,
        error: ann.message,
        ...(ann.errcode != null ? { errcode: ann.errcode } : {}),
        ...(ann.hint ? { hint: ann.hint } : {}),
      },
      { status: 502 },
    );
  }
}
