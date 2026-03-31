import { NextResponse } from "next/server";
import { CORS_HEADERS } from "@/lib/callCenterAuth";
import {
  CALL_CENTER_PUBLIC_META,
  CALL_CENTER_ENDPOINT_SPECS,
} from "@/lib/callCenterRequestDataSpec";

export const runtime = "nodejs";

/**
 * GET /api/call-center/public/request-data
 *
 * Public, no authentication — returns full request/response contract for integration handover.
 * Intended for: Niranga / call center dashboard developers.
 */
export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

export async function GET() {
  const payload = {
    generatedAt: new Date().toISOString(),
    meta: CALL_CENTER_PUBLIC_META,
    endpoints: CALL_CENTER_ENDPOINT_SPECS,
    errorShape: { error: "string message" },
    commonHeadersWhenAuthenticated: [
      "Authorization: Bearer <firebase_id_token>",
      "Content-Type: application/json",
      "X-Tenant-Id: <ownerUid> (optional alternative to ?ownerUid=)",
    ],
  };

  return NextResponse.json(payload, {
    headers: {
      ...CORS_HEADERS,
      "Cache-Control": "public, max-age=300",
    },
  });
}
