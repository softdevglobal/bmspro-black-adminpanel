import { NextResponse } from "next/server";
import { CORS_HEADERS } from "@/lib/callCenterAuth";

export const runtime = "nodejs";

/**
 * GET /api/call-center/public/health
 *
 * Public liveness check — no authentication.
 */
export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

export async function GET() {
  return NextResponse.json(
    {
      ok: true,
      service: "call-center",
      specUrl: "/api/call-center/public/request-data",
      timestamp: new Date().toISOString(),
    },
    { headers: CORS_HEADERS }
  );
}
