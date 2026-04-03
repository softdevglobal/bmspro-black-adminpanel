import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import {
  verifyCallCenterOrTenantAdminAuth,
  canAccessWorkshopForAuth,
  CORS_HEADERS,
} from "@/lib/callCenterAuth";
import { fetchWorkshopFullDetail } from "@/lib/callCenterWorkshopDetail";

export const runtime = "nodejs";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

/**
 * GET /api/call-center/workshops/[ownerUid]
 *
 * Get full workshop details: profile, branches, services.
 * Agent must have access to this workshop.
 */
export async function GET(
  req: NextRequest,
  context: { params: Promise<{ ownerUid: string }> }
) {
  const gate = await verifyCallCenterOrTenantAdminAuth(req);
  if (!gate.success) {
    return NextResponse.json(
      { error: gate.error },
      { status: gate.status || 401, headers: CORS_HEADERS }
    );
  }

  const { ownerUid } = await context.params;

  if (!canAccessWorkshopForAuth(gate.auth, ownerUid)) {
    return NextResponse.json(
      { error: "You do not have access to this workshop" },
      { status: 403, headers: CORS_HEADERS }
    );
  }

  try {
    const db = adminDb();
    const bundle = await fetchWorkshopFullDetail(db, ownerUid.trim());
    if (!bundle) {
      return NextResponse.json(
        { error: "Workshop not found" },
        { status: 404, headers: CORS_HEADERS }
      );
    }

    return NextResponse.json(bundle, { headers: CORS_HEADERS });
  } catch (error: any) {
    console.error("[call-center/workshops/[ownerUid]] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
