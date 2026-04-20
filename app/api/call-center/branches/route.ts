import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import {
  verifyCallCenterOrTenantAdminAuth,
  canAccessWorkshopForAuth,
  getTenantId,
  CORS_HEADERS,
} from "@/lib/callCenterAuth";
import { serializeCallCenterBranchForBooking } from "@/lib/callCenterBranchForBooking";

export const runtime = "nodejs";

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

/**
 * GET /api/call-center/branches?ownerUid=<workshopOwnerUid>
 *
 * All branches for a workshop owner, each in the same shape as GET …/branches/[branchId].
 * Optional `date=YYYY-MM-DD` sets `daySchedule` on every row.
 *
 * **Call center agents:** may list branches for any owner.
 * **BMS staff:** only for workshops they are allowed to access (`canAccessWorkshopForAuth`).
 */
export async function GET(req: NextRequest) {
  const gate = await verifyCallCenterOrTenantAdminAuth(req);
  if (!gate.success) {
    return NextResponse.json(
      { error: gate.error },
      { status: gate.status || 401, headers: CORS_HEADERS }
    );
  }

  const ownerUidRaw = getTenantId(req);
  if (!ownerUidRaw || !ownerUidRaw.trim()) {
    return NextResponse.json(
      { error: "Missing ownerUid (query or X-Tenant-Id)" },
      { status: 400, headers: CORS_HEADERS }
    );
  }
  const ownerUid = ownerUidRaw.trim();

  if (gate.auth.kind !== "agent") {
    if (!canAccessWorkshopForAuth(gate.auth, ownerUid)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403, headers: CORS_HEADERS });
    }
  }

  const dateParam = req.nextUrl.searchParams.get("date");

  try {
    const db = adminDb();
    const snap = await db.collection("branches").where("ownerUid", "==", ownerUid).get();

    const rows = snap.docs
      .map((doc) => {
        const data = doc.data();
        return serializeCallCenterBranchForBooking(doc.id, data, dateParam);
      })
      .filter((b): b is NonNullable<typeof b> => b != null);

    rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

    return NextResponse.json(
      {
        ownerUid,
        total: rows.length,
        branches: rows,
      },
      { headers: CORS_HEADERS }
    );
  } catch (e: any) {
    console.error("[call-center/branches GET]", e);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
