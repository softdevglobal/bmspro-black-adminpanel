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
 * GET /api/call-center/branches/[branchId]
 *
 * Branch details: `hours`, `daySchedules`, `bookingLimitPerDay`.
 * Optional `date=YYYY-MM-DD` sets `daySchedule` for that weekday.
 *
 * **Call center agents** (`call_center_agent` / `call_center_admin`): any authenticated
 * agent may read any branch (operations hub). `X-Tenant-Id` / `ownerUid` are ignored for agents.
 *
 * **BMS staff** (workshop_owner / branch_admin / super_admin): must be allowed for that
 * branch’s `ownerUid` via `canAccessWorkshopForAuth`. If they send `ownerUid` / `X-Tenant-Id`,
 * it must match the branch’s owner.
 */
export async function GET(
  req: NextRequest,
  context: { params: Promise<{ branchId: string }> }
) {
  const gate = await verifyCallCenterOrTenantAdminAuth(req);
  if (!gate.success) {
    return NextResponse.json(
      { error: gate.error },
      { status: gate.status || 401, headers: CORS_HEADERS }
    );
  }

  const { branchId } = await context.params;
  const id = branchId?.trim();
  if (!id) {
    return NextResponse.json({ error: "Missing branchId" }, { status: 400, headers: CORS_HEADERS });
  }

  const dateParam = req.nextUrl.searchParams.get("date");

  try {
    const db = adminDb();
    const branchDoc = await db.collection("branches").doc(id).get();
    const data = branchDoc.data();

    if (!branchDoc.exists || !data) {
      return NextResponse.json({ error: "Branch not found" }, { status: 404, headers: CORS_HEADERS });
    }

    const branchOwnerUid =
      typeof data.ownerUid === "string" && data.ownerUid.trim() !== ""
        ? data.ownerUid.trim()
        : null;

    if (!branchOwnerUid) {
      return NextResponse.json({ error: "Branch not found" }, { status: 404, headers: CORS_HEADERS });
    }

    const requestedTenant = getTenantId(req);
    if (gate.auth.kind !== "agent") {
      if (
        requestedTenant &&
        requestedTenant.trim() !== "" &&
        requestedTenant.trim() !== branchOwnerUid
      ) {
        return NextResponse.json(
          { error: "ownerUid does not match this branch" },
          { status: 400, headers: CORS_HEADERS }
        );
      }

      if (!canAccessWorkshopForAuth(gate.auth, branchOwnerUid)) {
        return NextResponse.json({ error: "Access denied" }, { status: 403, headers: CORS_HEADERS });
      }
    }

    const branch = serializeCallCenterBranchForBooking(id, data, dateParam);
    if (!branch) {
      return NextResponse.json({ error: "Branch not found" }, { status: 404, headers: CORS_HEADERS });
    }

    return NextResponse.json({ branch }, { headers: CORS_HEADERS });
  } catch (e: any) {
    console.error("[call-center/branches/[branchId]]", e);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
