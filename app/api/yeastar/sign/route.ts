import { NextRequest, NextResponse } from "next/server";

import { handleYeastarSignGet } from "@/lib/yeastar/handleYeastarSignGet";

export const runtime = "nodejs";

/**
 * GET /api/yeastar/sign?extension=1001
 *
 * Returns a **fresh** SDK login signature for the requested extension along
 * with the Linkus SIP/TLS edge (host + port) the mobile bridge should pass to
 * `YlsLoginManager.loginBlock` / iOS `YLSLoginManager.login`.
 *
 * Auth: `Authorization: Bearer <Firebase ID token>` (mobile roles only).
 * The caller's `users/{uid}.yeastarExtension` must equal the requested
 * extension — defense-in-depth so no one can sign for another user.
 *
 * Response:
 * ```
 * { "sign": "…", "host": "bmsproslynbrook.ras.yeastar.com", "port": 443 }
 * ```
 */
export async function GET(req: NextRequest) {
  return handleYeastarSignGet(req, "sign");
}

export async function POST() {
  return NextResponse.json(
    {
      success: false,
      error:
        "Method Not Allowed. Use GET /api/yeastar/sign?extension=… (POST /api/yeastar/linkus-sign also works for legacy clients).",
    },
    {
      status: 405,
      headers: { Allow: "GET" },
    },
  );
}
